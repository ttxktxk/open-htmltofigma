// HTML to Figma (Playwright capture) — plugin main code (plain JS, no build step).
// Renderer promoted unchanged from spikes/figma-plugin/code.js (tested on two real Claude Design exports).
// MVP-B: the UI sends the HTML to the Local Helper (npm run helper) itself and passes the returned design here
// through the same "import" message as a design.json file; this file only stores the Helper token/port.
//  - "Import":     renders a design.json from `npm run capture` into editable layers, checks geometry against Chrome
//                  and returns a summary (design size, layers, missing, substituted fonts, unsupported features)
//  - "Find fonts": lists Figma font families/styles matching a query (to fill the font map)
figma.showUI(__html__, { width: 480, height: 760, themeColors: true });
figma.clientStorage.getAsync('h2f-config').then(function (c) { if (c) figma.ui.postMessage({ type: 'config', config: c }); });
// Local Helper connection (MVP-B): the UI talks to the Helper directly; only its token/port are remembered here.
figma.clientStorage.getAsync('h2f-helper').then(function (h) { figma.ui.postMessage({ type: 'helper-settings', settings: h || null }); });

var LS = '\u2028';
var availableFonts = null;       // "Family::Style" -> true
var fontReport = {};             // requested -> {resolved, status, count}

// ---------------------------------------------------------------- fonts
async function loadAvailable() {
  if (availableFonts) return;
  availableFonts = {};
  var list = await figma.listAvailableFontsAsync();
  for (var i = 0; i < list.length; i++) availableFonts[list[i].fontName.family + '::' + list[i].fontName.style] = true;
}
function has(family, style) { return !!availableFonts[family + '::' + style]; }

var WEIGHT_STYLES = {
  100: ['Thin', 'Hairline'], 200: ['ExtraLight', 'Extra Light', 'UltraLight'], 300: ['Light'],
  400: ['Regular', 'Normal', 'Book', 'Roman'], 500: ['Medium', 'Med'], 600: ['SemiBold', 'Semi Bold', 'DemiBold', 'Demi Bold'],
  700: ['Bold'], 800: ['ExtraBold', 'Extra Bold', 'Heavy'], 900: ['Black', 'Heavy']
};
function stripWeight(family) {
  return family.replace(/\s+(Thin|Hairline|ExtraLight|Extra Light|UltraLight|Light|Regular|Book|Medium|Med|SemiBold|Semi Bold|DemiBold|Bold|ExtraBold|Extra Bold|Heavy|Black)$/i, '');
}

// run: {postScript, usedFamily}; style: {cssFamilies[], weight}; config: {fontMap, families, fallback}
function resolveFont(run, style, config) {
  var key = run.postScript || (style.cssFamilies[0] + ' ' + style.weight);
  var hit = function (family, st, status) {
    var r = { family: family, style: st };
    var rep = fontReport[key] || (fontReport[key] = { requested: key, usedFamily: run.usedFamily || null, resolved: family + ' / ' + st, status: status, count: 0 });
    rep.count++;
    return r;
  };
  // 1. explicit postScript mapping
  var m = run.postScript && config.fontMap && config.fontMap[run.postScript];
  if (m && has(m.family, m.style)) return hit(m.family, m.style, 'mapped');
  // 2. family candidates: Chrome's used family (weight words stripped), then the CSS stack
  var fams = [];
  if (run.usedFamily) fams.push(stripWeight(run.usedFamily));
  for (var i = 0; i < style.cssFamilies.length; i++) if (fams.indexOf(style.cssFamilies[i]) < 0) fams.push(style.cssFamilies[i]);
  var w = Math.round((style.weight || 400) / 100) * 100;
  for (var f = 0; f < fams.length; f++) {
    var fam = fams[f];
    var byWeight = config.families && config.families[fam];
    if (byWeight && byWeight[w] && has(fam, byWeight[w])) return hit(fam, byWeight[w], f === 0 ? 'mapped' : 'SUBSTITUTED');
    var names = WEIGHT_STYLES[w] || ['Regular'];
    for (var n = 0; n < names.length; n++) if (has(fam, names[n])) return hit(fam, names[n], f === 0 ? 'exact' : 'SUBSTITUTED');
  }
  var fb = config.fallback || { family: 'Inter', style: 'Regular' };
  return hit(fb.family, fb.style, 'SUBSTITUTED');
}

