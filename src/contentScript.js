// contentScript.js
// injector.js 주입 → 자막 URL 수신 → background에 번역 요청 → 오버레이 표시

if (window.__NST_CONTENT_SCRIPT_INSTALLED) {
  console.log("[NST] Content script 이미 설치됨");
} else {
  window.__NST_CONTENT_SCRIPT_INSTALLED = true;

const GET_TRANSLATION = "NST_GET_TRANSLATION";
const SUBTITLE_STATUS = "NST_SUBTITLE_STATUS";
const PROCESS_SUBTITLES = "NST_PROCESS_SUBTITLES";
const GET_AVAILABLE_SUBTITLES = "NST_GET_AVAILABLE_SUBTITLES";
const START_TRANSLATION = "NST_START_TRANSLATION";
const GET_TRANSLATION_STATUS = "NST_GET_TRANSLATION_STATUS";

let overlayRoot = null;
let overlayContainer = null;
let statusIndicator = null;
let isEnabled = true;
let lastSubtitleText = "";

// 상태
let preTranslationStatus = "idle";
let preTranslationProgress = { current: 0, total: 0 };
let preTranslationError = "";

// 발견된 자막 저장 (자동 번역 안함)
let availableSubtitles = [];
let currentMovieId = null;
let currentWatchId = getWatchIdFromUrl();
let resetTimer = null;
let activeTranslationLangCode = null;
let statusPollTimer = null;

// 번역 데이터 로컬 저장 (service worker 종료 대비)
let localTranslations = new Map();
let localNormalizedTranslations = new Map();

// 리셋 후 상태 업데이트 무시 플래그
let ignoreStatusUpdates = false;

// 즉시 injector 주입 (document_start에서 실행되므로)
injectScript();
init();

// ============================================
// Injector 스크립트 주입
// ============================================
function injectScript() {
  try {
    if (!isExtensionContextReady()) return;

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/injector.js");
    script.onload = function() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
    console.log("[NST] Injector 주입 완료");
  } catch (err) {
    console.warn("[NST] Injector 주입 실패:", err);
  }
}

function init() {
  loadSettings();

  // DOM 준비 후 오버레이 설정
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupOverlay();
      observeSubtitles();
      observeNetflixNavigation();
    });
  } else {
    setupOverlay();
    observeSubtitles();
    observeNetflixNavigation();
  }

  // injector에서 자막 발견 이벤트 수신 (추출만, 번역은 팝업에서 선택)
  window.addEventListener("NST_SUBTITLES_FOUND", (event) => {
    const { movieId, subtitles } = event.detail;
    console.log("[NST] 자막 발견 이벤트 수신:", movieId, subtitles.length + "개");

    // 영상 변경 감지
    if (currentMovieId && currentMovieId !== movieId) {
      console.log("[NST] 영상 변경 감지:", currentMovieId, "→", movieId);

      resetTranslationState(movieId, 1200);
    }

    // 자막 정보 저장 (번역은 하지 않음)
    currentMovieId = movieId;
    availableSubtitles = subtitles;

    // 한국어 자막이 있는지 확인만
    const koreanSubtitle = subtitles.find(s => s.langCode === "ko");
    if (koreanSubtitle) {
      console.log("[NST] 한국어 자막 발견:", koreanSubtitle.langName);
    }

    console.log("[NST] 자막 추출 완료, 팝업에서 번역 시작 대기 중...");
  });

  window.addEventListener("NST_LOCATION_CHANGED", (event) => {
    const nextWatchId = event.detail?.watchId || getWatchIdFromUrl();
    handleWatchNavigation(nextWatchId, "injector");
  });

  // 메시지 리스너
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === SUBTITLE_STATUS) {
      // 리셋 후 상태 업데이트 무시 (번역 데이터는 계속 받음)
      if (ignoreStatusUpdates) {
        console.log("[NST] 상태 업데이트 무시 (리셋 중)");
        sendResponse?.({ ok: true });
        return true;
      }
      preTranslationStatus = message.status;
      if (message.progress) preTranslationProgress = message.progress;
      if (message.error) preTranslationError = message.error;
      updateStatusIndicator(message.error || "");
      if (message.status === "ready" || message.status === "error") {
        stopTranslationStatusPolling();
      }
      sendResponse?.({ ok: true });
      return true;
    }

    // background에서 번역 데이터 수신 (로컬에 저장) - ignoreStatusUpdates 무관하게 항상 받음
    if (message?.type === "NST_TRANSLATIONS_DATA") {
      const { translations } = message;
      if (translations && typeof translations === "object") {
        // 리셋 중이 아닐 때만 저장
        if (!ignoreStatusUpdates) {
          localTranslations = new Map(Object.entries(translations));
          localNormalizedTranslations = buildNormalizedTranslationMap(localTranslations);
          console.log("[NST] 번역 데이터 로컬 저장:", localTranslations.size + "개");
        } else {
          console.log("[NST] 번역 데이터 무시 (리셋 중)");
        }
      }
      sendResponse?.({ ok: true });
      return true;
    }

    if (message?.type === "NST_SETTINGS_UPDATED") {
      if (typeof message.isEnabled === "boolean") {
        isEnabled = message.isEnabled;
        if (!isEnabled) hideOverlay();
      }
      sendResponse?.({ ok: true });
      return true;
    }

    // 강제 리셋 요청 (팝업에서 "번역 중지 & 재인식" 클릭)
    if (message?.type === "NST_FORCE_RESET") {
      console.log("[NST] 강제 리셋 요청");

      // 상태 업데이트 무시 시작
      ignoreStatusUpdates = true;

      // background에 취소 요청
      safeRuntimeSendMessage({
        type: "NST_CANCEL_TRANSLATION",
        movieId: "FORCE_RESET"
      });

      // 로컬 상태 완전 초기화
      clearLocalTranslationState(true);

      // 3초 후 상태 업데이트 다시 허용
      setTimeout(() => {
        ignoreStatusUpdates = false;
        console.log("[NST] 강제 리셋 완료");
      }, 3000);

      sendResponse?.({ ok: true });
      return true;
    }

    // 팝업에서 사용 가능한 자막 요청
    if (message?.type === GET_AVAILABLE_SUBTITLES) {
      sendResponse({
        movieId: currentMovieId,
        subtitles: availableSubtitles,
        status: preTranslationStatus,
        progress: preTranslationProgress,
        error: preTranslationError
      });
      return true;
    }

    // 팝업에서 번역 시작 요청
    if (message?.type === START_TRANSLATION) {
      const { langCode } = message;
      console.log("[NST] 번역 시작 요청:", langCode);
      console.log("[NST] availableSubtitles:", availableSubtitles.length + "개");

      const subtitle = availableSubtitles.find(s => s.langCode === langCode);

      if (subtitle && currentMovieId) {
        // 리셋 플래그 해제 (새 번역 시작)
        ignoreStatusUpdates = false;

        console.log("[NST] 번역 시작:", subtitle.langName);
        console.log("[NST] subtitleUrl:", subtitle.url?.substring(0, 100));
        console.log("[NST] movieId:", currentMovieId);

        preTranslationStatus = "loading";
        preTranslationProgress = { current: 0, total: 0 };
        preTranslationError = "";
        activeTranslationLangCode = subtitle.langCode;
        updateStatusIndicator();
        startTranslationStatusPolling();

        safeRuntimeSendMessage({
          type: PROCESS_SUBTITLES,
          movieId: currentMovieId,
          subtitleUrl: subtitle.url,
          langCode: subtitle.langCode,
          subtitles: availableSubtitles
        }, (response) => {
          console.log("[NST] background 번역 시작 응답:", response);
          if (response && response.ok === false) {
            preTranslationStatus = "error";
            updateStatusIndicator();
            stopTranslationStatusPolling();
          }
        });
        sendResponse({ ok: true });
      } else {
        console.log("[NST] 자막 찾기 실패 - subtitle:", !!subtitle, "movieId:", currentMovieId);
        sendResponse({ ok: false, error: "자막을 찾을 수 없습니다" });
      }
      return true;
    }

    return true;
  });
}

