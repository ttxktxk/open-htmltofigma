// Injected into the page (plain browser script). Exposes window.__h2f.
// Walks the rendered DOM into a design tree. Text, images, rasters and SVG files are left as
// "pending" items that capture.js completes from Node (fonts via CDP, screenshots, file reads).
(() => {
  const r2 = v => Math.round(v * 100) / 100;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'TEMPLATE', 'NOSCRIPT', 'BR', 'WBR', 'H2F-W', 'H2F-R', 'H2F-M']);
  const RASTER_TAGS = { CANVAS: 'canvas', VIDEO: 'media', IFRAME: 'iframe', OBJECT: 'embed', EMBED: 'embed' };
  const MAP_SELECTOR = [
    '.esri-view-surface',                         // ArcGIS JS 4.x
    '.leaflet-map-pane',                          // Leaflet (tiles + vector layers + markers)
    '.maplibregl-canvas-container', '.mapboxgl-canvas-container',
    '.ol-viewport > .ol-layers', '.ol-layer',     // OpenLayers
    '.gm-style > div:first-child',                // Google Maps
  ].join(',');
  const ICON_FONT = /material|icons?\b|symbols|font ?awesome|remixicon|bootstrap-icons|phosphor|ionicons|feather/i;
  const SVG_UNSAFE = 'foreignObject, filter, mask, pattern, text, textPath, image, animate, animateTransform, animateMotion, set';
  const SVG_DEFAULTS = { 'fill-opacity': '1', 'fill-rule': 'nonzero', 'stroke-opacity': '1', 'stroke-miterlimit': '4', 'stroke-dasharray': 'none',
    'stroke-dashoffset': '0', opacity: '1', 'clip-rule': 'nonzero', display: 'inline', visibility: 'visible', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter' };
  const SVG_GRADIENT_PROPS = ['stop-color', 'stop-opacity'];
  const SVG_PAINT_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-rule', 'display', 'visibility'];

  const textNodes = [];      // index -> DOM Text node
  const unsupported = [];
  let seq = 0;

  // ---------------------------------------------------------------- colours / boxes
  const probe = document.createElement('canvas').getContext('2d');
  function rgba(css) {
    if (!css || css === 'transparent' || css === 'none') return null;
    let m = css.match(/^rgba?\(([^)]+)\)$/);
    if (!m) { // color(srgb ...), oklch(), lab() ... -> let canvas normalise
      probe.fillStyle = '#000'; probe.fillStyle = css; const n = probe.fillStyle;
      if (n[0] === '#') return { r: r2(parseInt(n.slice(1, 3), 16) / 255), g: r2(parseInt(n.slice(3, 5), 16) / 255), b: r2(parseInt(n.slice(5, 7), 16) / 255), a: 1 };
      m = n.match(/^rgba?\(([^)]+)\)$/); if (!m) return null;
    }
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    const c = { r: r2(p[0] / 255), g: r2(p[1] / 255), b: r2(p[2] / 255), a: p.length > 3 ? r2(p[3]) : 1 };
    return c.a === 0 ? null : c;
  }
  function abs(r) { return { x: r2(r.left + scrollX), y: r2(r.top + scrollY), width: r2(r.width), height: r2(r.height) }; }
  function rel(a, p) { return { x: r2(a.x - p.x), y: r2(a.y - p.y), width: a.width, height: a.height }; }
  function nameOf(el) {
    if (el.dataset && el.dataset.figmaName) return el.dataset.figmaName;
    let n = el.tagName.toLowerCase();
    if (el.id) n += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    if (cls.trim()) n += '.' + cls.trim().split(/\s+/).slice(0, 3).join('.');
    return n;
  }
  function borders(cs) {
    const side = s => ({ width: parseFloat(cs[`border${s}Width`]) || 0, style: cs[`border${s}Style`], color: rgba(cs[`border${s}Color`]) });
    const b = { top: side('Top'), right: side('Right'), bottom: side('Bottom'), left: side('Left') };
    for (const k in b) if (b[k].style === 'none' || b[k].style === 'hidden' || !b[k].color) b[k].width = 0;
    return Object.values(b).some(s => s.width > 0) ? b : null;
  }
  // border-radius per corner. % is horizontal-of-width / vertical-of-height (CSS), so "50%" on a non-square box
  // is an ellipse: returned as { ellipse: true } (Figma has an Ellipse node; frame corners are circular only).
  // `box` must be the untransformed layout size (a rotated element's bounding box is larger).
  function radii(cs, id, box, report = true) {
    const W = box.width, H = box.height;
    const corner = k => {
      const parts = cs[k].split(' ');
      const hx = parts[0], vy = parts[1] || parts[0];
      return { h: hx.endsWith('%') ? parseFloat(hx) / 100 * W : parseFloat(hx) || 0,
               v: vy.endsWith('%') ? parseFloat(vy) / 100 * H : parseFloat(vy) || 0 };
    };
    const ks = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'];
    const c = ks.map(corner);
    // CSS overlap rule: if adjacent radii exceed the side, ALL radii shrink by the same factor
    // (so 999px on a pill = stadium, while 50% = ellipse)
    const f = Math.min(1, W / ((c[0].h + c[1].h) || 1), W / ((c[3].h + c[2].h) || 1), H / ((c[0].v + c[3].v) || 1), H / ((c[1].v + c[2].v) || 1));
    c.forEach(q => { q.h *= f; q.v *= f; });
    if (Math.abs(W - H) > 0.5 && c.every(q => Math.abs(q.h - W / 2) < 0.5 && Math.abs(q.v - H / 2) < 0.5)) return { ellipse: true, topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 };
    const max = Math.min(W, H) / 2;
    const one = (q, k) => {
      if (report && Math.abs(q.h - q.v) > 0.5) unsupported.push({ nodeId: id, property: k, value: cs[k], action: 'approximated (elliptical corner drawn circular)' });
      return r2(Math.min(Math.min(q.h, q.v), max));
    };
    const r = { topLeft: one(c[0], ks[0]), topRight: one(c[1], ks[1]), bottomRight: one(c[2], ks[2]), bottomLeft: one(c[3], ks[3]) };
    return Object.values(r).some(v => v > 0) ? r : null;
  }
  function shadows(cs) {
    if (!cs.boxShadow || cs.boxShadow === 'none') return [];
    // computed form: "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px [inset], ..."
    const parts = cs.boxShadow.split(/,(?![^(]*\))/);
    return parts.map(p => {
      const color = rgba((p.match(/(rgba?\([^)]+\)|color\([^)]+\))/) || [])[0]);
      const nums = p.replace(/(rgba?\([^)]+\)|color\([^)]+\))/, '').match(/-?[\d.]+px/g) || [];
      const [x, y, blur, spread] = nums.map(parseFloat).concat([0, 0, 0, 0]);
      return color ? { type: /inset/.test(p) ? 'inner-shadow' : 'drop-shadow', color, x, y, blur, spread } : null;
    }).filter(Boolean);
  }
  function textStyle(cs, el) {
    return {
      cssFamilies: cs.fontFamily.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')),
      weight: +cs.fontWeight, style: cs.fontStyle, size: parseFloat(cs.fontSize),
      lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
      letterSpacing: parseFloat(cs.letterSpacing) || 0,
      color: rgba(cs.color), align: cs.textAlign,
      textCase: { uppercase: 'upper', lowercase: 'lower', capitalize: 'title' }[cs.textTransform] || 'none',
      decoration: /underline/.test(cs.textDecorationLine) ? 'underline' : /line-through/.test(cs.textDecorationLine) ? 'line-through' : 'none',
    };
  }
  // ---------------------------------------------------------------- ::before / ::after
  // A rendered pseudo-element becomes a "pseudo-pending" child of its host: ::before in front of the host's
  // children, ::after behind them (DOM order). capture/cli.js reads its exact geometry from Chrome's box model
  // (CDP) and then calls pseudoPaint() — nothing in the page is moved or restyled to measure it.
  const PSEUDO_DEFAULTS = { filter: 'none', backdropFilter: 'none', mixBlendMode: 'normal', clipPath: 'none', maskImage: 'none' };
  function cssString(v) {   // computed content: exactly one quoted string -> its text, otherwise null
    const m = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(v);
    return m ? m[1].replace(/\\([0-9a-fA-F]{1,6}) ?|\\([\s\S])/g, (all, hex, ch) => hex ? String.fromCodePoint(parseInt(hex, 16)) : ch) : null;
  }
  function pseudoOf(el, which) {
    const cs = getComputedStyle(el, '::' + which);
    const c = cs.content;
    if (!c || c === 'none' || c === 'normal' || cs.display === 'none') return null;
    return { type: 'pseudo-pending', which, hostId: el.getAttribute('data-h2f-id') };
  }
  // Paint of one pseudo-element. quad = its border-box quad from Chrome's box model (viewport coords, transformed).
  // complex = reasons it cannot be drawn as editable layers (-> captured as an image and reported).
  function pseudoPaint(hostId, which, quad) {
    const el = document.querySelector(`[data-h2f-id="${hostId}"]`);
    const cs = getComputedStyle(el, '::' + which);
    const id = hostId + ':' + which;
    const before = unsupported.length;
    const complex = [];
    let text = null;
    if (cs.content !== '""') {
      text = cssString(cs.content);
      if (text == null) complex.push('content ' + cs.content.slice(0, 60));
      else if (/[\uE000-\uF8FF]/.test(text) || ICON_FONT.test(cs.fontFamily)) complex.push('icon-font glyph');
      else if (!/^pre/.test(cs.whiteSpace)) text = text.replace(/\s+/g, ' ');
      if (text != null && !text.trim()) text = null;
      if (text != null && /\n/.test(text)) complex.push('multi-line content');
    }
    if (cs.backgroundImage && cs.backgroundImage !== 'none') complex.push('background-image ' + cs.backgroundImage.slice(0, 60));
    for (const k in PSEUDO_DEFAULTS) if (cs[k] && cs[k] !== PSEUDO_DEFAULTS[k]) complex.push(k + ' ' + String(cs[k]).slice(0, 60));
    let m = null;
    if (cs.transform && cs.transform !== 'none') {
      m = new DOMMatrix(cs.transform);
      if (m.isIdentity) m = null;
      else if (!m.is2D) complex.push('3D transform');
      else if (Math.abs(m.a * m.c + m.b * m.d) > 1e-3 || m.a * m.d - m.b * m.c <= 0) complex.push('skew/flip transform');
      else if (text != null) complex.push('transform on text');
    }
    // untransformed border-box size: the quad's sides divided by the matrix scale
    const side = (i, j) => Math.hypot(quad[j] - quad[i], quad[j + 1] - quad[i + 1]);
    const box = m ? { width: r2(side(0, 2) / Math.hypot(m.a, m.b)), height: r2(side(0, 6) / Math.hypot(m.c, m.d)) }
                  : { width: r2(quad[2] - quad[0]), height: r2(quad[7] - quad[1]) };
    const out = {
      id, name: nameOf(el) + '::' + which, size: box,
      matrix: m ? { a: +m.a.toFixed(4), b: +m.b.toFixed(4), c: +m.c.toFixed(4), d: +m.d.toFixed(4) } : null, opacity: r2(+cs.opacity), visible: cs.visibility !== 'hidden',
      fills: [rgba(cs.backgroundColor)].filter(Boolean).map(color => ({ type: 'solid', color })),
      border: borders(cs), radius: radii(cs, id, box), effects: shadows(cs),
      text, complex, zIndex: cs.zIndex,
    };
    if (text != null) {
      out.textStyle = textStyle(cs, el);
      out.textAlign = cs.textAlign;
      out.whiteSpace = cs.whiteSpace;
    }
    out.unsupported = unsupported.splice(before);   // radii() notes for this pseudo-element
    return out;
  }

  // Untransformed layout box + CSS matrix -> Figma-style affine: local (0,0) maps to (tx, ty) in parent coords.
  //   abs(L) = P + O + M·(L − O) + (e, f)   with P = layout box origin, O = transform-origin
  function leafTransform(el, cs, m, parentAbs) {
    const saved = el.getAttribute('style');
    el.style.setProperty('transform', 'none', 'important');
    const r = el.getBoundingClientRect();
    if (saved === null) el.removeAttribute('style'); else el.setAttribute('style', saved);
    const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
    const px = r.left + scrollX, py = r.top + scrollY;
    const r4 = v => Math.round(v * 10000) / 10000;
    return {
      a: r4(m.a), b: r4(m.b), c: r4(m.c), d: r4(m.d),
      tx: r2(px + ox - (m.a * ox + m.c * oy) + m.e - parentAbs.x),
      ty: r2(py + oy - (m.b * ox + m.d * oy) + m.f - parentAbs.y),
      width: r2(r.width), height: r2(r.height),
    };
  }

  // ---------------------------------------------------------------- SVG
  // xf (optional): CSS transform of the <svg> itself, from leafTransform() with parentAbs = on-screen box.
  //   Baked into the markup as <g transform> so a flipped / rotated icon keeps its on-screen orientation
  //   (found on a real Claude Design export: dropdown chevrons use matrix(-1,0,0,-1,…), header art matrix(-1,0,0,1,…)).
  function serializeSvg(svg, box, xf) {
    if (svg.querySelector(SVG_UNSAFE)) return { unsafe: 'svg-unsafe:' + svg.querySelector(SVG_UNSAFE).tagName };
    const clone = svg.cloneNode(true);
    // inline <use href="#id"> (icon sprites)
    for (const u of [...clone.querySelectorAll('use')]) {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      const target = href.startsWith('#') && document.querySelector(href);
      if (!target) return { unsafe: 'svg-unsafe:use-external' };
      const g = document.createElementNS('http://www.w3.org/2000/svg', target.tagName.toLowerCase() === 'symbol' ? 'svg' : 'g');
      if (target.getAttribute('viewBox')) g.setAttribute('viewBox', target.getAttribute('viewBox'));
      for (const a of ['x', 'y', 'width', 'height']) if (u.getAttribute(a)) g.setAttribute(a, u.getAttribute(a));
      for (const c of target.childNodes) g.appendChild(c.cloneNode(true));
      u.replaceWith(g);
    }
    // copy computed paint of the ORIGINAL elements onto the clone (resolves classes, CSS vars, currentColor)
    const orig = [svg, ...svg.querySelectorAll('*')];
    const copy = [clone, ...clone.querySelectorAll('*')];
    if (orig.length === copy.length) {
      orig.forEach((o, i) => {
        const cs = getComputedStyle(o);
        const tag = o.tagName.toLowerCase();
        const props = tag === 'stop' ? SVG_GRADIENT_PROPS : /^(defs|lineargradient|radialgradient|clippath|symbol)$/.test(tag) ? [] : SVG_PAINT_PROPS;
        for (const p of props) {
          let v = cs.getPropertyValue(p);
          if (!v) continue;
          if (p === 'fill' || p === 'stroke') v = v.replace(/url\(["']?[^)"']*?(#[^)"']+)["']?\)/, 'url($1)');   // url("…#grad") -> url(#grad), keep gradients
          v = v.replace(/(\d)px\b/g, '$1');            // "2px" -> "2" (plain SVG user units)
          if (SVG_DEFAULTS[p] === v) { copy[i].removeAttribute(p); continue; }
          copy[i].setAttribute(p, v);
        }
        copy[i].removeAttribute('class'); copy[i].removeAttribute('style');
        for (const at of [...copy[i].attributes]) if (at.name.startsWith('data-') || at.name.startsWith('aria-')) copy[i].removeAttribute(at.name);
      });
    }
    clone.querySelectorAll('style, script, title, desc').forEach(n => n.remove());
    // paint servers referenced from another <svg> on the page (shared <defs>) -> copy into this SVG
    const refs = new Set((clone.outerHTML.match(/url\(#([^)]+)\)/g) || []).map(u => u.slice(5, -1)));
    for (const rid of refs) {
      if (clone.querySelector('#' + CSS.escape(rid))) continue;
      const src = document.getElementById(rid);
      if (!src || !/gradient|pattern|clippath/i.test(src.tagName)) return { unsafe: 'svg-unsafe:missing-ref #' + rid };
      if (/pattern/i.test(src.tagName)) return { unsafe: 'svg-unsafe:pattern' };
      let defs = clone.querySelector('defs');
      if (!defs) { defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); clone.insertBefore(defs, clone.firstChild); }
      const copy = src.cloneNode(true);
      copy.querySelectorAll('stop').forEach((st, k) => { const c = getComputedStyle(src.querySelectorAll('stop')[k]); st.setAttribute('stop-color', c.stopColor); st.setAttribute('stop-opacity', c.stopOpacity); st.removeAttribute('style'); st.removeAttribute('class'); });
      defs.appendChild(copy);
    }
    if (!clone.getAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width')) || box.width, h = parseFloat(svg.getAttribute('height')) || box.height;
      clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    if (xf) {
      // user units -> layout px (viewBox + preserveAspectRatio), then layout px -> on-screen box (CSS matrix)
      const [vx, vy, vw, vh] = clone.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
      const par = (clone.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim().split(/\s+/);
      let sx = xf.width / vw, sy = xf.height / vh, ax = 0, ay = 0;
      if (par[0] !== 'none') {
        const k = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
        sx = sy = k;
        const fx = /xMid/.test(par[0]) ? 0.5 : /xMax/.test(par[0]) ? 1 : 0, fy = /YMid/.test(par[0]) ? 0.5 : /YMax/.test(par[0]) ? 1 : 0;
        ax = (xf.width - vw * k) * fx; ay = (xf.height - vh * k) * fy;
      }
      const ox = ax - vx * sx, oy = ay - vy * sy, n6 = v => Math.round(v * 1e6) / 1e6;
      const m = [xf.a * sx, xf.b * sx, xf.c * sy, xf.d * sy, xf.a * ox + xf.c * oy + xf.tx, xf.b * ox + xf.d * oy + xf.ty].map(n6);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', `matrix(${m.join(',')})`);
      for (const c of [...clone.childNodes]) if (!(c.nodeType === 1 && c.tagName.toLowerCase() === 'defs')) g.appendChild(c);
      clone.appendChild(g);
      clone.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      clone.removeAttribute('preserveAspectRatio');
      clone.removeAttribute('transform');
    }
    clone.setAttribute('width', box.width); clone.setAttribute('height', box.height);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return { svg: clone.outerHTML };
  }

  // ---------------------------------------------------------------- form controls
  function controlText(el, cs, id, a) {
    const isPh = !el.value;
    const text = (el.value || el.placeholder || '').replace(/\s+/g, ' ');
    if (!text.trim() || el.type === 'password' && !isPh) return null;
    const style = textStyle(isPh ? getComputedStyle(el, '::placeholder') : cs, el);
    if (isPh) { const pc = rgba(getComputedStyle(el, '::placeholder').color); if (pc) style.color = pc; }
    const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth), br = parseFloat(cs.borderRightWidth), bb = parseFloat(cs.borderBottomWidth);
    const pl = parseFloat(cs.paddingLeft), pt = parseFloat(cs.paddingTop), pr = parseFloat(cs.paddingRight), pb = parseFloat(cs.paddingBottom);
    const cw = a.width - bl - br - pl - pr, ch = a.height - bt - bb - pt - pb;
    const lh = style.lineHeight || r2(style.size * 1.25);
    probe.font = `${style.style} ${style.weight} ${style.size}px ${cs.fontFamily}`;
    const w = r2(Math.min(probe.measureText(text).width, cw));
    const multi = el.tagName === 'TEXTAREA';
    let x = bl + pl;
    if (!multi && /center/.test(cs.textAlign)) x += (cw - w) / 2;
    if (!multi && /right|end/.test(cs.textAlign)) x += cw - w;
    const y = multi ? bt + pt : bt + pt + (ch - lh) / 2;
    const box = { x: r2(x), y: r2(y), width: multi ? r2(cw) : w, height: multi ? r2(Math.min(ch, lh * Math.max(1, Math.round(ch / lh)))) : lh };
    style.lineHeight = lh;
    return {
      id: id + 't', type: 'text', name: (isPh ? 'placeholder: ' : 'value: ') + text.slice(0, 30), role: isPh ? 'placeholder' : 'input-value',
      box, absBox: { x: r2(a.x + box.x), y: r2(a.y + box.y), width: box.width, height: box.height },
      opacity: 1, visible: true, originalText: text, wrap: multi ? 'figma' : 'none',
      visualLines: [{ start: 0, end: text.length, box: { x: 0, y: 0, width: box.width, height: lh } }],
      runs: [{ start: 0, end: text.length, usedFamily: null, postScript: null }], style, fontsFrom: 'css',
    };
  }

  // ---------------------------------------------------------------- walk
  function walk(el, parentAbs, opts) {
    if (SKIP.has(el.tagName)) return null;
    if (el.hasAttribute('data-h2f-exclude')) return null;   // another design root (multi-root page, captured separately)
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return null;
    const rect = el.getBoundingClientRect();
    const id = 'n' + (++seq);
    el.setAttribute('data-h2f-id', id);
    const a = abs(rect);
    const base = { id, name: nameOf(el), source: { tag: el.tagName.toLowerCase() }, box: rel(a, parentAbs), absBox: a,
      opacity: r2(+cs.opacity), visible: cs.visibility !== 'hidden' };
    const empty = rect.width === 0 || rect.height === 0;
    const tag = el.tagName;

    if (!empty && opts.rasterSelector && el.matches(opts.rasterSelector)) return { ...base, type: 'raster-pending', reason: 'selector' };
    if (!empty && el.matches(MAP_SELECTOR)) return { ...base, type: 'raster-pending', reason: 'map' };
    if (RASTER_TAGS[tag]) return empty ? null : { ...base, type: 'raster-pending', reason: RASTER_TAGS[tag] };
    if (tag === 'IMG') {
      if (empty) return null;
      const src = el.currentSrc || el.src;
      const isSvg = /\.svg(\?|#|$)/i.test(src) || /^data:image\/svg/i.test(src);
      return { ...base, type: isSvg ? 'svgfile-pending' : 'image-pending', src, fit: cs.objectFit, radius: radii(cs, id, a) };
    }
    if (el instanceof SVGSVGElement) {
      if (empty) return null;
      const tm = cs.transform && cs.transform !== 'none' ? new DOMMatrix(cs.transform) : null;
      const xf = tm && !tm.isIdentity && tm.is2D ? leafTransform(el, cs, tm, a) : null;
      const s = serializeSvg(el, a, xf);
      if (tm && !tm.isIdentity && !tm.is2D) unsupported.push({ nodeId: id, property: 'transform', value: cs.transform.slice(0, 100), action: 'ignored (3D transform on <svg>)' });
      if (s.svg && xf) base.flags = ['svg-css-transform-baked:' + cs.transform.slice(0, 60)];
      // inline <svg> clips to its viewport by default (UA overflow:hidden); icons exported with outlined strokes
      // draw past the viewBox, so the clip matters (found on a Claude Design export: icons looked bolder in Figma)
      const clip = !/visible/.test(cs.overflowX + cs.overflowY);
      return s.svg ? { ...base, type: 'vector', svg: s.svg, clip } : { ...base, type: 'raster-pending', reason: s.unsafe };
    }
    if (tag === 'SELECT' || (tag === 'INPUT' && /^(checkbox|radio|range|color|file|image|date|time|datetime-local|month|week)$/.test(el.type))) {
      return empty ? null : { ...base, type: 'raster-pending', reason: 'native-control' };
    }
    if (tag === 'INPUT' && el.type === 'hidden') return null;
    if (el instanceof SVGElement) return null; // stray SVG child outside an <svg> root
    // icon fonts (ligatures / private-use glyphs) -> raster the element
    if (!empty && ICON_FONT.test(cs.fontFamily) && (el.textContent || '').trim() && !el.children.length) {
      return { ...base, type: 'raster-pending', reason: 'icon-font' };
    }

    const frame = {
      ...base, type: 'frame',
      fills: [rgba(cs.backgroundColor)].filter(Boolean).map(color => ({ type: 'solid', color })),
      bgRaster: cs.backgroundImage && cs.backgroundImage !== 'none' && !empty,
      border: borders(cs), radius: radii(cs, id, a), effects: shadows(cs),
      clip: /(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY),
      children: [],
    };
    for (const [k, ok] of [['filter', 'none'], ['backdropFilter', 'none'], ['mixBlendMode', 'normal'], ['clipPath', 'none'], ['maskImage', 'none']]) {
      if (cs[k] && cs[k] !== ok) unsupported.push({ nodeId: id, property: k, value: String(cs[k]).slice(0, 100), action: 'ignored' });
    }
    if (cs.position === 'fixed' || cs.position === 'sticky') unsupported.push({ nodeId: id, property: 'position', value: cs.position, action: 'approximated' });

    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const t = controlText(el, cs, id, a);
      if (t) frame.children.push(t);
      return frame;
    }
    const pb = pseudoOf(el, 'before'), pa = pseudoOf(el, 'after');
    if (pb) frame.children.push(pb);
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        if (!n.data.trim()) continue;
        textNodes.push(n);
        frame.children.push({ type: 'text-pending', ti: textNodes.length - 1, parentId: id, style: textStyle(cs, el) });
      } else if (n.nodeType === 1) {
        const c = walk(n, a, opts);
        if (c) frame.children.push(c);
      }
    }
    if (pa) frame.children.push(pa);
    // CSS transform: exact for childless frames (Figma relativeTransform); otherwise children keep their on-screen boxes
    if (cs.transform && cs.transform !== 'none') {
      const m = new DOMMatrix(cs.transform);
      if (!m.isIdentity) {
        const t = frame.children.length === 0 && !frame.bgRaster && m.is2D ? leafTransform(el, cs, m, parentAbs) : null;
        if (t) { frame.transform = t; frame.radius = radii(cs, id, { width: t.width, height: t.height }, false); }
        else unsupported.push({ nodeId: id, property: 'transform', value: cs.transform.slice(0, 100),
          action: frame.bgRaster ? 'approximated (captured as image)' : 'approximated (children placed at on-screen boxes)' });
      }
    }
    // shadow roots (web components) are not walked in the spike
    if (el.shadowRoot) unsupported.push({ nodeId: id, property: 'shadow-root', value: el.tagName.toLowerCase(), action: 'ignored' });
    return frame;
  }

  // Design area = the part of the page that becomes the Figma Root Frame (page coordinates).
  //   'document' : whole scrollable document (0,0 .. scroll size)
  //   'body'     : origin = <body> content box (drops the browser's default body margin that exports keep),
  //                size = viewport, grown only if the body content is larger (long/scrolling pages)
  //   'x,y,w,h'  : explicit
  function designArea(mode) {
    const doc = document.documentElement;
    if (!mode || mode === 'document') return { x: 0, y: 0, width: doc.scrollWidth, height: doc.scrollHeight, mode: 'document' };
    if (mode === 'body') {
      const b = document.body, cs = getComputedStyle(b), r = b.getBoundingClientRect();
      const x = r.left + scrollX + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const y = r.top + scrollY + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      const cw = r.width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ch = r.height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return { x: r2(x), y: r2(y), width: r2(Math.max(innerWidth, cw)), height: r2(Math.max(innerHeight, ch)), mode: 'body' };
    }
    const [x, y, w, h] = String(mode).split(',').map(Number);
    if ([x, y, w, h].some(isNaN) || w <= 0 || h <= 0) throw new Error('--design-area must be document | body | x,y,w,h');
    return { x, y, width: w, height: h, mode: 'explicit' };
  }

  // ---------------------------------------------------------------- design root + size (--design-area auto)
  // Order: 1. attribute (data-figma-frame / data-design-root / data-screen-label)
  //        2. $preview {width,height} that Claude Design embeds (data-props JSON / bundled scripts)
  //        3. explicit px width+height on the page's root element (inline style or stylesheet rule)
  //        4. <body> content box (fallback, with warning)
  // Never scales anything. Several roots are all returned — capture.js decides (never silently).
  const ROOT_ATTRS = ['data-figma-frame', 'data-design-root', 'data-screen-label'];
  const pxVal = v => { const m = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(v || ''); return m ? +m[1] : null; };
  const isVisible = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + '#' + CSS.escape(e.id)); break; }
      if (e !== document.body) {
        const same = [...e.parentElement.children].filter(c => c.tagName === e.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  function explicitSize(el) {
    let w = pxVal(el.style.width), h = pxVal(el.style.height);
    const from = [];
    if (w != null || h != null) from.push('inline style');
    if (w == null || h == null) {
      for (const sh of document.styleSheets) {
        let rules; try { rules = sh.cssRules; } catch (e) { continue; }
        for (const r of rules) {
          if (!r.selectorText || !r.style) continue;
          let hit = false; try { hit = el.matches(r.selectorText); } catch (e) {}
          if (!hit) continue;
          if (w == null && pxVal(r.style.width) != null) { w = pxVal(r.style.width); from.push('css ' + r.selectorText); }
          if (h == null && pxVal(r.style.height) != null) { h = pxVal(r.style.height); from.push('css ' + r.selectorText); }
        }
      }
    }
    return w != null && h != null ? { width: w, height: h, from: [...new Set(from)].join(', ') } : null;
  }
  function bodyContent() {
    const b = document.body, cs = getComputedStyle(b), r = b.getBoundingClientRect(), f = k => parseFloat(cs[k]) || 0;
    return { x: r2(r.left + scrollX + f('borderLeftWidth') + f('paddingLeft')), y: r2(r.top + scrollY + f('borderTopWidth') + f('paddingTop')),
      width: r2(r.width - f('borderLeftWidth') - f('borderRightWidth') - f('paddingLeft') - f('paddingRight')),
      height: r2(r.height - f('borderTopWidth') - f('borderBottomWidth') - f('paddingTop') - f('paddingBottom')) };
  }
  function rootInfo(el, source, size) {
    const r = el.getBoundingClientRect();
    const lw = el.offsetWidth || r.width, lh = el.offsetHeight || r.height;   // layout size: ignores ancestor transforms
    const scale = lw ? r2(r.width / lw) : 1;
    const width = size ? size.width : (Math.abs(r.width - lw) < 1 ? r.width : lw);
    const height = size ? size.height : (Math.abs(r.height - lh) < 1 ? r.height : lh);
    const label = ROOT_ATTRS.concat('data-figma-name').map(a => el.getAttribute(a)).find(v => v && v !== 'true') || null;
    return { element: cssPath(el), label, source, sizeFrom: size && size.from || 'layout box', x: r2(r.left + scrollX), y: r2(r.top + scrollY),
      width: r2(width), height: r2(height), rendered: { width: r2(r.width), height: r2(r.height) }, scale, _el: el };
  }
  function findPreviews() {
    const seen = new Map(), add = (w, h, where) => { if (+w > 0 && +h > 0 && !seen.has(w + 'x' + h)) seen.set(w + 'x' + h, { width: +w, height: +h, where }); };
    for (const s of document.querySelectorAll('[data-props]')) {
      try { const p = JSON.parse(s.getAttribute('data-props')).$preview; if (p) add(p.width, p.height, 'data-props'); } catch (e) {}
    }
    if (!seen.size) {   // not rendered yet / other bundle shapes: search script text (quotes may be escaped)
      const q = '(?:"|&quot;|\\\\")';
      const re = new RegExp(q + '\\$preview' + q + '\\s*:\\s*\\{\\s*' + q + 'width' + q + '\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*,\\s*' + q + 'height' + q + '\\s*:\\s*(\\d+(?:\\.\\d+)?)', 'g');
      for (const s of document.scripts) { let m; const t = s.textContent || ''; while ((m = re.exec(t))) add(m[1], m[2], 'script'); }
    }
    return [...seen.values()];
  }
  function descend(pred) {   // breadth-first from <body>, in-flow visible elements only, first level with hits wins
    let level = [document.body];
    for (let d = 0; d < 10 && level.length; d++) {
      const kids = level.flatMap(e => [...e.children]).filter(c => !SKIP.has(c.tagName) && !c.hasAttribute('data-h2f-exclude') &&
        !/^(fixed|absolute)$/.test(getComputedStyle(c).position) && isVisible(c)).slice(0, 200);
      const hits = kids.map(el => ({ el, v: pred(el) })).filter(k => k.v);
      if (hits.length) return hits;
      level = kids;
    }
    return [];
  }
  function detectDesign(opts) {
    opts = opts || {};
    const notes = [];
    const previews = findPreviews();
    let source, roots;
    if (opts.rootSelector) {
      const el = document.querySelector(opts.rootSelector);
      if (!el) throw new Error('--design-root selector matched nothing: ' + opts.rootSelector);
      source = 'option --design-root'; roots = [rootInfo(el, source, explicitSize(el))];
    } else {
      const found = [...document.querySelectorAll(ROOT_ATTRS.map(a => `[${a}]`).join(','))].filter(isVisible);
      const tops = found.filter(e => !found.some(o => o !== e && o.contains(e)));
      if (tops.length) {
        source = 'attribute';
        roots = tops.map(e => rootInfo(e, 'attribute ' + ROOT_ATTRS.find(a => e.hasAttribute(a)), null));
        if (previews.length === 1 && roots.length === 1 && (Math.abs(previews[0].width - roots[0].width) > 1 || Math.abs(previews[0].height - roots[0].height) > 1))
          notes.push(`$preview is ${previews[0].width}x${previews[0].height} but the attribute root is ${roots[0].width}x${roots[0].height} — attribute root used`);
      } else if (previews.length) {
        source = '$preview';
        roots = previews.map(p => {
          const hit = descend(el => { const lw = el.offsetWidth, lh = el.offsetHeight; return Math.abs(lw - p.width) <= 1 && Math.abs(lh - p.height) <= 1; })[0];
          if (hit) return rootInfo(hit.el, '$preview', { ...p, from: '$preview (' + p.where + ')' });
          const b = bodyContent();
          notes.push(`$preview ${p.width}x${p.height}: no element of that size — origin = <body> content box`);
          return { element: 'body (content box)', label: null, source: '$preview', sizeFrom: '$preview (' + p.where + ')', x: b.x, y: b.y, width: p.width, height: p.height, rendered: null, scale: 1 };
        });
      } else {
        // the page's root element only: <body>'s in-flow children, then down single-child wrapper chains (max 4 levels)
        const hits = [];
        let level = [document.body];
        for (let d = 0; d < 4 && level.length && !hits.length; d++) {
          const kids = level.flatMap(e => [...e.children]).filter(c => !SKIP.has(c.tagName) && !/^(IMG|SVG|CANVAS|VIDEO|IFRAME|svg)$/.test(c.tagName) &&
            !/^(fixed|absolute)$/.test(getComputedStyle(c).position) && isVisible(c));
          for (const el of kids) { const s = explicitSize(el); if (s && s.width >= 100 && s.height >= 100) hits.push({ el, v: s }); }
          level = kids.length === 1 ? kids : [];
        }
        if (hits.length) { source = 'explicit-size'; roots = hits.map(h => rootInfo(h.el, 'explicit-size', h.v)); }
        else {
          source = 'body-fallback';
          const b = bodyContent(), doc = document.documentElement;
          const height = b.height > 0 ? b.height : r2(doc.scrollHeight - b.y);
          roots = [{ element: 'body (content box)', label: null, source, sizeFrom: 'body content box', x: b.x, y: b.y, width: b.width, height, rendered: null, scale: 1 }];
          notes.push('WARNING: no design root found (no data-figma-frame / data-design-root / data-screen-label, no $preview, no explicit px size) — using the <body> content box; size depends on the browser viewport');
        }
      }
    }
    document.querySelectorAll('[data-h2f-root]').forEach(e => e.removeAttribute('data-h2f-root'));
    roots.forEach((r, i) => { if (r._el) r._el.setAttribute('data-h2f-root', String(i)); r.index = i; delete r._el; });
    return { source, roots, previews, notes };
  }
  function excludeOtherRoots(index) {   // multi-root page: capture one root, leave the others out of the walk
    let n = 0;
    document.querySelectorAll('[data-h2f-root]').forEach(e => { if (e.getAttribute('data-h2f-root') !== String(index)) { e.setAttribute('data-h2f-exclude', ''); n++; } });
    return n;
  }

  function walkDocument(opts) {
    opts = opts || {};
    const doc = document.documentElement;
    const area = opts.area || designArea(opts.designArea);
    // Root = the design area at (0,0). <body> is its child; all boxes are parent-relative, so only
    // body's box moves by -origin here (absBox values are shifted in capture.js after assets are shot).
    const body = walk(document.body, { x: 0, y: 0 }, opts);
    if (body) { body.box.x = r2(body.box.x - area.x); body.box.y = r2(body.box.y - area.y); }
    const htmlBg = rgba(getComputedStyle(doc).backgroundColor);
    const bodyBg = body && body.fills.find(f => f.type === 'solid');
    // CSS canvas rule: without an html background, the body background paints the whole canvas
    const canvas = htmlBg || (bodyBg && bodyBg.color) || { r: 1, g: 1, b: 1, a: 1 };
    const rootBox = { x: 0, y: 0, width: area.width, height: area.height };
    const root = { id: 'root', name: 'Page', source: { tag: 'html' }, type: 'frame', box: rootBox, absBox: { ...rootBox },
      opacity: 1, visible: true, fills: [{ type: 'solid', color: canvas }], border: null, radius: null, effects: [], clip: true,
      children: body ? [body] : [] };
    return { root, unsupported, area, sourceDocument: { width: doc.scrollWidth, height: doc.scrollHeight }, textNodeCount: textNodes.length };
  }

  // ---------------------------------------------------------------- text measurement (spec §4.2)
  // Returns rendered text (collapsed whitespace removed), raw offsets per rendered char, visual lines (abs).
  const seg = new Intl.Segmenter('th', { granularity: 'grapheme' });
  // Line-box top from Chrome itself: two zero-size inline-blocks (vertical-align top / bottom) are put in front of the
  // text node, read and removed at once. Needed because the glyph box is not centred in the line box when the
  // line-height is smaller than the font's content height (seen on a real export: line-height 1.4 / 1.0 with
  // IBM Plex Sans Thai / DB Ozone X -> text placed 0.7 px too high -> 1 px after pixel snapping).
  // Used only if the text's own rects do not move and the probed line box is exactly one line-height tall.
  function lineBoxTop(tn, lh) {
    const p = tn.parentElement;
    if (!p || !lh || /flex|grid/.test(getComputedStyle(p).display)) return null;   // text = anonymous flex/grid item
    const rects = () => { const r = document.createRange(); r.selectNodeContents(tn); const q = [...r.getClientRects()].filter(x => x.width > 0);
      return q.length ? [q.length, q[0].left, q[0].top, q[q.length - 1].right, q[q.length - 1].top] : null; };
    const mk = va => { const m = document.createElement('h2f-m');
      for (const [k, v] of [['display', 'inline-block'], ['width', '0'], ['height', '0'], ['margin', '0'], ['padding', '0'], ['border', '0'], ['vertical-align', va], ['line-height', '0'], ['font-size', '0']]) m.style.setProperty(k, v, 'important');
      return m; };
    const before = rects();
    const t = mk('top'), b = mk('bottom');
    p.insertBefore(t, tn); p.insertBefore(b, tn);
    const top = t.getBoundingClientRect().top, bottom = b.getBoundingClientRect().bottom;
    const after = rects();
    t.remove(); b.remove();
    if (!before || !after || before.some((v, i) => Math.abs(v - after[i]) > 0.01)) return null;
    if (Math.abs(bottom - top - lh) > 0.5) return null;   // mixed inline content made the line taller: keep the centred box
    return top;
  }
  function measureText(ti, lineHeight) {
    const tn = textNodes[ti];
    let text = '';
    const raw = [];
    const lines = [];
    let cur = null, prev = null, pendingSpace = -1;
    for (const g of seg.segment(tn.data)) {
      const r = document.createRange();
      r.setStart(tn, g.index); r.setEnd(tn, g.index + g.segment.length);
      const rect = [...r.getClientRects()].find(q => q.width > 0);
      const ws = /^\s+$/.test(g.segment);
      if (!rect) {                              // collapsed whitespace (e.g. the space at a soft wrap) / hidden
        if (ws && text && !text.endsWith(' ') && pendingSpace < 0) pendingSpace = g.index;
        continue;
      }
      if (ws && (text.endsWith(' ') || !text)) continue;
      if (!ws && pendingSpace >= 0 && cur) { text += ' '; raw.push(pendingSpace); cur.end = text.length; }
      pendingSpace = -1;
      let newLine = !cur;
      if (cur) {
        const overlap = Math.min(cur.bottom, rect.bottom) - Math.max(cur.top, rect.top);
        if (overlap < 0.5 * Math.min(cur.bottom - cur.top, rect.height)) newLine = true;
        else if (prev && rect.left < prev.left - 1) newLine = true;
      }
      if (newLine) {
        if (ws) continue;                       // never start a line with a space
        cur = { start: text.length, end: text.length, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        lines.push(cur);
      }
      if (ws) { text += ' '; raw.push(g.index); }          // any collapsed whitespace run -> one space
      else { text += g.segment; for (let k = 0; k < g.segment.length; k++) raw.push(g.index + k); }
      cur.end = text.length;
      if (!ws) { cur.left = Math.min(cur.left, rect.left); cur.right = Math.max(cur.right, rect.right); }
      cur.top = Math.min(cur.top, rect.top); cur.bottom = Math.max(cur.bottom, rect.bottom);
      prev = rect;
    }
    if (!lines.length) return null;
    const probed = lineBoxTop(tn, lineHeight);
    const first = lines[0], y0 = (first.top + first.bottom) / 2 - (lineHeight || 0) / 2;
    const dy = probed != null && Math.abs(probed - y0) <= lineHeight / 2 ? probed - y0 : 0;   // same shift for every line (same line-height)
    return {
      text, raw, lineTop: probed != null ? 'probed' : 'centred',
      lines: lines.map(l => {
        const cy = (l.top + l.bottom) / 2, h = lineHeight || (l.bottom - l.top);
        return { start: l.start, end: l.end, box: { x: r2(l.left + scrollX), y: r2(cy - h / 2 + dy + scrollY), width: r2(l.right - l.left), height: r2(h) } };
      }),
    };
  }

  // ---------------------------------------------------------------- font-run spans (spike 2 method)
  function wrapWhole(ti) {
    const tn = textNodes[ti];
    const w = document.createElement('h2f-w');
    w.setAttribute('data-i', ti);
    tn.replaceWith(w); w.appendChild(tn);
    void document.body.offsetHeight; // force layout before CDP asks for platform fonts
    return true;
  }
  function splitRuns(ti) {
    const w = document.querySelector(`h2f-w[data-i="${ti}"]`);
    const tn = textNodes[ti];
    const cls = c => /[฀-๿]/.test(c) ? 'thai' : /\s/.test(c) ? 'space' : /\d/.test(c) ? 'digit' : /[A-Za-z]/.test(c) ? 'latin' : 'punct';
    const out = []; let i = 0;
    for (const ch of tn.data) {
      const k = cls(ch), last = out[out.length - 1];
      if (last && last.cls === k) last.end += ch.length; else out.push({ cls: k, start: i, end: i + ch.length });
      i += ch.length;
    }
    tn.remove();
    out.forEach((r, n) => { const s = document.createElement('h2f-r'); s.setAttribute('data-r', n); s.textContent = tn.data.slice(r.start, r.end); w.appendChild(s); });
    void document.body.offsetHeight;
    return out;
  }
  function unwrap(ti) {
    const w = document.querySelector(`h2f-w[data-i="${ti}"]`);
    if (w) w.replaceWith(textNodes[ti]);
  }

  // ---------------------------------------------------------------- CSS paint order (for pseudo-element layers)
  // Does box a paint above box b? A box is an element or a pseudo-element: { id: data-h2f-id, pseudo: 'before'|'after'|null }.
  // CSS 2.1 Appendix E, simplified: inside each stacking context, painters are ordered by layer —
  //   z<0 · in-flow · positioned z:auto/0 (and opacity/transform) · z>0 — then by z-index, then by tree order.
  // Read-only: uses computed styles and the DOM tree, nothing in the page changes.
  // Returns 1 (a above b), -1 (a below b) or 0 (could not tell).
  // A box: { el, pseudo: 'before'|'after'|null, text: true for the element's own text (in-flow content) }
  const TEXT_STYLE = { position: 'static', zIndex: 'auto', opacity: '1', transform: 'none', filter: 'none', isolation: 'auto', mixBlendMode: 'normal', clipPath: 'none', maskImage: 'none', contain: 'none' };
  function boxStyle(b) { return b.text ? TEXT_STYLE : getComputedStyle(b.el, b.pseudo ? '::' + b.pseudo : null); }
  function parentBox(b) { return b.pseudo || b.text ? { el: b.el, pseudo: null } : b.el.parentElement ? { el: b.el.parentElement, pseudo: null } : null; }
  function flexItem(b) { const p = b.pseudo ? b.el : b.el.parentElement; return !!p && /flex|grid/.test(getComputedStyle(p).display); }
  function isContext(b, cs) {
    if (b.text) return false;
    if (!b.pseudo && b.el === document.documentElement) return true;
    return (cs.zIndex !== 'auto' && (cs.position !== 'static' || flexItem(b))) || +cs.opacity < 1 || cs.transform !== 'none' ||
      cs.filter !== 'none' || cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal' || /fixed|sticky/.test(cs.position) ||
      (cs.clipPath && cs.clipPath !== 'none') || (cs.maskImage && cs.maskImage !== 'none') || /paint|strict|content/.test(cs.contain || '');
  }
  const sameBox = (a, b) => !!a && !!b && a.el === b.el && a.pseudo === b.pseudo && !a.text === !b.text;
  function ctxOf(x) { for (let y = parentBox(x); y; y = parentBox(y)) if (isContext(y, boxStyle(y))) return y; return null; }
  // For each stacking context from the root down to the box: the painter ordered in that context and its layer.
  // Painter = nearest positioned box / stacking context between the box and the context, else the box itself (in-flow).
  function paintChain(b) {
    const out = [];
    for (let x = b; ;) {
      const S = ctxOf(x);
      if (!S) break;
      let painter = null, cs = null;
      for (let y = x; y && !sameBox(y, S); y = parentBox(y)) { const c = boxStyle(y); if (c.position !== 'static' || isContext(y, c)) { painter = y; cs = c; break; } }
      let key = [1, 0];
      if (painter) {
        const z = cs.zIndex === 'auto' ? 0 : +cs.zIndex;
        key = isContext(painter, cs) && z < 0 ? [0, z] : isContext(painter, cs) && z > 0 ? [3, z] : [2, 0];
      }
      out.unshift({ painter: painter || x, key });
      x = S;
    }
    return out;
  }
  // tree (pre-)order: element, its ::before, its own text, its children, its ::after
  // (an element's text is placed before its child elements: text and children are not told apart here)
  function treeCompare(a, b) {
    if (sameBox(a, b)) return 0;
    const rank = x => x.pseudo === 'before' ? 1 : x.text ? 2 : x.pseudo === 'after' ? 3 : 0;
    if (a.el === b.el) return rank(a) < rank(b) ? -1 : 1;
    if (a.text) a = { el: a.el, pseudo: 'before' };   // same position relative to other elements
    if (b.text) b = { el: b.el, pseudo: 'before' };
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) return a.pseudo === 'after' ? 1 : -1;     // b inside a's element
    if (pos & Node.DOCUMENT_POSITION_CONTAINS) return b.pseudo === 'after' ? -1 : 1;         // a inside b's element
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }
  function paintCompare(ra, rb) {
    const box = r => ({ el: document.querySelector(`[data-h2f-id="${r.id}"]`), pseudo: r.pseudo || null, text: !!r.text });
    const a = box(ra), b = box(rb);
    if (!a.el || !b.el) return 0;
    const ca = paintChain(a), cb = paintChain(b);
    let i = 0;
    while (i < ca.length && i < cb.length && sameBox(ca[i].painter, cb[i].painter)) i++;
    if (i < ca.length && i < cb.length) {
      const ka = ca[i].key, kb = cb[i].key;
      if (ka[0] !== kb[0]) return ka[0] > kb[0] ? 1 : -1;
      if (ka[1] !== kb[1]) return ka[1] > kb[1] ? 1 : -1;
      return treeCompare(ca[i].painter, cb[i].painter) > 0 ? 1 : -1;
    }
    // one box is the stacking context the other one is painted in: a context paints below its own content
    if (i === ca.length && i < cb.length) return -1;
    if (i === cb.length && i < ca.length) return 1;
    return treeCompare(a, b) > 0 ? 1 : treeCompare(a, b) < 0 ? -1 : 0;   // both in-flow in the same painter
  }
  function paintOrder(ref, others) { return others.map(o => paintCompare(ref, o)); }

  window.__h2f = { walkDocument, detectDesign, excludeOtherRoots, measureText, wrapWhole, splitRuns, unwrap, pseudoPaint, paintOrder };
})();
