// npm test — quick checks on the small fixtures kept in spikes/fixtures (no private files needed).
//   capture → schema valid · Root Frame = design size · mock import creates every layer · determinism · exit codes
const fs = require('fs'), path = require('path'), os = require('os');
const { PROD_CLI, runCapture, findDesigns, readJson, harness } = require('./lib');
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

  process.exit(t.finish());
})().catch(e => { console.error(e); process.exit(1); });