function loadSettings() {
  try {
    chrome.storage.sync.get(["nstEnabled"], (result) => {
      if (typeof result.nstEnabled === "boolean") {
        isEnabled = result.nstEnabled;
      }
    });
  } catch (err) {
    console.warn("[NST] 설정 로드 실패:", err);
  }
}

// ============================================
// Netflix SPA 영상 전환 감지
// ============================================
function observeNetflixNavigation() {
  window.addEventListener("popstate", () => {
    handleWatchNavigation(getWatchIdFromUrl(), "popstate");
  });

  setInterval(() => {
    handleWatchNavigation(getWatchIdFromUrl(), "poll");
  }, 1000);
}

function handleWatchNavigation(nextWatchId, reason) {
  if (!nextWatchId || nextWatchId === currentWatchId) return;

  console.log("[NST] Netflix 영상 URL 변경 감지:", currentWatchId, "→", nextWatchId, reason);
  currentWatchId = nextWatchId;
  resetTranslationState(nextWatchId, 1200);
}

function resetTranslationState(nextMovieId, ignoreMs) {
  ignoreStatusUpdates = true;

  safeRuntimeSendMessage({
    type: "NST_CANCEL_TRANSLATION",
    movieId: nextMovieId
  });

  clearLocalTranslationState(true);

  if (resetTimer) {
    clearTimeout(resetTimer);
  }

  resetTimer = setTimeout(() => {
    ignoreStatusUpdates = false;
    resetTimer = null;
    console.log("[NST] 영상 전환 리셋 완료");
  }, ignoreMs);
}

