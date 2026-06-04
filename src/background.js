// background.js (service worker)
// 단순화된 버전 - 디버깅용

console.log("[NST] ===== 서비스 워커 시작 =====");

const GET_TRANSLATION = "NST_GET_TRANSLATION";
const SUBTITLE_STATUS = "NST_SUBTITLE_STATUS";
const PROCESS_SUBTITLES = "NST_PROCESS_SUBTITLES";
const GET_TRANSLATION_STATUS = "NST_GET_TRANSLATION_STATUS";

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
const FIRST_BATCH_SIZE = 8;
const BATCH_SIZE = 30;  // 속도와 응답 안정성의 균형점
const BATCH_CONCURRENCY = 1;
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
const activeKeepAliveTimers = new Map();
const translationJobs = new Map();

// ============================================
// 메시지 핸들러
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  console.log("[NST] 메시지 수신:", message?.type, "tabId:", tabId);

  // 자막 처리 요청
  if (message?.type === PROCESS_SUBTITLES) {
    const { movieId, subtitleUrl, langCode, subtitles } = message;
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
    processSubtitlesWithKeepAlive(movieId, subtitleUrl, tabId, langCode, subtitles || []);
    sendResponse({ ok: true });
    return true;
  }

  // 번역 조회
  if (message?.type === GET_TRANSLATION) {
    const { text } = message;
    const tabData = tabTranslations.get(tabId);

    if (tabData && tabData.subtitles.has(text)) {
      sendResponse({ translated: tabData.subtitles.get(text) });
    } else if (tabData) {
      const translated = findNormalizedTranslation(tabData.subtitles, text);
      sendResponse({ translated });
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

  if (message?.type === GET_TRANSLATION_STATUS) {
    const { movieId, langCode } = message;
    const jobKey = getJobKey(tabId, movieId, langCode);
    sendResponse(translationJobs.get(jobKey) || { status: "idle" });
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
async function processSubtitlesWithKeepAlive(movieId, subtitleUrl, tabId, subtitleLangCode, availableSubtitles = []) {
  const jobKey = getJobKey(tabId, movieId, subtitleLangCode);

  startKeepAlive(jobKey);

  try {
    await processSubtitles(movieId, subtitleUrl, tabId, subtitleLangCode, availableSubtitles);
  } finally {
    stopKeepAlive(jobKey);
  }
}

async function processSubtitles(movieId, subtitleUrl, tabId, subtitleLangCode, availableSubtitles = []) {
  const jobKey = getJobKey(tabId, movieId, subtitleLangCode);

  try {
    console.log("[NST] processSubtitles 시작");
    updateJobStatus(jobKey, tabId, "starting", { current: 0, total: 1, message: "번역 준비 중" });

    // 설정 로드
    const settings = await chrome.storage.sync.get(["geminiApiKey", "targetLanguage"]);
    const targetLanguage = settings.targetLanguage || "uk";
    const apiKey = settings.geminiApiKey;

    console.log("[NST] targetLanguage:", targetLanguage);
    console.log("[NST] API 키 존재:", !!apiKey);

    // 캐시 확인
    const cacheKey = `nst_cache_${movieId}_${subtitleLangCode}_${targetLanguage}`;
    const cached = await chrome.storage.local.get(cacheKey);
    const cacheData = cached[cacheKey];

    if (cacheData && cacheData.subtitles && Object.keys(cacheData.subtitles).length > 0 && cacheData.completed) {
      console.log("[NST] 캐시 히트!", Object.keys(cacheData.subtitles).length + "개");

      const subtitlesMap = new Map(Object.entries(cacheData.subtitles));
      tabTranslations.set(tabId, { subtitles: subtitlesMap, cancelled: false });

      sendToTab(tabId, cacheData.subtitles);
      updateJobStatus(jobKey, tabId, "ready", { current: subtitlesMap.size, total: subtitlesMap.size, message: "캐시 로드 완료" });
      notifyStatus(tabId, "ready", null, subtitlesMap.size);
      return;
    }

    updateJobStatus(jobKey, tabId, "fetching", { current: 0, total: 1, message: "자막 파일 다운로드 중" });
    notifyStatus(tabId, "loading", { current: 0, total: 1 });

    // 자막 파일 다운로드
    console.log("[NST] 자막 파일 다운로드 시작...");
    console.log("[NST] 자막 URL 호스트:", getUrlHost(subtitleUrl));
    const vttText = await fetchSubtitleText(subtitleUrl);
    console.log("[NST] 자막 파일 크기:", vttText.length);
    console.log("[NST] 자막 시작 부분:", vttText.substring(0, 300));

    // WebVTT 파싱
    updateJobStatus(jobKey, tabId, "parsing", { current: 0, total: 1, message: "자막 파싱 중" });
    const entries = parseWebVTT(vttText);
    console.log("[NST] 파싱된 자막 수:", entries.length);

    if (entries.length === 0) {
      console.error("[NST] 자막 파싱 실패!");
      updateJobStatus(jobKey, tabId, "error", { error: "자막 파싱 실패" });
      return;
    }

    console.log("[NST] 첫 5개 자막:", entries.slice(0, 5));

    // 번역 시작
    const total = entries.length;

    if (subtitleLangCode === targetLanguage) {
      console.log("[NST] 선택한 자막이 대상 언어와 같음. 원문 그대로 표시합니다.");
      const identityMap = new Map(entries.map(text => [text, text]));

      tabTranslations.set(tabId, {
        subtitles: identityMap,
        cancelled: false
      });

      sendToTab(tabId, Object.fromEntries(identityMap));
      await saveTranslationCache(cacheKey, identityMap, entries, true);
      updateJobStatus(jobKey, tabId, "ready", { current: identityMap.size, total: identityMap.size, message: "원문 표시 완료" });
      notifyStatus(tabId, "ready", null, identityMap.size);
      return;
    }

    const targetSubtitle = findTargetSubtitleTrack(availableSubtitles, targetLanguage, subtitleLangCode);
    if (targetSubtitle) {
      updateJobStatus(jobKey, tabId, "fetching", {
        current: 0,
        total: 1,
        message: `기존 ${LANGUAGE_NAMES[targetLanguage] || targetLanguage} 자막 불러오는 중`
      });
      console.log("[NST] 대상 언어 자막 발견, Gemini 없이 이중자막 사용:", targetSubtitle.langName);

      const targetVttText = await fetchSubtitleText(targetSubtitle.url);
      const dualSubtitleMap = buildExistingSubtitleMap(vttText, targetVttText);

      if (dualSubtitleMap.size > 0) {
        tabTranslations.set(tabId, {
          subtitles: dualSubtitleMap,
          cancelled: false
        });

        sendToTab(tabId, Object.fromEntries(dualSubtitleMap));
        await saveTranslationCache(cacheKey, dualSubtitleMap, entries, true);
        updateJobStatus(jobKey, tabId, "ready", {
          current: dualSubtitleMap.size,
          total: entries.length,
          message: "기존 대상 언어 자막 표시 완료"
        });
        return;
      }

      console.warn("[NST] 대상 언어 자막 매칭 실패, Gemini 번역으로 전환");
    }

    if (!apiKey) {
      console.error("[NST] API 키 없음!");
      updateJobStatus(jobKey, tabId, "error", {
        error: "대상 언어 자막 매칭에 실패했고, Gemini API 키도 설정되지 않았습니다."
      });
      return;
    }

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

    updateJobStatus(jobKey, tabId, "translating", {
      current: initialSubtitles.size,
      total,
      message: "번역 중"
    });
    notifyStatus(tabId, "loading", { current: initialSubtitles.size, total });

    const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

    const jobs = buildTranslationJobs(entries, tabData.subtitles);

    if (jobs.length === 0) {
      notifyStatus(tabId, "loading", { current: countTranslatedEntries(entries, tabData.subtitles), total });
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
          updateJobStatus(jobKey, tabId, "translating", {
            current: countTranslatedEntries(entries, tabData.subtitles),
            total,
            message: `Gemini 호출 중: 배치 ${job.number}/${jobs.length} (${job.batch.length}줄)`
          });

          const translatedBatch = await translateBatchReliable(
            apiKey,
            targetLang,
            job.batch,
            job.contextBefore,
            (message) => {
              updateJobStatus(jobKey, tabId, "translating", {
                current: countTranslatedEntries(entries, tabData.subtitles),
                total,
                message: `배치 ${job.number}/${jobs.length}: ${message}`
              });
            }
          );

          for (const [original, translated] of translatedBatch) {
            tabData.subtitles.set(original, translated);
          }

          // 진행 상황 업데이트
          const current = countTranslatedEntries(entries, tabData.subtitles);
          updateJobStatus(jobKey, tabId, "translating", {
            current,
            total,
            message: `번역 중 (${current}/${total})`
          });
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
          updateJobStatus(jobKey, tabId, "error", { error: getErrorMessage(err) });
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

      updateJobStatus(jobKey, tabId, "ready", { current: translatedCount, total, message: "번역 완료" });
      notifyStatus(tabId, "ready", null, translatedCount);
    } else {
      console.error(`[NST] 번역 미완료: ${translatedCount}/${total}`);
      await saveTranslationCache(cacheKey, tabData.subtitles, entries, false);
      updateJobStatus(jobKey, tabId, "error", { error: `번역 미완료: ${translatedCount}/${total}` });
    }

  } catch (err) {
    console.error("[NST] 처리 오류:", err);
    console.error("[NST] 실패한 자막 URL:", subtitleUrl);
    updateJobStatus(jobKey, tabId, "error", { error: getErrorMessage(err) });
  }
}

// ============================================
// 안정 번역 엔진
// ============================================
function buildTranslationJobs(entries, subtitlesMap) {
  const jobs = [];
  let index = 0;
  let jobNumber = 1;

  while (index < entries.length) {
    const size = jobNumber === 1 ? FIRST_BATCH_SIZE : BATCH_SIZE;
    const batch = entries
      .slice(index, index + size)
      .filter(text => !subtitlesMap.has(text));

    if (batch.length > 0) {
      jobs.push({
        number: jobNumber,
        batch,
        contextBefore: entries.slice(Math.max(0, index - CONTEXT_SIZE), index)
      });
    }

    index += size;
    jobNumber++;
  }

  return jobs;
}

async function translateBatchReliable(apiKey, targetLang, batch, contextBefore, onStatus = null, depth = 0) {
  const translated = new Map();
  let pending = [...batch];
  const maxRetries = pending.length === 1 ? MAX_SINGLE_RETRIES : MAX_BATCH_RETRIES;

  for (let attempt = 1; attempt <= maxRetries && pending.length > 0; attempt++) {
    try {
      console.log(`[NST] 번역 시도: ${pending.length}개, attempt ${attempt}/${maxRetries}, depth ${depth}`);
      onStatus?.(`API 요청 중 (${pending.length}줄, ${attempt}/${maxRetries})`);
      const result = await translateBatchOnce(apiKey, targetLang, pending, contextBefore);

      for (const [original, text] of result) {
        if (text) translated.set(original, text);
      }

      pending = pending.filter(text => !translated.has(text));
      if (pending.length === 0) {
        return translated;
      }

      console.warn(`[NST] 응답 누락 ${pending.length}개, 누락분 재시도`);
      onStatus?.(`응답 누락 ${pending.length}줄 재시도 대기`);
    } catch (err) {
      console.warn(`[NST] 번역 시도 실패 (${attempt}/${maxRetries}):`, err);
      if (isNonRetryableGeminiError(err)) {
        throw err;
      }
      onStatus?.(`API 오류 재시도 대기: ${getErrorMessage(err).slice(0, 120)}`);
    }

    await sleep(getRetryDelay(attempt, pending.length));
  }

  if (pending.length === 0) {
    return translated;
  }

  if (pending.length > 1) {
    console.warn(`[NST] 배치 분할 재시도: ${pending.length}개`);
    onStatus?.(`배치 분할 재시도 (${pending.length}줄)`);
    const mid = Math.ceil(pending.length / 2);
    const first = await translateBatchReliable(apiKey, targetLang, pending.slice(0, mid), contextBefore, onStatus, depth + 1);
    const second = await translateBatchReliable(apiKey, targetLang, pending.slice(mid), contextBefore, onStatus, depth + 1);

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
        const error = createGeminiApiError(apiResponse.status, model, body);

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
  return cleanSubtitleDisplayText(text)
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

function findNormalizedTranslation(subtitlesMap, text) {
  const normalizedText = normalizeSubtitleText(text);

  for (const [original, translated] of subtitlesMap) {
    if (normalizeSubtitleText(original) === normalizedText) {
      return translated;
    }
  }

  return null;
}

function normalizeSubtitleText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/<[^>]*>/g, "")
    .replace(/[“”„«»]/g, "\"")
    .replace(/[‘’‚]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getRetryDelay(attempt, pendingCount) {
  const jitter = Math.floor(Math.random() * 600);
  const scale = pendingCount === 1 ? 1.4 : 1;
  return Math.min(RETRY_MAX_DELAY, Math.round(RETRY_BASE_DELAY * scale * (2 ** (attempt - 1)))) + jitter;
}

function isModelNotFoundError(err) {
  return String(err?.message || err).includes("Gemini API 오류: 404");
}

function createGeminiApiError(status, model, body) {
  const bodyText = String(body || "");

  if (status === 429 && isQuotaOrCreditError(bodyText)) {
    const error = new Error("Gemini API 크레딧 또는 할당량이 부족합니다. Google AI Studio/Cloud에서 결제, 크레딧, 사용량 한도를 확인하세요.");
    error.nonRetryable = true;
    error.status = status;
    error.model = model;
    error.rawBody = bodyText.slice(0, 500);
    return error;
  }

  const error = new Error(`Gemini API 오류: ${status} model=${model} ${bodyText.substring(0, 300)}`);
  error.status = status;
  error.model = model;
  return error;
}

function isQuotaOrCreditError(bodyText) {
  const lower = String(bodyText || "").toLowerCase();
  return (
    lower.includes("prepayment credits") ||
    lower.includes("quota") ||
    lower.includes("billing") ||
    lower.includes("exceeded your current quota")
  );
}

function isNonRetryableGeminiError(err) {
  return err?.nonRetryable === true;
}

function getJobKey(tabId, movieId, langCode) {
  return `${tabId || "unknown"}:${movieId || "unknown"}:${langCode || "unknown"}`;
}

function updateJobStatus(jobKey, tabId, status, data = {}) {
  const nextStatus = {
    status,
    current: data.current ?? null,
    total: data.total ?? null,
    message: data.message || "",
    error: data.error || null,
    updatedAt: Date.now()
  };

  translationJobs.set(jobKey, nextStatus);

  if (status === "loading" || status === "fetching" || status === "parsing" || status === "starting" || status === "translating") {
    notifyStatus(tabId, "loading", {
      current: Number.isFinite(nextStatus.current) ? nextStatus.current : 0,
      total: Number.isFinite(nextStatus.total) ? nextStatus.total : 1
    });
  } else if (status === "error") {
    notifyStatus(tabId, "error", null, null, nextStatus.error);
  } else if (status === "ready") {
    notifyStatus(tabId, "ready", null, nextStatus.current);
  }

  console.log("[NST] 작업 상태:", jobKey, nextStatus);
}

function getErrorMessage(err) {
  return String(err?.message || err || "알 수 없는 오류").slice(0, 500);
}

function startKeepAlive(jobKey) {
  stopKeepAlive(jobKey);

  const timer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {
        if (chrome.runtime.lastError) {
          console.warn("[NST] keep-alive 실패:", chrome.runtime.lastError.message);
        } else {
          console.log("[NST] keep-alive:", jobKey);
        }
      });
    } catch (err) {
      console.warn("[NST] keep-alive 중단:", err);
    }
  }, 15000);

  activeKeepAliveTimers.set(jobKey, timer);
}

function stopKeepAlive(jobKey) {
  const timer = activeKeepAliveTimers.get(jobKey);
  if (!timer) return;

  clearInterval(timer);
  activeKeepAliveTimers.delete(jobKey);
}

function findTargetSubtitleTrack(subtitles, targetLanguage, sourceLanguage) {
  if (!Array.isArray(subtitles) || targetLanguage === sourceLanguage) return null;

  const candidates = subtitles.filter(sub => sub.langCode === targetLanguage && sub.url);
  if (candidates.length === 0) return null;

  return candidates.find(sub => !String(sub.langName || "").includes("(CC)")) || candidates[0];
}

function buildExistingSubtitleMap(sourceVttText, targetVttText) {
  const sourceCues = parseWebVTTCues(sourceVttText);
  const targetCues = parseWebVTTCues(targetVttText);
  const result = new Map();

  if (sourceCues.length === 0 || targetCues.length === 0) {
    return result;
  }

  for (let i = 0; i < sourceCues.length; i++) {
    const sourceCue = sourceCues[i];
    const targetCue = findMatchingCue(sourceCue, targetCues, i);

    if (sourceCue.text && targetCue?.text) {
      result.set(sourceCue.text, targetCue.text);
    }
  }

  console.log(`[NST] 기존 대상 자막 매칭: ${result.size}/${sourceCues.length}`);
  return result;
}

function findMatchingCue(sourceCue, targetCues, index) {
  const midpoint = (sourceCue.start + sourceCue.end) / 2;
  const byTime = targetCues.find(cue => cue.start <= midpoint && midpoint <= cue.end);
  if (byTime) return byTime;

  const byIndex = targetCues[index];
  if (byIndex) return byIndex;

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const cue of targetCues) {
    const targetMidpoint = (cue.start + cue.end) / 2;
    const distance = Math.abs(targetMidpoint - midpoint);
    if (distance < nearestDistance) {
      nearest = cue;
      nearestDistance = distance;
    }
  }

  return nearestDistance <= 2500 ? nearest : null;
}

