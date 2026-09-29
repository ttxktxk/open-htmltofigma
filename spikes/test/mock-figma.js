// Minimal Figma API mock to smoke-test figma-plugin/code.js outside Figma (no rendering fidelity).
const fs = require('fs'), path = require('path'), vm = require('vm');
let idn = 0;
function node(type) {
  const n = { id: 'm' + (++idn), type, x: 0, y: 0, width: 100, height: 20, children: [], fills: [], pluginData: {},
    appendChild(c) { this.children.push(c); c.parent = this; },
    resize(w, h) { this.width = w; this.height = h; },
    setPluginData(k, v) { this.pluginData[k] = v; },
    get absoluteTransform() { let x = 0, y = 0, p = this; while (p) { x += p.x; y += p.y; p = p.parent; } return [[1, 0, x], [0, 1, y]]; },
    get absoluteBoundingBox() { const t = this.absoluteTransform; return { x: t[0][2], y: t[1][2], width: this.width, height: this.height }; },
    get absoluteRenderBounds() { return this.absoluteBoundingBox; },
    async exportAsync() { return new Uint8Array([1, 2, 3]); } };
  if (type === 'TEXT') {
    let chars = '';
    Object.defineProperty(n, 'characters', { get: () => chars, set(v) { chars = v; } });
    n.setRangeFontName = (s, e, f) => { if (s < 0 || e > chars.length || s >= e) throw new Error(`bad range ${s}-${e}/${chars.length}`); };
    let auto = 'WIDTH_AND_HEIGHT';
    Object.defineProperty(n, 'textAutoResize', { get: () => auto, set(v) { auto = v; const lh = (n.lineHeight && n.lineHeight.value) || 20; const lines = chars.split(new RegExp('\\n|\\u2028')).length; if (v !== 'NONE') n.height = lines * lh; } });
  }
  return n;
}
const fonts = ['Inter', 'Noto Sans Thai'].flatMap(f => ['Regular', 'Medium', 'Bold'].map(s => ({ fontName: { family: f, style: s } })));
const outbox = [];
const progress = [];
const figma = {
  showUI() {}, ui: { postMessage: m => (m.type === 'progress' || m.type === 'config' ? progress : outbox).push(m), onmessage: null },
  listAvailableFontsAsync: async () => fonts,
  loadFontAsync: async f => { if (!fonts.some(x => x.fontName.family === f.family && x.fontName.style === f.style)) throw new Error('font not available ' + JSON.stringify(f)); },
  createText: () => node('TEXT'), createFrame: () => node('FRAME'), createRectangle: () => node('RECTANGLE'), createEllipse: () => node('ELLIPSE'),
  createImage: b => ({ hash: 'h' + b.length }), base64Decode: s => Buffer.from(s, 'base64'),
  currentPage: node('PAGE'), viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
  getNodeByIdAsync: async id => ({ exportAsync: async () => new Uint8Array(3) }),
  createNodeFromSvg: svg => { if (!/^<svg[\s>]/.test(svg.trim())) throw new Error('bad svg'); const f = node('FRAME'); const m = svg.match(/width="([\d.]+)" height="([\d.]+)"/); if (m) f.resize(+m[1], +m[2]); return f; },
  clientStorage: { getAsync: async () => null, setAsync: async () => {} },
};
const ctx = vm.createContext({ figma, __html__: '', console, Math, JSON, Object, Array, String, Number, Promise });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../figma-plugin/code.js'), 'utf8'), ctx);
const cfg = { fontMap: {}, families: { 'Noto Sans Thai': { 400: 'Regular', 500: 'Medium', 700: 'Bold' } }, fallback: { family: 'Inter', style: 'Regular' } };
(async () => {
  await figma.ui.onmessage({ type: 'text-spike', data: require('../out/text-lines.json'), config: cfg });
  let m = outbox.pop();
  if (m.type === 'error') throw new Error(m.message);
  console.log('text spike ok:', m.rows.length, 'cells;', m.summary.map(s => s.method + ' ' + s.pct + '%').join(', '));
  console.log('fonts:', m.figmaFonts.map(f => `${f.status} ${f.requested}->${f.resolved}`).join(' | '));
  for (const mode of ['ls', 'nl', 'none']) {
    await figma.ui.onmessage({ type: 'import', data: JSON.parse(fs.readFileSync(path.resolve(process.argv[2] || path.join(__dirname, '../out/e2e-spike/design.json')), 'utf8')), config: cfg, lineMode: mode });
    m = outbox.pop();
    if (m.type === 'error') throw new Error(m.message);
    console.log(`import ${mode} ok: elements ${m.elements}, geometry fails ${m.geometryFailures}, missing ${m.report.missing.length}, approximations ${m.report.approximations.map(a => a.what).join(',') || '-'}`);
    if (m.report.geometry.length) console.log('  geometry fails:', m.report.geometry.map(g => g.nodeId + ':' + g.type + ':' + g.maxDeltaPx).slice(0, 6).join(' '));
    const conv = {}; (m.report.converted || []).forEach(c => { const k = c.what.split(' (')[0].replace(/ \d.*$/, ''); conv[k] = (conv[k] || 0) + 1; });
    console.log('  converted:', JSON.stringify(conv), '| approximations:', m.report.approximations.map(a => a.nodeId + ':' + a.what).join(', ') || '-');
  }
  await figma.ui.onmessage({ type: 'export-png', rootId: 'x', scale: 2, name: 'a.png' });
  console.log('export ok:', outbox.pop().type);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