function clearLocalTranslationState(clearMovieId) {
  localTranslations.clear();
  localNormalizedTranslations.clear();
  availableSubtitles = [];
  if (clearMovieId) currentMovieId = null;
  activeTranslationLangCode = null;
  stopTranslationStatusPolling();
  lastSubtitleText = "";
  preTranslationStatus = "idle";
  preTranslationProgress = { current: 0, total: 0 };
  preTranslationError = "";
  hideOverlay();
  hideStatusIndicator();
}

function getWatchIdFromUrl() {
  const match = location.pathname.match(/\/watch\/(\d+)/);
  return match?.[1] || null;
}

function startTranslationStatusPolling() {
  stopTranslationStatusPolling();

  statusPollTimer = setInterval(() => {
    if (!currentMovieId || !activeTranslationLangCode || preTranslationStatus !== "loading") {
      stopTranslationStatusPolling();
      return;
    }

    safeRuntimeSendMessage({
      type: GET_TRANSLATION_STATUS,
      movieId: currentMovieId,
      langCode: activeTranslationLangCode
    }, (status) => {
      if (!status || status.status === "idle") return;

      console.log("[NST] background 작업 상태:", JSON.stringify(status));

      if (status.status === "error") {
        preTranslationStatus = "error";
        preTranslationError = status.error || "번역 실패";
        updateStatusIndicator(status.error || "번역 실패");
        stopTranslationStatusPolling();
        return;
      }

      if (status.status === "ready") {
        preTranslationStatus = "ready";
        updateStatusIndicator();
        stopTranslationStatusPolling();
        return;
      }

      preTranslationStatus = "loading";
      if (Number.isFinite(status.current) && Number.isFinite(status.total)) {
        preTranslationProgress = {
          current: status.current,
          total: status.total
        };
      }
      updateStatusIndicator(status.message);
    });
  }, 1500);
}

