// options.js
// 설정 저장/로드

document.addEventListener("DOMContentLoaded", () => {
  const apiKeyInput = document.getElementById("apiKey");
  const sourceLanguageSelect = document.getElementById("sourceLanguage");
  const targetLanguageSelect = document.getElementById("targetLanguage");
  const enabledInput = document.getElementById("enabled");
  const saveButton = document.getElementById("save");
  const statusEl = document.getElementById("status");

  // 설정 로드
  chrome.storage.sync.get(
    ["geminiApiKey", "sourceLanguage", "targetLanguage", "nstEnabled"],
    (result) => {
      if (result.geminiApiKey) {
        apiKeyInput.value = result.geminiApiKey;
      }
      if (result.sourceLanguage) {
        sourceLanguageSelect.value = result.sourceLanguage;
      }
      if (result.targetLanguage) {
        targetLanguageSelect.value = result.targetLanguage;
      }
      if (typeof result.nstEnabled === "boolean") {
        enabledInput.checked = result.nstEnabled;
      }
    }
  );

  // 저장
  saveButton.addEventListener("click", () => {
    const settings = {
      geminiApiKey: apiKeyInput.value.trim(),
      sourceLanguage: sourceLanguageSelect.value,
      targetLanguage: targetLanguageSelect.value,
      nstEnabled: enabledInput.checked
    };

    chrome.storage.sync.set(settings, () => {
      statusEl.textContent = "Saved!";
      setTimeout(() => {
        statusEl.textContent = "";
      }, 2000);

      // Netflix 탭에 알림
      chrome.tabs.query({ url: "https://www.netflix.com/*" }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: "NST_SETTINGS_UPDATED",
            isEnabled: settings.nstEnabled
          }).catch(() => {});
        }
      });
    });
  });
});