// ---------------------------------------------------------------- text building
// Compose characters from original text + Chrome lines. sep: '\n', LS or '' (no inserted breaks).
// Returns {chars, map} where map[i] = index in chars for original index i (length text.length+1).
function compose(text, lines, sep) {
  var map = new Array(text.length + 1);
  var out = '';
  for (var li = 0; li < lines.length; li++) {
    var l = lines[li];
    var piece = text.slice(l.start, l.end);
    var keep = sep ? piece.replace(/\s+$/, '').length : piece.length; // drop trailing spaces before an inserted break
    for (var i = l.start; i < l.end; i++) { map[i] = out.length; if (i - l.start < keep) out += text[i]; }
    if (sep && li < lines.length - 1) out += sep;
  }
  map[text.length] = out.length;
  for (var k = 0; k < map.length; k++) if (map[k] === undefined) map[k] = out.length;
  return { chars: out, map: map };
}

async function makeText(opts) {
  // opts: text, lines, runs, style{cssFamilies, weight, size, lineHeight, letterSpacing, color, align}, sep, sizing, width, height, config
  var c = compose(opts.text, opts.lines, opts.sep);
  var fonts = opts.runs.map(function (r) { return resolveFont(r, opts.style, opts.config); });
  for (var i = 0; i < fonts.length; i++) await figma.loadFontAsync(fonts[i]);
  var t = figma.createText();
  t.fontName = fonts[0];
  t.characters = c.chars;
  for (var j = 0; j < opts.runs.length; j++) {
    var s = c.map[opts.runs[j].start], e = c.map[opts.runs[j].end];
    if (j === opts.runs.length - 1) e = c.chars.length;
    if (e > s) t.setRangeFontName(s, e, fonts[j]);
  }
  t.fontSize = opts.style.size;
  if (opts.style.lineHeight) t.lineHeight = { value: opts.style.lineHeight, unit: 'PIXELS' };
  if (opts.style.letterSpacing) t.letterSpacing = { value: opts.style.letterSpacing, unit: 'PIXELS' };
  if (opts.style.color) t.fills = [{ type: 'SOLID', color: { r: opts.style.color.r, g: opts.style.color.g, b: opts.style.color.b }, opacity: opts.style.color.a }];
  var align = { center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' }[opts.style.align] || 'LEFT';
  t.textAlignHorizontal = align;
  t.textCase = { upper: 'UPPER', lower: 'LOWER', title: 'TITLE' }[opts.style.textCase] || 'ORIGINAL';
  t.textDecoration = { underline: 'UNDERLINE', 'line-through': 'STRIKETHROUGH' }[opts.style.decoration] || 'NONE';
  t.textAutoResize = opts.sizing;
  if (opts.sizing === 'HEIGHT') t.resize(opts.width, t.height);
  if (opts.sizing === 'NONE') t.resize(opts.width, opts.height);
  return { node: t, composed: c.chars };
}

function cssColor(str) {
  var m = /rgba?\(([^)]+)\)/.exec(str || '');
  if (!m) return { r: 0, g: 0, b: 0, a: 1 };
  var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
  return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
}
function round2(v) { return Math.round(v * 100) / 100; }

function clampRuns(runs, len) {
  var out = runs.map(function (r) { return { start: Math.min(r.start, len), end: Math.min(r.end, len), postScript: r.postScript, usedFamily: r.usedFamily }; })
    .filter(function (r) { return r.end > r.start; });
  if (!out.length) out = [{ start: 0, end: len, postScript: runs.length ? runs[0].postScript : null, usedFamily: runs.length ? runs[0].usedFamily : null }];
  out[out.length - 1].end = len;
  return out;
}

