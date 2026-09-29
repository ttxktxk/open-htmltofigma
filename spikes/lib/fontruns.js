// Font runs for one text leaf, via CDP CSS.getPlatformFontsForNode (spike 2 method):
// wrap each character-class run (thai / latin / digit / space / punct) in a temporary <span>,
// ask Chrome which platform font drew it, restore the original text node, merge adjacent runs
// that used the same font. Spaces with no glyph inherit the previous run's font.
async function platformFonts(cdp, selector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return [];
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map(f => ({ family: f.familyName, postScript: f.postScriptName, custom: f.isCustomFont, glyphs: f.glyphCount }));
}

async function fontRuns(page, cdp, selector) {
  const el = await page.$(selector);
  const segs = await el.evaluate(e => {
    const text = e.textContent;
    const cls = c => /[฀-๿]/.test(c) ? 'thai' : /\s/.test(c) ? 'space' : /\d/.test(c) ? 'digit' : /[A-Za-z]/.test(c) ? 'latin' : 'punct';
    const out = [];
    let i = 0;
    for (const ch of text) {
      const k = cls(ch), last = out[out.length - 1];
      if (last && last.cls === k) { last.end += ch.length; } else out.push({ cls: k, start: i, end: i + ch.length });
      i += ch.length;
    }
    e.setAttribute('data-h2f-text', text);
    e.textContent = '';
    out.forEach((r, n) => { const s = document.createElement('span'); s.dataset.h2fRun = n; s.textContent = text.slice(r.start, r.end); e.appendChild(s); });
    void e.offsetHeight; // force style/layout; without it the first spans report no platform font (seen in spike)
    return out;
  });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (let n = 0; n < segs.length; n++) {
    const f = await platformFonts(cdp, `${selector} [data-h2f-run="${n}"]`);
    segs[n].font = f.length ? f.sort((a, b) => b.glyphs - a.glyphs)[0] : null;
    segs[n].multi = f.length > 1;
  }
  await el.evaluate(e => { e.textContent = e.getAttribute('data-h2f-text'); e.removeAttribute('data-h2f-text'); });

  const runs = [];
  for (const s of segs) {
    const font = s.font || (runs.length ? runs[runs.length - 1].font : null);
    const last = runs[runs.length - 1];
    if (last && last.font && font && last.font.postScript === font.postScript) last.end = s.end;
    else runs.push({ start: s.start, end: s.end, font });
  }
  // leading glyph-less run (e.g. text starting with a space) takes the next run's font
  if (runs.length > 1 && !runs[0].font) { runs[1].start = 0; runs.shift(); }
  return {
    runs: runs.map(r => ({ start: r.start, end: r.end, usedFamily: r.font ? r.font.family : null, postScript: r.font ? r.font.postScript : null, custom: r.font ? r.font.custom : null })),
    multiFontSpans: segs.filter(s => s.multi).length,
  };
}
module.exports = { fontRuns, platformFonts };
