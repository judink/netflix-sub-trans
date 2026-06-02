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
const BATCH_SIZE = 35;  // 속도와 응답 안정성의 균형점
const BATCH_CONCURRENCY = 2;
const CONTEXT_SIZE = 2;
const BATCH_DELAY = 100; // 배치 간 딜레이 (ms)
const MAX_BATCH_RETRIES = 5;
const MAX_SINGLE_RETRIES = 8;
const RETRY_BASE_DELAY = 1200;
const RETRY_MAX_DELAY = 15000;
const API_TIMEOUT = 45000;
const GEMINI_MODEL_CANDIDATES = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];

const geminiModelCache = new Map();

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
async function processSubtitles(movieId, subtitleUrl, tabId, subtitleLangCode) {
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
    const cacheKey = `nst_cache_${movieId}_${subtitleLangCode}_${targetLanguage}`;
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

    notifyStatus(tabId, "loading", { current: 0, total: 0 });

    // 자막 파일 다운로드
    console.log("[NST] 자막 파일 다운로드 시작...");
    console.log("[NST] 자막 URL 호스트:", getUrlHost(subtitleUrl));
    const vttText = await fetchSubtitleText(subtitleUrl);
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
    const total = entries.length;
    const initialSubtitles = cacheData?.subtitles
      ? new Map(Object.entries(cacheData.subtitles))
      : new Map();

    if (initialSubtitles.size > 0) {
      console.log("[NST] 부분 캐시 이어받기:", initialSubtitles.size + "개");
      sendToTab(tabId, Object.fromEntries(initialSubtitles));
    }

    tabTranslations.set(tabId, {
      subtitles: initialSubtitles,
      cancelled: false
    });

    const tabData = tabTranslations.get(tabId);

    notifyStatus(tabId, "loading", { current: initialSubtitles.size, total });

    const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

    const jobs = [];

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries
        .slice(i, i + BATCH_SIZE)
        .filter(text => !tabData.subtitles.has(text));

      if (batch.length === 0) {
        notifyStatus(tabId, "loading", { current: countTranslatedEntries(entries, tabData.subtitles), total });
        continue;
      }

      jobs.push({
        number: Math.floor(i / BATCH_SIZE) + 1,
        batch,
        contextBefore: entries.slice(Math.max(0, i - CONTEXT_SIZE), i)
      });
    }

    let nextJobIndex = 0;
    let failedError = null;

    async function runTranslationWorker(workerId) {
      while (!failedError && nextJobIndex < jobs.length) {
        if (tabData.cancelled) {
          console.log("[NST] 번역 취소됨");
          await saveTranslationCache(cacheKey, tabData.subtitles, entries, false);
          return;
        }

        const job = jobs[nextJobIndex++];
        console.log(`[NST] 워커 ${workerId} 배치 ${job.number}: ${job.batch.length}개`);

        try {
          const translatedBatch = await translateBatchReliable(apiKey, targetLang, job.batch, job.contextBefore);

          for (const [original, translated] of translatedBatch) {
            tabData.subtitles.set(original, translated);
          }

          // 진행 상황 업데이트
          const current = countTranslatedEntries(entries, tabData.subtitles);
          notifyStatus(tabId, "loading", { current, total });
          console.log(`[NST] 진행: ${current}/${total}`);

          // contentScript에 전송
          sendToTab(tabId, Object.fromEntries(tabData.subtitles));

          // 중간 저장: service worker가 꺼지거나 새로고침돼도 이어받기
          await saveTranslationCache(cacheKey, tabData.subtitles, entries, false);

          await sleep(BATCH_DELAY);
        } catch (err) {
          failedError = err;
          console.error("[NST] 배치 최종 실패:", err);
          await saveTranslationCache(cacheKey, tabData.subtitles, entries, false);
          notifyStatus(tabId, "error");
          return;
        }
      }
    }

    const workerCount = Math.min(BATCH_CONCURRENCY, jobs.length);
    if (workerCount > 0) {
      console.log(`[NST] 병렬 번역 시작: ${jobs.length}개 배치, 워커 ${workerCount}개`);
      await Promise.all(
        Array.from({ length: workerCount }, (_unused, index) => runTranslationWorker(index + 1))
      );
    }

    if (failedError) {
      return;
    }

    // 완료
    console.log("[NST] 번역 완료:", tabData.subtitles.size + "개");

    const translatedCount = countTranslatedEntries(entries, tabData.subtitles);

    if (translatedCount === total) {
      // 캐시 저장
      await saveTranslationCache(cacheKey, tabData.subtitles, entries, true);
      console.log("[NST] 캐시 저장 완료");

      notifyStatus(tabId, "ready", null, translatedCount);
    } else {
      console.error(`[NST] 번역 미완료: ${translatedCount}/${total}`);
      await saveTranslationCache(cacheKey, tabData.subtitles, entries, false);
      notifyStatus(tabId, "error");
    }

  } catch (err) {
    console.error("[NST] 처리 오류:", err);
    console.error("[NST] 실패한 자막 URL:", subtitleUrl);
    notifyStatus(tabId, "error");
  }
}

