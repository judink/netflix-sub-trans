// background.js (service worker)
// contentScript에서 자막 URL 수신 → 캐시 확인 → fetch → 파싱 → Gemini API 일괄 번역 → 저장

console.log("[NST] ===== 서비스 워커 시작 =====");

const GET_TRANSLATION = "NST_GET_TRANSLATION";
const SUBTITLE_STATUS = "NST_SUBTITLE_STATUS";
const PROCESS_SUBTITLES = "NST_PROCESS_SUBTITLES";

// 언어 이름 매핑
const LANGUAGE_NAMES = {
  ko: "Korean",
  en: "English",
  uk: "Ukrainian",
  ja: "Japanese",
  ru: "Russian",
  es: "Spanish",
  fr: "French",
  de: "German",
  zh: "Chinese"
};

// 탭별 번역 저장소: tabId -> { subtitles: Map<원본, 번역>, status, progress }
const tabTranslations = new Map();

// 처리된 영화 ID 추적 (중복 방지)
const processedMovies = new Set();

// 배치 번역 설정
const BATCH_SIZE = 5; // 문맥 포함으로 줄임
const CONTEXT_SIZE = 2; // 앞뒤 2문장씩 문맥 제공
const BATCH_DELAY = 100;

// 캐시 키 생성: movieId + sourceLanguage + targetLanguage
function getCacheKey(movieId, sourceLang, targetLang) {
  return `nst_cache_${movieId}_${sourceLang}_${targetLang}`;
}

// ============================================
// 캐시에서 번역 로드
// ============================================
async function loadFromCache(movieId, sourceLang, targetLang) {
  const key = getCacheKey(movieId, sourceLang, targetLang);
  const result = await chrome.storage.local.get(key);

  if (result[key]) {
    console.log("[NST] 캐시에서 로드:", movieId);
    return result[key]; // { subtitles: { original: translated, ... }, timestamp }
  }
  return null;
}

// ============================================
// 캐시에 번역 저장
// ============================================
async function saveToCache(movieId, sourceLang, targetLang, subtitlesMap) {
  const key = getCacheKey(movieId, sourceLang, targetLang);

  // Map을 일반 객체로 변환
  const subtitlesObj = {};
  for (const [original, translated] of subtitlesMap) {
    subtitlesObj[original] = translated;
  }

  await chrome.storage.local.set({
    [key]: {
      subtitles: subtitlesObj,
      timestamp: Date.now(),
      movieId,
      sourceLang,
      targetLang
    }
  });

  console.log("[NST] 캐시에 저장:", movieId, Object.keys(subtitlesObj).length + "개");
}

// ============================================
// 메시지 핸들러
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // 자막 처리 요청 (contentScript에서 자막 URL 전달)
  if (message?.type === PROCESS_SUBTITLES) {
    const { movieId, subtitleUrl, langCode } = message;

    // 이미 이 세션에서 처리된 영화인지 확인 (같은 언어로)
    const sessionKey = `${tabId}-${movieId}-${langCode}`;
    if (processedMovies.has(sessionKey)) {
      console.log("[NST] 이미 처리된 영화:", movieId, langCode);
      sendResponse({ ok: true });
      return true;
    }
    processedMovies.add(sessionKey);

    console.log("[NST] 자막 처리 시작:", movieId, langCode);

    // 비동기로 처리 (langCode 전달)
    handleSubtitleProcessing(movieId, subtitleUrl, tabId, langCode);
    sendResponse({ ok: true });
    return true;
  }

  // 번역 조회
  if (message?.type === GET_TRANSLATION) {
    const { text } = message;

    if (tabId && tabTranslations.has(tabId)) {
      const translated = tabTranslations.get(tabId).subtitles.get(text);
      sendResponse({ translated: translated || null });
    } else {
      sendResponse({ translated: null });
    }
    return true;
  }
});

