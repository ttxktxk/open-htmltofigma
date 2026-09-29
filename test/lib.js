// Shared helpers for smoke / regression tests.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
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
function comparable(norm) {
  const c = JSON.parse(JSON.stringify(norm));
  delete c.schemaVersion; delete c.capture.capturedAt; delete c.capture.browser;
  return c;
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
function nodeStats(design) {
  const types = {}; let total = 0; const lines = {}; const fonts = new Set();
  walkNodes(design.root, n => {
    total++; types[n.type] = (types[n.type] || 0) + 1;
    if (n.type === 'text') { lines[n.id] = n.visualLines.length; (n.runs || []).forEach(r => r.postScript && fonts.add(r.postScript)); }
  });
  return { total, types, lines, fonts: [...fonts].sort() };
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

module.exports = { INPUTS_DIR, inputMap, baselineInput, baselineForSource, ROOT, PROD_CLI, SPIKE_CLI, runCapture, findDesigns, readJson, comparable, firstDiff, walkNodes, nodeStats, pixelDiff, harness };