function stopTranslationStatusPolling() {
  if (!statusPollTimer) return;
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

// ============================================
// 오버레이 설정 (Shadow DOM)
// ============================================
function setupOverlay() {
  if (overlayRoot) return;

  const host = document.createElement("div");
  host.id = "nst-overlay-host";
  host.style.cssText = `
    position: fixed;
    left: 0;
    right: 0;
    top: 5%;
    z-index: 999999;
    pointer-events: none;
    display: flex;
    justify-content: center;
  `;

  overlayRoot = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .nst-container {
      max-width: 85%;
      text-align: center;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.8);
      font-family: system-ui, -apple-system, sans-serif;
      padding: 12px 20px;
    }
    .nst-text {
      color: #ffd54f;
      font-size: 2.5rem;
      font-weight: 700;
      line-height: 1.4;
    }
    .nst-hidden {
      display: none;
    }
    .nst-status {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 8px 12px;
      background: rgba(0,0,0,0.85);
      border-radius: 6px;
      font-size: 0.85rem;
      color: #ffd54f;
    }
    .nst-status.ready {
      color: #4caf50;
    }
    .nst-status.error {
      color: #ff6b6b;
    }
  `;
  overlayRoot.appendChild(style);

  overlayContainer = document.createElement("div");
  overlayContainer.className = "nst-container nst-hidden";
  overlayRoot.appendChild(overlayContainer);

  statusIndicator = document.createElement("div");
  statusIndicator.className = "nst-status nst-hidden";
  overlayRoot.appendChild(statusIndicator);

  document.documentElement.appendChild(host);
}

// ============================================
// 상태 표시기 업데이트
// ============================================
function updateStatusIndicator(customMessage = "") {
  if (!statusIndicator) return;

  // 리셋 중이면 무조건 숨김
  if (ignoreStatusUpdates) {
    statusIndicator.className = "nst-status nst-hidden";
    return;
  }

  if (preTranslationStatus === "loading") {
    if (preTranslationProgress.total <= 1) {
      statusIndicator.textContent = customMessage || "자막 가져오는 중...";
      statusIndicator.className = "nst-status";
      return;
    }

    const percent = preTranslationProgress.total > 0
      ? Math.round((preTranslationProgress.current / preTranslationProgress.total) * 100)
      : 0;
    statusIndicator.textContent = customMessage || `번역 준비 중... ${percent}%`;
    statusIndicator.className = "nst-status";
  } else if (preTranslationStatus === "ready") {
    statusIndicator.textContent = "번역 준비 완료 ✓";
    statusIndicator.className = "nst-status ready";
    setTimeout(() => {
      if (preTranslationStatus === "ready") {
        statusIndicator.className = "nst-status nst-hidden";
      }
    }, 3000);
  } else if (preTranslationStatus === "error") {
    statusIndicator.textContent = customMessage || "번역 준비 실패";
    statusIndicator.className = "nst-status error";
  } else {
    statusIndicator.className = "nst-status nst-hidden";
  }
}

// 상태 표시기 강제 숨김
function hideStatusIndicator() {
  if (statusIndicator) {
    statusIndicator.className = "nst-status nst-hidden";
  }
}

// ============================================
// 오버레이 표시/숨김
// ============================================
function showOverlay(text) {
  if (!overlayContainer || !isEnabled) return;

  overlayContainer.innerHTML = "";
  overlayContainer.className = "nst-container";

  const textEl = document.createElement("div");
  textEl.className = "nst-text";
  textEl.textContent = cleanSubtitleDisplayText(text);
  overlayContainer.appendChild(textEl);
}

function hideOverlay() {
  if (overlayContainer) {
    overlayContainer.className = "nst-container nst-hidden";
  }
}

// ============================================
// Netflix 자막 DOM 감지
// ============================================
function observeSubtitles() {
  const observer = new MutationObserver(() => {
    handleSubtitleChange();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function handleSubtitleChange() {
  const currentText = readNetflixSubtitle();

  if (!currentText) {
    if (lastSubtitleText) {
      lastSubtitleText = "";
      hideOverlay();
    }
    return;
  }

  if (currentText === lastSubtitleText) return;

  lastSubtitleText = currentText;
  requestTranslation(currentText);
}

function readNetflixSubtitle() {
  const selectors = [
    ".player-timedtext-text-container span",
    ".player-timedtext span"
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (!elements.length) continue;

    const textParts = [];
    const seen = new Set();

    for (const el of elements) {
      if (el.children.length > 0 && el.querySelector("span")) continue;

      const text = (el.textContent || "").trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        textParts.push(text);
      }
    }

    const result = textParts.join(" ").trim();
    if (result) return result;
  }

  return "";
}

// ============================================
// 번역 요청 (로컬 우선, 없으면 background 조회)
// ============================================
function requestTranslation(text) {
  // 오버레이 비활성화 확인
  if (!isEnabled) {
    return;
  }

  // 로컬에서 먼저 조회 (service worker 종료 대비)
  if (localTranslations.has(text)) {
    const translated = localTranslations.get(text);
    console.log("[NST] 로컬 번역 발견:", text.substring(0, 20), "→", translated.substring(0, 20));
    showOverlay(translated);
    return;
  }

  const normalizedText = normalizeSubtitleText(text);
  if (localNormalizedTranslations.has(normalizedText)) {
    const translated = localNormalizedTranslations.get(normalizedText);
    console.log("[NST] 정규화 번역 발견:", text.substring(0, 20), "→", translated.substring(0, 20));
    showOverlay(translated);
    return;
  }

  // 로컬에 없으면 background에 요청 (service worker가 살아있을 때)
  safeRuntimeSendMessage({ type: GET_TRANSLATION, text }, (response) => {
    if (response?.translated) {
      // 로컬에도 저장
      localTranslations.set(text, response.translated);
      localNormalizedTranslations.set(normalizeSubtitleText(text), response.translated);
      console.log("[NST] background 번역 수신:", text.substring(0, 20), "→", response.translated.substring(0, 20));
      showOverlay(response.translated);
    } else {
      // 번역 없음 - 오버레이 숨기지 않음 (번역 중일 수 있음)
      if (preTranslationStatus !== "loading") {
        console.log("[NST] 번역 없음 (아직 번역 안됨):", text.substring(0, 20));
      }
    }
  });
}

function buildNormalizedTranslationMap(translations) {
  const normalized = new Map();

  for (const [original, translated] of translations) {
    normalized.set(normalizeSubtitleText(original), translated);
  }

  return normalized;
}

function normalizeSubtitleText(text) {
  return cleanSubtitleDisplayText(text)
    .normalize("NFKC")
    .replace(/<[^>]*>/g, "")
    .replace(/[“”„«»]/g, "\"")
    .replace(/[‘’‚]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function safeRuntimeSendMessage(message, callback = null) {
  try {
    if (!isExtensionContextReady()) {
      console.warn("[NST] 확장 컨텍스트가 무효화됨. Netflix 탭을 새로고침하세요.");
      return Promise.resolve(null);
    }

    if (callback) {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[NST] runtime 메시지 실패:", chrome.runtime.lastError.message);
          callback(null);
          return;
        }

        callback(response);
      });
      return Promise.resolve(null);
    }

    return chrome.runtime.sendMessage(message).catch((err) => {
      console.warn("[NST] runtime 메시지 실패:", err);
      return null;
    });
  } catch (err) {
    console.warn("[NST] runtime 메시지 전송 중단:", err);
    return Promise.resolve(null);
  }
}

function isExtensionContextReady() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

}