// ---------------------------------------------------------------- import design.json
async function importDesign(data, config, lineMode) {
  if (!data.schemaVersion || !/^(1\.|0\.1\.0-spike$)/.test(data.schemaVersion)) throw new Error('Unsupported schemaVersion ' + data.schemaVersion + ' (expected 1.x from npm run capture)');
  await loadAvailable();
  fontReport = {};
  var report = { geometry: [], text: [], missing: [], approximations: [], converted: [] };
  var hashes = {};
  for (var id in data.assets) {
    var a = data.assets[id];
    if (a.storage.kind !== 'inline') { report.missing.push({ assetId: id, reason: 'storage ' + a.storage.kind + ' not supported in spike' }); continue; }
    hashes[id] = figma.createImage(figma.base64Decode(a.storage.base64)).hash;
  }
  var sep = lineMode === 'nl' ? '\n' : lineMode === 'ls' ? LS : '';
  var created = [];

  function applyRadius(node, r) {
    if (r && !r.ellipse && node.type !== 'ELLIPSE') { node.topLeftRadius = r.topLeft; node.topRightRadius = r.topRight; node.bottomRightRadius = r.bottomRight; node.bottomLeftRadius = r.bottomLeft; }
  }
  // box-shadow -> Figma effects.
  // Figma only applies shadow `spread` on frames with clipsContent = true (API limitation), so:
  //  1. a "ring" shadow (x=0, y=0, blur=0, spread>0 — how Claude Design/Tailwind draw 1px borders) becomes a
  //     real stroke (INSIDE for inset, OUTSIDE otherwise) when the frame has no CSS border of its own;
  //  2. other shadows with spread: turn clipsContent on only if nothing inside paints outside the frame,
  //     otherwise keep the shadow and report that its spread is ignored.
  function isRing(e) { return e.x === 0 && e.y === 0 && e.blur === 0 && e.spread > 0; }
  // does any painting descendant cover the inset ring band (the outer `w` px of the box)?
  // CSS paints inset box-shadow UNDER children; a Figma frame stroke paints OVER them.
  function contentOverRing(n, w) {
    var b = n.absBox;
    function paints(c) { return c.type !== 'frame' || (c.fills && c.fills.length) || c.border || (c.effects && c.effects.length); }
    function over(c) {
      var a = c.absBox;
      if (paints(c) && a.width > 0 && a.height > 0) {
        var intersects = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        var insideInner = a.x >= b.x + w && a.y >= b.y + w && a.x + a.width <= b.x + b.width - w && a.y + a.height <= b.y + b.height - w;
        if (intersects && !insideInner) return true;
      }
      return (c.children || []).some(over);
    }
    return (n.children || []).some(over);
  }
  function paintsOutside(n) {
    var b = n.absBox;
    function out(c) {
      var e = 0;
      (c.effects || []).forEach(function (f) { if (f.type === 'drop-shadow') e = Math.max(e, Math.abs(f.x) + Math.abs(f.y) + f.blur + Math.max(0, f.spread)); });
      var a = c.absBox;
      if (a.x - e < b.x - 0.5 || a.y - e < b.y - 0.5 || a.x + a.width + e > b.x + b.width + 0.5 || a.y + a.height + e > b.y + b.height + 0.5) return true;
      return (c.children || []).some(out);
    }
    return (n.children || []).some(out);
  }
  function applyEffects(node, n) {
    var effects = n.effects || [];
    if (!effects.length) return;
    var hasBorder = !!(n.border && ['top', 'right', 'bottom', 'left'].some(function (k) { return n.border[k].width > 0; }));
    var rest = [];
    effects.forEach(function (e) {
      if (isRing(e) && !hasBorder && e.type === 'inner-shadow' && node.type === 'FRAME' && contentOverRing(n, e.spread)) {
        // children overlap the ring: put it in its own layer at the bottom of the frame (above fill, below content)
        var ring = figma.createRectangle();
        ring.name = 'ring (box-shadow inset)';
        ring.resize(Math.max(n.box.width, 0.01), Math.max(n.box.height, 0.01));
        ring.fills = [];
        ring.strokes = [{ type: 'SOLID', color: { r: e.color.r, g: e.color.g, b: e.color.b }, opacity: e.color.a }];
        ring.strokeWeight = e.spread; ring.strokeAlign = 'INSIDE';
        applyRadius(ring, n.radius);
        node.appendChild(ring);                    // first child = bottom-most; real children are appended after
        hasBorder = true;
        report.converted.push({ nodeId: n.id, name: n.name, what: 'box-shadow ring -> ring layer under children ' + e.spread + 'px' });
      } else if (isRing(e) && !hasBorder) {
        node.strokes = [{ type: 'SOLID', color: { r: e.color.r, g: e.color.g, b: e.color.b }, opacity: e.color.a }];
        node.strokeWeight = e.spread;
        node.strokeAlign = e.type === 'inner-shadow' ? 'INSIDE' : 'OUTSIDE';
        hasBorder = true;                         // a second ring stays an effect
        report.converted.push({ nodeId: n.id, name: n.name, what: 'box-shadow ring -> stroke ' + node.strokeAlign + ' ' + e.spread + 'px' });
      } else rest.push(e);
    });
    node.effects = rest.map(function (e) {
      return { type: e.type === 'inner-shadow' ? 'INNER_SHADOW' : 'DROP_SHADOW', color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
        offset: { x: e.x, y: e.y }, radius: e.blur, spread: e.spread, visible: true, blendMode: 'NORMAL' };
    });
    if (rest.some(function (e) { return e.spread !== 0; }) && !node.clipsContent && node.type === 'FRAME') {
      if (!paintsOutside(n)) { node.clipsContent = true; report.converted.push({ nodeId: n.id, name: n.name, what: 'clipsContent on (needed for shadow spread; nothing overflows)' }); }
      else report.approximations.push({ nodeId: n.id, name: n.name, what: 'shadow spread ignored', note: 'Figma applies spread only with clipsContent, and this frame has overflowing content' });
    }
  }
  function imageRect(n, assetId, scaleMode) {
    var r = figma.createRectangle();
    r.resize(Math.max(n.box.width, 0.01), Math.max(n.box.height, 0.01));
    if (assetId && hashes[assetId]) r.fills = [{ type: 'IMAGE', imageHash: hashes[assetId], scaleMode: scaleMode || 'FILL' }];
    else { r.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }]; report.missing.push({ nodeId: n.id, name: n.name, reason: 'no image asset - grey placeholder' }); }
    applyRadius(r, n.radius);
    return r;
  }
  var total = 0; (function count(n) { total++; (n.children || []).forEach(count); })(data.root);
  var done = 0;

  async function render(n, parent) {
    var node;
    if (n.type === 'frame') {
      // border-radius 50% on a non-square box = ellipse (e.g. the rotated white shape in the header)
      var ellipse = !!(n.radius && n.radius.ellipse);
      var hasKids = !!(n.children && n.children.length);
      node = ellipse && !hasKids ? figma.createEllipse() : figma.createFrame();
      if (ellipse && hasKids) report.approximations.push({ nodeId: n.id, name: n.name, what: 'elliptical border-radius on a frame with children', note: 'drawn with circular corners' });
      node.fills = (n.fills || []).map(function (f) {
        if (f.type === 'image') return hashes[f.assetId] ? { type: 'IMAGE', imageHash: hashes[f.assetId], scaleMode: 'FILL' } : null;
        return { type: 'SOLID', color: { r: f.color.r, g: f.color.g, b: f.color.b }, opacity: f.color.a };
      }).filter(Boolean);
      if (node.type === 'FRAME') node.clipsContent = !!n.clip;   // only overflow clips, never radius alone (spec §6.4)
      if (n.border) {
        var sides = ['top', 'right', 'bottom', 'left'];
        var first = null;
        for (var s = 0; s < sides.length; s++) if (n.border[sides[s]].width > 0 && n.border[sides[s]].color) { first = n.border[sides[s]]; break; }
        if (first) {
          node.strokes = [{ type: 'SOLID', color: { r: first.color.r, g: first.color.g, b: first.color.b }, opacity: first.color.a }];
          node.strokeAlign = 'INSIDE';
          if (node.type === 'ELLIPSE') node.strokeWeight = first.width;
          else {
            node.strokeTopWeight = n.border.top.width; node.strokeRightWeight = n.border.right.width;
            node.strokeBottomWeight = n.border.bottom.width; node.strokeLeftWeight = n.border.left.width;
          }
          var colors = sides.filter(function (k) { return n.border[k].width > 0 && n.border[k].color; })
            .map(function (k) { var c = n.border[k].color; return [c.r, c.g, c.b, c.a].join(','); });
          if (colors.some(function (c) { return c !== colors[0]; })) report.approximations.push({ nodeId: n.id, name: n.name, what: 'border-multicolor', note: 'used first visible side colour' });
          var bw = first.width;
          if (first.style === 'dashed') node.dashPattern = [3 * bw, 3 * bw];          // Chrome: dash ≈ gap ≈ 3 × width
          else if (first.style === 'dotted') node.dashPattern = [bw, bw];
          else if (first.style && first.style !== 'solid') report.approximations.push({ nodeId: n.id, name: n.name, what: 'border-style ' + first.style, note: 'drawn solid' });
        }
      }
      applyRadius(node, n.radius);
      applyEffects(node, n);
      node.resize(Math.max(n.box.width, 0.01), Math.max(n.box.height, 0.01));
      if (ellipse && hasKids) node.cornerRadius = Math.min(n.box.width, n.box.height) / 2;
    } else if (n.type === 'text') {
      var one = n.visualLines.length === 1;
      var sizing = n.wrap === 'figma' ? 'HEIGHT' : (one ? 'WIDTH_AND_HEIGHT' : 'HEIGHT'); // spec §4.4
      var mk = await makeText({ text: n.originalText, lines: n.visualLines, runs: n.runs, style: n.style,
        sep: one || n.wrap === 'figma' ? '' : sep, sizing: sizing,
        width: n.wrap === 'figma' ? n.box.width : n.box.width + 2, height: n.box.height, config: config });
      node = mk.node;
    } else if (n.type === 'vector') {
      try {
        node = figma.createNodeFromSvg(n.svg);
        node.clipsContent = n.clip !== false;   // same as Chrome: <svg> clips to its box unless overflow: visible
        if (Math.abs(node.width - n.box.width) > 0.5 || Math.abs(node.height - n.box.height) > 0.5) node.resize(Math.max(n.box.width, 0.01), Math.max(n.box.height, 0.01));
      } catch (e) {
        report.approximations.push({ nodeId: n.id, name: n.name, what: 'svg-import-failed', note: String(e && e.message || e).slice(0, 120) });
        node = imageRect(n, n.fallbackAssetId, 'FILL');
      }
    } else { // image / raster
      var mode = n.type === 'image' ? ({ contain: 'FIT', cover: 'FILL', fill: 'FILL', none: 'CROP', 'scale-down': 'FIT' }[n.fit] || 'FILL') : 'FILL';
      node = imageRect(n, n.assetId, mode);
      if (n.type === 'image' && n.fit === 'fill') report.approximations.push({ nodeId: n.id, name: n.name, what: 'object-fit: fill', note: 'Figma FILL crops instead of stretching' });
    }
    node.name = n.name;
    node.x = n.box.x; node.y = n.box.y;
    if (n.transform) {   // childless frame with a CSS 2D transform: rotation via relativeTransform, scale folded into the size
      var t = n.transform, sx = Math.sqrt(t.a * t.a + t.b * t.b), sy = (t.a * t.d - t.b * t.c) / (sx || 1);
      var skew = sx > 0 && Math.abs(t.a * t.c + t.b * t.d) / (sx * Math.sqrt(t.c * t.c + t.d * t.d)) > 0.001;
      if (sx > 0 && sy > 0 && !skew) {
        node.resize(Math.max(t.width * sx, 0.01), Math.max(t.height * sy, 0.01));
        node.relativeTransform = [[t.a / sx, -t.b / sx, t.tx], [t.b / sx, t.a / sx, t.ty]];
        report.converted.push({ nodeId: n.id, name: n.name, what: 'CSS transform -> relativeTransform (rotation ' + Math.round(Math.atan2(t.b, t.a) * 1800 / Math.PI) / 10 + '°)' });
      } else report.approximations.push({ nodeId: n.id, name: n.name, what: 'transform with skew/flip', note: 'drawn at its on-screen bounding box' });
    }
    if (n.opacity < 1) node.opacity = n.opacity;
    if (n.visible === false) node.visible = false;
    node.setPluginData('h2f', n.id);
    if (parent) parent.appendChild(node);
    created.push({ n: n, node: node });
    if (n.type === 'text') {
      var st = n.style.align;
      if (n.visualLines.length === 1 && n.wrap !== 'figma' && (st === 'center' || st === 'right' || st === 'end')) {
        node.x = n.box.x + (st === 'center' ? (n.box.width - node.width) / 2 : n.box.width - node.width);
      }
    }
    if (++done % 100 === 0) figma.ui.postMessage({ type: 'progress', done: done, total: total });
    if (n.children) for (var i = 0; i < n.children.length; i++) await render(n.children[i], node);
    return node;
  }

  var root = await render(data.root, null);
  root.name = 'H2F Import · ' + data.capture.source + ' · ' + data.root.box.width + '×' + data.root.box.height;
  figma.currentPage.appendChild(root);
  root.x = figma.viewport.center.x - root.width / 2; root.y = figma.viewport.center.y - root.height / 2;

  // verify geometry against Chrome absBox (root-relative)
  var ox = root.absoluteTransform[0][2], oy = root.absoluteTransform[1][2];
  var elementCount = 0;
  for (var k = 0; k < created.length; k++) {
    var c = created[k];
    elementCount++;
    var bb = c.node.absoluteBoundingBox;
    var got = { x: round2(bb.x - ox), y: round2(bb.y - oy), width: round2(bb.width), height: round2(bb.height) };
    var exp = c.n.absBox;
    if (c.n === data.root) exp = { x: 0, y: 0, width: data.root.box.width, height: data.root.box.height };
    var d = Math.max(Math.abs(got.x - exp.x), Math.abs(got.y - exp.y), Math.abs(got.width - exp.width), Math.abs(got.height - exp.height));
    if (c.n.type === 'text') {
      var lhh = c.n.style.lineHeight;
      var gotLines = Math.round(c.node.height / lhh);
      var rb = c.node.absoluteRenderBounds;
      if (c.n.wrap === 'figma') gotLines = c.n.visualLines.length; // textarea: Figma wraps by design
      report.text.push({ nodeId: c.n.id, text: c.n.originalText.slice(0, 30), expectedLines: c.n.visualLines.length, gotLines: gotLines,
        widthDeltaPx: round2(got.width - exp.width), heightDeltaPx: round2(got.height - exp.height),
        overflowPx: rb ? round2(Math.max(0, rb.y + rb.height - bb.y - bb.height)) : null });
      // for text compare x/y only (width depends on Figma metrics; reported separately)
      d = Math.max(Math.abs(got.x - exp.x), Math.abs(got.y - exp.y));
    }
    if (d > 2) report.geometry.push({ nodeId: c.n.id, name: c.n.name, type: c.n.type, expected: exp, got: got, maxDeltaPx: round2(d) });
  }
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  var fonts = Object.keys(fontReport).map(function (key) { return fontReport[key]; });
  var textLineMismatch = report.text.filter(function (t) { return t.expectedLines !== t.gotLines; }).length;
  return {
    type: 'import-result', schemaVersion: data.schemaVersion, source: data.capture.source, rootId: root.id, lineMode: lineMode, elements: elementCount,
    geometryFailures: report.geometry.length, textLineMismatch: textLineMismatch,
    fonts: fonts, captureReport: data.report, report: report,
    summary: importSummary(data, elementCount, fonts, report, textLineMismatch)
  };
}

