# HTML to Penpot

A Chrome extension that converts web pages into `.penpot` design files that can be imported directly into [Penpot](https://penpot.app/).

## Features

- **Full page or visible area** export — choose to capture the entire page or just what's on screen
- **Images included** — cross-origin images are fetched via a background service worker (bypasses CORS)
- **Tables supported** — table cells become frames with borders and child text
- **Clean Penpot v3 format** — produces valid `.penpot` ZIP files that import without errors
- **Style preservation** — backgrounds, borders, colors, fonts, text alignment

## Installation

1. Clone this repo
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `html-to-penpot/` folder

## Usage

1. Navigate to the page you want to convert
2. Click the extension icon in the toolbar
3. Choose **Visible Area** or **Full Page** scope
4. Click **Export**
5. The `.penpot` file downloads automatically
6. In Penpot, go to Dashboard → Import and upload the file

## How It Works

1. **`content.js`** — Walks the DOM, collects element positions, styles, text, and images. Images are captured as base64 using a 3-tier approach: background service worker → canvas with crossOrigin → direct fetch.

2. **`penpot-builder.js`** — Converts the collected DOM data into Penpot's JSON structure: shapes with proper parent-child trees, `fillImage` objects for images, frame types for containers.

3. **`popup.js`** — Orchestrates the flow, builds the ZIP file (manifest, file/page metadata, shape JSON, image objects + binary data), and triggers the download.

4. **`background.js`** — Service worker that fetches images without CORS restrictions using the extension's `host_permissions`.

## Technical Notes

- The `.penpot` format is a ZIP file following [Penpot's v3 export format](https://penpot.app/)
- Image objects require `size` to match actual binary size (validated on import)
- The `hash` field on storage objects is optional — omitted to avoid validation failures
- Only `frame` type shapes can have children in Penpot; `rect` types cannot
- ZIP files must not contain 0-byte directory entries
- Parent-child relationships must be bidirectionally consistent (`parentId` ↔ `shapes` arrays)

## License

MIT
