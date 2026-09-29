#!/usr/bin/env node
// MVP-A capture CLI: bundled HTML (Claude Design export) -> design.json + reference.png + capture-report.json
// Promoted from spikes/capture.js (tested on two real exports); spikes/ stays as the regression reference.
//
//   npm run capture -- "C:\path\to\design.html"
//   npm run capture -- "C:\mockups" --out "C:\mockups\h2f-out"          (every .html in the folder)
//
// Output: <out>\<file name>\<W>x<H>\ design.json, design.normalized.json, reference.png, capture-report.json
// Exit codes: 0 ok · 1 capture failed · 2 usage error · 3 several design roots found (choose with --design-root)
//
// Options
//   --input <file|folder>   repeatable; a bare path works too
//   --out <dir>             default: ./out  -> one sub-folder per HTML file
//   --width W --height H    browser viewport (render tool only). Default: = detected design size
//   --dpr 2
//   --expand ".panel,.list" scrollMode full-content for these selectors only (never all scroll containers)
//   --raster ".chart,.map"  capture these elements as images (maps are detected automatically)
//   --wait 1500             extra ms after the page settles (slow JS / fonts)
//   --design-area auto      what becomes the Figma Root Frame (default auto; --design-size auto = same):
//                             auto     = detected design root, in this order:
//                                        1. [data-figma-frame] / [data-design-root] / [data-screen-label]
//                                        2. $preview {width,height} embedded by Claude Design
//                                        3. explicit px width+height on the page's root element
//                                        4. <body> content box (warning)
//                             body     = <body> content box as (0,0), size = viewport
//                             document = the whole scrollable document
//                             x,y,w,h  = explicit area in page pixels
//   --design-root all|N|"css selector"
//                           several design roots found: capture all (one Frame each), root N, or this element.
//                           Without it, capture stops and lists the roots (never picks one silently).
//   --font "DB Ozone X|400|C:\fonts\DB Ozone X v3.2.ttf"
//                           repeatable. Adds a temporary @font-face (data URI) to the loaded page only —
//                           the HTML file is not modified. Capture STOPS if any of these faces fails to load.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv2020 = require('ajv/dist/2020');
const { launch, openPage, stabilize } = require('./browser');
const { inputDirRedactor } = require('./redact');

const PAGE_JS = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const SCHEMA = require('../schema/design.schema.json');
const MAX_ASSET = 4096;
const SCHEMA_VERSION = '1.0.0';
// Machine-readable progress for the Local Helper (opt-in, stdout only; does not change any output file)
const progress = stage => { if (process.env.H2F_PROGRESS === '1') console.log('::h2f-progress:: ' + stage); };

