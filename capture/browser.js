// Launch a Chromium-family browser. Order: $CHROME_PATH, installed Chrome, installed Edge, Playwright's own.
const { chromium } = require('playwright-core');
const { isolatedWorld } = require('./iso');

async function launch() {
  const tries = [];
  if (process.env.CHROME_PATH) tries.push({ executablePath: process.env.CHROME_PATH });
  tries.push({ channel: 'chrome' }, { channel: 'msedge' }, {});
  const errors = [];
  for (const opts of tries) {
    try {
      const browser = await chromium.launch(opts);
      return { browser, how: JSON.stringify(opts), version: browser.version() };
    } catch (e) { errors.push(`${JSON.stringify(opts)}: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('Could not launch Chrome/Edge. Install Chrome or set CHROME_PATH to chrome.exe / msedge.exe.\n' + errors.join('\n'));
}

// Spec decision: default viewport 1920x992, DPR 2 for rasters/screenshots.
// Returns { context, page, iso } — iso = isolated world (use it for all DOM reads/writes).
async function openPage(browser, file, { width = 1920, height = 992, dpr = 2 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const url = /^https?:/.test(file) ? file : require('url').pathToFileURL(require('path').resolve(file)).href;
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const iso = await isolatedWorld(page);
  await stabilize(page, iso);
  return { context, page, iso };
}

// Spec §7 stabilization (spike version). Runs in the isolated world.
async function stabilize(page, iso) {
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await iso.eval(async () => {
    const s = document.createElement('style');
    s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.head.appendChild(s);
    await document.fonts.ready;
    await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
    await new Promise(resolve => {           // DOM quiet for 500 ms (max 10 s)
      let t = setTimeout(done, 500);
      const hard = setTimeout(done, 10000);
      const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 500); });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      function done() { mo.disconnect(); clearTimeout(hard); resolve(); }
    });
    await document.fonts.ready;              // fonts requested by late-rendered content
    let last = '';                           // layout stable for 2 frames
    for (let i = 0; i < 20; i++) {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const now = document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight;
      if (now === last) break;
      last = now;
    }
  });
}

module.exports = { launch, openPage, stabilize };
