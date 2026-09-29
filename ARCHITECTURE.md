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
4. **design.json** (`schema/design.schema.json`, `schemaVersion 1.0.0`): root = design size at (0,0); every node has a parent-relative `box`
   and a design-relative `absBox`; assets are inline PNG/JPEG; `report` lists fallbacks, unsupported CSS, font issues and overflow.
5. **Plugin** (`figma-plugin/code.js`, plain JS): creates Frames / Text (fixed line breaks) / SVG vectors / image fills, maps fonts via the
   font map, verifies geometry against `absBox`, and returns a summary (design size, layers, missing, substituted fonts, unsupported).

`spikes/` holds the prototype these files were promoted from; `npm run test:regression` asserts that production and prototype still
produce the same design.json for the two real baseline pages.
