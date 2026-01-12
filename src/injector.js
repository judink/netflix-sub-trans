// injector.js
// Netflix 페이지에 주입되어 JSON.parse/stringify를 후킹하여 자막 URL을 추출

(function() {
  console.log("[NST] Injector 로드됨");

  // 자막 데이터 저장용 숨겨진 요소 생성
  if (!document.getElementById("NST_SUBTITLE_DATA")) {
    const container = document.createElement("div");
    container.id = "NST_SUBTITLE_DATA";
    container.style.display = "none";
    document.documentElement.appendChild(container);
  }

  const originalStringify = JSON.stringify;
  const originalParse = JSON.parse;

  // JSON.stringify 후킹: webvtt 프로필 추가
  JSON.stringify = function(value) {
    if (value === undefined) return originalStringify.apply(this, arguments);

    try {
      const result = originalStringify.apply(this, arguments);
      const data = originalParse(result);

      // Netflix API 요청에 webvtt 프로필 추가
      if (data && data.params && data.params.profiles) {
        data.params.profiles.unshift("webvtt-lssdh-ios8");
        return originalStringify(data);
      }

      return result;
    } catch (e) {
      return originalStringify.apply(this, arguments);
    }
  };

  // JSON.parse 후킹: 자막 정보 추출
  JSON.parse = function() {
    const value = originalParse.apply(this, arguments);

    try {
      // Netflix API 응답에서 자막 정보 추출
      if (value && value.result && value.result.movieId && value.result.timedtexttracks) {
        extractSubtitleInfo(value.result);
      }
    } catch (e) {
      // 무시
    }

    return value;
  };

  function extractSubtitleInfo(movieData) {
    const movieId = movieData.movieId;
    const container = document.getElementById("NST_SUBTITLE_DATA");
    if (!container) return;

    // 이미 처리된 영화인지 확인
    if (container.querySelector(`.movie-${movieId}`)) return;

    console.log("[NST] 자막 정보 추출 시작:", movieId);

    const movieElem = document.createElement("div");
    movieElem.className = `movie-${movieId}`;
    movieElem.dataset.movieId = movieId;

    const subtitles = [];

    for (const track of movieData.timedtexttracks) {
      // 강제 자막이나 빈 트랙 제외
      if (!track.ttDownloadables || track.isForcedNarrative || track.isNoneTrack) {
        continue;
      }

      // webvtt URL 찾기
      const webvtt = track.ttDownloadables["webvtt-lssdh-ios8"];
      if (!webvtt || !webvtt.urls) continue;

      const url = Object.values(webvtt.urls)[0]?.url;
      if (!url) continue;

      const langCode = track.language;
      const langName = track.trackType === "ASSISTIVE"
        ? `${track.languageDescription} (CC)`
        : track.languageDescription;

      subtitles.push({
        langCode,
        langName,
        url
      });

      console.log(`[NST] 자막 발견: ${langName} (${langCode})`);
    }

    // 데이터를 DOM에 저장
    movieElem.dataset.subtitles = JSON.stringify(subtitles);
    container.appendChild(movieElem);

    // contentScript에 알림 (커스텀 이벤트)
    window.dispatchEvent(new CustomEvent("NST_SUBTITLES_FOUND", {
      detail: { movieId, subtitles }
    }));

    console.log(`[NST] 총 ${subtitles.length}개 자막 트랙 발견`);
  }
})();