// ============================================
// 안정 번역 엔진
// ============================================
async function translateBatchReliable(apiKey, targetLang, batch, contextBefore, depth = 0) {
  const translated = new Map();
  let pending = [...batch];
  const maxRetries = pending.length === 1 ? MAX_SINGLE_RETRIES : MAX_BATCH_RETRIES;

  for (let attempt = 1; attempt <= maxRetries && pending.length > 0; attempt++) {
    try {
      console.log(`[NST] 번역 시도: ${pending.length}개, attempt ${attempt}/${maxRetries}, depth ${depth}`);
      const result = await translateBatchOnce(apiKey, targetLang, pending, contextBefore);

      for (const [original, text] of result) {
        if (text) translated.set(original, text);
      }

      pending = pending.filter(text => !translated.has(text));
      if (pending.length === 0) {
        return translated;
      }

      console.warn(`[NST] 응답 누락 ${pending.length}개, 누락분 재시도`);
    } catch (err) {
      console.warn(`[NST] 번역 시도 실패 (${attempt}/${maxRetries}):`, err);
    }

    await sleep(getRetryDelay(attempt, pending.length));
  }

  if (pending.length === 0) {
    return translated;
  }

  if (pending.length > 1) {
    console.warn(`[NST] 배치 분할 재시도: ${pending.length}개`);
    const mid = Math.ceil(pending.length / 2);
    const first = await translateBatchReliable(apiKey, targetLang, pending.slice(0, mid), contextBefore, depth + 1);
    const second = await translateBatchReliable(apiKey, targetLang, pending.slice(mid), contextBefore, depth + 1);

    for (const [original, text] of first) translated.set(original, text);
    for (const [original, text] of second) translated.set(original, text);
    return translated;
  }

  throw new Error(`단일 자막 번역 실패: "${pending[0]?.substring(0, 80)}"`);
}

async function translateBatchOnce(apiKey, targetLang, batch, contextBefore) {
  const prompt = buildTranslationPrompt(targetLang, batch, contextBefore);
  const models = await getGeminiModelCandidates(apiKey);
  let lastError = null;

  for (const model of models) {
    try {
      const apiResponse = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 8192
            }
          })
        },
        API_TIMEOUT
      );

      console.log("[NST] API 응답:", apiResponse.status, "model:", model);

      if (!apiResponse.ok) {
        const body = await apiResponse.text().catch(() => "");
        const error = new Error(`Gemini API 오류: ${apiResponse.status} model=${model} ${body.substring(0, 300)}`);

        if (apiResponse.status === 404) {
          console.warn("[NST] Gemini 모델 사용 불가, 다음 모델 시도:", model);
          lastError = error;
          continue;
        }

        throw error;
      }

      const data = await apiResponse.json();
      const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const finishReason = data.candidates?.[0]?.finishReason;

      if (!resultText.trim()) {
        throw new Error(`Gemini 응답 비어 있음: model=${model}, finishReason=${finishReason || "unknown"}`);
      }

      console.log("[NST] API 결과:", resultText.substring(0, 200));
      return parseTranslationResult(resultText, batch);
    } catch (err) {
      lastError = err;
      if (!isModelNotFoundError(err)) {
        throw err;
      }
    }
  }

  throw lastError || new Error("사용 가능한 Gemini generateContent 모델을 찾지 못했습니다.");
}

async function fetchSubtitleText(subtitleUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetchWithTimeout(subtitleUrl, {}, API_TIMEOUT);
      console.log("[NST] 자막 fetch 응답:", response.status, `attempt ${attempt}/4`);

      if (!response.ok) {
        throw new Error(`자막 파일 fetch 실패: ${response.status} (${getUrlHost(subtitleUrl)})`);
      }

      return await response.text();
    } catch (err) {
      lastError = err;
      console.warn(`[NST] 자막 fetch 재시도 (${attempt}/4):`, err);
      await sleep(getRetryDelay(attempt, 1));
    }
  }

  throw lastError || new Error("자막 파일 fetch 실패");
}

