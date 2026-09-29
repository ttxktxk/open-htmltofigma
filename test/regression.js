// npm run test:regression — the two real Claude Design exports that passed in Figma are the baseline.
//
//   npm run test:regression                      (inputs from regression\inputs\, see regression\README.md)
//   npm run test:regression -- --inputs "C:\path\to\folder"
//   npm run test:regression -- --update          rewrite the expectations in regression\baselines.json
//
// Per baseline file:
//   1. Root Frame = expected design size, detected from the file itself
//   2. production capture == spikes/capture.js capture on the same machine (normalized design.json) -> no regression
//   3. capture twice -> identical normalized design.json (determinism)
//   4. layer counts per type, line breaks of every text node, fonts used, unsupported CSS = baselines.json
//   5. rerender(design.json) vs Chrome reference.png: layout difference <= maxLayoutPct
//   6. mock Figma import with the production plugin == the spike plugin (layers, conversions, fonts); no missing layers
const fs = require('fs'), path = require('path');
const { baselineInput, INPUTS_DIR, ROOT, PROD_CLI, SPIKE_CLI, runCapture, readJson, comparable, firstDiff, nodeStats, pixelDiff, harness } = require('./lib');
const { mockImport } = require('./mock-figma');
const { launch, openPage } = require('../capture/browser');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const UPDATE = args.includes('--update');
const BASE_FILE = path.join(ROOT, 'regression', 'baselines.json');
const INPUTS = path.resolve(opt('--inputs') || INPUTS_DIR);
const OUT = path.resolve(opt('--out') || path.join(ROOT, 'regression', 'out'));

// the page's own @font-face rules (fonts embedded in the bundle) -> CSS file for the rerender
async function pageFontCss(browser, file, cssPath) {
  const { context, page } = await openPage(browser, file, { width: 1280, height: 800, dpr: 1 });
  const css = await page.evaluate(async () => {
    const out = [];
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (!(r instanceof CSSFontFaceRule)) continue;
        let t = r.cssText;
        for (const m of [...t.matchAll(/url\("?([^")]+)"?\)/g)]) {
          if (m[1].startsWith('data:')) continue;
          try {
            const blob = await (await fetch(m[1])).blob();
            const data = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
            t = t.split(m[1]).join(data);
          } catch (e) { /* keep url */ }
        }
        out.push(t);
      }
    }
    return out.join('\n');
  });
  await context.close();
  fs.writeFileSync(cssPath, css);
}

function unsupportedSummary(rep) { const s = {}; for (const u of rep.unsupported) s[u.property] = (s[u.property] || 0) + 1; return s; }
function convertedSummary(m) { const s = {}; for (const c of m.report.converted || []) { const k = c.what.split(' (')[0].replace(/ -?\d.*$/, ''); s[k] = (s[k] || 0) + 1; } return s; }
function fontStatus(m) { return m.fonts.map(f => `${f.requested}=${f.status}`).sort(); }

