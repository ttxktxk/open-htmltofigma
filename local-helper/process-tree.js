// Stopping a capture child process together with the browser it started — and nothing else.
//
// 1. Graceful: the child (capture/cli.js) is asked over its IPC channel to close its browser and exit; Playwright then
//    also removes its temporary browser profile. This works the same on Windows and POSIX.
// 2. Forced, only if it is still running after the grace period:
//    Windows: `taskkill /PID <pid> /T /F` — ends exactly that PID and its descendants (the browser). Started with an
//             argument array (no shell); the PID is a number from our own spawn().
//    POSIX:   SIGKILL to the child and to the descendants recorded while the child was alive.
// A PID is only acted on when it is verified: the ChildProcess is one this Helper spawned and is still registered,
// it has not exited (so the PID cannot have been reused), and descendants are found by walking the parent chain
// from that PID (POSIX; re-checked before each kill).
const { spawn, execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
const alive = child => !!child && Number.isInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null && !child.__closed;

function waitClose(child, ms) {
  if (!child || child.__closed) return Promise.resolve(true);
  return new Promise(res => {
    const t = setTimeout(() => res(false), ms);
    child.once('close', () => { clearTimeout(t); res(true); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// POSIX: pid -> ppid table
function processTable() {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const t = new Map();
    for (const line of out.split('\n')) { const [pid, ppid] = line.trim().split(/\s+/).map(Number); if (pid) t.set(pid, ppid); }
    return t;
  } catch (e) { return new Map(); }
}
function descendants(rootPid) {
  const t = processTable(), tree = new Set([rootPid]);
  let grew = true;
  while (grew) { grew = false; for (const [pid, ppid] of t) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
  tree.delete(rootPid);
  return tree;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function taskkillTree(pid) {
  return new Promise(res => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => res(false));
    p.on('close', code => res(code === 0));
  });
}

// owned: Set of children this Helper started
async function killTree(child, owned, { graceMs = 5000, closeMs = 10000 } = {}) {
  if (!owned.has(child) || !alive(child)) return waitClose(child, closeMs);
  const tree = isWin ? null : descendants(child.pid);          // recorded while the parent chain still exists
  try { if (child.connected) child.send('h2f-stop'); } catch (e) {}
  let closed = await waitClose(child, graceMs);
  if (!closed && alive(child)) {
    if (isWin) { if (!(await taskkillTree(child.pid)) && alive(child)) { try { child.kill(); } catch (e) {} } }
    else { try { child.kill('SIGKILL'); } catch (e) {} }
    closed = await waitClose(child, closeMs);
  }
  if (tree && tree.size) {                                        // POSIX: browser processes of this child
    for (let i = 0; i < 20 && [...tree].some(pidAlive); i++) await sleep(100);
    const t = processTable();
    for (const pid of tree) {
      const ppid = t.get(pid);
      if (ppid === undefined) continue;                           // gone
      if (ppid !== 1 && !tree.has(ppid) && ppid !== child.pid) continue;   // re-parented to something else: not ours any more
      try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    }
  }
  return closed;
}

// stdio for a child we may have to stop later (IPC channel for the graceful stop)
const childStdio = ['ignore', 'pipe', 'pipe', 'ipc'];

module.exports = { killTree, waitClose, childStdio, alive, isWin, descendants };
