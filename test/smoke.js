// npm test — quick checks on the small fixtures kept in spikes/fixtures (no private files needed).
//   capture → schema valid · Root Frame = design size · mock import creates every layer · determinism · exit codes
const fs = require('fs'), path = require('path'), os = require('os');
const { PROD_CLI, runCapture, findDesigns, readJson, harness, fontFace, comparable, assetRefs } = require('./lib');
const { inputDirRedactor } = require('../capture/redact');
const { mockImport } = require('./mock-figma');

const FIX = path.join(__dirname, '..', 'spikes', 'fixtures');
const EXPECT = {   // fixture -> expected Root Frame (design size) and detection source
  'Login-Change-Organization/375x812': ['attribute data-screen-label'],
  'Dashboard-1440-preview-only/1440x900': ['$preview'],
  'Report-long-page/1920x2351': ['explicit-size'],
  'Two-screens/Home/390x844': ['attribute data-screen-label'],
  'Two-screens/Detail/390x844': ['attribute data-screen-label'],
  'Plain-no-size/1904x80': ['body-fallback'],
  'e2e-spike/1920x992': ['body-fallback'],
};

(async () => {
  const t = harness('npm test');

  // cross-platform normalizations (values seen on Windows vs Linux for the same page)
  const winRedact = inputDirRedactor(path.join(os.tmpdir(), 'h2f-helper-Ab12', 'input', 'Menu แจ้ง (1).html'));
  const url = require('url').pathToFileURL(path.join(os.tmpdir(), 'h2f-helper-Ab12', 'input', 'Menu แจ้ง (1).html')).href;
  t.check('redaction: temp folder in a failed-request URL -> <input-dir>, file name and error kept',
    winRedact(`request failed: ${url} (origin)`) === `request failed: <input-dir>/${url.split('/').pop()} (origin)`, winRedact(`request failed: ${url} (origin)`));
  t.check('font face: Anuphan-Regular (Linux) and Anuphan-Medium (Windows) at weight 500 are the same face; Arial is not',
    fontFace({ usedFamily: 'Anuphan', postScript: 'Anuphan-Regular' }, { weight: 500 }) === fontFace({ usedFamily: 'Anuphan', postScript: 'Anuphan-Medium' }, { weight: 500 })
    && fontFace({ usedFamily: 'IBM Plex Sans Thai Medium' }, { weight: 500 }) === 'IBM Plex Sans Thai|500|normal'
    && fontFace({ usedFamily: 'Arial' }, { weight: 500 }) !== fontFace({ usedFamily: 'Anuphan' }, { weight: 500 }));
  const cmp = comparable({ capture: {}, report: { warnings: ['request failed: file:///C:/a/b/very-long-name-truncat (origin)', 'page error: x'], fallbacks: [] } }, 'C:\\a\\b\\page.html');
  t.check('prod/spike comparison: failed-request URL compared by type + error only, other warnings unchanged',
    cmp.report.warnings[0] === 'request failed: <url> (origin)' && cmp.report.warnings[1] === 'page error: x', JSON.stringify(cmp.report.warnings));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'h2f-smoke-'));
  console.log('output:', out);

  let r = runCapture(PROD_CLI, []);
  t.check('usage error exits with 2', r.code === 2);
  r = runCapture(PROD_CLI, [path.join(FIX, 'design-size', 'Two-screens.html'), '--out', path.join(out, 'stop')]);
  t.check('several design roots without --design-root: stops with exit 3 and lists them', r.code === 3 && /2 design roots found/.test(r.out));

  r = runCapture(PROD_CLI, [path.join(FIX, 'design-size'), path.join(FIX, 'e2e-spike.html'), '--design-root', 'all', '--out', out]);
  t.check('capture of all fixtures exits 0', r.code === 0, r.code ? r.out.slice(-400) : '');
  const dirs = findDesigns(out).filter(d => !d.includes(path.sep + 'stop' + path.sep));
  const rel = d => path.relative(out, d).split(path.sep).join('/');
  t.check('one design.json per design root', dirs.length === Object.keys(EXPECT).length, dirs.map(rel).join(', '));

  for (const dir of dirs) {
    const key = rel(dir), exp = EXPECT[key];
    if (!t.check(`${key}: expected output folder`, !!exp)) continue;
    const rep = readJson(path.join(dir, 'capture-report.json')), d = readJson(path.join(dir, 'design.json'));
    const [w, h] = key.split('/').pop().split('x').map(Number);
    t.check(`${key}: schema valid`, rep.schemaValid, JSON.stringify(rep.schemaErrors || []).slice(0, 200));
    t.check(`${key}: Root Frame = ${w}x${h} (${exp[0]})`, Math.round(d.root.box.width) === w && Math.round(d.root.box.height) === h && rep.detectionSource === exp[0],
      `${d.root.box.width}x${d.root.box.height} from ${rep.detectionSource}`);
    t.check(`${key}: reference.png = design size @${d.capture.deviceScaleFactor}x`, (() => { const b = fs.readFileSync(path.join(dir, 'reference.png'));
      return Math.abs(b.readUInt32BE(16) - d.root.box.width * d.capture.deviceScaleFactor) <= 2 && Math.abs(b.readUInt32BE(20) - d.root.box.height * d.capture.deviceScaleFactor) <= 2; })());
    const m = await mockImport(d);
    t.check(`${key}: mock import creates every layer, none missing`, m.summary.layers.created === m.summary.layers.expected && !m.report.missing.length,
      `${m.summary.layers.created}/${m.summary.layers.expected}, missing ${m.report.missing.length}`);
  }
  const login = dirs.find(d => rel(d).startsWith('Login'));
  const overflow = login && readJson(path.join(login, 'capture-report.json')).overflowDesignArea;
  t.check('Login: portal sticking out of the design is clipped and reported', overflow && overflow.some(o => o.name === 'div#menu'));

  // determinism: capture the same file again, normalized design.json must be identical
  r = runCapture(PROD_CLI, [path.join(FIX, 'design-size', 'Login-Change-Organization.html'), '--out', path.join(out, 'again')]);
  const a = fs.readFileSync(path.join(login, 'design.normalized.json'), 'utf8');
  const b = fs.readFileSync(path.join(out, 'again', 'Login-Change-Organization', '375x812', 'design.normalized.json'), 'utf8');
  const strip = s => s.replace(/"capturedAt": "[^"]*",?/, '');
  t.check('determinism: normalized design.json identical on re-capture', r.code === 0 && strip(a) === strip(b));

  await pseudoFixture(t, out);
  process.exit(t.finish());
})().catch(e => { console.error(e); process.exit(1); });

