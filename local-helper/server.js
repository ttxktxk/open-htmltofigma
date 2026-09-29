#!/usr/bin/env node
// Open HTML to Figma — Local Helper (MVP-B)
// Receives an HTML file from the Figma plugin UI, runs the existing Playwright capture (capture/cli.js) on this
// computer and returns design data. URL: http://localhost:43127 — bound to 127.0.0.1 only (not reachable from other
// computers); every request except /health needs the session token.
//
//   npm run helper
//   npm run helper -- --port 43127 --timeout 5 --max-mb 100
//
// API (token: header "Authorization: Bearer <token>" or "X-H2F-Token: <token>")
//   GET  /health                       -> { ok, name, version, busy }                     (no token)
//   GET  /session                      -> { ok } when the token is right
//   POST /capture?name=<file.html>[&designRoot=auto|all|N|<selector>][&expand=<selector>][&wait=1]
//        body: the HTML bytes (application/octet-stream) or multipart/form-data with one file field
//        -> 202 { jobId }   (wait=1: 200 with the result, for PowerShell / scripts)
//   GET  /jobs/<id>                    -> { state, stage, error }
//   GET  /jobs/<id>/result             -> { ok, file, ms, designs: [{ summary, design }] }  (once; then forgotten)
const http = require('http'), crypto = require('crypto'), path = require('path');
const temp = require('./temp-files');
const { CaptureService } = require('./capture-service');
const pkg = require('../package.json');

const HOST = '127.0.0.1';
function parseArgs(argv) {
  const o = { port: 43127, timeoutMin: 5, maxMb: 100, tempDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--port') o.port = +v();
    else if (a === '--timeout') o.timeoutMin = +v();
    else if (a === '--max-mb') o.maxMb = +v();
    else if (a === '--temp-dir') o.tempDir = v();
    else if (a === '-h' || a === '--help') { console.log(require('fs').readFileSync(__filename, 'utf8').split('\nconst http')[0]); process.exit(0); }
    else { console.error(`Unknown option ${a} (see --help)`); process.exit(2); }
  }
  if (!(o.port >= 0 && o.port < 65536) || !(o.timeoutMin > 0) || !(o.maxMb > 0)) { console.error('Invalid --port / --timeout / --max-mb'); process.exit(2); }
  return o;
}

const o = parseArgs(process.argv.slice(2));
const TOKEN = crypto.randomBytes(24).toString('base64url');
const MAX_BYTES = Math.round(o.maxMb * 1048576);
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = msg => console.log(`[${stamp()}] ${msg}`);   // file name, size, status, time only — never file contents
const service = new CaptureService({ timeoutMs: o.timeoutMin * 60000, tempDir: o.tempDir, log });

