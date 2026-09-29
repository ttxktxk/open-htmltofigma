// npm run check:import -- "C:\path\to\import-result.json"
// Checks the result JSON downloaded from the Figma plugin ("Download result JSON") against the MVP-A acceptance criteria.
// If the source HTML is one of the regression baselines, design size and layer count are compared with it too.
const fs = require('fs'), path = require('path');
const { ROOT, readJson, harness, baselineForSource } = require('./lib');

const file = process.argv[2];
if (!file) { console.error('Usage: npm run check:import -- "C:\\path\\to\\import-result.json"'); process.exit(2); }
const m = readJson(path.resolve(file));
if (m.type !== 'import-result') { console.error('Not an import-result.json from the plugin'); process.exit(2); }
const t = harness('check:import');
const s = m.summary;   // present from the MVP-A plugin on

const osFallback = new Set((m.captureReport.fontIssues || []).filter(f => f.issue === 'browser-fallback').map(f => f.postScript));
const substituted = m.fonts.filter(f => f.status !== 'exact' && f.status !== 'mapped');
const unexpected = substituted.filter(f => !osFallback.has(f.requested));

console.log(`${m.source || '(source not recorded)'} — ${s ? `design ${s.designSize.width}x${s.designSize.height}, ` : ''}${m.elements} layers`);
if (s) t.check('every design.json node became a layer', s.layers.created === s.layers.expected, `${s.layers.created}/${s.layers.expected}`);
t.check('no missing layers', !m.report.missing.length, m.report.missing.slice(0, 3).map(x => x.nodeId + ' ' + x.reason).join('; '));
t.check('geometry within ±2 px of Chrome', !m.geometryFailures, m.report.geometry.slice(0, 5).map(g => `${g.nodeId} Δ${g.maxDeltaPx}`).join(', '));
t.check('line breaks = Chrome', !m.textLineMismatch, m.report.text.filter(x => x.expectedLines !== x.gotLines).slice(0, 5).map(x => x.nodeId).join(', '));
t.check('fonts and weights resolved (only OS-fallback glyphs substituted)', !unexpected.length,
  unexpected.map(f => `${f.requested} -> ${f.resolved}`).join(', ') + (substituted.length > unexpected.length ? ` · expected substitutions: ${substituted.filter(f => osFallback.has(f.requested)).map(f => f.requested).join(', ')}` : ''));
const overflow = m.report.text.filter(x => x.overflowPx > 2);
t.check('text does not overflow its box by > 2 px', !overflow.length, overflow.slice(0, 5).map(x => `${x.nodeId} ${x.overflowPx}px`).join(', '));

const base = baselineForSource(readJson(path.join(ROOT, 'regression', 'baselines.json')).baselines, m.source);
if (base && s) {
  t.check(`baseline "${base.name}": Root Frame = ${base.designSize.join('x')}`, s.designSize.width === base.designSize[0] && s.designSize.height === base.designSize[1]);
  t.check(`baseline "${base.name}": ${base.layers} layers`, m.elements === base.layers, `${m.elements}`);
}
if (s && s.unsupported.length) console.log('\nunsupported (accepted MVP-A limits): ' + s.unsupported.map(u => `${u.feature} x${u.count}`).join('; '));
process.exit(t.finish());