// counts every node in design.json (what the import should have created)
function countNodes(n) { var c = 1; if (n.children) for (var i = 0; i < n.children.length; i++) c += countNodes(n.children[i]); return c; }
function importSummary(data, elementCount, fonts, report, textLineMismatch) {
  var unsupported = {};
  function add(key, nodeId) { var u = unsupported[key] || (unsupported[key] = { feature: key, count: 0, nodeIds: [] }); u.count++; if (u.nodeIds.length < 10) u.nodeIds.push(nodeId); }
  (data.report.unsupported || []).forEach(function (u) { add(u.property + ' (' + u.action + ')', u.nodeId); });
  (report.approximations || []).forEach(function (a) { add(a.what, a.nodeId); });
  var rasters = {};
  (data.report.fallbacks || []).forEach(function (f) { rasters[f.reason] = (rasters[f.reason] || 0) + 1; });
  return {
    designSize: { width: data.root.box.width, height: data.root.box.height },
    detection: data.capture.detectionSource || data.capture.designAreaMode || null,
    layers: { expected: countNodes(data.root), created: elementCount },
    missingLayers: report.missing,
    substitutedFonts: fonts.filter(function (f) { return f.status !== 'exact' && f.status !== 'mapped'; }),
    captureFontIssues: data.report.fontIssues || [],
    unsupported: Object.keys(unsupported).map(function (k) { return unsupported[k]; }),
    rasterFallbacks: rasters,
    geometryFailures: report.geometry.length,
    textLineMismatch: textLineMismatch
  };
}