// ---------------------------------------------------------------- request guards
// The plugin UI runs in a sandboxed iframe whose Origin is "null". Scripts (PowerShell, curl) send no Origin.
// Any other Origin (a web page in a browser) is refused, and the Host header must be this machine (DNS rebinding).
function originAllowed(req) { const or = req.headers.origin; return or === undefined || or === 'null'; }
// Host must name this computer (the plugin uses http://localhost:<port>; scripts may use 127.0.0.1)
function hostAllowed(req, port) { return ['localhost', `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port}`].includes(String(req.headers.host || '').toLowerCase()); }
function tokenOk(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-h2f-token'] || '');
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cors(res, req) {
  if (req.headers.origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Vary', 'Origin');
  }
}
function send(res, status, body, req) {
  cors(res, req);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
const fail = (res, req, status, code, message, hint, extra) => send(res, status, { ok: false, error: { code, message, hint: hint || null, ...(extra || {}) } }, req);

function readBody(req, limit) {
  // Over the limit: stop keeping data but keep reading (discarding) so the client receives the 413 answer
  // instead of a connection reset; give up on clients that keep sending far beyond the limit.
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('too-large'), { status: 413 });
    let chunks = [], n = 0, over = +req.headers['content-length'] > limit;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { over = true; chunks = null; }
      if (over) { if (n > limit * 4 + 1048576) req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => over ? reject(tooLarge()) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => { if (over) reject(tooLarge()); });
  });
}
// multipart/form-data with one file part -> { name, bytes }
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  let start = buf.indexOf(boundary);
  while (start >= 0) {
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) return null;
    const head = Buffer.from(buf.subarray(start + boundary.length, headEnd).toString('latin1'), 'latin1').toString('utf8');
    const next = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), headEnd + 4);
    if (next < 0) return null;
    const star = /filename\*=UTF-8''([^;\r\n]+)/i.exec(head), plain = /filename="([^"]*)"/i.exec(head);
    if (star || plain) return { name: star ? decodeURIComponent(star[1]) : plain[1], bytes: buf.subarray(headEnd + 4, next) };
    start = next + 2;
  }
  return null;
}
function cleanOption(v, name) {
  if (v == null || v === '' || v === 'auto') return null;
  if (v.length > 300 || /[\u0000-\u001f]/.test(v)) throw Object.assign(new Error(`${name} is too long or contains control characters`), { status: 400 });
  return v;
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const port = server.address().port;
  if (!hostAllowed(req, port)) return fail(res, req, 403, 'bad-host', 'Requests must be addressed to localhost.');
  if (!originAllowed(req)) return fail(res, req, 403, 'bad-origin', 'This Helper only accepts requests from the Figma plugin or local scripts.');
  const url = new URL(req.url, `http://${HOST}:${port}`);

  if (req.method === 'OPTIONS') {   // CORS preflight from the plugin UI (Private Network Access included)
    cors(res, req);
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-H2F-Token',
      'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, name: 'open-htmltofigma-helper', version: pkg.version, busy: !!service.running, tokenRequired: true }, req);
  if (!tokenOk(req)) return fail(res, req, 401, 'bad-token', 'Missing or wrong Helper token.', 'Copy the token shown in the Helper window into the plugin (it changes every time the Helper starts).');
  if (req.method === 'GET' && url.pathname === '/session') return send(res, 200, { ok: true, version: pkg.version }, req);

  if (req.method === 'POST' && url.pathname === '/capture') {
    const t0 = Date.now();
    let body;
    try { body = await readBody(req, MAX_BYTES); }
    catch (e) { if (e.status === 413) { log(`reject too large (> ${o.maxMb} MB)`); return fail(res, req, 413, 'too-large', `The file is larger than ${o.maxMb} MB.`, 'Start the Helper with --max-mb to raise the limit.'); } throw e; }
    let name = url.searchParams.get('name'), bytes = body;
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      const part = parseMultipart(body, req.headers['content-type']);
      if (!part) return fail(res, req, 400, 'bad-multipart', 'No file found in the multipart body.');
      name = part.name; bytes = part.bytes;
    }
    name = temp.sanitizeFilename(name);
    if (!temp.HTML_EXT.test(name)) { log(`reject not .html: ${name}`); return fail(res, req, 415, 'not-html', `"${name}" is not an .html / .htm file.`, 'Export the design from Claude Design as a standalone HTML file.'); }
    if (!bytes.length || !temp.looksLikeHtml(bytes)) { log(`reject not HTML content: ${name} (${bytes.length} bytes)`); return fail(res, req, 415, 'not-html', `"${name}" does not contain an HTML document.`); }
    let options;
    try { options = { designRoot: cleanOption(url.searchParams.get('designRoot'), 'designRoot'), expand: cleanOption(url.searchParams.get('expand'), 'expand') }; }
    catch (e) { return fail(res, req, 400, 'bad-option', e.message); }
    let job;
    try { job = service.submit(bytes, name, options); }
    catch (e) { return fail(res, req, e.status || 500, 'stopping', 'The Helper is shutting down.'); }
    log(`upload ${name} (${(bytes.length / 1048576).toFixed(1)} MB) in ${Date.now() - t0} ms -> job ${job.id.slice(0, 6)}${service.queue.length ? ` (queued behind ${service.queue.length})` : ''}`);
    if (url.searchParams.get('wait') === '1') {
      const j = await service.wait(job.id);
      if (j.state === 'error') { service.jobs.delete(job.id); return send(res, 422, { ok: false, error: j.error }, req); }
      return send(res, 200, service.take(job.id), req);
    }
    return send(res, 202, { ok: true, jobId: job.id, file: name, size: bytes.length }, req);
  }

  const jm = url.pathname.match(/^\/jobs\/([0-9a-f]{24})(\/result)?$/);
  if (req.method === 'GET' && jm) {
    const job = service.get(jm[1]);
    if (!job) return fail(res, req, 404, 'no-job', 'Unknown or already collected job.');
    if (!jm[2]) return send(res, 200, { ok: true, state: job.state, stage: job.stage, file: job.name, size: job.size, error: job.error }, req);
    if (job.state === 'error') { service.jobs.delete(job.id); return send(res, 422, { ok: false, error: job.error }, req); }
    if (job.state !== 'done') return fail(res, req, 409, 'not-ready', 'The capture is still running.');
    return send(res, 200, service.take(job.id), req);
  }
  return fail(res, req, 404, 'not-found', 'Unknown endpoint.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { log(`internal error: ${String(e && e.message || e).slice(0, 200)}`); if (!res.headersSent) fail(res, req, e.status || 500, 'internal', 'Internal Helper error.'); });
});
server.requestTimeout = (o.timeoutMin + 5) * 60000;   // wait=1 requests stay open for the whole capture
server.headersTimeout = 60000;

