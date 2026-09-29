// npm run asset-diff -- "run1\design.json" "run2\design.json"
// Two captures of the same page with different asset ids: pairs the nodes and compares each differing image —
// dimensions, decoded RGBA hash, number of differing pixels, largest channel difference, PNG byte size.
// "same pixels: true" with different bytes = encoding only; "same pixels: false" = the browser drew something else.
const fs = require('fs'), path = require('path');
const { explainAssetDiff } = require('./lib');
const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('Usage: npm run asset-diff -- <design.json> <design.json>'); process.exit(2); }
const rows = explainAssetDiff(JSON.parse(fs.readFileSync(path.resolve(a), 'utf8')), JSON.parse(fs.readFileSync(path.resolve(b), 'utf8')), 1000);
if (!rows.length) { console.log('All asset references are identical.'); process.exit(0); }
for (const r of rows) console.log(`${r.ref}: ${r.a} vs ${r.b} · ${r.size} · same pixels: ${r.samePixels} · differing px: ${r.diffPx} · max channel diff: ${r.maxChannelDiff} · png bytes: ${r.pngBytes}`);
console.log(`\n${rows.length} differing asset reference(s)`);
process.exit(1);
