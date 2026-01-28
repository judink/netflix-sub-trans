// background.js (service worker)
// 단순화된 버전 - 디버깅용

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

// 탭별 번역 저장소
const tabTranslations = new Map();

// 배치 번역 설정
const BATCH_SIZE = 40;  // 한 번에 40개 자막 (안전한 최대치)
const CONTEXT_SIZE = 2;
const BATCH_DELAY = 30; // 배치 간 딜레이 (ms)

// ============================================
// 메시지 핸들러
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  console.log("[NST] 메시지 수신:", message?.type, "tabId:", tabId);

  // 자막 처리 요청
  if (message?.type === PROCESS_SUBTITLES) {
    const { movieId, subtitleUrl, langCode } = message;
    console.log("[NST] === 번역 요청 ===");
    console.log("[NST] movieId:", movieId);
    console.log("[NST] langCode:", langCode);
    console.log("[NST] URL:", subtitleUrl?.substring(0, 80));

    if (!subtitleUrl) {
      console.error("[NST] subtitleUrl이 없음!");
      sendResponse({ ok: false, error: "URL 없음" });
      return true;
    }

    // 비동기 처리
    processSubtitles(movieId, subtitleUrl, tabId, langCode);
    sendResponse({ ok: true });
    return true;
  }

  // 번역 조회
  if (message?.type === GET_TRANSLATION) {
    const { text } = message;
    const tabData = tabTranslations.get(tabId);

    if (tabData && tabData.subtitles.has(text)) {
      sendResponse({ translated: tabData.subtitles.get(text) });
    } else {
      sendResponse({ translated: null });
    }
    return true;
  }

  // 캐시 상태 조회
  if (message?.type === "NST_GET_CACHE_STATUS") {
    const { movieId, langCode, targetLang } = message;
    getCacheStatus(movieId, langCode, targetLang).then(sendResponse);
    return true;
  }

  // 번역 취소
  if (message?.type === "NST_CANCEL_TRANSLATION") {
    console.log("[NST] 번역 취소 요청");
    // 모든 탭의 번역 취소
    for (const [tid, data] of tabTranslations) {
      data.cancelled = true;
    }
    sendResponse({ ok: true });
    return true;
  }

  return true;
});