// ---------------------------------------------------------------- messages
figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'find-fonts') {
      await loadAvailable();
      var q = msg.query.toLowerCase();
      var fams = {};
      Object.keys(availableFonts).forEach(function (k) { var p = k.split('::'); if (p[0].toLowerCase().indexOf(q) >= 0) (fams[p[0]] = fams[p[0]] || []).push(p[1]); });
      figma.ui.postMessage({ type: 'fonts', fams: fams });
    } else if (msg.type === 'get-helper') {
      figma.ui.postMessage({ type: 'helper-settings', settings: (await figma.clientStorage.getAsync('h2f-helper')) || null });
    } else if (msg.type === 'save-helper') {
      await figma.clientStorage.setAsync('h2f-helper', msg.settings);
    } else if (msg.type === 'notify') {
      figma.notify(String(msg.text).slice(0, 200), { error: !!msg.error });
    } else if (msg.type === 'save-config') {
      await figma.clientStorage.setAsync('h2f-config', msg.config);
    } else if (msg.type === 'import') {
      figma.ui.postMessage(await importDesign(msg.data, msg.config, msg.lineMode));
    } else if (msg.type === 'export-png') {
      var node = await figma.getNodeByIdAsync(msg.rootId);
      if (!node) throw new Error('node not found');
      var bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: msg.scale || 1 } });
      figma.ui.postMessage({ type: 'png', bytes: bytes, name: msg.name });
    }
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};
