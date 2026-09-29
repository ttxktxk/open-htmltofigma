// Runs the existing MVP-A capture (capture/cli.js) for one uploaded HTML file.
// The CLI is started as a child process with an argument array (no shell), so nothing from the file name or the
// request can become a command. Jobs run one at a time; temp files are removed in every outcome.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');
const temp = require('./temp-files');
const { killTree, childStdio } = require('./process-tree');

const CLI = path.join(__dirname, '..', 'capture', 'cli.js');
const RESULT_TTL_MS = 10 * 60 * 1000;

class CaptureService {
  constructor({ timeoutMs = 5 * 60 * 1000, tempDir = null, log = () => {} } = {}) {
    this.timeoutMs = timeoutMs; this.tempDir = tempDir; this.log = log;
    this.jobs = new Map(); this.queue = []; this.running = null; this.runningPromise = null; this.children = new Set();
    this.activeDirs = new Set(); this.stopping = false;
  }

  // bytes: Buffer of the HTML file; name: sanitized file name; options: { designRoot, expand }
  submit(bytes, name, options) {
    if (this.stopping) throw Object.assign(new Error('The Helper is stopping.'), { status: 503 });
    const id = crypto.randomBytes(12).toString('hex');
    const job = { id, name, size: bytes.length, options, state: 'queued', stage: 'queued', createdAt: Date.now(), result: null, error: null };
    this.jobs.set(id, job);
    this.queue.push({ job, bytes });
    this._next();
    return job;
  }
  get(id) { return this.jobs.get(id) || null; }
  // result JSON text, removed from memory once taken
  take(id) { const j = this.jobs.get(id); if (!j || j.state !== 'done') return null; this.jobs.delete(id); return j.result; }
  wait(id) { return new Promise(res => { const tick = () => { const j = this.jobs.get(id); if (!j || j.state === 'done' || j.state === 'error') res(j); else setTimeout(tick, 200); }; tick(); }); }

  _next() {
    if (this.running || !this.queue.length) return;
    const { job, bytes } = this.queue.shift();
    this.running = job;
    this.runningPromise = this._run(job, bytes).finally(() => { this.running = null; this.runningPromise = null; this._expire(); if (!this.stopping) this._next(); });
  }
  _expire() { const now = Date.now(); for (const [id, j] of this.jobs) if ((j.state === 'done' || j.state === 'error') && now - (j.finishedAt || now) > RESULT_TTL_MS) this.jobs.delete(id); }

  async _run(job, bytes) {
    const t0 = Date.now();
    let dirs = null;
    job.state = 'running'; job.stage = 'rendering';
    try {
      dirs = temp.createJobDir(this.tempDir);
      this.activeDirs.add(dirs.dir);
      const htmlPath = path.join(dirs.input, job.name);
      fs.writeFileSync(htmlPath, bytes);
      bytes = null;   // not kept in memory
      const args = [CLI, htmlPath, '--out', dirs.out];
      if (job.options.designRoot) args.push('--design-root', job.options.designRoot);
      if (job.options.expand) args.push('--expand', job.options.expand);
      const { code, tail, timedOut } = await this._spawn(args, job);
      if (timedOut) throw helperError('timeout', `Capture took longer than ${this.timeoutMs >= 60000 ? +(this.timeoutMs / 60000).toFixed(1) + ' min' : Math.round(this.timeoutMs / 1000) + ' s'} and was stopped.`, 'Try again; if the page is very heavy, start the Helper with a longer --timeout.');
      if (code === 3) {
        const rep = readJsonSafe(findFile(dirs.out, 'capture-report.json'));
        const roots = (rep && rep.designRoots || []).map(r => ({ index: r.index, label: r.label, width: r.width, height: r.height, element: r.element }));
        throw helperError('multiple-roots', `This file has ${roots.length} design roots (screens). Choose "All" or a selector.`, null, { roots });
      }
      if (code !== 0) throw classifyFailure(code, tail, dirs.dir);
      job.stage = 'collecting';
      const designDirs = findDesignDirs(dirs.out);
      if (!designDirs.length) throw helperError('no-output', 'Capture finished but produced no design.json.');
      const parts = designDirs.map(d => {
        const report = JSON.parse(fs.readFileSync(path.join(d, 'capture-report.json'), 'utf8'));
        const designText = fs.readFileSync(path.join(d, 'design.json'), 'utf8');
        return `{"summary":${JSON.stringify(summarize(report, designText.length))},"design":${designText}}`;
      });
      job.result = `{"ok":true,"file":${JSON.stringify(job.name)},"ms":${Date.now() - t0},"designs":[${parts.join(',')}]}`;
      job.state = 'done'; job.stage = 'done';
      this.log(`done   ${job.name} (${mb(job.size)}) -> ${designDirs.length} design(s), ${mb(job.result.length)} result, ${sec(Date.now() - t0)}`);
    } catch (e) {
      job.state = 'error'; job.stage = 'error';
      job.error = e.helper ? e.helper : { code: 'internal', message: String(e && e.message || e).slice(0, 300) };
      this.log(`error  ${job.name} (${mb(job.size)}) ${job.error.code}: ${job.error.message} — ${sec(Date.now() - t0)}`);
    } finally {
      job.finishedAt = Date.now();
      // the capture process (and its browser) has closed by now; Windows may still release file handles a moment later
      if (dirs) { if (await temp.removeDirWithRetry(dirs.dir)) this.activeDirs.delete(dirs.dir); else this.log(`warning: could not remove temp folder ${path.basename(dirs.dir)} (will retry on stop)`); }
    }
  }

