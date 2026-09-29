// Shared helpers for smoke / regression tests.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const { inputDirRedactor } = require('../capture/redact');
const ROOT = path.join(__dirname, '..');

// Runs a capture CLI (production capture/cli.js or spikes/capture.js) in a child process.
function runCapture(cli, args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const PROD_CLI = path.join(ROOT, 'capture', 'cli.js');
const SPIKE_CLI = path.join(ROOT, 'spikes', 'capture.js');

// every design.json below dir (out/<file>/<WxH>/design.json or out/<file>/<root>/<WxH>/design.json)
function findDesigns(dir) {
  const out = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name === 'design.json') out.push(path.dirname(p));
  } })(dir);
  return out.sort();
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// normalized design.json minus fields that legitimately differ between the spike and production CLIs
// file: the captured HTML path. Its folder is machine-specific; the spike CLI does not redact it (production does),
// and it truncates the URL before redaction, so failed-request URLs are compared by warning type + error only.
function comparable(norm, file) {
  const c = JSON.parse(JSON.stringify(norm));
  delete c.schemaVersion; delete c.capture.capturedAt; delete c.capture.browser;
  if (file && c.report) {
    const redact = inputDirRedactor(file);
    c.report.warnings = (c.report.warnings || []).map(w => redact(w).replace(/^request failed: .* \((?=[^()]*\)$)/, 'request failed: <url> ('));
    (c.report.fallbacks || []).forEach(f => { if (f.detail) f.detail = redact(f.detail); });
  }
  return c;
}

// every asset reference in the tree exists in the assets map, and every asset is referenced
function assetRefs(design) {
  const used = new Set();
  walkNodes(design.root, n => {
    for (const k of ['assetId', 'fallbackAssetId']) if (n[k]) used.add(n[k]);
    for (const f of n.fills || []) if (f.assetId) used.add(f.assetId);
  });
  const have = new Set(Object.keys(design.assets || {}));
  return { missing: [...used].filter(a => !have.has(a)), orphan: [...have].filter(a => !used.has(a)), used: used.size };
}

// Why two captures of the same page have different asset ids: pair nodes by id and compare the decoded images
// (dimensions, RGBA hash, differing pixels, PNG bytes). Needs full design.json files (with base64).
function explainAssetDiff(a, b, max = 8) {
  const { PNG } = require('pngjs'), crypto = require('crypto');
  const refs = d => { const m = {}; walkNodes(d.root, n => { for (const k of ['assetId', 'fallbackAssetId']) if (n[k]) m[n.id + '.' + k] = n[k]; (n.fills || []).forEach((f, i) => { if (f.assetId) m[`${n.id}.fills[${i}]`] = f.assetId; }); }); return m; };
  const ra = refs(a), rb = refs(b), out = [];
  for (const k of Object.keys({ ...ra, ...rb })) {
    if (ra[k] === rb[k]) continue;
    const dec = (d, id) => { const e = d.assets[id]; if (!e) return null; const buf = Buffer.from(e.storage.base64, 'base64');
      const p = e.mime === 'image/png' ? PNG.sync.read(buf) : null; return { bytes: buf.length, w: p && p.width, h: p && p.height, px: p && p.data, rgba: p && crypto.createHash('sha256').update(p.data).digest('hex').slice(0, 12) }; };
    const x = ra[k] && dec(a, ra[k]), y = rb[k] && dec(b, rb[k]);
    let diffPx = null, maxD = 0;
    if (x && y && x.px && y.px && x.w === y.w && x.h === y.h) {
      diffPx = 0;
      for (let i = 0; i < x.px.length; i += 4) { const m = Math.max(...[0, 1, 2, 3].map(j => Math.abs(x.px[i + j] - y.px[i + j]))); if (m) { diffPx++; maxD = Math.max(maxD, m); } }
    }
    out.push({ ref: k, a: ra[k], b: rb[k], size: x && y ? `${x.w}x${x.h} vs ${y.w}x${y.h}` : 'missing on one side',
      samePixels: !!(x && y && x.rgba && x.rgba === y.rgba), diffPx, maxChannelDiff: maxD, pngBytes: x && y ? `${x.bytes} vs ${y.bytes}` : null });
    if (out.length >= max) break;
  }
  return out;
}
// first difference between two JSON values (path + both values), or null
function firstDiff(a, b, p = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return { path: p, a: short(a), b: short(b) };
  if (Array.isArray(a) !== Array.isArray(b)) return { path: p, a: 'array?', b: 'array?' };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  return null;
}
const short = v => { const s = JSON.stringify(v); return s && s.length > 120 ? s.slice(0, 120) + '…' : s; };

