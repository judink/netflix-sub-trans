// contentScript.js
// injector.js 주입 → 자막 URL 수신 → background에 번역 요청 → 오버레이 표시

const GET_TRANSLATION = "NST_GET_TRANSLATION";
const SUBTITLE_STATUS = "NST_SUBTITLE_STATUS";
const PROCESS_SUBTITLES = "NST_PROCESS_SUBTITLES";
const GET_AVAILABLE_SUBTITLES = "NST_GET_AVAILABLE_SUBTITLES";
const START_TRANSLATION = "NST_START_TRANSLATION";

let overlayRoot = null;
let overlayContainer = null;
let statusIndicator = null;
let isEnabled = true;
let lastSubtitleText = "";

// 상태
let preTranslationStatus = "idle";
let preTranslationProgress = { current: 0, total: 0 };

// 발견된 자막 저장 (자동 번역 안함)
let availableSubtitles = [];
let currentMovieId = null;

// 번역 데이터 로컬 저장 (service worker 종료 대비)
let localTranslations = new Map();

// 즉시 injector 주입 (document_start에서 실행되므로)
injectScript();
init();

// ============================================
// Injector 스크립트 주입
// ============================================
function injectScript() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/injector.js");
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  console.log("[NST] Injector 주입 완료");
}

function init() {
  loadSettings();

  // DOM 준비 후 오버레이 설정
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupOverlay();
      observeSubtitles();
    });
  } else {
    setupOverlay();
    observeSubtitles();
  }

  // injector에서 자막 발견 이벤트 수신 (추출만, 번역은 팝업에서 선택)
  window.addEventListener("NST_SUBTITLES_FOUND", (event) => {
    const { movieId, subtitles } = event.detail;
    console.log("[NST] 자막 발견 이벤트 수신:", movieId, subtitles.length + "개");

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

  // 메시지 리스너
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === SUBTITLE_STATUS) {
      preTranslationStatus = message.status;
      if (message.progress) preTranslationProgress = message.progress;
      updateStatusIndicator();
      sendResponse?.({ ok: true });
    }

    // background에서 번역 데이터 수신 (로컬에 저장)
    if (message?.type === "NST_TRANSLATIONS_DATA") {
      const { translations } = message;
      if (translations && typeof translations === "object") {
        localTranslations = new Map(Object.entries(translations));
        console.log("[NST] 번역 데이터 로컬 저장:", localTranslations.size + "개");
      }
      sendResponse?.({ ok: true });
    }

    if (message?.type === "NST_SETTINGS_UPDATED") {
      if (typeof message.isEnabled === "boolean") {
        isEnabled = message.isEnabled;
        if (!isEnabled) hideOverlay();
      }
      sendResponse?.({ ok: true });
    }

    // 팝업에서 사용 가능한 자막 요청
    if (message?.type === GET_AVAILABLE_SUBTITLES) {
      sendResponse({
        movieId: currentMovieId,
        subtitles: availableSubtitles,
        status: preTranslationStatus,
        progress: preTranslationProgress
      });
    }

    // 팝업에서 번역 시작 요청
    if (message?.type === START_TRANSLATION) {
      const { langCode } = message;
      const subtitle = availableSubtitles.find(s => s.langCode === langCode);

      if (subtitle && currentMovieId) {
        console.log("[NST] 번역 시작:", subtitle.langName);
        chrome.runtime.sendMessage({
          type: PROCESS_SUBTITLES,
          movieId: currentMovieId,
          subtitleUrl: subtitle.url,
          langCode: subtitle.langCode
        });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "자막을 찾을 수 없습니다" });
      }
    }

    return true;
  });
}

function loadSettings() {
  chrome.storage.sync.get(["nstEnabled"], (result) => {
    if (typeof result.nstEnabled === "boolean") {
      isEnabled = result.nstEnabled;
    }
  });
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
function updateStatusIndicator() {
  if (!statusIndicator) return;

  if (preTranslationStatus === "loading") {
    const percent = preTranslationProgress.total > 0
      ? Math.round((preTranslationProgress.current / preTranslationProgress.total) * 100)
      : 0;
    statusIndicator.textContent = `번역 준비 중... ${percent}%`;
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
    statusIndicator.textContent = "번역 준비 실패";
    statusIndicator.className = "nst-status error";
  } else {
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
  textEl.textContent = text;
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
  // 로컬에서 먼저 조회 (service worker 종료 대비)
  if (localTranslations.has(text)) {
    showOverlay(localTranslations.get(text));
    return;
  }

  // 로컬에 없으면 background에 요청 (service worker가 살아있을 때)
  chrome.runtime.sendMessage(
    { type: GET_TRANSLATION, text },
    (response) => {
      if (chrome.runtime.lastError) {
        // service worker 종료됨 - 로컬 데이터만 사용
        return;
      }

      if (response?.translated) {
        // 로컬에도 저장
        localTranslations.set(text, response.translated);
        showOverlay(response.translated);
      } else {
        hideOverlay();
      }
    }
  );
}