function parseArgs(argv) {
  const o = { inputs: [], out: path.resolve('out'), width: 1920, height: 992, dpr: 2, expand: [], raster: [], wait: 0, fonts: [], designArea: 'auto', designRoot: null, viewportGiven: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--input' || a === '-i') o.inputs.push(v());
    else if (a === '--out' || a === '-o') o.out = path.resolve(v());
    else if (a === '--width') { o.width = +v(); o.viewportGiven = true; }
    else if (a === '--height') { o.height = +v(); o.viewportGiven = true; }
    else if (a === '--dpr') o.dpr = +v();
    else if (a === '--expand') o.expand = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--raster') o.raster = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--wait') o.wait = +v();
    else if (a === '--design-area' || a === '--design-size') o.designArea = v();
    else if (a === '--design-root') o.designRoot = v();
    else if (a === '--font') {
      const [family, weight, file] = v().split('|').map(x => x && x.trim());
      const abs = file && path.resolve(file.replace(/^["']|["']$/g, ''));
      if (!family || !+weight || !abs || !fs.existsSync(abs)) { console.error(`--font needs "Family|weight|path-to-font-file" (got: ${family}|${weight}|${abs})`); process.exit(2); }
      o.fonts.push({ family, weight: +weight, file: abs });
    }
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\nconst fs')[0]); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`Unknown option ${a}`); process.exit(2); }
    else o.inputs.push(a);
  }
  if (!o.inputs.length) { console.error('Usage: npm run capture -- "C:\\path\\to\\design.html"  (--help for options)'); process.exit(2); }
  const files = [];
  for (const p of o.inputs) {
    const abs = path.resolve(p.replace(/^["']|["']$/g, ''));
    if (!fs.existsSync(abs)) { console.error(`Not found: ${abs}`); process.exit(2); }
    if (fs.statSync(abs).isDirectory()) fs.readdirSync(abs).filter(f => /\.html?$/i.test(f)).forEach(f => files.push(path.join(abs, f)));
    else files.push(abs);
  }
  o.files = files;
  return o;
}

const slugify = t => String(t).trim().replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'root';

async function captureOne(browser, version, file, o, rootIndex = null) {
  const t0 = Date.now();
  const slug = slugify(path.basename(file).replace(/\.html?$/i, ''));
  const baseDir = path.join(o.out, slug);   // final outDir = baseDir[/<root>]/<W>x<H>  (known after detection)
  fs.mkdirSync(baseDir, { recursive: true });
  const warnings = [];

  progress('rendering');
  const { context, page, iso } = await openPage(browser, file, o);
  const redact = inputDirRedactor(file);   // no absolute input/temp folder in design.json or the report
  page.on('pageerror', e => warnings.push(redact('page error: ' + e.message.split('\n')[0])));
  page.on('requestfailed', r => { if (!/favicon/.test(r.url())) warnings.push(`request failed: ${redact(r.url()).slice(0, 120)} (${r.failure() && r.failure().errorText})`); });
  if (o.wait) await page.waitForTimeout(o.wait);
  const cdp = iso.cdp;   // all DOM access goes through the isolated world (see lib/iso.js)
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');

  // temporary @font-face for this capture only (spike): inject, force-load, verify, stop on failure
  const injectedFonts = [];
  if (o.fonts.length) {
    const faces = o.fonts.map(f => {
      const buf = fs.readFileSync(f.file);
      const ext = path.extname(f.file).toLowerCase();
      const fmt = { '.ttf': 'truetype', '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2' }[ext] || 'truetype';
      const mime = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' }[ext] || 'font/ttf';
      injectedFonts.push({ family: f.family, weight: f.weight, file: f.file, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
      return `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;font-display:block;src:url(data:${mime};base64,${buf.toString('base64')}) format("${fmt}")}`;
    }).join('\n');
    const status = await iso.eval(async (css, specs) => {
      const st = document.createElement('style'); st.id = 'h2f-injected-fonts'; st.textContent = css; document.head.appendChild(st);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = [];
      for (const sp of specs) {
        const face = [...document.fonts].find(f => f.family.replace(/["']/g, '') === sp.family && String(f.weight) === String(sp.weight) && f.status !== 'error' && st.sheet && true);
        let status = face ? face.status : 'not-found', error = null;
        if (face) { try { await face.load(); status = face.status; } catch (e) { status = 'error'; error = String(e); } }
        const check = document.fonts.check(`${sp.weight} 20px "${sp.family}"`, 'กขค ABC 123');
        out.push({ status, error, check });
      }
      await document.fonts.ready;
      return out;
    }, faces, o.fonts.map(f => ({ family: f.family, weight: f.weight })));
    status.forEach((s, i) => Object.assign(injectedFonts[i], s));
    const bad = injectedFonts.filter(f => f.status !== 'loaded' || !f.check);
    console.log('  injected fonts: ' + injectedFonts.map(f => `${f.family} ${f.weight} = ${f.status}${f.check ? '' : ' (check failed)'}`).join(', '));
    if (bad.length) {
      await context.close();
      const err = new Error(`Font(s) failed to load - capture stopped: ${bad.map(f => `${f.family} ${f.weight} (${f.status}${f.error ? ': ' + f.error : ''})`).join(', ')}`);
      fs.writeFileSync(path.join(baseDir, 'capture-report.json'), JSON.stringify({ source: file, aborted: true, reason: err.message, injectedFonts }, null, 2));
      throw err;
    }
    await stabilize(page, iso);   // layout changes once the new faces apply
  }

  if (o.expand.length) {
    const n = await iso.eval(sels => {
      let count = 0;
      for (const el of document.querySelectorAll(sels.join(','))) {
        el.style.setProperty('height', 'auto', 'important'); el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('overflow', 'visible', 'important'); el.style.setProperty('flex', 'none', 'important');
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
          a.style.setProperty('height', 'auto', 'important'); a.style.setProperty('min-height', '0', 'important'); a.style.setProperty('max-height', 'none', 'important');
        }
        count++;
      }
      return count;
    }, o.expand);
    if (!n) warnings.push(`--expand matched nothing: ${o.expand.join(', ')}`);
    await stabilize(page, iso);
  }

  progress('measuring');
  await iso.run(PAGE_JS);

  // ---- design root + size. The browser viewport is only a render tool: by default it is set to the
  //      detected design size; the design itself is never resized or scaled.
  let detection = null, picked = null, multiRoot = false;
  const vp0 = page.viewportSize();
  if (o.designArea === 'auto') {
    const detect = () => iso.eval(opts => window.__h2f.detectDesign(opts), { rootSelector: o.designRoot && !/^(all|\d+)$/.test(o.designRoot) ? o.designRoot : null });
    detection = await detect();
    const list = detection.roots;
    multiRoot = list.length > 1;
    if (multiRoot && rootIndex == null) {
      if (o.designRoot === 'all') { await context.close(); return list.map(r => r.index); }   // caller captures each root in its own page
      if (/^\d+$/.test(o.designRoot || '')) rootIndex = +o.designRoot;
      else {
        await context.close();
        const err = new Error(`${list.length} design roots found (${detection.source}) — choose with --design-root all | <n> | "<css selector>":\n` +
          list.map(r => `    ${r.index}: ${r.width}x${r.height} at (${r.x},${r.y})  ${r.label ? '"' + r.label + '"  ' : ''}${r.element}  [${r.source}]`).join('\n'));
        fs.writeFileSync(path.join(baseDir, 'capture-report.json'), JSON.stringify({ source: file, aborted: true, reason: 'multiple design roots — choose with --design-root', detectionSource: detection.source, designRoots: list, previews: detection.previews }, null, 2));
        err.expected = true; err.exitCode = 3; throw err;
      }
    }
    picked = list[rootIndex || 0];
    if (!picked) { await context.close(); throw new Error(`--design-root ${rootIndex}: only ${list.length} root(s) found`); }
    // viewport = design size (long designs: width = design width, height = design height, capped at 16384 by Chrome)
    const want = o.viewportGiven ? { width: o.width, height: o.height }
      : detection.source === 'body-fallback' ? vp0
      : { width: Math.ceil(picked.width), height: Math.min(Math.ceil(picked.height), 16384) };
    if (want.width !== vp0.width || want.height !== vp0.height) {
      await page.setViewportSize(want);
      await stabilize(page, iso);
      const before = picked;
      detection = await detect();
      picked = detection.roots.find(r => r.element === before.element) || detection.roots[before.index];
      if (!picked) { await context.close(); throw new Error('design root disappeared after setting the viewport to the design size'); }
      if (Math.abs(picked.width - before.width) > 1 || Math.abs(picked.height - before.height) > 1)
        detection.notes.push(`design root changed size when the viewport was set to ${want.width}x${want.height}: ${before.width}x${before.height} -> ${picked.width}x${picked.height} (responsive layout) — using the new size`);
    }
    if (Math.abs(picked.scale - 1) > 0.01) {
      await context.close();
      throw new Error(`design root ${picked.element} is drawn at scale ${picked.scale} (ancestor transform, e.g. a preview zoom). Capture refuses to scale the design — set --width/--height so the page renders it at 100%.`);
    }
    if (multiRoot) await iso.eval(i => window.__h2f.excludeOtherRoots(i), picked.index);
    detection.notes.forEach(n => warnings.push(n));
  }
  const areaOpt = picked ? { x: picked.x, y: picked.y, width: picked.width, height: picked.height, mode: 'auto:' + detection.source } : null;
  const walked = await iso.eval(opts => window.__h2f.walkDocument(opts), { rasterSelector: o.raster.join(',') || null, designArea: o.designArea === 'auto' ? null : o.designArea, area: areaOpt });
  const { root, unsupported, area } = walked;   // area = design area in page pixels (walk only adds data-* attributes)
  const browserViewport = page.viewportSize();
  const sizeTag = `${Math.round(area.width)}x${Math.round(area.height)}`;
  const outDir = multiRoot ? path.join(baseDir, slugify(picked.label || 'root-' + picked.index), sizeTag) : path.join(baseDir, sizeTag);
  fs.mkdirSync(outDir, { recursive: true });
  const areaClip = { x: area.x, y: area.y, width: area.width, height: area.height };
  await page.screenshot({ path: path.join(outDir, 'reference.png'), fullPage: true, clip: areaClip });

  const assets = {};
  const fallbacks = [];
  const fontUse = {};          // postScript -> {usedFamily, cssFamilies, chars, nodes}
  const fontIssues = [];
  const primaryFallback = {};   // "requested -> used" summary
  const stats = { frame: 0, text: 0, image: 0, raster: 0, vector: 0, bgRaster: 0 };

  function addAsset(buf, mime, w, h) {
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const id = 'a_' + sha.slice(0, 12);
    if (!assets[id]) assets[id] = { mime, pixelWidth: w, pixelHeight: h, sha256: sha, storage: { kind: 'inline', base64: buf.toString('base64') } };
    return id;
  }
  // Isolated element screenshot (transparent background):
  //   mode 'subtree' = the element and its descendants only; 'self' = only the element's own background/border.
  // Everything else is hidden while shooting, so overlapping layers (map pins, menus) are not baked in.
  // The clip is limited to the design area (page coords); returns { assetId, box (abs page coords, clipped), clipped } or null.
  const r2 = v => Math.round(v * 100) / 100;
  async function shot(box, id, why, mode = 'subtree') {
    const x0 = Math.max(box.x, area.x), y0 = Math.max(box.y, area.y);
    const x1 = Math.min(box.x + box.width, area.x + area.width), y1 = Math.min(box.y + box.height, area.y + area.height);
    if (x1 - x0 < 1 || y1 - y0 < 1) { warnings.push(`${id}: ${why} is outside the design area – skipped`); return null; }
    const clip = { x: r2(x0), y: r2(y0), width: r2(x1 - x0), height: r2(y1 - y0) };
    let scale = 'device', w = Math.round(clip.width * o.dpr), h = Math.round(clip.height * o.dpr);
    if (w > MAX_ASSET || h > MAX_ASSET) { scale = 'css'; w = Math.round(clip.width); h = Math.round(clip.height); }
    if (w > MAX_ASSET || h > MAX_ASSET) { warnings.push(`${id}: ${why} ${w}x${h}px > ${MAX_ASSET} (tiling not in spike) – skipped`); return null; }
    await iso.eval((id, mode) => {
      const t = document.querySelector(`[data-h2f-id="${id}"]`);
      document.documentElement.setAttribute('data-h2f-shotmode', '');
      t.setAttribute('data-h2f-shot', mode);
      for (const el of document.querySelectorAll('body, body *')) {
        if (el === t) continue;
        if (el.contains(t)) el.setAttribute('data-h2f-anc', '');
        else if (!t.contains(el)) el.setAttribute('data-h2f-hide', '');
      }
    }, id, mode);
    let buf;
    // fullPage + clip: allows clips beyond the viewport (otherwise Playwright silently clamps to the viewport)
    try { buf = await page.screenshot({ clip, type: 'png', scale, omitBackground: true, fullPage: true }); }
    finally {
      await iso.eval(() => {
        document.documentElement.removeAttribute('data-h2f-shotmode');
        for (const el of document.querySelectorAll('[data-h2f-shot],[data-h2f-anc],[data-h2f-hide]')) {
          el.removeAttribute('data-h2f-shot'); el.removeAttribute('data-h2f-anc'); el.removeAttribute('data-h2f-hide');
        }
      });
    }
    const clipped = clip.x !== box.x || clip.y !== box.y || clip.width !== box.width || clip.height !== box.height;
    const pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20);   // real size from the PNG header
    if (Math.abs(pw - w) > 2 || Math.abs(ph - h) > 2) warnings.push(`${id}: ${why} screenshot is ${pw}x${ph}px, expected ${w}x${h}px`);
    return { assetId: addAsset(buf, 'image/png', pw, ph), box: clip, clipped };
  }
  // raster/image nodes: keep only the visible (in-document) part
  function applyShot(node, res, parentAbs) {
    if (!res) return null;
    if (res.clipped) {
      node.box = { x: r2(node.box.x + res.box.x - node.absBox.x), y: r2(node.box.y + res.box.y - node.absBox.y), width: res.box.width, height: res.box.height };
      node.absBox = res.box;
      node.flags = (node.flags || []).concat('clipped-to-design-area');
    }
    return res.assetId;
  }
  async function platformFonts(selector) {
    const { root: d } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: d.nodeId, selector });
    if (!nodeId) return [];
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map(f => ({ family: f.familyName, postScript: f.postScriptName, custom: f.isCustomFont, glyphs: f.glyphCount })).sort((a, b) => b.glyphs - a.glyphs);
  }
  function noteFont(run, style, id, chars) {
    const k = run.postScript || '(unknown)';
    const u = fontUse[k] || (fontUse[k] = { postScript: run.postScript, usedFamily: run.usedFamily, cssFamilies: style.cssFamilies.join(', '), weight: style.weight, chars: 0, nodes: 0 });
    u.chars += chars; u.nodes++;
    if (run.usedFamily && !style.cssFamilies.some(f => stripWeight(run.usedFamily).toLowerCase() === f.toLowerCase()))
      fontIssues.push({ nodeId: id, issue: 'browser-fallback', usedFamily: run.usedFamily, postScript: run.postScript, cssFamilies: style.cssFamilies });
    // first font in the CSS stack not used (e.g. "DB Ozone X" requested, Chrome drew "Anuphan") - never silent
    else if (run.usedFamily && stripWeight(run.usedFamily).toLowerCase() !== style.cssFamilies[0].toLowerCase()) {
      const k = style.cssFamilies[0] + ' -> ' + stripWeight(run.usedFamily);
      const pf = primaryFallback[k] || (primaryFallback[k] = { requested: style.cssFamilies[0], used: run.usedFamily, postScript: run.postScript, chars: 0, runs: 0, examples: [] });
      pf.chars += chars; pf.runs++;
      if (pf.examples.length < 5) pf.examples.push({ nodeId: id, text: (run.text || '').slice(0, 30) });
    }
  }

  // ---- ::before / ::after (page.js leaves them as "pseudo-pending" children of their host)
  // Geometry comes from Chrome's box model of the pseudo-element itself (CDP DOM.getBoxModel): exact, transformed
  // quad included, and nothing in the page is changed to measure it.
  const pseudoStats = { editable: 0, rasterized: 0, empty: 0, text: 0 };
  const pseudoList = [];
  async function pseudoBox(hostId, which) {
    const { root: d } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: d.nodeId, selector: `[data-h2f-id="${hostId}"]` });
    if (!nodeId) return null;
    const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 0 });
    const ps = (node.pseudoElements || []).find(x => x.pseudoType === which);
    if (!ps) return null;
    let model;
    try { model = (await cdp.send('DOM.getBoxModel', { nodeId: ps.nodeId })).model; } catch (e) { return null; }
    let fonts = [];
    try { fonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId: ps.nodeId })).fonts; } catch (e) {}
    return { border: model.border, content: model.content, fonts: fonts.map(f => ({ family: f.familyName, postScript: f.postScriptName, glyphs: f.glyphCount })).sort((a, b) => b.glyphs - a.glyphs) };
  }
  const quadBox = (q, sx, sy) => { const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs), y = Math.min(...ys); return { x: r2(x + sx), y: r2(y + sy), width: r2(Math.max(...xs) - x), height: r2(Math.max(...ys) - y) }; };
  let pageScroll = null;
  // -> finished node (frame / raster), or null when the pseudo-element paints nothing
  async function buildPseudo(p, host) {
    const label = '::' + p.which;
    const id = p.hostId + ':' + p.which;
    const rec = { nodeId: id, host: p.hostId, pseudo: label, result: null };
    pseudoList.push(rec);
    if (!pageScroll) pageScroll = await iso.eval(() => [scrollX, scrollY]);
    const [sx, sy] = pageScroll;
    const geo = await pseudoBox(p.hostId, p.which);
    if (!geo) {
      unsupported.push({ nodeId: id, property: 'pseudo-element', value: label, action: 'ignored (no layout box in Chrome)' });
      rec.result = 'no-box'; return null;
    }
    const q = geo.border, absBox = quadBox(q, sx, sy);
    const paint = await iso.eval((h, w, quad) => window.__h2f.pseudoPaint(h, w, quad), p.hostId, p.which, q);
    unsupported.push(...paint.unsupported);
    const complex = paint.complex.slice();
    // text: one line only (content box no taller than 1.5 line-heights)
    let lh = null, cbox = null;
    if (paint.text != null) {
      cbox = quadBox(geo.content, sx, sy);
      lh = paint.textStyle.lineHeight || cbox.height;
      if (cbox.height > lh * 1.5) complex.push('text on more than one line');
    }
    const nothing = !paint.fills.length && !paint.border && !paint.effects.length && paint.text == null && !complex.length;
    if (nothing || (absBox.width === 0 && absBox.height === 0 && !paint.effects.length)) { pseudoStats.empty++; rec.result = 'empty'; return null; }
    const base = { id, name: paint.name, source: { tag: label, pseudo: p.which }, box: { x: r2(absBox.x - host.absBox.x), y: r2(absBox.y - host.absBox.y), width: absBox.width, height: absBox.height },
      absBox, opacity: paint.opacity, visible: paint.visible };
    if (complex.length) {
      // too complex for editable layers: isolated screenshot of just this pseudo-element, and reported
      unsupported.push({ nodeId: id, property: 'pseudo-element', value: `${label}: ${complex.join('; ')}`.slice(0, 160), action: 'rasterized (captured as image)' });
      const node = { ...base, type: 'raster', name: 'raster:' + paint.name, reason: 'pseudo-element' };
      node.assetId = applyShot(node, await shot(absBox, p.hostId, 'pseudo-element ' + label, 'pseudo-' + p.which));
      fallbacks.push({ nodeId: id, reason: 'pseudo-element', box: node.absBox, ok: !!node.assetId });
      stats.raster++; pseudoStats.rasterized++; rec.result = 'rasterized'; return node;
    }
    const node = { ...base, type: 'frame', fills: paint.fills, border: paint.border, radius: paint.radius, effects: paint.effects, clip: false, children: [] };
    if (paint.matrix) {   // simple 2D rotation/scale: Figma relativeTransform (local (0,0) = first quad corner)
      node.transform = { ...paint.matrix, tx: r2(q[0] + sx - host.absBox.x), ty: r2(q[1] + sy - host.absBox.y), width: paint.size.width, height: paint.size.height };
      if (paint.radius) node.radius = paint.radius;
    }
    if (paint.text != null) {
      const style = { ...paint.textStyle, lineHeight: lh };
      const f = geo.fonts[0] || null;
      const tb = { x: cbox.x, y: r2(cbox.y + (cbox.height - lh) / 2), width: cbox.width, height: r2(lh) };
      const run = { start: 0, end: paint.text.length, usedFamily: f ? f.family : null, postScript: f ? f.postScript : null };
      if (!f) fontIssues.push({ nodeId: id + ':t', issue: 'no-platform-font', text: paint.text.slice(0, 20) });
      else noteFont({ ...run, text: paint.text }, style, id + ':t', paint.text.length);
      if (geo.fonts.length > 1) warnings.push(`${id}: pseudo-element text uses ${geo.fonts.length} fonts (${geo.fonts.map(x => x.family).join(', ')}) — drawn with ${f.family}`);
      node.children.push({ id: id + ':t', type: 'text', name: paint.text.slice(0, 40), role: 'content',
        box: { x: r2(tb.x - absBox.x), y: r2(tb.y - absBox.y), width: tb.width, height: tb.height }, absBox: tb,
        opacity: 1, visible: true, originalText: paint.text, wrap: 'none',
        visualLines: [{ start: 0, end: paint.text.length, box: { x: 0, y: 0, width: tb.width, height: tb.height } }], runs: [run], style });
      stats.text++; pseudoStats.text++;
    }
    stats.frame++; pseudoStats.editable++; rec.result = 'editable';
    return node;
  }
  // Layer order of pseudo-elements (Figma: later sibling = on top, parent below its children).
  // Default = DOM order: ::before in front of the host's children, ::after behind them. Chrome's CSS paint order
  // (stacking contexts, z-index, positioned vs in-flow; page.js paintOrder) is then checked against every layer the
  // pseudo-element overlaps. If the default contradicts it — e.g. a connector drawn with ::before that runs under the
  // circles of the NEIGHBOURING steps (z-index: 1) — the layer moves to the nearest ancestor frame where the order is
  // right (never out of a frame that clips it, is transparent or transformed). No position -> kept + reported.
  async function orderPseudos(root) {
    const parentOf = new Map();
    (function idx(n) { for (const c of n.children || []) { parentOf.set(c, n); idx(c); } })(root);
    const pseudoNodes = [];
    (function f(n) { for (const c of n.children || []) { if (c.source && c.source.pseudo) pseudoNodes.push(c); f(c); } })(root);
    // node id -> box in the page: n12 element · n12t3 / n12t its text · n12bg its background · n12:after(:t) pseudo-element
    const refOf = n => { const m = /^(n\d+)(?::(before|after)|(t\d*))?/.exec(n.id); return m ? { id: m[1], pseudo: m[2] || null, text: !!m[3] } : null; };
    const paints = n => n.visible !== false && (n.type !== 'frame' || (n.fills && n.fills.length) || n.border || (n.effects && n.effects.length));
    const hit = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.01 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.01;
    const inside = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
    for (const P of pseudoNodes) {
      const rec = pseudoList.find(r => r.nodeId === P.id);
      // paint order of the tree without P: node -> index; subtree end index
      const order = new Map(), last = new Map();
      let k = 0;
      (function pre(n) { if (n === P) return; order.set(n, k++); for (const c of n.children || []) pre(c); last.set(n, k - 1); })(root);
      const others = [];
      for (const [n] of order) if (n !== root && paints(n) && n.absBox && hit(n.absBox, P.absBox) && refOf(n)) others.push(n);
      if (!others.length) continue;
      const rel = await iso.eval((r, o) => window.__h2f.paintOrder(r, o), refOf(P), others.map(refOf));
      const ok = pos => others.every((x, i) => !rel[i] || (rel[i] > 0 ? order.get(x) < pos : order.get(x) > pos));
      const host = parentOf.get(P);
      const curIdx = host.children.indexOf(P);
      const curPos = curIdx === 0 ? order.get(host) + 0.5 : last.get(host.children[curIdx - 1]) + 0.5;
      if (ok(curPos)) continue;
      let placed = null;
      for (let A = host, branch = null; A && A !== root; branch = A, A = parentOf.get(A)) {
        if (branch && ((branch.clip && !inside(P.absBox, branch.absBox)) || branch.opacity < 1 || branch.transform || branch.visible === false)) break;
        const kids = A.children.filter(c => c !== P);
        const want = branch ? kids.indexOf(branch) + (P.source.pseudo === 'after' ? 1 : 0) : (P.source.pseudo === 'before' ? 0 : kids.length);
        let best = null;
        for (let j = 0; j <= kids.length; j++) {
          const pos = j === 0 ? order.get(A) + 0.5 : last.get(kids[j - 1]) + 0.5;
          if (ok(pos) && (best == null || Math.abs(j - want) < Math.abs(best - want))) best = j;
        }
        if (best != null) { placed = { A, j: best, kids }; break; }
      }
      if (!placed) {
        unsupported.push({ nodeId: P.id, property: 'pseudo-element z-order', value: P.name.slice(0, 80), action: 'approximated (DOM order kept — no layer position matches the CSS paint order)' });
        if (rec) rec.zOrder = 'approximated';
        continue;
      }
      const { A, j, kids } = placed;
      host.children.splice(curIdx, 1);
      kids.splice(j, 0, P);
      A.children = kids;
      if (A !== host) {
        const dx = host.absBox.x - A.absBox.x, dy = host.absBox.y - A.absBox.y;
        P.box = { ...P.box, x: r2(P.absBox.x - A.absBox.x), y: r2(P.absBox.y - A.absBox.y) };
        if (P.transform) { P.transform.tx = r2(P.transform.tx + dx); P.transform.ty = r2(P.transform.ty + dy); }
        parentOf.set(P, A);
      }
      if (rec) rec.zOrder = A === host ? `reordered inside ${host.name}` : `moved to ${A.name} (${A.id}) for CSS paint order`;
    }
  }

  // text: measure first (no DOM changes), then detect fonts with temporary wrappers
  async function buildText(p, parent) {
    const m = await iso.eval((ti, lh) => window.__h2f.measureText(ti, lh), p.ti, p.style.lineHeight);
    if (!m) return null;
    const style = p.style;
    if (style.lineHeight == null) style.lineHeight = m.lines[0].box.height;
    // fonts: whole text node first; split into character-class runs only when >1 font
    await iso.eval(ti => window.__h2f.wrapWhole(ti), p.ti);
    let rawRuns;
    const whole = await platformFonts(`h2f-w[data-i="${p.ti}"]`);
    if (whole.length <= 1) {
      rawRuns = [{ start: 0, end: Infinity, font: whole[0] || null }];
    } else {
      const segs = await iso.eval(ti => window.__h2f.splitRuns(ti), p.ti);
      rawRuns = [];
      for (let n = 0; n < segs.length; n++) {
        const f = (await platformFonts(`h2f-w[data-i="${p.ti}"] > h2f-r[data-r="${n}"]`))[0] || null;
        const last = rawRuns[rawRuns.length - 1];
        if (last && (!f || (last.font && last.font.postScript === f.postScript))) last.end = segs[n].end;
        else if (last && !last.font) { last.end = segs[n].end; last.font = f; }
        else rawRuns.push({ start: segs[n].start, end: segs[n].end, font: f });
      }
    }
    await iso.eval(ti => window.__h2f.unwrap(ti), p.ti);
    // raw (DOM) offsets -> rendered-text offsets
    const toRendered = rawOff => { let k = 0; while (k < m.raw.length && m.raw[k] < rawOff) k++; return k; };
    let runs = rawRuns.map(r => ({ start: toRendered(r.start), end: r.end === Infinity ? m.text.length : toRendered(r.end),
      usedFamily: r.font ? r.font.family : null, postScript: r.font ? r.font.postScript : null })).filter(r => r.end > r.start);
    if (!runs.length) runs = [{ start: 0, end: m.text.length, usedFamily: null, postScript: null }];
    runs[0].start = 0; runs[runs.length - 1].end = m.text.length;
    for (let i = 1; i < runs.length; i++) runs[i].start = runs[i - 1].end;

    const id = p.parentId + 't' + p.ti;
    for (const r of runs) {
      if (!r.postScript) fontIssues.push({ nodeId: id, issue: 'no-platform-font', text: m.text.slice(r.start, r.end).slice(0, 20) });
      else noteFont({ ...r, text: m.text.slice(r.start, r.end) }, style, id, r.end - r.start);
    }
    const L = m.lines;
    const x0 = Math.min(...L.map(l => l.box.x)), y0 = Math.min(...L.map(l => l.box.y));
    const x1 = Math.max(...L.map(l => l.box.x + l.box.width)), y1 = Math.max(...L.map(l => l.box.y + l.box.height));
    const r2 = v => Math.round(v * 100) / 100;
    const absBox = { x: r2(x0), y: r2(y0), width: r2(x1 - x0), height: r2(y1 - y0) };
    return {
      id, type: 'text', name: m.text.slice(0, 40), role: 'content',
      box: { x: r2(x0 - parent.absBox.x), y: r2(y0 - parent.absBox.y), width: absBox.width, height: absBox.height }, absBox,
      opacity: 1, visible: true, originalText: m.text, wrap: 'none',
      visualLines: L.map(l => ({ start: l.start, end: l.end, box: { x: r2(l.box.x - x0), y: r2(l.box.y - y0), width: l.box.width, height: l.box.height } })),
      runs, style,
    };
  }

  async function finish(node, parent) {
    if (node.type === 'raster-pending') {
      node.type = 'raster'; node.name = 'raster:' + node.name;
      node.assetId = applyShot(node, await shot(node.absBox, node.id, node.reason));
      fallbacks.push({ nodeId: node.id, reason: node.reason, box: node.absBox, ok: !!node.assetId });
      stats.raster++; return node;
    }
    if (node.type === 'image-pending' || node.type === 'svgfile-pending') {
      const isSvg = node.type === 'svgfile-pending';
      try {
        let buf, mime;
        if (node.src.startsWith('data:')) {
          const mm = node.src.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
          mime = mm[1]; buf = mm[2] ? Buffer.from(mm[3], 'base64') : Buffer.from(decodeURIComponent(mm[3]));
        } else if (node.src.startsWith('file:')) {
          const f = require('url').fileURLToPath(node.src);
          buf = fs.readFileSync(f);
          mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }[path.extname(f).toLowerCase()];
        } else {
          const r = await page.request.get(node.src, { timeout: 15000 });
          if (!r.ok()) throw new Error('HTTP ' + r.status());
          buf = await r.body(); mime = (r.headers()['content-type'] || '').split(';')[0];
        }
        if (isSvg || mime === 'image/svg+xml') {
          node.type = 'vector';
          node.svg = buf.toString('utf8').replace(/<svg\b([^>]*)>/i, (all, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${node.absBox.width}" height="${node.absBox.height}">`);
          const fb = await shot(node.absBox, node.id, 'svg-fallback');
          node.fallbackAssetId = fb && !fb.clipped ? fb.assetId : null;
          stats.vector++;
        } else if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
          const dims = await iso.eval(id => { const e = document.querySelector(`[data-h2f-id="${id}"]`); return [e.naturalWidth, e.naturalHeight]; }, node.id);
          if (dims[0] > MAX_ASSET || dims[1] > MAX_ASSET || mime === 'image/webp') {
            node.assetId = applyShot(node, await shot(node.absBox, node.id, 'image'));     // Figma: ≤4096 px, no webp
            fallbacks.push({ nodeId: node.id, reason: mime === 'image/webp' ? 'image-webp' : 'image-too-large', box: node.absBox, ok: !!node.assetId });
          } else node.assetId = addAsset(buf, mime, dims[0], dims[1]);
          node.type = 'image'; stats.image++;
        } else throw new Error('unsupported image type ' + mime);
      } catch (e) {
        node.type = 'image'; node.assetId = applyShot(node, await shot(node.absBox, node.id, 'image'));
        fallbacks.push({ nodeId: node.id, reason: 'image-load-failed', detail: redact(e.message), box: node.absBox, ok: !!node.assetId });
        stats.image++;
      }
      delete node.src; return node;
    }
    if (node.type === 'vector') {
      const fb = await shot(node.absBox, node.id, 'svg-fallback');
      node.fallbackAssetId = fb && !fb.clipped ? fb.assetId : null;
      stats.vector++; return node;
    }
    if (node.type === 'text') { stats.text++; return node; }   // form-control text (already complete)
    if (node.type === 'frame') {
      stats.frame++;
      const pseudos = node.children.filter(c => c.type === 'pseudo-pending');
      if (pseudos.length) node.children = node.children.filter(c => c.type !== 'pseudo-pending');
      if (node.bgRaster) {
        // gradient / url() backgrounds: isolated shot of the element's own background (content hidden)
        const res = await shot(node.absBox, node.id, 'background', 'self');
        if (res && !res.clipped) node.fills.push({ type: 'image', assetId: res.assetId, scaleMode: 'FILL' });
        else if (res) {  // box reaches outside the document: put the visible part in as a raster layer under the children
          node.children.unshift({ id: node.id + 'bg', type: 'raster', name: 'bg:' + node.name, reason: 'background-raster', flags: ['clipped-to-design-area'],
            box: { x: r2(res.box.x - node.absBox.x), y: r2(res.box.y - node.absBox.y), width: res.box.width, height: res.box.height },
            absBox: res.box, opacity: 1, visible: true, assetId: res.assetId });
        }
        if (res) { stats.bgRaster++; fallbacks.push({ nodeId: node.id, reason: 'background-raster', box: res.box, clipped: res.clipped, ok: true }); }
      }
      delete node.bgRaster;
      const bgLayer = node.children.length && node.children[0].id === node.id + 'bg' ? [node.children.shift()] : [];
      const results = [];
      for (const c of node.children) {
        const done = c.type === 'text-pending' ? await buildText(c, node) : await finish(c, node);
        if (done && done.type === 'text' && c.type === 'text-pending') stats.text++;
        results.push(done || null);
      }
      const pre = [], post = [];   // DOM order: ::before in front of the children, ::after behind them (orderPseudos may move them)
      for (const p of pseudos) { const pn = await buildPseudo(p, node); if (pn) (p.which === 'before' ? pre : post).push(pn); }
      node.children = bgLayer.concat(pre, results.filter(Boolean), post);
      return node;
    }
    return node;
  }

  await iso.eval(css => { const s = document.createElement('style'); s.id = 'h2f-shot-css'; s.textContent = css; document.head.appendChild(s); }, [
    '[data-h2f-shotmode],[data-h2f-shotmode] body{background:transparent!important}',
    '[data-h2f-shotmode] [data-h2f-hide]{visibility:hidden!important}',
    // ancestors: keep layout, paint nothing of their own, no opacity/filter applied twice
    '[data-h2f-shotmode] [data-h2f-anc]{background:transparent!important;border-color:transparent!important;box-shadow:none!important;outline:none!important;-webkit-text-fill-color:transparent!important;opacity:1!important;filter:none!important;backdrop-filter:none!important}',
    '[data-h2f-shotmode] [data-h2f-anc]::before,[data-h2f-shotmode] [data-h2f-anc]::after{visibility:hidden!important}',
    '[data-h2f-shotmode] [data-h2f-shot]{opacity:1!important;-webkit-text-fill-color:currentcolor!important}',
    '[data-h2f-shotmode] [data-h2f-shot="self"]{color:transparent!important;-webkit-text-fill-color:transparent!important;box-shadow:none!important}',
    '[data-h2f-shotmode] [data-h2f-shot="self"] *,[data-h2f-shotmode] [data-h2f-shot="self"]::before,[data-h2f-shotmode] [data-h2f-shot="self"]::after{visibility:hidden!important}',
    // one pseudo-element only: the host paints nothing of its own, its children and its other pseudo-element are hidden
    '[data-h2f-shotmode] [data-h2f-shot^="pseudo-"]{background:transparent!important;border-color:transparent!important;box-shadow:none!important;outline:none!important;-webkit-text-fill-color:transparent!important;filter:none!important;backdrop-filter:none!important}',
    '[data-h2f-shotmode] [data-h2f-shot^="pseudo-"] *,[data-h2f-shotmode] [data-h2f-shot="pseudo-before"]::after,[data-h2f-shotmode] [data-h2f-shot="pseudo-after"]::before{visibility:hidden!important}',
    '[data-h2f-shotmode] [data-h2f-shot="pseudo-before"]::before,[data-h2f-shotmode] [data-h2f-shot="pseudo-after"]::after{-webkit-text-fill-color:currentcolor!important;opacity:1!important}',   // own opacity stays on the layer
  ].join('\n'));
  await finish(root, null);
  if (pseudoList.length) await orderPseudos(root);
  progress('building');
  await context.close();

  // page coords -> design coords: design origin (area.x, area.y) becomes (0,0) for every absBox and report box
  const shift = b => b && { ...b, x: r2(b.x - area.x), y: r2(b.y - area.y) };
  (function sh(n) { if (n !== root) n.absBox = shift(n.absBox); (n.children || []).forEach(sh); })(root);
  fallbacks.forEach(f => { f.box = shift(f.box); });
  // elements reaching outside the design area: Root Frame clips them; report the outermost ones
  // (descendants of a clipping ancestor that lies inside the area are already clipped by that ancestor)
  const overflow = [];
  (function ov(n, clippedInside) {
    for (const c of n.children || []) {
      const b = c.absBox, out = { left: r2(Math.max(0, -b.x)), top: r2(Math.max(0, -b.y)),
        right: r2(Math.max(0, b.x + b.width - area.width)), bottom: r2(Math.max(0, b.y + b.height - area.height)) };
      const outside = Object.values(out).some(v => v > 0.5);
      if (outside && !clippedInside && c.visible !== false) { overflow.push({ nodeId: c.id, name: c.name, type: c.type, absBox: b, beyondPx: out }); continue; }
      const inside = b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= area.width + 0.5 && b.y + b.height <= area.height + 0.5;
      ov(c, clippedInside || (c.clip && inside));
    }
  })(root, false);

  const design = {
    schemaVersion: SCHEMA_VERSION,
    capture: {
      source: path.basename(file), sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      capturedAt: new Date().toISOString(), browser: version,
      viewport: browserViewport, document: { width: area.width, height: area.height }, deviceScaleFactor: o.dpr, scroll: { x: 0, y: 0 },
      sourceDocument: walked.sourceDocument, designViewport: { width: area.width, height: area.height },
      designOrigin: { x: area.x, y: area.y }, designAreaMode: area.mode,
      detectedDesignRoot: picked ? { element: picked.element, label: picked.label, index: picked.index, sizeFrom: picked.sizeFrom } : null,
      detectionSource: picked ? picked.source : area.mode,
      scrollMode: o.expand.length ? 'full-content' : 'viewport', expandSelectors: o.expand, rasterSelectors: o.raster,
      injectedFonts: injectedFonts.map(f => ({ family: f.family, weight: f.weight, file: path.basename(f.file), sha256: f.sha256, status: f.status })),
    },
    root, assets,
    report: { fallbacks, unsupported, fontIssues: dedupe(fontIssues), warnings, overflowDesignArea: overflow },
  };
  if (pseudoList.length) design.report.pseudoElements = { ...pseudoStats, items: pseudoList };   // only on pages that have any
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(SCHEMA);
  const valid = validate(design);
  fs.writeFileSync(path.join(outDir, 'design.json'), JSON.stringify(design));
  // normalized copy for determinism checks: no timestamp, no base64 (asset sha256 stays)
  const norm = JSON.parse(JSON.stringify(design));
  delete norm.capture.capturedAt;
  for (const a of Object.values(norm.assets)) delete a.storage.base64;
  fs.writeFileSync(path.join(outDir, 'design.normalized.json'), JSON.stringify(norm, null, 2));

  const jsonBytes = fs.statSync(path.join(outDir, 'design.json')).size;
  const unsupportedByProp = {};
  for (const u of unsupported) unsupportedByProp[u.property] = (unsupportedByProp[u.property] || 0) + 1;
  const report = {
    source: file, outDir, capturedAt: design.capture.capturedAt, browser: version, ms: Date.now() - t0,
    schemaValid: valid, schemaErrors: valid ? [] : validate.errors.slice(0, 20),
    detectedDesignRoot: design.capture.detectedDesignRoot, detectionSource: design.capture.detectionSource,
    designWidth: area.width, designHeight: area.height, designOrigin: design.capture.designOrigin,
    browserViewport, sourceDocumentSize: walked.sourceDocument, overflowDesignArea: overflow,
    designRootsFound: detection ? detection.roots.map(r => ({ index: r.index, element: r.element, label: r.label, width: r.width, height: r.height, x: r.x, y: r.y, source: r.source })) : null,
    previewSize: detection ? detection.previews : null, detectionNotes: detection ? detection.notes : [],
    designAreaMode: area.mode, scrollMode: design.capture.scrollMode,
    stats: { ...stats, assets: Object.keys(assets).length, jsonKB: Math.round(jsonBytes / 1024) },
    fonts: Object.values(fontUse).sort((a, b) => b.chars - a.chars),
    injectedFonts, primaryFontFallback: Object.values(primaryFallback).sort((a, b) => b.chars - a.chars),
    fontIssues: design.report.fontIssues, fallbacks, unsupportedSummary: unsupportedByProp, unsupported, warnings,
    pseudoElements: design.report.pseudoElements || null,
  };
  fs.writeFileSync(path.join(outDir, 'capture-report.json'), JSON.stringify(report, null, 2));
  return report;
}

