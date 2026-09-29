#!/usr/bin/env node
// Spike 2 — font detection
//  a) CSS.getPlatformFontsForNode per text container: which font(s) Chrome really used
//  b) wrap Thai / non-Thai runs in temporary <span>s: does geometry or wrapping change?
//  c) per-span platform fonts: can we attribute a font to each script run?
//  d) unwrap and re-measure: is the page restored exactly?
// Usage: node font-spike.js [fixtures/text-spike.html]
const fs = require('fs');
const path = require('path');
const { launch, openPage } = require('./lib/browser');
const { measureLines } = require('./lib/measure');
const { fontRuns } = require('./lib/fontruns');

const file = process.argv[2] || path.join(__dirname, 'fixtures/text-spike.html');

async function platformFonts(cdp, selector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map(f => ({ family: f.familyName, postScript: f.postScriptName, custom: f.isCustomFont, glyphs: f.glyphCount }));
}

function diffLines(a, b) {
  const sameBreaks = a.lines.length === b.lines.length && a.lines.every((l, i) => l.start === b.lines[i].start && l.end === b.lines[i].end);
  let maxDelta = 0;
  a.lines.forEach((l, i) => {
    const m = b.lines[i]; if (!m) return;
    for (const k of ['x', 'y', 'width', 'height']) maxDelta = Math.max(maxDelta, Math.abs(l.box[k] - m.box[k]));
  });
  for (const k of ['x', 'y', 'width', 'height']) maxDelta = Math.max(maxDelta, Math.abs(a.box[k] - b.box[k]));
  return { sameBreaks, lines: [a.lines.length, b.lines.length], maxDeltaPx: Math.round(maxDelta * 100) / 100 };
}

(async () => {
  const { browser, how, version } = await launch();
  const { page } = await openPage(browser, file);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');

  const cases = await page.$$eval('[data-case]', els => els.map(e => e.dataset.case));
  const results = [];
  const textCases = [];
  for (const id of cases) {
    const sel = `[data-case="${id}"]`;
    const el = await page.$(sel);
    const before = await el.evaluate(measureLines);
    const fontsA = await platformFonts(cdp, sel);
    const fontsA2 = await platformFonts(cdp, sel); // repeatability

    // wrap script runs in spans (neutral chars - spaces, digits, punctuation - stay with the current run)
    const runs = await el.evaluate(e => {
      const text = e.textContent;
      // character classes: each class gets its own span; adjacent same-class chars merge.
      // (First attempt grouped spaces/digits with the neighbouring script -> spans came back
      //  with 2 fonts, because spaces/digits are drawn by a different font than Thai letters.)
      const cls = c => /[฀-๿]/.test(c) ? 'thai' : /\s/.test(c) ? 'space' : /\d/.test(c) ? 'digit' : /[A-Za-z]/.test(c) ? 'latin' : 'punct';
      const out = [];
      for (const ch of text) {
        const script = cls(ch);
        const last = out[out.length - 1];
        if (last && last.script === script) last.text += ch; else out.push({ script, text: ch });
      }
      e.textContent = '';
      out.forEach((r, i) => {
        const s = document.createElement('span');
        s.dataset.run = i; s.textContent = r.text; e.appendChild(s);
      });
      return out.map(r => ({ script: r.script || 'neutral', text: r.text }));
    });
    const wrapped = await el.evaluate(measureLines);
    for (let i = 0; i < runs.length; i++) runs[i].fonts = await platformFonts(cdp, `${sel} [data-run="${i}"]`);

    // unwrap
    await el.evaluate((e, t) => { e.textContent = t; }, before.text);
    const restored = await el.evaluate(measureLines);

    const css = await el.evaluate(e => {
      const cs = getComputedStyle(e);
      return { family: cs.fontFamily, weight: +cs.fontWeight, size: parseFloat(cs.fontSize), lineHeight: parseFloat(cs.lineHeight), letterSpacing: parseFloat(cs.letterSpacing) || 0, color: cs.color };
    });
    const chromePng = (await el.screenshot({ type: 'png' })).toString('base64');
    const fr = await fontRuns(page, cdp, sel);
    textCases.push({ id, css, text: before.text, box: before.box, lines: before.lines, runs: fr.runs, platformFonts: fontsA, chromePng });

    results.push({
      id,
      lines: before.lines.map(l => l.text),
      platformFonts: fontsA,
      repeatable: JSON.stringify(fontsA) === JSON.stringify(fontsA2),
      spanWrap: diffLines(before, wrapped),
      runs: runs.map(r => ({ script: r.script, chars: r.text.length, fonts: (r.fonts || []).map(f => `${f.family} (${f.glyphs})`) })),
      restore: diffLines(before, restored),
    });
  }
  await page.screenshot({ path: path.join(__dirname, 'out/text-chrome.png'), fullPage: true });
  await browser.close();

  const out = { spike: 'font-detection', browser: { how, version }, file: path.basename(file), results };
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out/font-spike.json'), JSON.stringify(out, null, 2));
  // input for the Figma text spike (plugin -> "Text spike")
  fs.writeFileSync(path.join(__dirname, 'out/text-lines.json'), JSON.stringify({ type: 'h2f-text-spike', browser: version, cases: textCases }, null, 2));

  console.log(`browser: ${version} via ${how}\n`);
  console.log('case                    | platform fonts (glyphs)                         | span-wrap: breaks same / max Δpx | restore Δpx | repeatable');
  for (const r of results) {
    const fonts = (r.platformFonts || []).map(f => `${f.family}(${f.glyphs})`).join(', ');
    console.log(`${r.id.padEnd(23)} | ${fonts.padEnd(47)} | ${String(r.spanWrap.sameBreaks).padEnd(5)} / ${String(r.spanWrap.maxDeltaPx).padEnd(6)} | ${String(r.restore.maxDeltaPx).padEnd(11)} | ${r.repeatable}`);
  }
  const all = results.flatMap(r => r.runs.map(x => ({ id: r.id, ...x })));
  const multi = all.filter(x => x.fonts.length !== 1);
  console.log(`\nspans resolved to exactly one font: ${all.length - multi.length} / ${all.length}` +
    (multi.length ? `\n  not single-font: ${multi.map(x => `${x.id}:${x.script}[${x.fonts.join(' + ')}]`).join('; ')}` : ''));
  console.log('\nper-run fonts (first mixed case):');
  const m = results.find(r => r.id.includes('mix-400')) || results[0];
  m.runs.forEach(r => console.log(`  ${r.script.padEnd(7)} ${String(r.chars).padStart(3)} chars -> ${r.fonts.join(', ')}`));
  console.log('\nwrote out/font-spike.json, out/text-lines.json, out/text-chrome.png');
})().catch(e => { console.error(e); process.exit(1); });
