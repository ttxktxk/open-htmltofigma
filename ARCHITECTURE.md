# Architecture

## Goal

Local HTML file → Figma layers that **look like the rendered page**.

Not in scope: URL crawling, site-wide import, or rewriting flex as Figma Auto Layout.

## Pipeline

1. **UI** loads the HTML into a sandboxed iframe at a chosen viewport width (so media queries match desktop/tablet/mobile).
2. Wait for **fonts**, expand collapsed panels if needed.
3. Walk the DOM. For each visible element, record:
   - `getBoundingClientRect()` (x, y, width, height vs page origin)
   - computed styles (fill, border, radius, opacity, shadow, type)
   - rasterized SVG / `<img>` as PNG bytes
4. **Main thread** rebuilds Frames / Text / rectangles with image fills.
5. Child positions are **parent-relative** (`child.x - parent.x`), so nesting matches the DOM while layout matches the browser.

Flex, grid, absolute CSS, etc. are handled by the browser. We only measure the result.

## Why not Auto Layout?

Auto Layout is useful for *editing* later. For *matching* a finished page, absolute positions from real layout are more reliable. That is the intentional v1 approach.

---

## MVP-A: Playwright capture (`capture/` + `figma-plugin/`)

The in-plugin iframe cannot run the scripts of a bundled Claude Design export reliably, cannot read the fonts Chrome
actually used, and cannot take screenshots of browser-only effects. MVP-A moves measurement out of Figma:

```
design.html ─► capture/cli.js (Playwright + installed Chrome/Edge) ─► design.json ─► figma-plugin/code.js ─► layers
```

1. **Load & settle** (`browser.js`): open the file in Chrome, wait for fonts, images, a quiet DOM and a stable layout.
   All DOM access runs in a CDP *isolated world* (`iso.js`) so page globals (e.g. a React component named `Map`) cannot break it.
2. **Design root** (`page.js detectDesign`): `[data-figma-frame|data-design-root|data-screen-label]` → `$preview` → explicit px size →
   body (warning). The viewport is set to the design size; the design is never scaled. Several roots stop the capture unless `--design-root` is given.
3. **Walk** (`page.js walk`): frames with fills, 4-side borders, 4-corner radii (CSS overlap rule), shadows, clip; text runs with the
   platform font Chrome used (CDP `CSS.getPlatformFontsForNode`) and visual lines from `Range.getClientRects` (line top probed from Chrome);
   inline SVG serialized with computed paint (CSS transforms on `<svg>` baked in); canvas / maps / native controls / unsafe SVG / blob images
   as isolated screenshots.
   **`::before` / `::after`**: every rendered pseudo-element (any `content` other than `none`/`normal`, including `""`) becomes a layer
   named `<parent name>::before|::after`. Geometry = Chrome's own box model of the pseudo-element (CDP `DOM.getBoxModel`; transformed
   quad → Figma `relativeTransform`, sub-pixel sizes kept); paint from `getComputedStyle(el, '::after')`; single-line string content →
   an editable text child (font from `CSS.getPlatformFontsForNode` on the pseudo-element). Nothing in the page is changed to measure it.
   Too complex (gradient/url background, `content: url()/counter()/attr()`, icon-font glyph, multi-line text, skew/3D, filter/mask) →
   isolated screenshot of only that pseudo-element + an `unsupported` entry. Empty ones (no size, no paint) make no layer; every
   pseudo-element and its result is listed in `report.pseudoElements`.
   Layer order: DOM order (`::before` before the children, `::after` after them), then checked against Chrome's CSS paint order
   (`page.js paintOrder`: stacking contexts, z-index, positioned vs in-flow) for every layer the pseudo-element overlaps; if needed it
   moves to the nearest ancestor frame where the order is right (never out of a clipping, transparent or transformed frame).
   Otherwise the DOM order is kept and reported.
4. **design.json** (`schema/design.schema.json`, `schemaVersion 1.0.0`): root = design size at (0,0); every node has a parent-relative `box`
   and a design-relative `absBox`; assets are inline PNG/JPEG; `report` lists fallbacks, unsupported CSS, font issues and overflow.
5. **Plugin** (`figma-plugin/code.js`, plain JS): creates Frames / Text (fixed line breaks) / SVG vectors / image fills, maps fonts via the
   font map, verifies geometry against `absBox`, and returns a summary (design size, layers, missing, substituted fonts, unsupported).

`spikes/` holds the prototype these files were promoted from; `npm run test:regression` asserts that production and prototype still
produce the same design.json for the two real baseline pages.

---

## MVP-B: Local Helper (`local-helper/`) + one-click plugin

```
plugin UI (sandboxed iframe, Origin "null")
  ── POST /capture (HTML bytes, Bearer token) ──► http://localhost:43127  local-helper/server.js (bound to 127.0.0.1)
                                                     └─ capture-service.js: temp dir ─► spawn node capture/cli.js ─► read design.json ─► delete temp
  ◄── GET /jobs/<id> (stage), GET /jobs/<id>/result (design + summary) ──
plugin UI ── postMessage "import" (same message as a design.json file) ──► figma-plugin/code.js renderer ──► layers
```

- **No duplicated capture logic.** The Helper runs `capture/cli.js` as a child process with an argument array (no shell).
  `cli.js` only gained opt-in progress lines (`H2F_PROGRESS=1`); its output files are unchanged, so the MVP-A regression still applies.
- **HTML never passes through the Figma main thread.** The UI uploads the `File` itself (XHR, upload progress) and polls the job.
  The main thread gets the finished design through the existing `import` message; it only stores the Helper token (clientStorage).
- **Security:** the plugin uses http://localhost:43127 (Figma's devAllowedDomains accepts localhost but not IP literals); the Helper is bound to 127.0.0.1 only; random token per Helper start (printed in its window, pasted once into the plugin);
  only Origin `null` (plugin UI) or no Origin (scripts) accepted, Host must be localhost / localhost:<port> / 127.0.0.1:<port> (DNS rebinding);
  CORS + Private-Network-Access headers only for Origin `null`; no path from requests is ever opened; file names sanitized;
  .html/.htm + HTML content check; 100 MB limit (Content-Length and streamed count); 5 min capture timeout;
  temp dir per job removed in `finally` (success, error, timeout, Ctrl+C); logs contain name, size, status and time only.
- **Jobs** run one at a time; results stay in memory until collected once (or 10 min), then are dropped.
- **Plugin network access:** `devAllowedDomains` = `http://localhost:43127` only; `allowedDomains` = `none`.