function walkNodes(n, fn, parent = null) { fn(n, parent); for (const c of n.children || []) walkNodes(c, fn, n); }
// Font identity that does not depend on the OS: family (weight words removed) | CSS weight | CSS style.
// Needed because the PostScript name Chrome reports for the SAME variable-font file differs per platform:
// Anuphan (variable) is "Anuphan-Regular" on Linux/FreeType for every weight, but "Anuphan" (400) and
// "Anuphan-Medium" (500) on Windows/DirectWrite. A real fallback still changes the family and is caught.
const WEIGHT_WORDS = /\s+(Thin|Hairline|ExtraLight|Extra Light|UltraLight|Light|Regular|Book|Medium|Med|SemiBold|Semi Bold|DemiBold|Bold|ExtraBold|Extra Bold|Heavy|Black)$/i;
const familyOf = f => String(f || '').replace(WEIGHT_WORDS, '').trim();
const fontFace = (run, style) => `${familyOf(run.usedFamily)}|${style.weight}|${style.style || 'normal'}`;
// osFallback: PostScript names the capture reported as browser fallback for glyphs no page font has (e.g. "●")
function nodeStats(design, osFallback = new Set()) {
  const types = {}; let total = 0; const lines = {}; const fonts = new Set(), faces = new Set();
  walkNodes(design.root, n => {
    total++; types[n.type] = (types[n.type] || 0) + 1;
    if (n.type === 'text') {
      lines[n.id] = n.visualLines.length;
      (n.runs || []).forEach(r => { if (!r.postScript || osFallback.has(r.postScript)) return; fonts.add(r.postScript); faces.add(fontFace(r, n.style)); });
    }
  });
  return { total, types, lines, fonts: [...fonts].sort(), faces: [...faces].sort() };
}

// reference.png vs rerender.png: % of pixels whose max channel differs by > 40/255,
// split into text/anti-aliasing (text boxes + icon vectors <= 64px, dilated 2px) and layout (everything else).
function pixelDiff(dir) {
  const { PNG } = require('pngjs');
  const a = PNG.sync.read(fs.readFileSync(path.join(dir, 'reference.png')));
  const b = PNG.sync.read(fs.readFileSync(path.join(dir, 'rerender.png')));
  const d = readJson(path.join(dir, 'design.json'));
  const S = d.capture.deviceScaleFactor || 2;
  const W = Math.min(a.width, b.width), H = Math.min(a.height, b.height);
  const mask = new Uint8Array(W * H);
  walkNodes(d.root, n => {
    const q = n.absBox;
    if (!(n.type === 'text' || (n.type === 'vector' && q.width <= 64 && q.height <= 64))) return;
    const x0 = Math.max(0, Math.floor((q.x - 2) * S)), y0 = Math.max(0, Math.floor((q.y - 2) * S));
    const x1 = Math.min(W, Math.ceil((q.x + q.width + 2) * S)), y1 = Math.min(H, Math.ceil((q.y + q.height + 2) * S));
    for (let y = y0; y < y1; y++) mask.fill(1, y * W + x0, y * W + Math.max(x0, x1));
  });
  let diff = 0, text = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ia = (y * a.width + x) * 4, ib = (y * b.width + x) * 4;
    const m = Math.max(Math.abs(a.data[ia] - b.data[ib]), Math.abs(a.data[ia + 1] - b.data[ib + 1]), Math.abs(a.data[ia + 2] - b.data[ib + 2]));
    if (m > 40) { diff++; if (mask[y * W + x]) text++; }
  }
  const pct = v => Math.round(v / (W * H) * 1e5) / 1e3;
  return { totalPct: pct(diff), textAAPct: pct(text), layoutPct: pct(diff - text), size: [W / S, H / S] };
}

// tiny test harness
function harness(title) {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return !!ok; };
  const finish = () => {
    const failed = results.filter(r => !r.ok);
    console.log(`\n${title}: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — FAILED: ' + failed.map(f => f.name).join('; ') : ''}`);
    return failed.length ? 1 : 0;
  };
  return { check, finish, results };
}

// Regression inputs are private and gitignored. A baseline's HTML is regression/inputs/<name>.html, or the real
// file name given in regression/inputs/inputs.json ({ "<baseline name>": "<real file name>.html" }, also gitignored).
const INPUTS_DIR = path.join(ROOT, 'regression', 'inputs');
function inputMap(dir = INPUTS_DIR) { const f = path.join(dir, 'inputs.json'); return fs.existsSync(f) ? readJson(f) : {}; }
function baselineInput(b, dir = INPUTS_DIR) { return path.join(dir, inputMap(dir)[b.name] || b.file); }
function baselineForSource(baselines, source, dir = INPUTS_DIR) {
  const map = inputMap(dir);
  return baselines.find(b => b.file === source || map[b.name] === source);
}

module.exports = { assetRefs, explainAssetDiff, fontFace, familyOf, INPUTS_DIR, inputMap, baselineInput, baselineForSource, ROOT, PROD_CLI, SPIKE_CLI, runCapture, findDesigns, readJson, comparable, firstDiff, walkNodes, nodeStats, pixelDiff, harness };
