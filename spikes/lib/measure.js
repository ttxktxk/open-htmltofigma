// Runs INSIDE the page (passed to page.evaluate). Must be self-contained.
// Returns the visual lines Chrome produced for one text container element.
//
// Algorithm (spec §4.2):
//  1. concatenate the element's text nodes, remember (node, offset) per char
//  2. split into grapheme clusters (Intl.Segmenter) so Thai vowels/tone marks stay with their consonant
//  3. one Range per grapheme -> getClientRects(); graphemes with no rect (collapsed/trailing space) join the current line
//  4. new line when vertical overlap with the current line < 50% of the smaller height,
//     or (LTR) the rect jumps back left of the previous rect
function measureLines(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const map = []; // index -> [textNode, offsetInNode]
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (let i = 0; i < n.data.length; i++) map.push([n, i]);
    text += n.data;
  }
  const seg = new Intl.Segmenter('th', { granularity: 'grapheme' });
  const origin = el.getBoundingClientRect();
  const lines = [];
  let cur = null, prev = null;
  for (const g of seg.segment(text)) {
    const start = g.index, end = g.index + g.segment.length;
    const r = document.createRange();
    r.setStart(map[start][0], map[start][1]);
    const last = map[end - 1];
    r.setEnd(last[0], last[1] + 1);
    const rect = [...r.getClientRects()].find(q => q.width > 0);
    if (!rect) { if (cur) cur.end = end; continue; }
    let newLine = !cur;
    if (cur) {
      const overlap = Math.min(cur.bottom, rect.bottom) - Math.max(cur.top, rect.top);
      const minH = Math.min(cur.bottom - cur.top, rect.height);
      if (overlap < 0.5 * minH) newLine = true;
      else if (prev && rect.left < prev.left - 1) newLine = true;
    }
    if (newLine) {
      cur = { start, end, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      lines.push(cur);
    } else {
      cur.end = end;
      cur.left = Math.min(cur.left, rect.left); cur.right = Math.max(cur.right, rect.right);
      cur.top = Math.min(cur.top, rect.top); cur.bottom = Math.max(cur.bottom, rect.bottom);
    }
    prev = rect;
  }
  const round = v => Math.round(v * 100) / 100;
  return {
    text,
    box: { x: round(origin.left + scrollX), y: round(origin.top + scrollY), width: round(origin.width), height: round(origin.height) },
    lines: lines.map(l => ({
      start: l.start, end: l.end,
      text: text.slice(l.start, l.end),
      box: { x: round(l.left - origin.left), y: round(l.top - origin.top), width: round(l.right - l.left), height: round(l.bottom - l.top) },
    })),
  };
}
module.exports = { measureLines };
