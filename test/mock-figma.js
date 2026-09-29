// Minimal Figma API mock (from spikes/test/mock-figma.js) to run the plugin outside Figma.
// It checks that every design.json node becomes a layer and that the plugin does not throw.
// No rendering fidelity: rotated boxes and text widths are not simulated, so "geometry" here is not meaningful.
//   node test/mock-figma.js out\<file>\<W>x<H>\design.json [figma-plugin\code.js]
const fs = require('fs'), path = require('path'), vm = require('vm');

function createMock(fontFamilies) {
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
      n.setRangeFontName = (s, e) => { if (s < 0 || e > chars.length || s >= e) throw new Error(`bad range ${s}-${e}/${chars.length}`); };
      let auto = 'WIDTH_AND_HEIGHT';
      Object.defineProperty(n, 'textAutoResize', { get: () => auto, set(v) { auto = v; const lh = (n.lineHeight && n.lineHeight.value) || 20; const lines = chars.split(/\n|\u2028/).length; if (v !== 'NONE') n.height = lines * lh; } });
    }
    return n;
  }
  const fonts = fontFamilies.flatMap(f => ['Regular', 'Medium', 'Bold'].map(s => ({ fontName: { family: f, style: s } })));
  const outbox = [];
  const figma = {
    showUI() {}, ui: { postMessage: m => { if (m.type !== 'progress' && m.type !== 'config') outbox.push(m); }, onmessage: null },
    listAvailableFontsAsync: async () => fonts,
    loadFontAsync: async f => { if (!fonts.some(x => x.fontName.family === f.family && x.fontName.style === f.style)) throw new Error('font not available ' + JSON.stringify(f)); },
    createText: () => node('TEXT'), createFrame: () => node('FRAME'), createRectangle: () => node('RECTANGLE'), createEllipse: () => node('ELLIPSE'),
    createImage: b => ({ hash: 'h' + b.length }), base64Decode: s => Buffer.from(s, 'base64'),
    currentPage: node('PAGE'), viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
    getNodeByIdAsync: async () => ({ exportAsync: async () => new Uint8Array(3) }),
    createNodeFromSvg: svg => { if (!/^<svg[\s>]/.test(svg.trim())) throw new Error('bad svg'); const f = node('FRAME'); const m = svg.match(/width="([\d.]+)" height="([\d.]+)"/); if (m) f.resize(+m[1], +m[2]); return f; },
    clientStorage: { getAsync: async () => null, setAsync: async () => {} },
  };
  return { figma, outbox };
}

// Runs one import with the given plugin code; resolves to the plugin's import-result message.
async function mockImport(design, codePath = path.join(__dirname, '..', 'figma-plugin', 'code.js'), opts = {}) {
  const families = opts.fontFamilies || ['Inter', 'Noto Sans Thai', 'DB Ozone X', 'IBM Plex Sans Thai', 'Anuphan'];
  const { figma, outbox } = createMock(families);
  const ctx = vm.createContext({ figma, __html__: '', console, Math, JSON, Object, Array, String, Number, Promise });
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx);
  const config = opts.config || { fontMap: {}, families: { 'DB Ozone X': { 400: 'Regular', 500: 'Medium', 700: 'Bold' }, 'Noto Sans Thai': { 400: 'Regular', 500: 'Medium', 700: 'Bold' } }, fallback: { family: 'Inter', style: 'Regular' } };
  await figma.ui.onmessage({ type: 'import', data: design, config, lineMode: opts.lineMode || 'ls' });
  const m = outbox.pop();
  if (!m || m.type === 'error') throw new Error('plugin error: ' + (m && m.message));
  return m;
}
module.exports = { mockImport };

if (require.main === module) {
  (async () => {
    const design = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
    const m = await mockImport(design, process.argv[3] ? path.resolve(process.argv[3]) : undefined);
    const s = m.summary || {};
    console.log(`mock import ok: design ${s.designSize ? s.designSize.width + 'x' + s.designSize.height : '?'}, layers ${m.elements}` +
      `${s.layers ? '/' + s.layers.expected : ''}, missing ${m.report.missing.length}, substituted fonts ${(s.substitutedFonts || []).length}, unsupported ${(s.unsupported || []).map(u => u.feature + ' x' + u.count).join('; ') || '-'}`);
  })().catch(e => { console.error('FAIL', e.message); process.exit(1); });
}
