/**
 * linkedin_terminal_emulator — Popup Controller
 */

const toggle = document.getElementById('toggle');
const statusText = document.getElementById('status-text');

function updateUI(enabled) {
  toggle.checked = enabled;
  if (enabled) {
    statusText.textContent = 'ON — Text mode active';
    statusText.className = 'status on';
  } else {
    statusText.textContent = 'OFF — Normal LinkedIn';
    statusText.className = 'status off';
  }
}

// Get current state from content script
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (tab && tab.url && tab.url.includes('linkedin.com')) {
    chrome.tabs.sendMessage(tab.id, { action: 'getState' }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not loaded yet
        chrome.storage.local.get('linkedin-reader-enabled', (result) => {
          updateUI(result['linkedin-reader-enabled'] === true);
        });
        return;
      }
      if (response) {
        updateUI(response.enabled);
      }
    });
  } else {
    // Not on LinkedIn
    statusText.textContent = 'Navigate to LinkedIn to use';
    statusText.className = 'status off';
    toggle.disabled = true;
  }
});

// Toggle handler
toggle.addEventListener('change', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.url && tab.url.includes('linkedin.com')) {
      chrome.tabs.sendMessage(tab.id, { action: 'toggle' }, (response) => {
        if (chrome.runtime.lastError) {
          // If content script isn't responding, update storage directly
          const newState = toggle.checked;
          chrome.storage.local.set({ 'linkedin-reader-enabled': newState });
          updateUI(newState);
          // Reload the tab to inject content script
          chrome.tabs.reload(tab.id);
          return;
        }
        if (response) {
          updateUI(response.enabled);
        }
      });
    }
  });
});
