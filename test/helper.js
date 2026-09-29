// npm run test:helper — Local Helper (MVP-B): security, uploads, temp cleanup, capture via the existing CLI.
// With the regression inputs present, the two real pages are also captured through the Helper and compared with the CLI.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), { spawn, execFileSync } = require('child_process');
const Ajv2020 = require('ajv/dist/2020');
const { ROOT, PROD_CLI, runCapture, readJson, harness, firstDiff, baselineInput, INPUTS_DIR } = require('./lib');
const { mockImport } = require('./mock-figma');
const temp = require('../local-helper/temp-files');

const FIX = path.join(ROOT, 'spikes', 'fixtures');
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(readJson(path.join(ROOT, 'schema', 'design.schema.json')));

function startHelper(args, tempDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'local-helper', 'server.js'), '--port', '0', '--temp-dir', tempDir, ...args],
      { env: { ...process.env, H2F_HELPER_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    const kids = [];   // PIDs of capture processes the Helper started (announced in test mode)
    child.stdout.on('data', d => {
      out += d;
      for (const m of String(d).matchAll(/H2F_CHILD (\d+)/g)) kids.push(+m[1]);
      const m = out.match(/H2F_HELPER_READY (\{.*\})/);
      if (m && !child.ready) { child.ready = true; resolve({ child, kids, ...JSON.parse(m[1]), log: () => out }); }
    });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { if (!child.ready) reject(new Error('helper exited ' + c + ': ' + out)); });
    process.on('exit', () => { try { child.kill('SIGKILL'); } catch (e) {} });   // never leave a Helper behind, even when a test crashes
  });
}
// raw request (lets us set Host / Origin freely)
function req(h, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ agent: false, host: '127.0.0.1', port: h.port, method, path: p, headers: { host: `127.0.0.1:${h.port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const auth = h => ({ authorization: 'Bearer ' + h.token });
const upload = (h, name, bytes, q = '') => req(h, 'POST', `/capture?name=${encodeURIComponent(name)}${q}`, { body: bytes, headers: { ...auth(h), 'content-type': 'application/octet-stream' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- process checks (test only): a capture PID and every process below it
const isWin = process.platform === 'win32';
function processTree(pid) {
  let rows = [];
  try {
    const out = isWin
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8', windowsHide: true })
      : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    rows = out.split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number)).filter(r => r[0]);
  } catch (e) {}
  const tree = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const [p, pp] of rows) if (tree.has(pp) && !tree.has(p)) { tree.add(p); grew = true; } }
  return [...tree];
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Stop the Helper the way a user does: Ctrl+C (SIGINT) on POSIX. On Windows a signal cannot be sent to another
// process (child.kill would terminate it without cleanup), so the test uses the Helper's IPC "shutdown" message,
// which runs the same stop routine as Ctrl+C.
async function stopHelper(h, how = 'ipc') {
  const exited = new Promise(res => h.child.on('exit', res));
  if (how === 'SIGINT') h.child.kill('SIGINT'); else h.child.send('shutdown');
  return exited;
}
async function waitForBrowser(h, ms = 20000) {   // capture process running and its browser started
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const k = h.kids[h.kids.length - 1]; if (k && pidAlive(k)) { const tree = processTree(k); if (tree.length >= 3) return tree; } await sleep(100); }
  return null;
}
async function runJob(h, name, bytes, q = '') {
  const r = await upload(h, name, bytes, q);
  if (r.status !== 202) return { submit: r };
  const stages = new Set();
  for (;;) {
    const s = await req(h, 'GET', `/jobs/${r.json.jobId}`, { headers: auth(h) });
    stages.add(s.json.stage);
    if (s.json.state === 'done' || s.json.state === 'error') break;
    await sleep(150);
  }
  const res = await req(h, 'GET', `/jobs/${r.json.jobId}/result`, { headers: auth(h) });
  const again = await req(h, 'GET', `/jobs/${r.json.jobId}/result`, { headers: auth(h) });
  return { submit: r, result: res, again, stages: [...stages] };
}

(async () => {
  const t = harness('npm run test:helper');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2f-helper-test-'));
  const h = await startHelper([], tmp);
  console.log(`helper on 127.0.0.1:${h.port}, temp ${tmp}`);
  const login = fs.readFileSync(path.join(FIX, 'design-size', 'Login-Change-Organization.html'));

  // 1. health + binding
  let r = await req(h, 'GET', '/health');
  t.check('GET /health works without token', r.status === 200 && r.json.ok && r.json.name === 'open-htmltofigma-helper');
  t.check('shows http://localhost:<port>, bound to 127.0.0.1 only', new RegExp(`listening on http://localhost:${h.port} +\\(bound to 127\\.0\\.0\\.1 only`).test(h.log()));
  // the plugin's URL: name "localhost" (the OS may try ::1 first; the client falls back to 127.0.0.1)
  const viaName = await new Promise(res => http.get({ agent: false, host: 'localhost', port: h.port, path: '/health' }, x => { x.resume(); res(x.statusCode); }).on('error', e => res(e.code)));
  t.check('reachable as http://localhost:<port>', viaName === 200, String(viaName));
  const v6 = await new Promise(res => { const s = require('net').connect(h.port, '::1'); s.on('connect', () => { s.destroy(); res('connected'); }); s.on('error', e => res(e.code)); });
  t.check('not listening on any other address (::1 refused / unavailable)', v6 !== 'connected', v6);
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const refused = await new Promise(res => { const s = require('net').connect(h.port, lan.address); s.on('connect', () => { s.destroy(); res(false); }); s.on('error', () => res(true)); });
    t.check(`not reachable on the LAN address ${lan.address}`, refused);
  }

  // 2. token / origin / host
  r = await req(h, 'GET', '/session'); t.check('missing token -> 401', r.status === 401 && r.json.error.code === 'bad-token');
  r = await req(h, 'GET', '/session', { headers: { authorization: 'Bearer wrong' } }); t.check('wrong token -> 401', r.status === 401);
  r = await upload({ ...h, token: 'x' + h.token.slice(1) }, 'a.html', login); t.check('capture with wrong token -> 401', r.status === 401);
  r = await req(h, 'GET', '/session', { headers: auth(h) }); t.check('right token -> /session ok', r.status === 200 && r.json.ok);
  r = await req(h, 'GET', '/session', { headers: { ...auth(h), origin: 'https://evil.example' } }); t.check('web-page Origin refused (403)', r.status === 403 && !r.headers['access-control-allow-origin']);
  r = await req(h, 'GET', '/session', { headers: { ...auth(h), origin: 'null' } }); t.check('plugin UI Origin "null" allowed with CORS header', r.status === 200 && r.headers['access-control-allow-origin'] === 'null');
  r = await req(h, 'OPTIONS', '/capture', { headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  t.check('CORS preflight allows the plugin (incl. Private Network Access)', r.status === 204 && r.headers['access-control-allow-private-network'] === 'true' && /Authorization/.test(r.headers['access-control-allow-headers']));
  r = await req(h, 'GET', '/health', { headers: { host: 'evil.example:' + h.port } }); t.check('foreign Host header refused (DNS rebinding)', r.status === 403);
  r = await req(h, 'GET', '/health', { headers: { host: 'localhost.evil.example:' + h.port } }); t.check('look-alike Host "localhost.evil.example" refused', r.status === 403);
  const hosts = [`localhost:${h.port}`, 'localhost', `127.0.0.1:${h.port}`];
  const okHosts = [];
  for (const host of hosts) { r = await req(h, 'GET', '/session', { headers: { ...auth(h), host } }); if (r.status === 200) okHosts.push(host); }
  t.check('Host "localhost:<port>", "localhost" and "127.0.0.1:<port>" accepted', okHosts.length === hosts.length, okHosts.join(', '));

  // 3. input validation
  r = await upload(h, 'notes.txt', Buffer.from('<!doctype html><p>x')); t.check('non-.html name rejected (415)', r.status === 415 && r.json.error.code === 'not-html');
  r = await upload(h, 'fake.html', Buffer.from('PK\u0003\u0004 not html at all')); t.check('.html without HTML content rejected (415)', r.status === 415);
  r = await upload(h, '../../evil.html', login, '&designRoot=' + encodeURIComponent('a\nb')); t.check('control characters in options rejected (400)', r.status === 400);

  // 4. Thai / spaces / brackets, async job, stages, schema, mock import, temp cleanup
  const thaiName = 'หน้า ทดสอบ (สำเนา 1).html';
  let j = await runJob(h, thaiName, login);
  const res = j.result && j.result.json;
  t.check('Thai name with spaces and brackets: 202 -> job -> result', j.submit.status === 202 && j.result.status === 200 && res.ok, j.submit.text.slice(0, 200));
  t.check('progress stages reported (rendering / measuring / building)', ['rendering', 'measuring', 'building'].every(s => j.stages.includes(s)) || j.stages.includes('done'), j.stages.join(' > '));
  t.check('result can be collected once only (then 404)', j.again.status === 404);
  const d = res && res.designs[0].design;
  t.check('file name kept (sanitized) in design.capture.source', d && d.capture.source === thaiName, d && d.capture.source);
  t.check('design size 375x812 from the file', res && res.designs[0].summary.designSize.width === 375 && res.designs[0].summary.designSize.height === 812);
  t.check('returned design passes the schema', d && validate(d), JSON.stringify(validate.errors || []).slice(0, 200));
  const m = d && await mockImport(d);
  t.check('production renderer (mock): every layer created, missing 0', m && m.summary.layers.created === m.summary.layers.expected && !m.report.missing.length, m && `${m.summary.layers.created}/${m.summary.layers.expected}`);
  t.check('no temp files left after success', temp.listJobDirs(tmp).length === 0, temp.listJobDirs(tmp).join(','));

  // path parts in a name cannot escape the temp folder
  j = await runJob(h, '..\\..\\x (1).html', login);
  t.check('path parts in the name are stripped', j.result && j.result.status === 200 && j.result.json.designs[0].design.capture.source === 'x (1).html');

  // 5. error path: several design roots -> readable error with the list, temp cleaned
  const two = fs.readFileSync(path.join(FIX, 'design-size', 'Two-screens.html'));
  j = await runJob(h, 'Two-screens.html', two);
  t.check('several design roots -> 422 multiple-roots with the list', j.result.status === 422 && j.result.json.error.code === 'multiple-roots' && j.result.json.error.roots.length === 2);
  t.check('no temp files left after error', temp.listJobDirs(tmp).length === 0);
  j = await runJob(h, 'Two-screens.html', two, '&designRoot=all');
  t.check('designRoot=all -> 2 designs', j.result.status === 200 && j.result.json.designs.length === 2);
  j = await runJob(h, 'Two-screens.html', two, '&designRoot=' + encodeURIComponent("[data-screen-label='Detail']"));
  t.check('designRoot=<selector> -> that screen', j.result.status === 200 && j.result.json.designs.length === 1 && j.result.json.designs[0].summary.designRoot.label === 'Detail');

  // 6. wait=1 (PowerShell) and multipart
  r = await upload(h, 'Login.html', login, '&wait=1');
  t.check('wait=1 returns the result in one request', r.status === 200 && r.json.designs.length === 1);
  const boundary = '----h2f' + Date.now();
  const mp = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${encodeURIComponent('ไฟล์ (2).html')}\r\nContent-Type: text/html\r\n\r\n`), login, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  r = await req(h, 'POST', '/capture?wait=1', { body: mp, headers: { ...auth(h), 'content-type': 'multipart/form-data; boundary=' + boundary } });
  t.check('multipart/form-data upload with Thai file name', r.status === 200 && r.json.designs[0].design.capture.source === 'ไฟล์ (2).html', r.text.slice(0, 200));
  t.check('no temp files left', temp.listJobDirs(tmp).length === 0);
  t.check('log has file names and sizes but no HTML', !/<html|<!doctype|<div/i.test(h.log()) && /upload .*Login\.html/.test(h.log()));

  // 7. real pages through the Helper == CLI (if the private regression inputs are here; skipped with --quick)
  const base = readJson(path.join(ROOT, 'regression', 'baselines.json'));
  for (const b of process.argv.includes('--quick') ? [] : base.baselines) {
    const file = baselineInput(b, INPUTS_DIR);
    if (!fs.existsSync(file)) { console.log(`  skip  ${b.name}: regression input not present`); continue; }
    const bytes = fs.readFileSync(file);
    const t0 = Date.now();
    j = await runJob(h, path.basename(file), bytes);
    const rr = j.result && j.result.json;
    const dd = rr && rr.designs && rr.designs[0].design;
    t.check(`${b.name}: ${(bytes.length / 1048576).toFixed(1)} MB via Helper -> ${b.designSize.join('x')} (${((Date.now() - t0) / 1000).toFixed(0)} s)`, dd && dd.root.box.width === b.designSize[0] && dd.root.box.height === b.designSize[1]);
    const mm = dd && await mockImport(dd);
    t.check(`${b.name}: ${b.layers} layers, missing 0`, mm && mm.elements === b.layers && !mm.report.missing.length, mm && `${mm.elements}, missing ${mm.report.missing.length}`);
    const out = path.join(tmp, 'cli-' + b.name);
    runCapture(PROD_CLI, [file, '--out', out]);
    const cliDir = path.join(out, fs.readdirSync(out)[0], b.designSize.join('x'));
    const cli = readJson(path.join(cliDir, 'design.json'));
    const diff = dd && firstDiff({ root: cli.root, assets: Object.keys(cli.assets).sort(), report: cli.report }, { root: dd.root, assets: Object.keys(dd.assets).sort(), report: dd.report });
    t.check(`${b.name}: Helper design == CLI design (root, assets, report)`, dd && !diff, diff ? `${diff.path}: ${diff.a} vs ${diff.b}` : '');
    t.check(`${b.name}: no temp or input folder path in the Helper result`, dd && !/h2f-helper-|file:\/\/\/|[A-Za-z]:\\\\/.test(JSON.stringify({ ...dd, assets: null })) && !JSON.stringify({ ...dd, assets: null }).includes(os.tmpdir().split(path.sep).join('/')));
    fs.rmSync(out, { recursive: true, force: true });
    t.check(`${b.name}: no temp files left`, temp.listJobDirs(tmp).length === 0);
  }

  // 8. too large (separate Helper with a 1 MB limit) and Ctrl+C
  const small = await startHelper(['--max-mb', '1', '--timeout', '0.02'], tmp);
  r = await upload(small, 'big.html', Buffer.concat([Buffer.from('<!doctype html><p>'), Buffer.alloc(1.5 * 1048576, 97)]));
  t.check('file over the limit -> 413 too-large', r.status === 413 && r.json.error.code === 'too-large');
  j = await runJob(small, 'slow.html', login);
  t.check('capture over the time limit -> 422 timeout, readable message', j.result.status === 422 && j.result.json.error.code === 'timeout', j.result.json && j.result.json.error.message);
  t.check('no temp files left after timeout', temp.listJobDirs(tmp).length === 0);
  const smallKids = [...small.kids];
  let code = await stopHelper(small);
  t.check('stop after captures: exit 0, capture processes gone, no temp', code === 0 && smallKids.every(p => !pidAlive(p)) && !temp.listJobDirs(tmp).length);

  // 9. stop with no active job, and during a capture (browser running) — Ctrl+C where signals exist, IPC stop on Windows
  const modes = isWin ? ['ipc'] : ['SIGINT', 'ipc'];
  for (const how of modes) {
    const idle = await startHelper([], tmp);
    code = await stopHelper(idle, how);
    t.check(`stop (${how}) with no active job: exit 0`, code === 0);
    const busy = await startHelper([], tmp);
    r = await upload(busy, 'busy.html', fs.readFileSync(path.join(FIX, 'design-size', 'Report-long-page.html')));
    const tree = await waitForBrowser(busy);
    t.check(`stop (${how}) during a capture: capture + browser were running (${tree ? tree.length : 0} processes), temp folder in use`, !!tree && temp.listJobDirs(tmp).length === 1);
    code = await stopHelper(busy, how);
    await sleep(300);
    const left = (tree || []).filter(pidAlive);
    t.check(`stop (${how}) during a capture: exit 0, capture process tree gone, no temp`, code === 0 && !left.length && !temp.listJobDirs(tmp).length,
      `exit ${code}, still running: ${left.join(',') || '-'}, temp: ${temp.listJobDirs(tmp).join(',') || '-'}`);
  }
  const mainKids = [...h.kids];
  code = await stopHelper(h);
  t.check('main Helper stopped: exit 0, all its capture processes gone', code === 0 && mainKids.every(p => !pidAlive(p)));
  t.check('no temp files left at the end', temp.listJobDirs(tmp).length === 0);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(t.finish());
})().catch(e => { console.error(e); process.exit(1); });
