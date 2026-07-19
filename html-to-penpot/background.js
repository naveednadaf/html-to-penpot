// background.js - Service worker for HTML to Penpot extension
// Handles cross-origin image fetching (service workers with host_permissions bypass CORS)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "fetchImage") {
    (async () => {
      try {
        const response = await fetch(msg.url);
        if (!response.ok) {
          sendResponse({ success: false, error: `HTTP ${response.status}` });
          return;
        }
        const blob = await response.blob();
        const mimeType = blob.type || "image/png";
        // Convert blob to base64 using ArrayBuffer (no FileReader in service workers)
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        sendResponse({ success: true, base64, mimeType, size: bytes.length });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // Keep message channel open for async
  }
});
