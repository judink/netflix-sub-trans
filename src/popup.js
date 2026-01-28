// popup.js

const GET_AVAILABLE_SUBTITLES = "NST_GET_AVAILABLE_SUBTITLES";
const START_TRANSLATION = "NST_START_TRANSLATION";

let selectedLangCode = null;
let currentTabId = null;
let currentMovieId = null;

document.addEventListener("DOMContentLoaded", async () => {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const enableToggle = document.getElementById("enableToggle");
  const subtitleList = document.getElementById("subtitleList");
  const translateBtn = document.getElementById("translateBtn");

  // 설정 로드
  const settings = await chrome.storage.sync.get(["nstEnabled", "geminiApiKey", "targetLanguage"]);
  const targetLang = settings.targetLanguage || "uk";
  enableToggle.checked = settings.nstEnabled !== false;

  // API 키 체크
  if (!settings.geminiApiKey) {
    statusDot.className = "status-dot error";
    statusText.textContent = "API 키가 설정되지 않음";
    subtitleList.innerHTML = '<div class="no-subtitles">먼저 설정에서 API 키를 입력하세요</div>';
    return;
  }

  // 현재 탭 가져오기
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("netflix.com")) {
    statusDot.className = "status-dot";
    statusText.textContent = "Netflix 페이지를 열어주세요";
    subtitleList.innerHTML = '<div class="no-subtitles">Netflix 영상 재생 페이지에서 열어주세요</div>';
    return;
  }

  currentTabId = tab.id;

  // contentScript에서 자막 정보 가져오기
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: GET_AVAILABLE_SUBTITLES });

    if (response && response.subtitles && response.subtitles.length > 0) {
      currentMovieId = response.movieId;
      await renderSubtitles(response.subtitles, targetLang, response.movieId);
      updateStatus(response.status, response.progress);
    } else {
      subtitleList.innerHTML = '<div class="no-subtitles">영상을 재생하면 자막이 표시됩니다</div>';
      statusDot.className = "status-dot";
      statusText.textContent = "자막 대기 중";
    }
  } catch (err) {
    console.error("Failed to get subtitles:", err);
    subtitleList.innerHTML = '<div class="no-subtitles">영상을 재생하면 자막이 표시됩니다</div>';
    statusDot.className = "status-dot";
    statusText.textContent = "자막 대기 중";
  }

  async function renderSubtitles(subtitles, targetLang, movieId) {
    subtitleList.innerHTML = "";

    const targetLangNames = {
      ko: "한국어", en: "영어", uk: "우크라이나어", ja: "일본어",
      ru: "러시아어", es: "스페인어", fr: "프랑스어", de: "독일어", zh: "중국어"
    };

    for (const sub of subtitles) {
      const item = document.createElement("div");
      item.className = "subtitle-item";
      item.dataset.langCode = sub.langCode;

      // 캐시 상태 확인
      let cacheStatus = { exists: false, progress: 0, completed: false };
      try {
        cacheStatus = await chrome.runtime.sendMessage({
          type: "NST_GET_CACHE_STATUS",
          movieId,
          langCode: sub.langCode,
          targetLang
        });
      } catch (e) {
        // 무시
      }

      // 상태 배지 생성
      let statusBadge = "";
      if (cacheStatus.completed) {
        statusBadge = '<span class="cache-badge complete">완료</span>';
      } else if (cacheStatus.exists && cacheStatus.progress > 0) {
        statusBadge = `<span class="cache-badge partial">${cacheStatus.progress}%</span>`;
      }

      item.innerHTML = `
        <div>
          <div class="subtitle-name">${sub.langName} ${statusBadge}</div>
          <div class="target-lang">→ ${targetLangNames[targetLang] || targetLang}로 번역</div>
        </div>
        <span class="subtitle-code">${sub.langCode}</span>
      `;

      item.addEventListener("click", () => {
        document.querySelectorAll(".subtitle-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");
        selectedLangCode = sub.langCode;
        translateBtn.disabled = false;

        // 완료된 캐시면 버튼 텍스트 변경
        if (cacheStatus.completed) {
          translateBtn.textContent = "번역 불러오기";
        } else if (cacheStatus.exists && cacheStatus.progress > 0) {
          translateBtn.textContent = `이어서 번역 (${cacheStatus.progress}%)`;
        } else {
          translateBtn.textContent = "번역 시작";
        }
      });

      subtitleList.appendChild(item);
    }

    // 첫 번째 자막 자동 선택
    if (subtitles.length > 0) {
      const firstItem = subtitleList.querySelector(".subtitle-item");
      firstItem.click();
    }
  }

  function updateStatus(status, progress) {
    if (status === "loading") {
      statusDot.className = "status-dot loading";
      const percent = progress && progress.total > 0
        ? Math.round((progress.current / progress.total) * 100)
        : 0;
      statusText.textContent = `번역 중... ${percent}%`;
      translateBtn.disabled = true;
      translateBtn.textContent = `번역 중... ${percent}%`;
    } else if (status === "ready") {
      statusDot.className = "status-dot ready";
      statusText.textContent = "번역 완료!";
      translateBtn.textContent = "다른 자막 번역";
      translateBtn.disabled = false;
    } else if (status === "error") {
      statusDot.className = "status-dot error";
      statusText.textContent = "번역 실패";
      translateBtn.disabled = false;
      translateBtn.textContent = "다시 시도";
    } else {
      statusDot.className = "status-dot";
      statusText.textContent = "준비됨";
    }
  }

  // 번역 버튼 클릭
  translateBtn.addEventListener("click", async () => {
    if (!selectedLangCode || !currentTabId) return;

    translateBtn.disabled = true;
    translateBtn.textContent = "번역 시작 중...";
    statusDot.className = "status-dot loading";
    statusText.textContent = "번역 시작 중...";

    try {
      await chrome.tabs.sendMessage(currentTabId, {
        type: START_TRANSLATION,
        langCode: selectedLangCode
      });
    } catch (err) {
      console.error("Failed to start translation:", err);
      statusDot.className = "status-dot error";
      statusText.textContent = "오류 발생";
      translateBtn.disabled = false;
      translateBtn.textContent = "다시 시도";
    }
  });

  // 토글 변경
  enableToggle.addEventListener("change", () => {
    const isEnabled = enableToggle.checked;

    chrome.storage.sync.set({ nstEnabled: isEnabled }, () => {
      chrome.tabs.query({ url: "https://www.netflix.com/*" }, (tabs) => {
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, {
            type: "NST_SETTINGS_UPDATED",
            isEnabled
          }).catch(() => {});
        }
      });
    });
  });

  // 상태 업데이트 폴링 (번역 진행 중일 때)
  setInterval(async () => {
    if (!currentTabId) return;

    try {
      const response = await chrome.tabs.sendMessage(currentTabId, { type: GET_AVAILABLE_SUBTITLES });
      if (response) {
        updateStatus(response.status, response.progress);
      }
    } catch (err) {
      // 무시
    }
  }, 1000);

  // 번역 중지 & 새로고침 버튼
  const stopBtn = document.getElementById("stopBtn");
  stopBtn.addEventListener("click", async () => {
    if (!currentTabId) return;

    stopBtn.disabled = true;
    stopBtn.textContent = "새로고침 중...";

    // background에 번역 취소 요청 (실패해도 무시)
    chrome.runtime.sendMessage({
      type: "NST_CANCEL_TRANSLATION",
      movieId: "FORCE_RESET"
    }).catch(() => {});

    // Netflix 탭 새로고침 (0.5초 후)
    setTimeout(() => {
      chrome.tabs.reload(currentTabId).then(() => {
        window.close();
      }).catch((err) => {
        console.error("Reload failed:", err);
        // 실패해도 팝업 닫기
        window.close();
      });
    }, 500);
  });

  // 캐시 삭제 버튼
  const clearCacheBtn = document.getElementById("clearCacheBtn");
  clearCacheBtn.addEventListener("click", async () => {
    if (!confirm("모든 번역 캐시를 삭제하시겠습니까?")) return;

    // nst_cache_ 로 시작하는 모든 키 삭제
    const allData = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(allData).filter(k => k.startsWith("nst_cache_"));

    if (cacheKeys.length > 0) {
      await chrome.storage.local.remove(cacheKeys);
      alert(`${cacheKeys.length}개 캐시 삭제 완료`);
      // 팝업 새로고침
      window.location.reload();
    } else {
      alert("삭제할 캐시가 없습니다");
    }
  });
});
