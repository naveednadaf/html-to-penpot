// popup.js - Orchestrates the export flow

(function () {
  "use strict";

  const ROOT_ID = "00000000-0000-0000-0000-000000000000";

  // State
  let exportScope = "visible";
  let detailLevel = "medium";
  let collectedData = null;

  // DOM refs
  const exportBtn = document.getElementById("exportBtn");
  const previewBtn = document.getElementById("previewBtn");
  const statusEl = document.getElementById("status");
  const statsEl = document.getElementById("stats");
  const fileNameInput = document.getElementById("fileName");

  // Option chip handling
  document.querySelectorAll(".option-chip[data-scope]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".option-chip[data-scope]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      exportScope = chip.dataset.scope;
    });
  });

  document.querySelectorAll(".option-chip[data-detail]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".option-chip[data-detail]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      detailLevel = chip.dataset.detail;
    });
  });

  function setStatus(msg, type = "info") {
    statusEl.className = `status ${type}`;
    statusEl.innerHTML = msg;
  }

  function showStats(data) {
    const frames = data.elements.filter((e) => e.hasBackground || e.childIds.length > 0).length;
    const texts = data.elements.filter((e) => e.directText).length;
    const images = data.elements.filter((e) => e.imageUrl).length;
    const total = data.elements.length;
    document.getElementById("statFrames").textContent = frames;
    document.getElementById("statTexts").textContent = texts;
    document.getElementById("statImages").textContent = images;
    document.getElementById("statTotal").textContent = total;
    statsEl.style.display = "flex";
  }

  // Inject content script and collect DOM data
  async function collectDOM() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found");

    // Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    // Send message to content script (pass scope for visible-area filtering)
    const response = await chrome.tabs.sendMessage(tab.id, { action: "collectDOM", scope: exportScope });

    if (!response || !response.success) {
      throw new Error(response?.error || "Failed to collect DOM data");
    }

    return response.data;
  }

  function formatPenpotJson(obj) {
    return JSON.stringify(obj, null, 2);
  }

  // Convert base64 to binary Uint8Array
  function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  // Get file extension from MIME type
  function getExtFromMime(mtype) {
    if (mtype.includes("png")) return "png";
    if (mtype.includes("jpeg") || mtype.includes("jpg")) return "jpg";
    if (mtype.includes("gif")) return "gif";
    if (mtype.includes("webp")) return "webp";
    if (mtype.includes("avif")) return "avif";
    if (mtype.includes("svg")) return "svg";
    return "png";
  }

  // Build the .penpot ZIP file
  async function buildPenpotZip(domData) {
    const penpot = PenpotBuilder.build(domData);
    // Use createFolders:false on every file() call to prevent 0-byte directory entries
    // (Penpot's reference files don't have directory entries in the ZIP)
    const zipOpts = { createFolders: false };
    const zip = new JSZip();

    // manifest.json
    zip.file("manifest.json", formatPenpotJson(penpot.manifest), zipOpts);

    // File metadata
    const fileDir = `files/${penpot.fileId}`;
    zip.file(`${fileDir}.json`, formatPenpotJson(penpot.fileJson), zipOpts);

    // Page index
    const pageDir = `${fileDir}/pages/${penpot.pageId}`;
    zip.file(`${pageDir}.json`, formatPenpotJson(penpot.pageJson), zipOpts);

    // Root frame
    zip.file(`${pageDir}/${ROOT_ID}.json`, formatPenpotJson(penpot.rootFrame), zipOpts);

    // Artboard frame
    zip.file(`${pageDir}/${penpot.artboardFrame.id}.json`, formatPenpotJson(penpot.artboardFrame), zipOpts);

    // All shapes
    for (const [id, shape] of Object.entries(penpot.shapes)) {
      zip.file(`${pageDir}/${id}.json`, formatPenpotJson(shape), zipOpts);
    }

    // Child shapes (e.g., text inside table cells)
    if (penpot.mediaLibrary.childShapes) {
      for (const childShape of penpot.mediaLibrary.childShapes) {
        zip.file(`${pageDir}/${childShape.id}.json`, formatPenpotJson(childShape), zipOpts);
      }
    }

    // Media library and image objects
    const media = penpot.mediaLibrary;
    if (media.entries.length > 0) {
      // Media index file (one JSON with all entries)
      zip.file(`${fileDir}/media.json`, formatPenpotJson(media.entries), zipOpts);

      // Individual media entry files (one per image)
      for (const entry of media.entries) {
        zip.file(`${fileDir}/media/${entry.id}.json`, formatPenpotJson(entry), zipOpts);
      }

      // Image object files (actual image data + metadata)
      for (const obj of media.objects) {
        // Actual image binary data (compute size from actual bytes)
        const imgData = base64ToUint8Array(obj.base64);
        const ext = getExtFromMime(obj.mtype);

        // Object metadata — size must match actual binary size, hash is optional (omitted)
        const objMeta = {
          id: obj.id,
          bucket: "file-media-object",
          contentType: obj.mtype,
          size: imgData.length,
        };
        zip.file(`objects/${obj.id}.json`, formatPenpotJson(objMeta), zipOpts);
        zip.file(`objects/${obj.id}.${ext}`, imgData, zipOpts);
      }
    }

    // Generate ZIP
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
    });
    return blob;
  }

  // Download the file
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Export button handler
  exportBtn.addEventListener("click", async () => {
    try {
      exportBtn.disabled = true;
      setStatus('<span class="spinner"></span>Scanning page elements...');

      const data = await collectDOM();
      collectedData = data;

      if (data.elements.length === 0) {
        setStatus("No elements found on this page.", "error");
        exportBtn.disabled = false;
        return;
      }

      const imgCount = data.elements.filter(e => e.imageUrl).length;
      setStatus(`<span class="spinner"></span>Building Penpot file (${imgCount} images)...`);
      showStats(data);

      // Override file name if user specified one
      const customName = fileNameInput.value.trim();
      if (customName) {
        data.pageTitle = customName;
      }

      const blob = await buildPenpotZip(data);
      const filename = (customName || data.pageTitle || "export").replace(/[^a-zA-Z0-9_-]/g, "_") + ".penpot";

      downloadBlob(blob, filename);
      setStatus(`✓ Exported ${data.elements.length} elements successfully!`, "success");
    } catch (err) {
      console.error("Export failed:", err);
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      exportBtn.disabled = false;
    }
  });

  // Preview button handler
  previewBtn.addEventListener("click", async () => {
    try {
      previewBtn.disabled = true;
      setStatus('<span class="spinner"></span>Scanning page elements...');

      const data = await collectDOM();
      collectedData = data;
      showStats(data);
      setStatus(`Found ${data.elements.length} elements. Click Export to generate .penpot file.`, "info");
    } catch (err) {
      console.error("Preview failed:", err);
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      previewBtn.disabled = false;
    }
  });
})();