// ============================================
// 자막 처리 (캐시 확인 → 번역)
// ============================================
async function handleSubtitleProcessing(movieId, subtitleUrl, tabId, sourceLanguage) {
  // 설정 가져오기
  const settings = await chrome.storage.sync.get(["geminiApiKey", "targetLanguage"]);
  const targetLanguage = settings.targetLanguage || "uk";

  // 캐시 확인
  const cached = await loadFromCache(movieId, sourceLanguage, targetLanguage);

  if (cached && cached.subtitles) {
    // 캐시에서 로드!
    console.log("[NST] ★ 캐시 히트! API 호출 생략");

    // Map으로 변환하여 메모리에 저장
    const subtitlesMap = new Map(Object.entries(cached.subtitles));

    tabTranslations.set(tabId, {
      subtitles: subtitlesMap,
      status: "ready",
      progress: { current: subtitlesMap.size, total: subtitlesMap.size }
    });

    notifyStatus(tabId, "ready", null, subtitlesMap.size);
    return;
  }

  // 캐시 없음 - 새로 번역
  console.log("[NST] 캐시 미스, 새로 번역 시작");
  await fetchAndTranslateSubtitles(movieId, subtitleUrl, tabId, sourceLanguage, targetLanguage, settings.geminiApiKey);
}

// ============================================
// 자막 파일 가져오기 + 번역
// ============================================
async function fetchAndTranslateSubtitles(movieId, url, tabId, sourceLanguage, targetLanguage, apiKey) {
  if (!tabId || tabId < 0) return;

  try {
    // 상태 초기화
    tabTranslations.set(tabId, {
      subtitles: new Map(),
      status: "loading",
      progress: { current: 0, total: 0 }
    });

    notifyStatus(tabId, "loading", { current: 0, total: 0 });

    // API 키 확인
    if (!apiKey) {
      console.warn("[NST] API 키 없음");
      tabTranslations.get(tabId).status = "error";
      notifyStatus(tabId, "error");
      return;
    }

    // 자막 파일 fetch
    console.log("[NST] 자막 파일 다운로드:", url.substring(0, 80));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    const text = await response.text();
    console.log("[NST] 자막 파일 크기:", text.length);

    // WebVTT 파싱
    const entries = parseWebVTT(text);

    if (entries.length === 0) {
      console.log("[NST] 자막 없음");
      notifyStatus(tabId, "error");
      return;
    }

    console.log(`[NST] ${entries.length}개 자막 파싱 완료`);

    // 진행도 설정
    const tabData = tabTranslations.get(tabId);
    tabData.progress.total = entries.length;

    // 배치 번역 실행
    await translateBatch(tabId, entries, sourceLanguage, targetLanguage, apiKey);

    // 완료
    tabData.status = "ready";
    console.log(`[NST] 번역 완료: ${tabData.subtitles.size}개`);

    // 캐시에 저장
    await saveToCache(movieId, sourceLanguage, targetLanguage, tabData.subtitles);

    notifyStatus(tabId, "ready", null, tabData.subtitles.size);

  } catch (err) {
    console.error("[NST] 오류:", err);
    if (tabTranslations.has(tabId)) {
      tabTranslations.get(tabId).status = "error";
    }
    notifyStatus(tabId, "error");
  }
}

// ============================================
// WebVTT 파싱
// ============================================
function parseWebVTT(vttText) {
  const entries = [];
  const lines = vttText.split("\n");
  let buffer = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 헤더, 타임스탬프, 빈 줄, 숫자만 있는 줄 스킵
    if (
      trimmed === "WEBVTT" ||
      trimmed.includes("-->") ||
      trimmed === "" ||
      /^\d+$/.test(trimmed) ||
      trimmed.startsWith("NOTE") ||
      trimmed.startsWith("STYLE")
    ) {
      if (buffer.length > 0) {
        const text = buffer.join(" ").trim();
        if (text) entries.push(text);
        buffer = [];
      }
      continue;
    }

    // HTML 태그 제거
    const cleanText = trimmed
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .trim();

    if (cleanText) {
      buffer.push(cleanText);
    }
  }

  if (buffer.length > 0) {
    const text = buffer.join(" ").trim();
    if (text) entries.push(text);
  }

  // 중복 제거
  return [...new Set(entries)];
}

