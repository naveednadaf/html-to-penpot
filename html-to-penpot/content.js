// content.js - Walks the DOM and collects element data for Penpot conversion

(function () {
  "use strict";

  // Tags to skip entirely
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "HEAD", "TITLE",
    "SVG", "PATH", "DEFS", "USE", "SYMBOL", "G", "CIRCLE", "RECT",
    "LINE", "POLYGON", "POLYLINE", "ELLIPSE", "CLIPPATH", "MASK",
    "BR", "HR", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "BODY",
  ]);

  // Check if an element is visible
  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    const style = getComputedStyle(el);
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    if (style.clipPath === "inset(100%)") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  // Parse rgba/hex color to {r,g,b,a}
  function parseColor(colorStr) {
    if (!colorStr || colorStr === "transparent" || colorStr === "none" || colorStr === "rgba(0, 0, 0, 0)") {
      return null;
    }
    const m = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/);
    if (m) {
      const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
      if (a === 0) return null;
      const r = parseInt(m[1]).toString(16).padStart(2, "0");
      const g = parseInt(m[2]).toString(16).padStart(2, "0");
      const b = parseInt(m[3]).toString(16).padStart(2, "0");
      return { fillColor: `#${r}${g}${b}`, fillOpacity: a };
    }
    if (colorStr.startsWith("#")) {
      let hex = colorStr.slice(1);
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      return { fillColor: `#${hex}`, fillOpacity: 1 };
    }
    return null;
  }

  // Get font family (pick first, clean quotes)
  function cleanFontFamily(ff) {
    if (!ff) return "sourcesanspro";
    const first = ff.split(",")[0].trim().replace(/['"]/g, "").toLowerCase();
    const map = {
      "arial": "sourcesanspro",
      "helvetica": "sourcesanspro",
      "times new roman": "sourceserifpro",
      "georgia": "sourceserifpro",
      "courier new": "sourcecodepro",
      "monospace": "sourcecodepro",
      "sans-serif": "sourcesanspro",
      "serif": "sourceserifpro",
    };
    return map[first] || first.replace(/\s+/g, "").toLowerCase();
  }

  // Get direct text content (not from children)
  function getDirectText(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text.trim();
  }

  // Determine if an element has meaningful background
  function hasBackground(style) {
    const bg = style.backgroundColor;
    const parsed = parseColor(bg);
    return parsed !== null && parsed.fillColor !== "#000000" || (parsed && parsed.fillColor === "#000000" && parsed.fillOpacity > 0);
  }

  // Determine if element has meaningful border
  function hasBorder(style) {
    return parseFloat(style.borderWidth) > 0 && style.borderStyle !== "none" && style.borderStyle !== "initial";
  }

  // Capture image as base64 by loading it with crossOrigin="anonymous"
  // This works for same-origin and for servers that send CORS headers
  function captureImageAsBase64(imgEl) {
    try {
      if (!imgEl.complete || imgEl.naturalWidth === 0) return null;

      const canvas = document.createElement("canvas");
      const w = imgEl.naturalWidth;
      const h = imgEl.naturalHeight;
      const maxDim = 2048;
      let scale = 1;
      if (w > maxDim || h > maxDim) {
        scale = maxDim / Math.max(w, h);
      }
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);

      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/png");
      const parts = dataUrl.split(",");
      if (parts.length !== 2 || parts[1].length < 10) return null;

      return {
        base64: parts[1],
        mimeType: "image/png",
        size: parts[1].length,
        naturalWidth: w,
        naturalHeight: h,
      };
    } catch (e) {
      // Tainted canvas (cross-origin without CORS headers)
      return null;
    }
  }

  // Load an image with crossOrigin="anonymous" and capture via canvas
  // This re-requests the image with CORS headers, avoiding tainted canvas
  function loadImageAsBase64(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const result = captureImageAsBase64(img);
        resolve(result);
      };
      img.onerror = () => resolve(null);
      // Set src after crossOrigin to ensure it's used
      img.src = src;
      // Timeout after 5s
      setTimeout(() => resolve(null), 5000);
    });
  }

  // Fetch image as base64 using fetch API (fallback for same-origin)
  async function fetchImageAsBase64(src) {
    try {
      const response = await fetch(src, { mode: "cors", credentials: "omit" });
      if (!response.ok) return null;
      const blob = await response.blob();
      const mimeType = blob.type || "image/png";
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.split(",")[1];
          resolve({ base64, mimeType, size: blob.size, naturalWidth: 0, naturalHeight: 0 });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  // Fetch image via background service worker (bypasses CORS entirely)
  function fetchImageViaBackground(src) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "fetchImage", url: src }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          resolve(null);
          return;
        }
        resolve({
          base64: response.base64,
          mimeType: response.mimeType,
          size: response.size,
          naturalWidth: 0,
          naturalHeight: 0,
        });
      });
    });
  }

  // Main walk function
  function walkDOM(root, scope) {
    const elements = [];
    const viewportWidth = document.documentElement.scrollWidth;
    const viewportHeight = document.documentElement.scrollHeight;

    // Visible area bounds (relative to document)
    let clipRect = null;
    if (scope === "visible") {
      clipRect = {
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    }

    function walk(el, depth, parentPath, parentElementId) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (!isVisible(el)) return;

      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      const absX = rect.x + scrollX;
      const absY = rect.y + scrollY;

      const w = rect.width;
      const h = rect.height;
      if (w < 1 && h < 1) return;

      // If visible-area mode, skip elements entirely outside viewport
      if (clipRect) {
        const elRight = absX + w;
        const elBottom = absY + h;
        if (elRight < clipRect.x || elBottom < clipRect.y ||
            absX > clipRect.x + clipRect.width || absY > clipRect.y + clipRect.height) {
          return;
        }
      }

      const path = parentPath ? `${parentPath} > ${el.tagName}` : el.tagName;
      const myId = crypto.randomUUID();

      const data = {
        id: myId,
        tag: el.tagName.toLowerCase(),
        path: path,
        depth: depth,
        domParentId: parentElementId || null,
        x: absX,
        y: absY,
        width: w,
        height: h,
        styles: {
          backgroundColor: parseColor(style.backgroundColor),
          color: parseColor(style.color),
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          fontFamily: cleanFontFamily(style.fontFamily),
          fontStyle: style.fontStyle,
          letterSpacing: style.letterSpacing,
          textDecoration: style.textDecorationLine,
          textAlign: style.textAlign,
          lineHeight: style.lineHeight,
          borderRadius: style.borderRadius,
          borderWidth: style.borderWidth,
          borderStyle: style.borderStyle,
          borderColor: parseColor(style.borderLeftColor),
          borderTopWidth: style.borderTopWidth,
          borderRightWidth: style.borderRightWidth,
          borderBottomWidth: style.borderBottomWidth,
          borderLeftWidth: style.borderLeftWidth,
          borderTopLeftRadius: style.borderTopLeftRadius,
          borderTopRightRadius: style.borderTopRightRadius,
          borderBottomRightRadius: style.borderBottomRightRadius,
          borderBottomLeftRadius: style.borderBottomLeftRadius,
          opacity: parseFloat(style.opacity),
          boxShadow: style.boxShadow,
          overflow: style.overflow,
          position: style.position,
          display: style.display,
        },
        directText: getDirectText(el),
        imageUrl: null,
        imageBase64: null,
        imageMimeType: null,
        childIds: [],
        hasBackground: hasBackground(style),
        hasBorder: hasBorder(style),
      };

      // Handle images
      if (el.tagName === "IMG") {
        const src = el.currentSrc || el.src;
        if (src) {
          data.imageUrl = src;
          data.imageNaturalWidth = el.naturalWidth;
          data.imageNaturalHeight = el.naturalHeight;
          // Try canvas capture from the already-loaded element first
          const captured = captureImageAsBase64(el);
          if (captured) {
            data.imageBase64 = captured.base64;
            data.imageMimeType = captured.mimeType;
            if (captured.naturalWidth) data.imageNaturalWidth = captured.naturalWidth;
            if (captured.naturalHeight) data.imageNaturalHeight = captured.naturalHeight;
          }
          // If canvas failed (cross-origin), loadImageAsBase64 will retry later
        }
      }

      elements.push(data);

      // Walk children
      for (const child of el.children) {
        walk(child, depth + 1, path, myId);
      }
    }

    // Walk body's children, not body itself
    for (const child of root.children) {
      walk(child, 0, "", null);
    }

    return { elements, viewportWidth, viewportHeight, pageTitle: document.title || "Untitled" };
  }

  // Fetch images that weren't captured by canvas
  // Priority: 1) background service worker (bypasses CORS), 2) canvas+crossOrigin, 3) fetch
  async function fetchImages(elements) {
    const needFetch = elements.filter(el => el.imageUrl && !el.imageBase64);
    const fetchPromises = needFetch.map(async (el) => {
      // Method 1: Background service worker (bypasses CORS entirely)
      const bgResult = await fetchImageViaBackground(el.imageUrl);
      if (bgResult) {
        el.imageBase64 = bgResult.base64;
        el.imageMimeType = bgResult.mimeType;
        return;
      }
      // Method 2: Re-load with crossOrigin="anonymous" (works with CORS-enabled servers)
      const canvasResult = await loadImageAsBase64(el.imageUrl);
      if (canvasResult) {
        el.imageBase64 = canvasResult.base64;
        el.imageMimeType = canvasResult.mimeType;
        if (canvasResult.naturalWidth) el.imageNaturalWidth = canvasResult.naturalWidth;
        if (canvasResult.naturalHeight) el.imageNaturalHeight = canvasResult.naturalHeight;
        return;
      }
      // Method 3: Direct fetch (same-origin only)
      const result = await fetchImageAsBase64(el.imageUrl);
      if (result) {
        el.imageBase64 = result.base64;
        el.imageMimeType = result.mimeType;
      }
    });
    await Promise.all(fetchPromises);
    return elements;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "collectDOM") {
      (async () => {
        try {
          const scope = msg.scope || "visible";
          const data = walkDOM(document.body, scope);
          await fetchImages(data.elements);
          sendResponse({ success: true, data });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
  });
})();
