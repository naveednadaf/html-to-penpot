// penpot-builder.js - Converts collected DOM data into Penpot JSON structure
// Matches the Penpot v3 export format (ZIP-based, .penpot files)

const PenpotBuilder = (function () {
  "use strict";

  const ROOT_ID = "00000000-0000-0000-0000-000000000000";

  function uuid() {
    return crypto.randomUUID();
  }

  function identityTransform() {
    return { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
  }

  function selrect(x, y, w, h) {
    return { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h };
  }

  function points(x, y, w, h) {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }

  function parseBorderRadius(style) {
    const parse = (val) => {
      if (!val || val === "0px" || val === "0") return 0;
      return parseFloat(val) || 0;
    };
    return {
      r1: parse(style.borderTopLeftRadius),
      r2: parse(style.borderTopRightRadius),
      r3: parse(style.borderBottomRightRadius),
      r4: parse(style.borderBottomLeftRadius),
    };
  }

  function buildFills(bgColor) {
    if (!bgColor) return [];
    return [{ fillColor: bgColor.fillColor, fillOpacity: bgColor.fillOpacity }];
  }

  function buildStrokes(style) {
    if (!style.borderColor || !style.borderWidth || style.borderStyle === "none") return [];
    const w = parseFloat(style.borderWidth);
    if (w <= 0) return [];
    return [{
      strokeColor: style.borderColor.fillColor,
      strokeOpacity: style.borderColor.fillOpacity,
      strokeWidth: w,
      strokeAlignment: "inner",
      strokeStyle: "solid",
    }];
  }

  // Build strokes for table cells - always add a visible border
  function buildTableCellStrokes(style) {
    const borderColor = style.borderColor || { fillColor: "#d0d0d0", fillOpacity: 1 };
    return [{
      strokeColor: borderColor.fillColor,
      strokeOpacity: borderColor.fillOpacity || 1,
      strokeWidth: 1,
      strokeAlignment: "inner",
      strokeStyle: "solid",
    }];
  }

  function buildTextContent(text, style) {
    const fontSize = parseInt(style.fontSize) || 16;
    const fontWeight = style.fontWeight || "400";
    const fontFamily = style.fontFamily || "sourcesanspro";
    const fontStyle = style.fontStyle === "italic" ? "italic" : "normal";
    const textTransform = "none";
    const textAlign = style.textAlign || "left";
    const letterSpacing = parseFloat(style.letterSpacing) || 0;
    const textDecoration = style.textDecoration === "line-through" ? "line-through"
      : style.textDecoration === "underline" ? "underline" : "none";

    const fills = style.color
      ? [{ fillColor: style.color.fillColor, fillOpacity: style.color.fillOpacity }]
      : [{ fillColor: "#000000", fillOpacity: 1 }];

    const lines = text.split("\n");
    const paragraphs = lines.map((line) => ({
      type: "paragraph",
      key: uuid().slice(0, 6),
      lineHeight: style.lineHeight || "1.4",
      fontStyle,
      textTransform,
      textAlign,
      fontId: fontFamily,
      fontSize: String(fontSize),
      fontWeight,
      textDirection: "ltr",
      fontVariantId: fontStyle === "italic" ? "italic" : "regular",
      textDecoration,
      letterSpacing: String(letterSpacing),
      fills,
      fontFamily,
      children: [{
        lineHeight: style.lineHeight || "1.4",
        fontStyle,
        textTransform,
        textAlign,
        fontId: fontFamily,
        fontSize: String(fontSize),
        fontWeight,
        textDirection: "ltr",
        fontVariantId: fontStyle === "italic" ? "italic" : "regular",
        textDecoration,
        letterSpacing: String(letterSpacing),
        fills,
        fontFamily,
        text: line,
      }],
      typographyRefId: null,
      typographyRefFile: null,
    }));

    return {
      type: "root",
      children: [{
        type: "paragraph-set",
        children: paragraphs,
      }],
    };
  }

  function buildPositionData(text, style, x, y) {
    const fontSize = parseInt(style.fontSize) || 16;
    const fills = style.color
      ? [{ fillColor: style.color.fillColor, fillOpacity: style.color.fillOpacity }]
      : [{ fillColor: "#000000", fillOpacity: 1 }];

    const lines = text.split("\n");
    const lineHeightPx = style.lineHeight && style.lineHeight !== "normal"
      ? parseFloat(style.lineHeight)
      : fontSize * 1.4;

    return lines.map((line, idx) => ({
      x,
      y: y + fontSize + idx * lineHeightPx,
      width: line.length * fontSize * 0.6 || fontSize * 0.6,
      height: fontSize * 1.4,
      x1: 0,
      y1: idx * lineHeightPx,
      x2: line.length * fontSize * 0.6 || fontSize * 0.6,
      y2: idx * lineHeightPx + fontSize * 1.4,
      fontStyle: style.fontStyle === "italic" ? "italic" : "normal",
      textTransform: "none",
      fontSize: `${fontSize}px`,
      fontWeight: style.fontWeight || "400",
      textDecoration: style.textDecoration === "line-through" ? "line-through"
        : style.textDecoration === "underline" ? "underline" : "none",
      letterSpacing: "normal",
      fills,
      direction: "ltr",
      fontFamily: style.fontFamily || "sourcesanspro",
      text: line,
    }));
  }

  // Tags that should be treated as table-related
  const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col", "caption"]);

  function getShapeType(el) {
    if (el.imageUrl) return "rect";
    // Table cells with text become frames (rects can't have children in Penpot)
    if (el.tag === "td" || el.tag === "th") return "frame";
    // Table containers become frames
    if (TABLE_TAGS.has(el.tag)) return "frame";
    if (el.directText) return "text";
    if (el.childIds && el.childIds.length > 0) return "frame";
    if (el.hasBackground) return "rect";
    if (el.hasBorder) return "rect";
    return "frame";
  }

  function isTableCell(el) {
    return el.tag === "td" || el.tag === "th";
  }

  function isTableContainer(el) {
    return TABLE_TAGS.has(el.tag) && !isTableCell(el);
  }

  function buildShape(el, pageId, fileId, parentId, frameId, mediaLibrary) {
    const shapeType = getShapeType(el);
    const radii = parseBorderRadius(el.styles);

    const base = {
      id: el.id,
      name: el.tag + (el.directText ? ` "${el.directText.slice(0, 20)}"` : ""),
      type: shapeType,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      rotation: 0,
      selrect: selrect(el.x, el.y, el.width, el.height),
      points: points(el.x, el.y, el.width, el.height),
      transform: identityTransform(),
      transformInverse: identityTransform(),
      parentId: parentId,
      frameId: frameId,
      flipX: null,
      flipY: null,
      proportionLock: false,
      proportion: 1.0,
      strokes: buildStrokes(el.styles),
      fills: buildFills(el.styles.backgroundColor),
      pageId: pageId,
      ...radii,
    };

    if (shapeType === "frame") {
      base.shapes = el.penpotChildIds || [];
      base.hideFillOnExport = false;
      base.hideInViewer = false;
      base.growType = "fixed";

      // Table containers get a light background and no fills if none specified
      if (isTableContainer(el) && !el.hasBackground) {
        base.fills = [];
      }

      // Table cells: white fill + border strokes
      if (isTableCell(el)) {
        base.strokes = buildTableCellStrokes(el.styles);
        if (!el.hasBackground) {
          base.fills = [{ fillColor: "#ffffff", fillOpacity: 1 }];
        }
        // Cell has text -> create a child text shape
        if (el.directText) {
          const textId = uuid();
          const textPadX = 6;
          const textPadY = 4;
          base.shapes = [textId];
          const cellText = {
            id: textId,
            name: "text",
            type: "text",
            x: el.x + textPadX,
            y: el.y + textPadY,
            width: Math.max(el.width - textPadX * 2, 20),
            height: Math.max(el.height - textPadY * 2, 16),
            rotation: 0,
            selrect: selrect(el.x + textPadX, el.y + textPadY, Math.max(el.width - textPadX * 2, 20), Math.max(el.height - textPadY * 2, 16)),
            points: points(el.x + textPadX, el.y + textPadY, Math.max(el.width - textPadX * 2, 20), Math.max(el.height - textPadY * 2, 16)),
            transform: identityTransform(),
            transformInverse: identityTransform(),
            parentId: el.id,
            frameId: el.id,
            flipX: null,
            flipY: null,
            proportionLock: false,
            proportion: 1.0,
            strokes: [],
            fills: el.styles.color
              ? [{ fillColor: el.styles.color.fillColor, fillOpacity: el.styles.color.fillOpacity }]
              : [{ fillColor: "#000000", fillOpacity: 1 }],
            pageId: pageId,
            r1: 0, r2: 0, r3: 0, r4: 0,
            growType: "auto-width",
            hideInViewer: false,
            content: buildTextContent(el.directText, el.styles),
            positionData: buildPositionData(el.directText, el.styles, el.x + textPadX, el.y + textPadY),
          };
          mediaLibrary.childShapes.push(cellText);
        }
      }
    }

    if (shapeType === "text") {
      base.content = buildTextContent(el.directText, el.styles);
      base.positionData = buildPositionData(el.directText, el.styles, el.x, el.y);
      base.growType = "auto-width";
      base.hideInViewer = false;
    }

    if (shapeType === "rect") {
      base.hideFillOnExport = false;
      base.growType = "fixed";

      // Image shape
      if (el.imageUrl) {
        base.name = el.tag + " (image)";
        if (el.imageBase64 && mediaLibrary) {
          const mediaEntryId = uuid();
          const mediaObjectId = uuid();
          const imgW = el.imageNaturalWidth || el.width;
          const imgH = el.imageNaturalHeight || el.height;
          const mtype = el.imageMimeType || "image/png";

          mediaLibrary.entries.push({
            id: mediaEntryId,
            mediaId: mediaObjectId,
            mtype: mtype,
            name: el.tag + " image",
            width: imgW,
            height: imgH,
            isLocal: true,
            createdAt: new Date().toISOString(),
          });

          mediaLibrary.objects.push({
            id: mediaObjectId,
            base64: el.imageBase64,
            mtype: mtype,
            size: el.imageBase64.length,
          });

          base.fills = [{
            fillOpacity: 1,
            fillImage: {
              width: imgW,
              height: imgH,
              mtype: mtype,
              id: mediaEntryId,
              keepAspectRatio: true,
            },
          }];
          base.proportionLock = true;
          base.proportion = parseFloat((imgW / imgH).toFixed(4)) || 1;
        } else {
          base.fills = [{ fillColor: "#c4c4c4", fillOpacity: 1 }];
        }
      }
    }

    return base;
  }

  // Build the Penpot parent tree from DOM data.
  function buildTree(elements, artboardId) {
    const idSet = new Set(elements.map(el => el.id));
    const elMap = new Map();
    for (const el of elements) {
      elMap.set(el.id, el);
    }

    const penpotParentId = new Map();

    for (const el of elements) {
      let domParent = el.domParentId;
      let found = false;

      while (domParent) {
        if (idSet.has(domParent)) {
          penpotParentId.set(el.id, domParent);
          found = true;
          break;
        }
        const parentEl = elMap.get(domParent);
        domParent = parentEl ? parentEl.domParentId : null;
      }

      if (!found) {
        penpotParentId.set(el.id, artboardId);
      }
    }

    const penpotChildIds = new Map();
    penpotChildIds.set(artboardId, []);
    for (const el of elements) {
      penpotChildIds.set(el.id, []);
    }

    for (const el of elements) {
      const parentId = penpotParentId.get(el.id);
      if (parentId && penpotChildIds.has(parentId)) {
        penpotChildIds.get(parentId).push(el.id);
      }
    }

    const penpotFrameId = new Map();
    penpotFrameId.set(artboardId, artboardId);

    for (const el of elements) {
      let ancestorId = penpotParentId.get(el.id);
      while (ancestorId && ancestorId !== artboardId) {
        const ancestor = elMap.get(ancestorId);
        if (ancestor && getShapeType(ancestor) === "frame") {
          penpotFrameId.set(el.id, ancestorId);
          break;
        }
        ancestorId = penpotParentId.get(ancestorId);
      }
      if (!penpotFrameId.has(el.id)) {
        penpotFrameId.set(el.id, artboardId);
      }
    }

    for (const el of elements) {
      if (getShapeType(el) === "frame" && !penpotFrameId.has(el.id)) {
        penpotFrameId.set(el.id, penpotFrameId.get(el.id) || artboardId);
      }
    }

    return { penpotParentId, penpotFrameId, penpotChildIds };
  }

  // Main build function
  function build(domData) {
    const fileId = uuid();
    const pageId = uuid();
    const fileName = domData.pageTitle || "Exported Page";

    // Filter to significant elements
    const significantElements = domData.elements.filter(el => {
      return el.hasBackground || el.hasBorder || el.directText || el.imageUrl || el.childIds.length > 0;
    });

    // Find the top-level frame bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of significantElements) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 800; maxY = 600; }

    const padding = 40;
    const canvasX = minX - padding;
    const canvasY = minY - padding;
    const canvasW = (maxX - minX) + padding * 2;
    const canvasH = (maxY - minY) + padding * 2;

    const artboardId = uuid();

    // Build the proper parent tree
    const { penpotParentId, penpotFrameId, penpotChildIds } = buildTree(significantElements, artboardId);

    // Attach penpotChildIds to frame elements
    for (const el of significantElements) {
      el.penpotChildIds = penpotChildIds.get(el.id) || [];
    }

    const artboardChildIds = penpotChildIds.get(artboardId) || [];

    // Media library for images
    const mediaLibrary = { entries: [], objects: [], childShapes: [] };

    // Build manifest
    const manifest = {
      type: "penpot/export-files",
      version: 1,
      generatedBy: "html-to-penpot/1.0.0",
      refer: "penpot",
      files: [{
        id: fileId,
        name: fileName,
        features: [
          "fdata/path-data",
          "design-tokens/v1",
          "variants/v1",
          "layout/grid",
          "components/v2",
          "fdata/shape-data-type",
        ],
      }],
      relations: [],
    };

    const fileJson = {
      features: manifest.files[0].features,
      teamId: uuid(),
      hasMediaTrimmed: false,
      name: fileName,
      revn: 1,
      modifiedAt: new Date().toISOString(),
      vern: 0,
      id: fileId,
      isShared: false,
      options: { componentsV2: true, baseFontSize: "16px" },
      migrations: [],
      version: 1,
      projectId: uuid(),
      createdAt: new Date().toISOString(),
    };

    const pageJson = {
      id: pageId,
      name: "Page 1",
      index: 0,
    };

    // Root frame
    const rootFrame = {
      id: ROOT_ID,
      name: "Root Frame",
      type: "frame",
      x: 0,
      y: 0,
      width: 0.01,
      height: 0.01,
      rotation: 0,
      selrect: selrect(0, 0, 0.01, 0.01),
      points: points(0, 0, 0.01, 0.01),
      transform: identityTransform(),
      transformInverse: identityTransform(),
      parentId: ROOT_ID,
      frameId: ROOT_ID,
      flipX: null,
      flipY: null,
      hideFillOnExport: false,
      r2: 0, r3: 0, r1: 0, r4: 0,
      proportionLock: false,
      proportion: 1.0,
      pageId: pageId,
      strokes: [],
      fills: [{ fillColor: "#FFFFFF", fillOpacity: 1 }],
      shapes: [artboardId],
    };

    // Artboard frame
    const artboardFrame = {
      id: artboardId,
      name: fileName,
      type: "frame",
      x: canvasX,
      y: canvasY,
      width: canvasW,
      height: canvasH,
      rotation: 0,
      selrect: selrect(canvasX, canvasY, canvasW, canvasH),
      points: points(canvasX, canvasY, canvasW, canvasH),
      transform: identityTransform(),
      transformInverse: identityTransform(),
      parentId: ROOT_ID,
      frameId: ROOT_ID,
      flipX: null,
      flipY: null,
      hideFillOnExport: false,
      hideInViewer: false,
      r2: 0, r3: 0, r1: 0, r4: 0,
      proportionLock: false,
      proportion: 1.0,
      pageId: pageId,
      strokes: [],
      fills: [{ fillColor: "#FFFFFF", fillOpacity: 1 }],
      shapes: artboardChildIds,
      growType: "fixed",
    };

    // Adjust coordinates relative to artboard
    for (const el of significantElements) {
      el.x -= canvasX;
      el.y -= canvasY;
    }

    // Build all shapes
    const shapes = {};
    for (const el of significantElements) {
      const parentId = penpotParentId.get(el.id);
      const frameId = penpotFrameId.get(el.id);
      const shape = buildShape(el, pageId, fileId, parentId, frameId, mediaLibrary);
      shapes[shape.id] = shape;
    }

    return {
      manifest,
      fileJson,
      pageJson,
      rootFrame,
      artboardFrame,
      shapes,
      fileId,
      pageId,
      fileName,
      mediaLibrary,
    };
  }

  return { build, ROOT_ID };
})();
