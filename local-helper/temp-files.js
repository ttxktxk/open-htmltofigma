// Temp files for the Local Helper: one random directory per job under the OS temp dir, always removed afterwards.
// Only bytes the user sent are written here; no path from a request is ever opened.
const fs = require('fs'), path = require('path'), os = require('os');

const PREFIX = 'h2f-helper-';

function tempRoot(custom) { return custom ? path.resolve(custom) : os.tmpdir(); }

// Creates <tmp>/h2f-helper-XXXXXX/{input,out}; returns the paths.
function createJobDir(custom) {
  const root = tempRoot(custom);
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, PREFIX));
  fs.mkdirSync(path.join(dir, 'input')); fs.mkdirSync(path.join(dir, 'out'));
  return { dir, input: path.join(dir, 'input'), out: path.join(dir, 'out') };
}

function isOurs(dir) { return !!dir && path.basename(dir).startsWith(PREFIX); }   // never remove anything that is not ours
function removeDir(dir) {
  if (!isOurs(dir)) return false;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return !fs.existsSync(dir); } catch (e) { return false; }
}
// Windows keeps a file locked for a moment after the process that used it (Chrome) has exited: EPERM / EBUSY /
// ENOTEMPTY. Retry with growing waits (~6 s in total). Idempotent: an already removed folder counts as removed.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE']);
async function removeDirWithRetry(dir, delays = [0, 100, 200, 400, 800, 1600, 3200]) {
  if (!isOurs(dir)) return false;
  for (const ms of delays) {
    if (ms) await new Promise(r => setTimeout(r, ms));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { if (!RETRY_CODES.has(e.code)) return !fs.existsSync(dir); }
    if (!fs.existsSync(dir)) return true;
  }
  return false;
}

// Leftovers from a crash or a killed Helper (only our own prefix, only in the temp root).
function cleanupStale(custom, olderThanMs = 0) {
  const root = tempRoot(custom);
  let n = 0;
  try {
    for (const f of fs.readdirSync(root)) {
      if (!f.startsWith(PREFIX)) continue;
      const p = path.join(root, f);
      if (olderThanMs && Date.now() - fs.statSync(p).mtimeMs < olderThanMs) continue;   // may belong to a running Helper
      if (removeDir(p)) n++;
    }
  } catch (e) { /* no temp root yet */ }
  return n;
}
function listJobDirs(custom) {
  try { return fs.readdirSync(tempRoot(custom)).filter(f => f.startsWith(PREFIX)); } catch (e) { return []; }
}

// File name from the user -> safe single file name (Thai, spaces and brackets kept; no path parts, no control chars).
function sanitizeFilename(name) {
  let n = String(name || '').normalize('NFC');
  n = n.split(/[\\/]/).pop();                                   // drop any directory part
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')            // Windows-reserved and control characters
       .replace(/^[.\s]+|[.\s]+$/g, '');                          // no leading dots (hidden / "..") or trailing dots/spaces
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;   // Windows device names
  if (Buffer.byteLength(n) > 180) { const ext = path.extname(n); n = n.slice(0, 120) + ext; }
  return n || 'design.html';
}

const HTML_EXT = /\.html?$/i;
// First bytes must look like an HTML document (after an optional BOM, whitespace and comments).
function looksLikeHtml(buf) {
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').replace(/^(\s|<!--[\s\S]*?-->)+/, '').slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<meta') || head.startsWith('<body');
}

module.exports = { PREFIX, createJobDir, removeDir, removeDirWithRetry, cleanupStale, listJobDirs, sanitizeFilename, HTML_EXT, looksLikeHtml };