// ::before / ::after — test/fixtures/pseudo-stepper.html
//   A: 4-step stepper, connectors are ::after between the circles (same CSS as the real mobile export)
//   B: connectors are ::before from circle to circle, BEHIND the circles (circles z-index: 1)
//   C: 0.5 px hairline, border ring (radius, opacity), text badge, rotated chevron, gradient (too complex), empty
async function pseudoFixture(t, out) {
  const { walkNodes, pixelDiff } = require('./lib');
  const r = runCapture(PROD_CLI, [path.join(__dirname, 'fixtures', 'pseudo-stepper.html'), '--out', path.join(out, 'pseudo')]);
  const dir = path.join(out, 'pseudo', 'pseudo-stepper', '390x420');
  if (!t.check('pseudo fixture: capture ok, schema valid', r.code === 0 && fs.existsSync(path.join(dir, 'design.json')) && readJson(path.join(dir, 'capture-report.json')).schemaValid, r.code ? r.out.slice(-300) : '')) return;
  const d = readJson(path.join(dir, 'design.json'));
  const all = [], parent = new Map(), order = new Map();
  walkNodes(d.root, (n, p) => { order.set(n, all.length); all.push(n); parent.set(n, p); });
  const byName = re => all.filter(n => re.test(n.name));
  const near = (a, b) => Math.abs(a - b) <= 0.5;
  const rgb = (c, r, g, b) => !!c && [[c.r, r], [c.g, g], [c.b, b]].every(([v, w]) => Math.abs(v * 255 - w) <= 1.5);   // design.json keeps 2 decimals
  const green = c => rgb(c, 17, 136, 64), grey = c => rgb(c, 219, 219, 219);
  const center = n => n.absBox.x + n.absBox.width / 2;
  const stepper = cls => all.find(n => n.name === 'nav.stepper.' + cls);
  const circlesOf = nav => { const c = []; walkNodes(nav, n => { if (n.name === 'div.circle') c.push(n); }); return c; };
  const subtreeEnd = n => { let e = order.get(n); walkNodes(n, x => { e = Math.max(e, order.get(x)); }); return e; };

  // A: ::after connectors
  const navA = stepper('a'), cA = circlesOf(navA);
  const conA = []; walkNodes(navA, n => { if (/::after$/.test(n.name)) conA.push(n); });
  t.check('pseudo A: 3 connectors captured as layers named "<parent>::after"', conA.length === 3 && conA.every(n => n.type === 'frame' && /^div\.step.*::after$/.test(n.name)), conA.map(n => n.name).join(', '));
  t.check('pseudo A: 1→2 green, 2→3 and 3→4 grey', conA.length === 3 && green(conA[0].fills[0].color) && grey(conA[1].fills[0].color) && grey(conA[2].fills[0].color));
  const geoA = conA.map((n, i) => ({ x: center(cA[i]) + 17, x2: center(cA[i + 1]) - 17, y: cA[i].absBox.y + 15, n }));
  t.check('pseudo A: geometry = from circle i + 17 px to circle i+1 − 17 px, top 15 px, 2 px high (±0.5 px)', geoA.every(g => near(g.n.absBox.x, g.x) && near(g.n.absBox.x + g.n.absBox.width, g.x2) && near(g.n.absBox.y, g.y) && near(g.n.absBox.height, 2)),
    geoA.map(g => `${g.n.absBox.x},${g.n.absBox.y} ${g.n.absBox.width}x${g.n.absBox.height} (want ${g.x.toFixed(2)}..${g.x2.toFixed(2)})`).join(' · '));
  t.check('pseudo A: ::after is the last layer of its step (drawn after the children)', conA.every(n => { const p = parent.get(n); return p.children[p.children.length - 1] === n && /^div\.step/.test(p.name); }));

  // B: ::before connectors behind the circles
  const navB = stepper('b'), cB = circlesOf(navB);
  const conB = byName(/::before$/).filter(n => /^div\.step/.test(n.name));
  t.check('pseudo B: 3 connectors captured as layers named "<parent>::before"', conB.length === 3 && conB.every(n => n.type === 'frame'), conB.map(n => n.name).join(', '));
  t.check('pseudo B: 1→2 green, others grey', conB.length === 3 && green(conB[0].fills[0].color) && grey(conB[1].fills[0].color) && grey(conB[2].fills[0].color));
  t.check('pseudo B: geometry = centre of circle i to centre of circle i+1, 2 px high (±0.5 px)', conB.every((n, i) => near(n.absBox.x, center(cB[i])) && near(n.absBox.x + n.absBox.width, center(cB[i + 1])) && near(n.absBox.height, 2)),
    conB.map(n => `${n.absBox.x}..${(n.absBox.x + n.absBox.width).toFixed(2)}`).join(' · '));
  const behind = conB.every((n, i) => [cB[i], cB[i + 1]].every(c => order.get(n) < order.get(c)));
  t.check('pseudo B: every connector is BELOW both circles it touches (CSS z-index order kept)', behind,
    conB.map(n => `${n.id} in ${parent.get(n).name} @${order.get(n)} vs circles ${cB.map(c => order.get(c)).join('/')}`).join(' · '));
  t.check('pseudo B: connectors stay inside the stepper (no layer above it)', conB.every(n => parent.get(n) === navB || parent.get(parent.get(n)) === navB));

  // C: other simple visuals
  const one = re => byName(re)[0];
  const hair = one(/hair::after$/), ring = one(/ring::before$/), badge = one(/badge::after$/), chev = one(/chev::before$/), grad = all.find(n => /grad::before$/.test(n.name));
  t.check('pseudo C: 0.5 px hairline kept as 0.5 px (not rounded to 0 or 1)', hair && hair.box.height === 0.5 && near(hair.absBox.width, 64) && hair.fills.length === 1, hair && JSON.stringify(hair.box));
  t.check('pseudo C: ring = border + border-radius + opacity, drawn 4 px outside its box', ring && ring.border && ring.border.top.width > 0 && ring.radius && ring.radius.topLeft === 10 && ring.opacity === 0.6 && ring.box.x === -4 && ring.box.width === 72,
    ring && JSON.stringify({ b: ring.border && ring.border.top, r: ring.radius, o: ring.opacity, box: ring.box }));
  const bt = badge && badge.children[0];
  t.check('pseudo C: badge = frame (background, radius) + editable text "NEW"', badge && badge.fills.length && badge.radius && bt && bt.type === 'text' && bt.originalText === 'NEW' && bt.runs[0].postScript,
    badge && JSON.stringify({ text: bt && bt.originalText, box: bt && bt.box }));
  t.check('pseudo C: rotated chevron = frame with a 45° transform (12×12 box)', chev && chev.transform && near(Math.atan2(chev.transform.b, chev.transform.a) * 180 / Math.PI, 45) && chev.transform.width === 12 && chev.border,
    chev && JSON.stringify(chev.transform));
  const rep = d.report;
  t.check('pseudo C: gradient pseudo-element -> image layer + reported as unsupported (not silent)', grad && grad.type === 'raster' && grad.assetId &&
    rep.unsupported.some(u => u.nodeId === grad.id && u.property === 'pseudo-element' && /rasterized/.test(u.action)), grad && grad.type);
  t.check('pseudo C: empty pseudo-element (content "" with no size / paint) creates no layer, counted in the report',
    !byName(/empty::after$/).length && rep.pseudoElements && rep.pseudoElements.empty === 1, JSON.stringify(rep.pseudoElements && { ...rep.pseudoElements, items: undefined }));
  t.check('pseudo: report lists every pseudo-element with its result', rep.pseudoElements && rep.pseudoElements.items.length === 12 && rep.pseudoElements.items.every(i => i.result),
    rep.pseudoElements && rep.pseudoElements.items.map(i => i.nodeId + '=' + i.result).join(' '));

  // mock Figma: every layer created, pseudo-element layers at Chrome's geometry (±0.5 px)
  const m = await mockImport(d);
  t.check('pseudo: mock import creates every layer, none missing', m.summary.layers.created === m.summary.layers.expected && !m.report.missing.length, `${m.summary.layers.created}/${m.summary.layers.expected}`);
  const figmaRoot = m.page.children[m.page.children.length - 1], fnodes = new Map();
  (function f(n) { if (n.pluginData && n.pluginData.h2f) fnodes.set(n.pluginData.h2f, n); (n.children || []).forEach(f); })(figmaRoot);
  const rt = figmaRoot.absoluteTransform;
  const pseudoNodes = all.filter(n => n.source && n.source.pseudo);
  const bad = pseudoNodes.filter(n => {
    const f = fnodes.get(n.id);
    if (!f) return true;
    if (n.transform) return !(f.relativeTransform && near(f.relativeTransform[0][2], n.transform.tx) && near(f.relativeTransform[1][2], n.transform.ty));   // mock does not rotate
    const b = f.absoluteBoundingBox;
    return !(near(b.x - rt[0][2], n.absBox.x) && near(b.y - rt[1][2], n.absBox.y) && near(b.width, n.absBox.width) && near(b.height, n.absBox.height));
  });
  t.check(`pseudo: mock Figma has all ${pseudoNodes.length} pseudo-element layers at Chrome's geometry (±0.5 px)`, pseudoNodes.length === 11 && !bad.length, bad.map(n => n.id).join(', '));
  const fh = hair && fnodes.get(hair.id);
  t.check('pseudo: Figma hairline layer is 64 × 0.5 px with a solid fill (sub-pixel height not rounded away)', fh && fh.height === 0.5 && fh.width === 64 && fh.fills.length === 1 && fh.fills[0].type === 'SOLID', fh && `${fh.width}x${fh.height}`);
  const figOrder = new Map(); let k = 0; (function f(n) { figOrder.set(n, k++); (n.children || []).forEach(f); })(figmaRoot);
  t.check('pseudo: Figma layer order puts connector B below the circles', conB.every((n, i) => [cB[i], cB[i + 1]].every(c => figOrder.get(fnodes.get(n.id)) < figOrder.get(fnodes.get(c.id)))));

  // z-order cases (test/fixtures/pseudo-zindex.html): layer order must reproduce Chrome's paint order
  const rz = runCapture(PROD_CLI, [path.join(__dirname, 'fixtures', 'pseudo-zindex.html'), '--out', path.join(out, 'pseudo-z')]);
  const zdir = path.join(out, 'pseudo-z', 'pseudo-zindex', '340x240');
  if (!t.check('pseudo z-order fixture: capture ok', rz.code === 0 && fs.existsSync(path.join(zdir, 'design.json')), rz.code ? rz.out.slice(-300) : '')) return;
  const z = readJson(path.join(zdir, 'design.json'));
  const zl = []; walkNodes(z.root, (n, p) => zl.push({ n, p }));
  const kidsOf = name => (zl.find(x => x.n.name === name) || { n: { children: [] } }).n.children.map(c => c.id);
  const zid = re => (zl.find(x => re.test(x.n.name)) || { n: {} }).n.id;
  const b1 = kidsOf('div.b1'), b3 = kidsOf('div.b3'), body = kidsOf('body');
  t.check('pseudo z-order: z-index:-1 in a stacking context -> below the element\'s text', b1[0] === zid(/b1::after$/) && b1.length === 2, b1.join(' '));
  t.check('pseudo z-order: z-index:-1 without a stacking context -> below the card background (hidden, as in Chrome)', body[0] === zid(/b2::before$/), body.join(' '));
  t.check('pseudo z-order: ::after below a positioned child with z-index:2', b3[0] === zid(/b3::after$/), b3.join(' '));
  const css = path.join(out, 'pseudo-z', 'none.css'); fs.writeFileSync(css, '');   // system fonts only, same as the capture
  runCapture(path.join(__dirname, 'render-design.js'), [path.join(zdir, 'design.json'), '', css]);
  const px = pixelDiff(zdir);
  t.check('pseudo z-order: rerender of design.json = Chrome screenshot (layout diff 0 %)', px.layoutPct === 0, JSON.stringify(px));
}