async function getGeminiModelCandidates(apiKey) {
  const cacheKey = apiKey.slice(-8);
  const cached = geminiModelCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) {
    return cached.models;
  }

  try {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {},
      API_TIMEOUT
    );

    if (!response.ok) {
      throw new Error(`Gemini 모델 목록 조회 실패: ${response.status}`);
    }

    const data = await response.json();
    const available = (data.models || [])
      .filter(model => {
        const methods = model.supportedGenerationMethods || model.supportedActions || [];
        return methods.includes("generateContent");
      })
      .map(model => (model.name || "").replace(/^models\//, ""))
      .filter(Boolean);

    const preferred = GEMINI_MODEL_CANDIDATES.filter(model => available.includes(model));
    const fallback = available.filter(model => !preferred.includes(model));
    const models = [...preferred, ...fallback];

    if (models.length > 0) {
      console.log("[NST] 사용 가능한 Gemini 모델:", models.slice(0, 5).join(", "));
      geminiModelCache.set(cacheKey, { models, timestamp: Date.now() });
      return models;
    }
  } catch (err) {
    console.warn("[NST] Gemini 모델 목록 조회 실패, 기본 후보 사용:", err);
  }

  geminiModelCache.set(cacheKey, {
    models: GEMINI_MODEL_CANDIDATES,
    timestamp: Date.now()
  });
  return GEMINI_MODEL_CANDIDATES;
}

function buildTranslationPrompt(targetLang, batch, contextBefore) {
  const promptLines = [];

  if (contextBefore.length > 0) {
    promptLines.push("[CONTEXT BEFORE]");
    contextBefore.forEach(t => promptLines.push(`- "${t}"`));
    promptLines.push("");
  }

  promptLines.push("[TRANSLATE THESE]");
  batch.forEach((t, idx) => promptLines.push(`${idx + 1}. "${t}"`));

  return `You are a professional subtitle translator. Detect the source language automatically and translate these subtitles to ${targetLang}.

IMPORTANT RULES:
- Output ONLY the translated text in ${targetLang}
- Do NOT include romanization, transliteration, or pronunciation guides
- Do NOT include the original text
- Do NOT add explanations or notes
- Keep exactly the same number of lines as the input
- Keep the same numbered format (1. 2. 3. etc.)
- If a line is ambiguous, translate it using the surrounding context
- Preserve the natural conversational tone

${promptLines.join("\n")}

Output format example:
1. [translated text only]
2. [translated text only]`;
}

function parseTranslationResult(resultText, batch) {
  const result = new Map();
  const lines = resultText
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("```"));

  for (const line of lines) {
    const match = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (!match) continue;

    const index = Number(match[1]) - 1;
    if (index < 0 || index >= batch.length) continue;

    const translated = cleanTranslatedText(match[2]);
    if (translated) {
      result.set(batch[index], translated);
    }
  }

  // 폴백: 모델이 번호 일부를 빼먹고 줄 순서만 맞춘 경우
  if (result.size === 0 && lines.length === batch.length) {
    for (let i = 0; i < batch.length; i++) {
      const translated = cleanTranslatedText(lines[i].replace(/^\d+[.)]\s*/, ""));
      if (translated) result.set(batch[i], translated);
    }
  }

  return result;
}

function cleanTranslatedText(text) {
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/^\[(.*)\]$/g, "$1")
    .trim();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function saveTranslationCache(cacheKey, subtitlesMap, entries, completed) {
  await chrome.storage.local.set({
    [cacheKey]: {
      subtitles: Object.fromEntries(subtitlesMap),
      completed,
      current: countTranslatedEntries(entries, subtitlesMap),
      total: entries.length,
      timestamp: Date.now()
    }
  });
}

function countTranslatedEntries(entries, subtitlesMap) {
  return entries.reduce((count, text) => count + (subtitlesMap.has(text) ? 1 : 0), 0);
}

function getRetryDelay(attempt, pendingCount) {
  const jitter = Math.floor(Math.random() * 600);
  const scale = pendingCount === 1 ? 1.4 : 1;
  return Math.min(RETRY_MAX_DELAY, Math.round(RETRY_BASE_DELAY * scale * (2 ** (attempt - 1)))) + jitter;
}

function isModelNotFoundError(err) {
  return String(err?.message || err).includes("Gemini API 오류: 404");
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
  const total = data.total || count;
  const progress = total > 0 ? Math.round((count / total) * 100) : 0;

  return {
    exists: true,
    progress: data.completed ? 100 : progress,
    completed: data.completed === true,
    current: count,
    total
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

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch (_err) {
    return "invalid-url";
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