(async () => {
  const t = harness('npm run test:regression');
  const base = readJson(BASE_FILE);
  fs.mkdirSync(OUT, { recursive: true });
  const { browser } = await launch();
  for (const b of base.baselines) {
    const file = baselineInput(b, INPUTS);
    console.log(`\n== ${b.name}`);
    if (!t.check(`${b.name}: input file present`, fs.existsSync(file), fs.existsSync(file) ? '' : `missing ${file} — put the HTML in ${INPUTS} as ${b.file} or map it in inputs.json (see regression/README.md)`)) continue;
    const [W, H] = b.designSize;
    const sub = `${W}x${H}`;
    const cap = (cli, tag) => {
      const out = path.join(OUT, tag);
      fs.rmSync(out, { recursive: true, force: true });
      const r = runCapture(cli, [file, '--out', out]);
      const dirs = fs.existsSync(out) ? fs.readdirSync(out).map(d => path.join(out, d, sub)).filter(d => fs.existsSync(path.join(d, 'design.json'))) : [];
      return { r, dir: dirs[0] };
    };
    const prod = cap(PROD_CLI, 'production');
    if (!t.check(`${b.name}: production capture ok, output in <file>\\${sub}`, prod.r.code === 0 && prod.dir, prod.r.code ? prod.r.out.slice(-300) : '')) continue;
    const d = readJson(path.join(prod.dir, 'design.json')), rep = readJson(path.join(prod.dir, 'capture-report.json'));
    const norm = readJson(path.join(prod.dir, 'design.normalized.json'));

    // 1. design size
    t.check(`${b.name}: Root Frame = ${W}x${H} from ${b.detectionSource}`, d.root.box.width === W && d.root.box.height === H && rep.detectionSource === b.detectionSource,
      `${d.root.box.width}x${d.root.box.height} from ${rep.detectionSource}, viewport ${rep.browserViewport.width}x${rep.browserViewport.height}`);
    t.check(`${b.name}: schema valid`, rep.schemaValid);

    // 2. production == spike
    const spike = cap(SPIKE_CLI, 'spike');
    const diff = spike.dir ? firstDiff(comparable(norm), comparable(readJson(path.join(spike.dir, 'design.normalized.json')))) : { path: 'spike capture failed', a: '', b: spike.r.out.slice(-200) };
    t.check(`${b.name}: production design.json == spikes/capture.js (no regression)`, !diff, diff ? `${diff.path}: ${diff.a} vs ${diff.b}` : '');

    // 3. determinism
    const again = cap(PROD_CLI, 'production-2');
    const d2 = again.dir && firstDiff(norm, readJson(path.join(again.dir, 'design.normalized.json')));
    t.check(`${b.name}: re-capture gives identical normalized design.json`, again.dir && !d2, d2 ? `${d2.path}: ${d2.a} vs ${d2.b}` : '');

    // 4. structure, line breaks, fonts, unsupported
    const st = nodeStats(d);
    // glyphs none of the page fonts have (e.g. "●") fall back to an OS font whose name differs per machine: not part of the baseline
    const osFallback = new Set((rep.fontIssues || []).filter(f => f.issue === 'browser-fallback').map(f => f.postScript));
    st.fonts = st.fonts.filter(f => !osFallback.has(f));
    if (UPDATE) Object.assign(b, { layers: st.total, layerTypes: st.types, fonts: st.fonts, textLines: st.lines, unsupported: unsupportedSummary(rep) });
    t.check(`${b.name}: ${b.layers} layers (${Object.entries(b.layerTypes).map(([k, v]) => k + ' ' + v).join(', ')})`, st.total === b.layers && !firstDiff(st.types, b.layerTypes),
      `got ${st.total} ${JSON.stringify(st.types)}`);
    const lineDiff = Object.keys({ ...b.textLines, ...st.lines }).filter(k => b.textLines[k] !== st.lines[k]);
    t.check(`${b.name}: line breaks of all ${Object.keys(b.textLines).length} text layers = baseline`, !lineDiff.length, lineDiff.slice(0, 5).join(', '));
    t.check(`${b.name}: fonts used by Chrome = baseline`, !firstDiff(st.fonts, b.fonts), `got ${st.fonts.join(', ')}`);
    const noPrimaryFallback = !(rep.primaryFontFallback || []).length;
    t.check(`${b.name}: first CSS font used everywhere (no silent font fallback)`, noPrimaryFallback, JSON.stringify(rep.primaryFontFallback).slice(0, 200));
    t.check(`${b.name}: unsupported CSS = baseline (known MVP-A limits only)`, !firstDiff(unsupportedSummary(rep), b.unsupported), JSON.stringify(unsupportedSummary(rep)));
    t.check(`${b.name}: nothing outside the design area`, !rep.overflowDesignArea.length);

    // 5. rerender vs Chrome
    const css = path.join(OUT, 'page-fonts.css');
    await pageFontCss(browser, file, css);
    runCapture(path.join(ROOT, 'test', 'render-design.js'), [path.join(prod.dir, 'design.json'), '', css]);
    const px = pixelDiff(prod.dir);
    fs.writeFileSync(path.join(prod.dir, 'diff-summary.json'), JSON.stringify(px, null, 2));
    t.check(`${b.name}: rerender vs reference layout diff <= ${base.maxLayoutPct}%`, px.layoutPct <= base.maxLayoutPct,
      `layout ${px.layoutPct}% · text/AA ${px.textAAPct}% · total ${px.totalPct}%`);

    // 6. plugin: production vs spike (mock Figma)
    const mp = await mockImport(d);
    const ms = spike.dir ? await mockImport(readJson(path.join(spike.dir, 'design.json')), path.join(ROOT, 'spikes', 'figma-plugin', 'code.js')) : null;
    t.check(`${b.name}: plugin creates every layer (${mp.summary.layers.created}/${mp.summary.layers.expected}), none missing`,
      mp.summary.layers.created === mp.summary.layers.expected && !mp.report.missing.length);
    t.check(`${b.name}: production plugin == spike plugin (layers, conversions, fonts)`, ms && mp.elements === ms.elements &&
      !firstDiff(convertedSummary(mp), convertedSummary(ms)) && !firstDiff(fontStatus(mp), fontStatus(ms)),
      ms ? JSON.stringify(convertedSummary(mp)) : 'spike import failed');
  }
  await browser.close();
  if (UPDATE) { fs.writeFileSync(BASE_FILE, JSON.stringify(base, null, 2) + '\n'); console.log('\nupdated', BASE_FILE); }
  process.exit(t.finish());
})().catch(e => { console.error(e); process.exit(1); });