function stripWeight(f) { return (f || '').replace(/\s+(Thin|Hairline|ExtraLight|Extra Light|UltraLight|Light|Regular|Book|Medium|Med|SemiBold|Semi Bold|DemiBold|Bold|ExtraBold|Extra Bold|Heavy|Black)$/i, ''); }
function dedupe(list) { const seen = new Set(); return list.filter(x => { const k = JSON.stringify([x.issue, x.usedFamily, x.postScript, x.cssFamilies, x.nodeId]); if (seen.has(k)) return false; seen.add(k); return true; }); }

function printSummary(r) {
  const s = r.stats;
  console.log(`\n>> ${path.basename(r.source)}  (${(r.ms / 1000).toFixed(1)} s)`);
  console.log(`  out: ${r.outDir}`);
  console.log(`  schema valid: ${r.schemaValid}${r.schemaValid ? '' : '  <-- see capture-report.json schemaErrors'}`);
  console.log(`  nodes: frame ${s.frame}, text ${s.text}, image ${s.image}, vector ${s.vector}, raster ${s.raster}, bg-raster ${s.bgRaster} | assets ${s.assets} | design.json ${s.jsonKB} KB`);
  const dr = r.detectedDesignRoot;
  console.log(`  design: ${r.designWidth}x${r.designHeight} at (${r.designOrigin.x},${r.designOrigin.y})  from ${r.detectionSource}${dr ? ` — ${dr.label ? '"' + dr.label + '" ' : ''}${dr.element}` : ''}`);
  console.log(`  browser viewport ${r.browserViewport.width}x${r.browserViewport.height}, source document ${r.sourceDocumentSize.width}x${r.sourceDocumentSize.height}`);
  for (const n of r.detectionNotes || []) console.log('  ! ' + n);
  if (r.overflowDesignArea.length) console.log(`  clipped at Root Frame (outside design area): ${r.overflowDesignArea.map(v => v.nodeId + ' ' + v.name.slice(0, 20)).join(', ')}`);
  console.log('  fonts used by Chrome (postScript | family | chars):');
  for (const f of r.fonts.slice(0, 12)) console.log(`    ${String(f.postScript).padEnd(28)} ${String(f.usedFamily).padEnd(24)} ${f.chars}`);
  const fb = r.fontIssues.filter(f => f.issue === 'browser-fallback');
  if (fb.length) console.log(`  ! Chrome used a font NOT in the CSS stack for ${new Set(fb.map(f => f.postScript)).size} font(s): ${[...new Set(fb.map(f => f.usedFamily))].join(', ')}  (font not installed?)`);
  for (const p of r.primaryFontFallback) console.log(`  ! first CSS font not used: "${p.requested}" -> ${p.used} (${p.chars} chars, ${p.runs} runs) e.g. "${p.examples[0].text}"`);
  const np = r.fontIssues.filter(f => f.issue === 'no-platform-font').length;
  if (np) console.log(`  ! ${np} text run(s) without platform font info`);
  const fbk = {}; r.fallbacks.forEach(f => fbk[f.reason] = (fbk[f.reason] || 0) + 1);
  console.log(`  raster fallbacks: ${Object.entries(fbk).map(([k, v]) => `${k} x${v}`).join(', ') || '-'}`);
  console.log(`  unsupported (ignored/approximated): ${Object.entries(r.unsupportedSummary).map(([k, v]) => `${k} x${v}`).join(', ') || '-'}`);
  if (r.warnings.length) console.log(`  warnings: ${r.warnings.length} (first: ${r.warnings[0]})`);
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const { browser, how, version } = await launch();
  // Local Helper (parent with an IPC channel) asks us to stop: close the browser properly (Playwright removes its
  // temporary profile), then exit. Not active when run from the command line.
  if (process.send) process.on('message', m => { if (m === 'h2f-stop') browser.close().catch(() => {}).finally(() => process.exit(130)); });
  // Ctrl+C in the Helper's console reaches this child too (Windows sends it to every process in the console):
  // leave the decision to the Helper, which stops us through the message above.
  if (process.send) for (const sig of ['SIGINT', 'SIGBREAK']) process.on(sig, () => {});
  console.log(`browser: ${version}  (${how})  ${o.viewportGiven ? `viewport ${o.width}x${o.height}` : 'viewport = design size'} @${o.dpr}x`);
  let failed = 0, exitCode = 0;
  for (const f of o.files) {
    try {
      const r = await captureOne(browser, version, f, o);
      if (Array.isArray(r)) for (const i of r) printSummary(await captureOne(browser, version, f, o, i));   // --design-root all
      else printSummary(r);
    }
    catch (e) { failed++; exitCode = Math.max(exitCode, e.exitCode || 1); console.error(`\nSTOPPED ${f}\n  ${e.expected ? e.message : e.stack || e.message}`); }
  }
  await browser.close();
  console.log(`\ndone: ${o.files.length - failed}/${o.files.length} file(s). Import each design.json with the "HTML to Figma (Playwright capture)" plugin.`);
  process.exit(failed ? exitCode : 0);
})();