// ============================================
// WebVTT 파싱
// ============================================
function parseWebVTT(vttText) {
  return [...new Set(parseWebVTTCues(vttText).map(cue => cue.text).filter(Boolean))];
}

function parseWebVTTCues(vttText) {
  const entries = [];
  const lines = vttText.split("\n");
  let buffer = [];
  let currentTiming = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.includes("-->")) {
      flushCue();
      currentTiming = parseTimingLine(trimmed);
      continue;
    }

    // 스킵할 줄들
    if (
      trimmed === "WEBVTT" ||
      trimmed === "" ||
      /^\d+$/.test(trimmed) ||
      trimmed.startsWith("NOTE") ||
      trimmed.startsWith("STYLE")
    ) {
      if (trimmed === "") flushCue();
      continue;
    }

    // HTML 태그 제거
    const cleanText = cleanSubtitleDisplayText(trimmed);

    if (cleanText) {
      buffer.push(cleanText);
    }
  }

  flushCue();
  return entries;

  function flushCue() {
    if (!currentTiming || buffer.length === 0) {
      buffer = [];
      return;
    }

    const text = buffer.join(" ").trim();
    if (text) {
      entries.push({
        start: currentTiming.start,
        end: currentTiming.end,
        text
      });
    }
    buffer = [];
    currentTiming = null;
  }
}

function parseTimingLine(line) {
  const [startPart, rest] = line.split("-->");
  const endPart = rest?.trim().split(/\s+/)[0];

  return {
    start: parseTimestamp(startPart?.trim()),
    end: parseTimestamp(endPart)
  };
}

function parseTimestamp(value) {
  const parts = String(value || "").split(":");
  const secondsPart = parts.pop() || "0";
  const seconds = Number(secondsPart.replace(",", "."));
  const minutes = Number(parts.pop() || "0");
  const hours = Number(parts.pop() || "0");

  return Math.round(((hours * 3600) + (minutes * 60) + seconds) * 1000);
}

function cleanSubtitleDisplayText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lrm;|&#x200e;|&#8206;/gi, "")
    .replace(/&rlm;|&#x200f;|&#8207;/gi, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
function notifyStatus(tabId, status, progress = null, count = null, error = null) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: SUBTITLE_STATUS,
    status,
    progress,
    count,
    error
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