  _spawn(args, job) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env: { ...process.env, H2F_PROGRESS: '1' }, windowsHide: true, stdio: childStdio });
      this.children.add(child);
      if (process.env.H2F_HELPER_TEST === '1') console.log('H2F_CHILD ' + child.pid);
      let tail = '', buf = '', timedOut = false;
      const keep = s => { tail = (tail + s).slice(-4000); };
      child.stdout.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = line.match(/^::h2f-progress:: (\w+)/);
          if (m) job.stage = m[1]; else keep(line + '\n');
        }
      });
      child.stderr.on('data', d => keep(d.toString('utf8')));
      const timer = setTimeout(() => { timedOut = true; killTree(child, this.children); }, this.timeoutMs);
      child.on('close', code => { child.__closed = true; clearTimeout(timer); this.children.delete(child); resolve({ code, tail, timedOut }); });
      child.on('error', () => { child.__closed = true; clearTimeout(timer); this.children.delete(child); resolve({ code: -1, tail: 'could not start node', timedOut }); });
    });
  }

  // Ctrl+C: stop the queue, end our capture process trees, wait until they have closed and the running job has
  // cleaned up, then remove any temp folder that is still ours. Safe to call more than once.
  async shutdown() {
    this.stopping = true;
    this.queue.length = 0;
    await Promise.all([...this.children].map(c => killTree(c, this.children)));
    if (this.runningPromise) await Promise.race([this.runningPromise, new Promise(r => setTimeout(r, 15000))]);
    for (const d of [...this.activeDirs]) if (await temp.removeDirWithRetry(d)) this.activeDirs.delete(d);
    return { leftover: [...this.activeDirs].map(d => path.basename(d)) };
  }
}

function helperError(code, message, hint, extra) { const e = new Error(message); e.helper = { code, message, hint: hint || null, ...(extra || {}) }; return e; }
function classifyFailure(code, tail, tmpDir) {
  const text = tail.split(tmpDir).join('<temp>');
  if (/Could not launch Chrome\/Edge/.test(text)) return helperError('no-browser', 'Chrome or Microsoft Edge was not found on this computer.', 'Install Chrome or Edge, or start the Helper with $env:CHROME_PATH set to chrome.exe.');
  if (/Font\(s\) failed to load/.test(text)) return helperError('font-failed', 'A font could not be loaded during capture.');
  const last = text.split('\n').map(s => s.trim()).filter(s => s && !/^at\s/.test(s) && !/^browser:|^done:/.test(s)).slice(-3).join(' · ');
  return helperError('capture-failed', `Capture failed (exit ${code}). ${last}`.slice(0, 400));
}
function findDesignDirs(dir) {
  const out = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name === 'design.json') out.push(d); } })(dir);
  return out.sort();
}
function findFile(dir, name) { let hit = null; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name === name && !hit) hit = p; } })(dir); return hit; }
function readJsonSafe(p) { try { return p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (e) { return null; } }
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const sec = ms => (ms / 1000).toFixed(1) + ' s';

// Capture-side summary shown in the plugin before/after import (the plugin adds layer counts and font resolution).
function summarize(r, designBytes) {
  return {
    designSize: { width: r.designWidth, height: r.designHeight }, detection: r.detectionSource,
    designRoot: r.detectedDesignRoot ? { label: r.detectedDesignRoot.label, element: r.detectedDesignRoot.element } : null,
    browserViewport: r.browserViewport, nodes: r.stats, designJsonBytes: designBytes, schemaValid: r.schemaValid,
    fontsUsed: (r.fonts || []).map(f => ({ postScript: f.postScript, family: f.usedFamily, chars: f.chars })),
    primaryFontFallback: r.primaryFontFallback || [], fontIssues: r.fontIssues || [],
    unsupported: r.unsupportedSummary || {}, rasterFallbacks: (r.fallbacks || []).reduce((a, f) => (a[f.reason] = (a[f.reason] || 0) + 1, a), {}),
    overflowDesignArea: (r.overflowDesignArea || []).length, warnings: (r.warnings || []).length, detectionNotes: r.detectionNotes || [],
  };
}

module.exports = { CaptureService, summarize };