server.on('error', async e => {
  if (e.code === 'EADDRINUSE') {
    let ours = false;
    try { const r = await fetch(`http://${HOST}:${o.port}/health`); ours = (await r.json()).name === 'open-htmltofigma-helper'; } catch (x) {}
    console.error(ours
      ? `\nThe Local Helper is already running on port ${o.port} (another window). Use that window, or close it first.`
      : `\nPort ${o.port} (localhost / ${HOST}) is already used by another program.\n` +
        `  Find it (PowerShell):  Get-NetTCPConnection -LocalPort ${o.port} | Select-Object OwningProcess; Get-Process -Id <OwningProcess>\n` +
        `  or:                    netstat -ano | findstr :${o.port}\n` +
        `  Close that program, or start the Helper on another port: npm run helper -- --port 43128\n` +
        `  (another port also has to be added to figma-plugin/manifest.json and set in the plugin).`);
    process.exit(1);
  }
  console.error('Helper error:', e.message); process.exit(1);
});

const stale = temp.cleanupStale(o.tempDir, 30 * 60000);   // leftovers of a crashed Helper (older than 30 min)
server.listen(o.port, HOST, () => {
  const port = server.address().port;
  console.log(`\nOpen HTML to Figma — Local Helper ${pkg.version}`);
  console.log(`  listening on http://localhost:${port}  (bound to ${HOST} only — this computer)`);
  console.log(`  token:  ${TOKEN}`);
  console.log(`          paste it into the Figma plugin; it changes every time the Helper starts`);
  console.log(`  limits: ${o.maxMb} MB per file, ${o.timeoutMin} min per capture${stale ? ` · removed ${stale} leftover temp folder(s)` : ''}`);
  console.log(`  Press Ctrl+C to stop.\n`);
  if (process.env.H2F_HELPER_TEST === '1') console.log('H2F_HELPER_READY ' + JSON.stringify({ port, token: TOKEN }));
});

// Ctrl+C (SIGINT; SIGBREAK = Ctrl+Break on Windows), SIGTERM, or — for tests only — an IPC "shutdown" message
// from the process that started the Helper with an IPC channel (never reachable over the network).
let stopping = null;
function stop(why) {
  if (stopping) return stopping;
  log(`stopping (${why})…`);
  server.close();
  stopping = service.shutdown().then(r => {
    if (r.leftover.length) log(`warning: ${r.leftover.length} temp folder(s) could not be removed: ${r.leftover.join(', ')}`);
    else log('stopped, temp files removed');
    process.exit(r.leftover.length ? 1 : 0);
  });
  return stopping;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => stop(sig));
if (process.send) process.on('message', m => { if (m === 'shutdown') stop('shutdown message'); });