// ============================================
// 배치 번역
// ============================================
async function translateBatch(tabId, entries, sourceLanguage, targetLanguage, apiKey) {
  const tabData = tabTranslations.get(tabId);
  if (!tabData) return;

  const sourceLang = LANGUAGE_NAMES[sourceLanguage] || sourceLanguage;
  const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    // 문맥 포함 프롬프트 생성
    const promptLines = [];

    // 앞 문맥 (CONTEXT_SIZE개)
    const contextBefore = [];
    for (let c = Math.max(0, i - CONTEXT_SIZE); c < i; c++) {
      contextBefore.push(entries[c]);
    }
    if (contextBefore.length > 0) {
      promptLines.push("[CONTEXT BEFORE]");
      contextBefore.forEach(t => promptLines.push(`- "${t}"`));
      promptLines.push("");
    }

    // 번역할 문장들
    promptLines.push("[TRANSLATE THESE]");
    batch.forEach((t, idx) => promptLines.push(`${idx + 1}. "${t}"`));
    promptLines.push("");

    // 뒤 문맥 (CONTEXT_SIZE개)
    const contextAfter = [];
    const endIdx = Math.min(entries.length, i + BATCH_SIZE + CONTEXT_SIZE);
    for (let c = i + BATCH_SIZE; c < endIdx; c++) {
      contextAfter.push(entries[c]);
    }
    if (contextAfter.length > 0) {
      promptLines.push("[CONTEXT AFTER]");
      contextAfter.forEach(t => promptLines.push(`- "${t}"`));
    }

    const prompt = `You are translating ${sourceLang} drama/movie subtitles to ${targetLang}.
Use the context to understand the conversation flow, but ONLY translate the lines in [TRANSLATE THESE].
Output ONLY the translations, one per line, numbered to match (1. 2. 3. etc.):

${promptLines.join("\n")}`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
          })
        }
      );

      if (response.status === 429) {
        // Rate limit - 대기 후 재시도
        console.log("[NST] Rate limit, 대기 중...");
        await sleep(2000);
        i -= BATCH_SIZE;
        continue;
      }

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const resultLines = resultText.split("\n").filter(l => l.trim());

      // 결과 파싱
      for (let j = 0; j < batch.length; j++) {
        const original = batch[j];
        let translated = "";

        // 번호 매칭 시도
        const pattern = new RegExp(`^${j + 1}\\.\\s*"?(.+?)"?$`);
        for (const line of resultLines) {
          const m = line.match(pattern);
          if (m) {
            translated = m[1].trim();
            break;
          }
        }

        // 폴백: 위치 기반
        if (!translated && resultLines[j]) {
          translated = resultLines[j].replace(/^\d+\.\s*"?/, "").replace(/"?\s*$/, "").trim();
        }

        if (translated) {
          tabData.subtitles.set(original, translated);
        }
      }

      // 진행도 업데이트
      tabData.progress.current = Math.min(i + BATCH_SIZE, entries.length);
      notifyStatus(tabId, "loading", tabData.progress);

      console.log(`[NST] 번역 진행: ${tabData.progress.current}/${entries.length}`);

      // 배치 간 딜레이
      if (i + BATCH_SIZE < entries.length) {
        await sleep(BATCH_DELAY);
      }

    } catch (err) {
      console.error("[NST] 배치 오류:", err);
    }
  }
}

// ============================================
// 상태 알림
// ============================================
function notifyStatus(tabId, status, progress = null, count = null) {
  chrome.tabs.sendMessage(tabId, {
    type: SUBTITLE_STATUS,
    status,
    progress,
    count
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