// ============================================
// 메인 처리 함수
// ============================================
async function processSubtitles(movieId, subtitleUrl, tabId, sourceLanguage) {
  try {
    console.log("[NST] processSubtitles 시작");

    // 설정 로드
    const settings = await chrome.storage.sync.get(["geminiApiKey", "targetLanguage"]);
    const targetLanguage = settings.targetLanguage || "uk";
    const apiKey = settings.geminiApiKey;

    console.log("[NST] targetLanguage:", targetLanguage);
    console.log("[NST] API 키 존재:", !!apiKey);

    if (!apiKey) {
      console.error("[NST] API 키 없음!");
      notifyStatus(tabId, "error");
      return;
    }

    // 캐시 확인
    const cacheKey = `nst_cache_${movieId}_${sourceLanguage}_${targetLanguage}`;
    const cached = await chrome.storage.local.get(cacheKey);
    const cacheData = cached[cacheKey];

    if (cacheData && cacheData.subtitles && Object.keys(cacheData.subtitles).length > 0 && cacheData.completed) {
      console.log("[NST] 캐시 히트!", Object.keys(cacheData.subtitles).length + "개");

      const subtitlesMap = new Map(Object.entries(cacheData.subtitles));
      tabTranslations.set(tabId, { subtitles: subtitlesMap, cancelled: false });

      sendToTab(tabId, cacheData.subtitles);
      notifyStatus(tabId, "ready", null, subtitlesMap.size);
      return;
    }

    // 상태 초기화
    tabTranslations.set(tabId, {
      subtitles: new Map(),
      cancelled: false
    });

    notifyStatus(tabId, "loading", { current: 0, total: 0 });

    // 자막 파일 다운로드
    console.log("[NST] 자막 파일 다운로드 시작...");
    const response = await fetch(subtitleUrl);
    console.log("[NST] fetch 응답:", response.status);

    if (!response.ok) {
      throw new Error(`Fetch 실패: ${response.status}`);
    }

    const vttText = await response.text();
    console.log("[NST] 자막 파일 크기:", vttText.length);
    console.log("[NST] 자막 시작 부분:", vttText.substring(0, 300));

    // WebVTT 파싱
    const entries = parseWebVTT(vttText);
    console.log("[NST] 파싱된 자막 수:", entries.length);

    if (entries.length === 0) {
      console.error("[NST] 자막 파싱 실패!");
      notifyStatus(tabId, "error");
      return;
    }

    console.log("[NST] 첫 5개 자막:", entries.slice(0, 5));

    // 번역 시작
    const tabData = tabTranslations.get(tabId);
    const total = entries.length;

    notifyStatus(tabId, "loading", { current: 0, total });

    // 배치 번역
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      // 취소 확인
      if (tabData.cancelled) {
        console.log("[NST] 번역 취소됨");
        return;
      }

      const batch = entries.slice(i, i + BATCH_SIZE);
      console.log(`[NST] 배치 ${i / BATCH_SIZE + 1}: ${batch.length}개`);

      // 프롬프트 생성
      const promptLines = ["[TRANSLATE THESE]"];
      batch.forEach((t, idx) => promptLines.push(`${idx + 1}. "${t}"`));

      // 문맥 추가
      if (i > 0) {
        const before = entries.slice(Math.max(0, i - CONTEXT_SIZE), i);
        promptLines.unshift("");
        before.forEach(t => promptLines.unshift(`- "${t}"`));
        promptLines.unshift("[CONTEXT BEFORE]");
      }

      const sourceLang = LANGUAGE_NAMES[sourceLanguage] || sourceLanguage;
      const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

      const prompt = `You are a professional subtitle translator. Translate ${sourceLang} subtitles to ${targetLang}.

IMPORTANT RULES:
- Output ONLY the translated text in ${targetLang}
- Do NOT include romanization, transliteration, or pronunciation guides
- Do NOT include the original text
- Do NOT add explanations or notes
- Keep the same numbered format (1. 2. 3. etc.)
- Preserve the natural conversational tone

${promptLines.join("\n")}

Output format example:
1. [translated text only]
2. [translated text only]`;

      try {
        const apiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
            })
          }
        );

        console.log("[NST] API 응답:", apiResponse.status);

        if (apiResponse.status === 429) {
          console.log("[NST] Rate limit, 2초 대기...");
          await sleep(2000);
          i -= BATCH_SIZE;
          continue;
        }

        if (!apiResponse.ok) {
          console.error("[NST] API 오류:", apiResponse.status);
          continue;
        }

        const data = await apiResponse.json();
        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        console.log("[NST] API 결과:", resultText.substring(0, 200));

        const resultLines = resultText.split("\n").filter(l => l.trim());

        // 결과 파싱
        for (let j = 0; j < batch.length; j++) {
          const original = batch[j];
          let translated = "";

          // 번호 매칭
          for (const line of resultLines) {
            const match = line.match(new RegExp(`^${j + 1}\\.\\s*(.+)$`));
            if (match) {
              translated = match[1].replace(/^["']|["']$/g, "").trim();
              break;
            }
          }

          // 폴백
          if (!translated && resultLines[j]) {
            translated = resultLines[j].replace(/^\d+\.\s*/, "").replace(/^["']|["']$/g, "").trim();
          }

          if (translated) {
            tabData.subtitles.set(original, translated);
          }
        }

        // 진행 상황 업데이트
        const current = Math.min(i + BATCH_SIZE, total);
        notifyStatus(tabId, "loading", { current, total });
        console.log(`[NST] 진행: ${current}/${total}`);

        // contentScript에 전송
        sendToTab(tabId, Object.fromEntries(tabData.subtitles));

        // 딜레이
        await sleep(BATCH_DELAY);

      } catch (err) {
        console.error("[NST] 배치 오류:", err);
      }
    }

    // 완료
    console.log("[NST] 번역 완료:", tabData.subtitles.size + "개");

    if (tabData.subtitles.size > 0) {
      // 캐시 저장
      await chrome.storage.local.set({
        [cacheKey]: {
          subtitles: Object.fromEntries(tabData.subtitles),
          completed: true,
          timestamp: Date.now()
        }
      });
      console.log("[NST] 캐시 저장 완료");

      notifyStatus(tabId, "ready", null, tabData.subtitles.size);
    } else {
      console.error("[NST] 번역된 자막이 없음!");
      notifyStatus(tabId, "error");
    }

  } catch (err) {
    console.error("[NST] 처리 오류:", err);
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

    // 스킵할 줄들
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

  return [...new Set(entries)];
}

// ============================================
// 캐시 상태 조회
// ============================================
async function getCacheStatus(movieId, sourceLang, targetLang) {
  const cacheKey = `nst_cache_${movieId}_${sourceLang}_${targetLang}`;
  const cached = await chrome.storage.local.get(cacheKey);
  const data = cached[cacheKey];

  if (!data || !data.subtitles) {
    return { exists: false, progress: 0, completed: false };
  }

  const count = Object.keys(data.subtitles).length;
  return {
    exists: true,
    progress: data.completed ? 100 : 50,
    completed: data.completed === true,
    current: count,
    total: count
  };
}

// ============================================
// 헬퍼 함수
// ============================================
function notifyStatus(tabId, status, progress = null, count = null) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: SUBTITLE_STATUS,
    status,
    progress,
    count
  }).catch(() => {});
}

function sendToTab(tabId, translations) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: "NST_TRANSLATIONS_DATA",
    translations
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
