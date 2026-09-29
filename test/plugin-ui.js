// npm run test:plugin — end-to-end check of the plugin UI without Figma:
//   figma-plugin/ui.html runs in a sandboxed iframe (Origin "null", like Figma) inside Chrome,
//   figma-plugin/code.js runs in Node on the Figma API mock, and a real Local Helper serves the captures over HTTP.
// Flow per case: choose HTML -> Convert & Import -> Helper capture -> plugin import -> summary in the UI.
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), { spawn } = require('child_process');
const { ROOT, readJson, harness, baselineInput, INPUTS_DIR } = require('./lib');
const { createMock } = require('./mock-figma');
const { launch } = require('../capture/browser');
const temp = require('../local-helper/temp-files');

const FIX = path.join(ROOT, 'spikes', 'fixtures');
const SHOTS = path.join(os.tmpdir(), 'h2f-plugin-ui-shots');

function startHelper(tempDir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'local-helper', 'server.js'), '--port', String(port), '--temp-dir', tempDir],
      { env: { ...process.env, H2F_HELPER_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    child.stdout.on('data', d => { out += d; const m = out.match(/H2F_HELPER_READY (\{.*\})/); if (m && !child.ready) { child.ready = true; resolve({ child, ...JSON.parse(m[1]) }); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { if (!child.ready) reject(new Error('helper exited ' + c + ': ' + out)); });
    process.on('exit', () => { try { child.kill('SIGKILL'); } catch (e) {} });   // never leave a Helper behind
  });
}
// same stop routine as Ctrl+C; the IPC message also works on Windows, where signals cannot be sent to another process
const stop = h => new Promise(res => { h.child.on('exit', res); h.child.send('shutdown'); });

(async () => {
  const t = harness('npm run test:plugin');
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2f-plugin-ui-'));
  let helper = await startHelper(tmp, 43127);   // the UI talks to the fixed port, like in Figma

  const { browser } = await launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 1100 } });
  page.on('pageerror', e => console.log('  page error:', e.message));
  const requests = [];
  page.on('request', r => { if (!/^(data|about|blob):/.test(r.url())) requests.push(r.url()); });

  // plugin main code on the Figma mock; its postMessage goes into the iframe
  const posted = [];
  const { figma } = createMock(['Inter', 'Noto Sans Thai', 'DB Ozone X', 'IBM Plex Sans Thai', 'Anuphan'], m => {
    posted.push(m.type);
    page.evaluate(msg => document.getElementById('ui').contentWindow.postMessage({ pluginMessage: msg }, '*'), m).catch(() => {});
  });
  const ctx = vm.createContext({ figma, __html__: '', console, Math, JSON, Object, Array, String, Number, Promise });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'figma-plugin', 'code.js'), 'utf8'), ctx);
  await page.exposeFunction('toMain', msg => figma.ui.onmessage(msg));

  const ui = fs.readFileSync(path.join(ROOT, 'figma-plugin', 'ui.html'), 'utf8');
  await page.setContent(`<iframe id="ui" sandbox="allow-scripts allow-downloads" style="width:470px;height:1080px;border:0"></iframe>
    <script>addEventListener('message', e => { if (e.source === document.getElementById('ui').contentWindow && e.data && e.data.pluginMessage) toMain(e.data.pluginMessage); });</script>`);
  await page.evaluate(html => { document.getElementById('ui').srcdoc = html; }, ui);
  const frame = await (await page.$('#ui')).contentFrame();
  await frame.waitForSelector('#convert');
  const text = sel => frame.$eval(sel, e => e.innerText);
  const waitText = (sel, re, ms = 20000) => frame.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s).innerText), [sel, re.source], { timeout: ms });
  // finished = last step done, or an error shown
  const finished = (ms = 5 * 60000) => frame.waitForFunction(() => document.querySelector('#steps li[data-s="complete"]').className === 'done' || !document.querySelector('#error').classList.contains('hidden'), null, { timeout: ms });
  const origin = await frame.evaluate(() => self.origin);
  const manifest = readJson(path.join(ROOT, 'figma-plugin', 'manifest.json'));
  t.check('manifest: devAllowedDomains is only http://localhost:43127 (Figma rejects IP literals); allowedDomains none',
    JSON.stringify(manifest.networkAccess.devAllowedDomains) === '["http://localhost:43127"]' && JSON.stringify(manifest.networkAccess.allowedDomains) === '["none"]');
  t.check('UI source has no http://127.0.0.1 URL (Helper URL is http://localhost:43127 only)', !/https?:\/\/127\.0\.0\.1/.test(ui) && /const HOSTS = \['http:\/\/localhost:43127'\];/.test(ui));
  t.check('UI runs in a sandboxed iframe with Origin "null" (like Figma)', origin === 'null', origin);

  // 1. connection: running but no token -> token needed -> paste -> Connected
  await waitText('#htext', /token needed|Connected|Not running/);
  t.check('Helper running, no token yet -> "token needed" + token box', /token needed/.test(await text('#htext')) && await frame.isVisible('#tokenbox'));
  await frame.fill('#token', 'wrong-token'); await frame.click('#savetoken');
  await waitText('#error', /not accepted/);
  t.check('wrong token -> readable error, still asks for the token', /token/.test(await text('#htext')) && await frame.isVisible('#tokenbox'));
  await frame.fill('#token', helper.token); await frame.click('#savetoken');
  await waitText('#htext', /Connected/);
  t.check('right token -> "Local Helper: Connected"', /Connected/.test(await text('#htext')));
  t.check('token remembered through the plugin main code (clientStorage)', (await figma.clientStorage.getAsync('h2f-helper')).token === helper.token);

  // 2. file checks in the UI
  await frame.setInputFiles('#htmlfile', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  t.check('non-HTML file refused in the UI, button stays disabled', /not an \.html/.test(await text('#error')) && await frame.isDisabled('#convert'));

  // 3. one click: Thai file name -> Frame
  const login = fs.readFileSync(path.join(FIX, 'design-size', 'Login-Change-Organization.html'));
  await frame.setInputFiles('#htmlfile', { name: 'หน้า ทดสอบ (1).html', mimeType: 'text/html', buffer: login });
  t.check('file name and size shown', /หน้า ทดสอบ \(1\)\.html · 0\.0 MB/.test(await text('#fileinfo')), await text('#fileinfo'));
  await frame.click('#convert');
  await finished();
  const r1 = await text('#result');
  t.check('Convert & Import: summary shows design size 375 × 812', /375 × 812/.test(r1));
  t.check('summary: layers created = expected, missing none', /Layers\s+(\d+) \/ \1/.test(r1) && /Missing layers\s+none/.test(r1), r1.split('\n').slice(0, 3).join(' | '));
  t.check('summary lists substituted fonts and unsupported features rows', /Substituted fonts/.test(r1) && /Unsupported features/.test(r1));
  t.check('all progress steps done', await frame.$$eval('#steps li', ls => ls.every(l => l.className === 'done')));
  t.check('plugin created the Frame (import-result) and notified', posted.includes('import-result'));
  t.check('no temp files left on the Helper', temp.listJobDirs(tmp).length === 0);
  await page.screenshot({ path: path.join(SHOTS, '1-login.png') });

  // 4. several screens -> choice -> Import all
  await frame.setInputFiles('#htmlfile', { name: 'Two-screens.html', mimeType: 'text/html', buffer: fs.readFileSync(path.join(FIX, 'design-size', 'Two-screens.html')) });
  await frame.click('#convert');
  await waitText('#error', /design roots/, 60000);
  t.check('several screens -> list with "Import only this" / "Import all screens"', (await frame.$$('#error button[data-root]')).length === 3);
  await page.screenshot({ path: path.join(SHOTS, '2-multi-roots.png') });
  await frame.click('#error button[data-root="all"]');
  await finished();
  await frame.waitForFunction(() => document.querySelectorAll('#result table').length === 2, null, { timeout: 60000 });
  t.check('"Import all screens" -> 2 Frames with summaries', (await frame.$$('#result table')).length === 2);

  // 5. real page (if the private regression input is present)
  const base = readJson(path.join(ROOT, 'regression', 'baselines.json'));
  const long = base.baselines.find(b => b.designSize[1] === 2415);
  const real = long && baselineInput(long, INPUTS_DIR);
  if (real && fs.existsSync(real)) {
    await frame.setInputFiles('#htmlfile', { name: path.basename(real), mimeType: 'text/html', buffer: fs.readFileSync(real) });
    console.log('  file:', await text('#fileinfo'));
    const t0 = Date.now();
    await frame.click('#convert');
    await finished();
    const rr = await text('#result') + (await frame.isVisible('#error') ? ' ERROR: ' + await text('#error') : '');
    t.check(`real page ${long.name}: one click -> 1920 × 2415, ${long.layers} / ${long.layers} layers, missing none (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
      /1920 × 2415/.test(rr) && new RegExp(`Layers\\s+${long.layers} / ${long.layers}`).test(rr) && /Missing layers\s+none/.test(rr), rr.split('\n').slice(0, 3).join(' | '));
    await page.screenshot({ path: path.join(SHOTS, '3-real-long-page.png') });
    t.check('no temp files left on the Helper', temp.listJobDirs(tmp).length === 0);
  } else console.log('  skip  real page: regression input not present');

  // 6. fallback: design.json file import still works
  const dj = path.join(tmp, 'design.json');
  const cap = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'capture', 'cli.js'), path.join(FIX, 'design-size', 'Dashboard-1440-preview-only.html'), '--out', path.join(tmp, 'cli')], { encoding: 'utf8' });
  fs.copyFileSync(path.join(tmp, 'cli', 'Dashboard-1440-preview-only', '1440x900', 'design.json'), dj);
  t.check('CLI capture still works', cap.status === 0);
  await frame.click('#advanced summary');
  await frame.setInputFiles('#jsonfile', dj);
  await frame.click('#importjson');
  await waitText('#result', /1440 × 900/, 60000);
  t.check('Advanced / Fallback: Import design.json -> Frame 1440 × 900', /Layers\s+(\d+) \/ \1/.test(await text('#result')));

  // 7. Helper closed -> "Not running" with instructions, no crash; restart -> new token needed
  await stop(helper);
  await frame.click('#retry');
  await waitText('#htext', /Not running/);
  t.check('Helper closed -> "Not running" + how to start it', await frame.isVisible('#helphelp') && /npm run helper/.test(await text('#helphelp')));
  await frame.setInputFiles('#htmlfile', { name: 'a.html', mimeType: 'text/html', buffer: login });
  t.check('Convert & Import disabled while the Helper is not running', await frame.isDisabled('#convert'));
  await page.screenshot({ path: path.join(SHOTS, '4-not-running.png') });
  helper = await startHelper(tmp, 43127);
  await frame.click('#retry');
  await waitText('#htext', /token changed|token needed/);
  t.check('Helper restarted -> asks for the new token', true);
  await frame.fill('#token', helper.token); await frame.click('#savetoken');
  await waitText('#htext', /Connected/);
  t.check('new token -> Connected again', true);

  const foreign = requests.filter(u => !/^http:\/\/localhost:43127\//.test(u));
  t.check(`plugin UI only contacted http://localhost:43127 (${requests.length} requests, none elsewhere, no 127.0.0.1)`, requests.length > 0 && !foreign.length, foreign.slice(0, 3).join(', '));
  await browser.close();
  await stop(helper);
  t.check('no temp files left at the end', temp.listJobDirs(tmp).length === 0);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('screenshots:', SHOTS);
  process.exit(t.finish());
})().catch(e => { console.error(e); process.exit(1); });
