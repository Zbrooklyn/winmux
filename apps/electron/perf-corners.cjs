// WinMux corner-speed harness (SP-6, speed arc).
//
//   node perf-corners.cjs            measure all four corners, print table
//   node perf-corners.cjs --headed   watch it
//
// The corners nobody benchmarks until they hurt:
//   A. window-resize frame rate (viewport stepped while a shell is open)
//   B. split-drag frame rate (real mouse drag on the .wsdiv divider)
//   C. scrollback search across 100k real lines (far hit, dense hit, full miss)
//   D. tab switch with 30 heavy sessions (each holding a 20k-line buffer)
// Same conventions as perf-actions.cjs: own port, real browser, committed asset.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const HEADED = process.argv.includes('--headed');
const PORT = 9946;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function inUse(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.end(); res(true); });
    s.on('error', () => res(false));
  });
}
async function waitUp(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await inUse(port)) return; await wait(150); }
  throw new Error('server never came up on ' + port);
}

// rAF frame recorder, evaluated in-page around each stress window.
const FRAMES_ON = `(() => {
  window.__cf = { n: 0, worst: 0, last: performance.now(), on: true };
  (function tick() {
    if (!window.__cf.on) return;
    const now = performance.now();
    const gap = now - window.__cf.last;
    if (window.__cf.n > 0 && gap > window.__cf.worst) window.__cf.worst = gap;
    window.__cf.last = now; window.__cf.n++;
    requestAnimationFrame(tick);
  })();
})()`;
const FRAMES_OFF = `(() => { window.__cf.on = false; return { n: window.__cf.n, worst: Math.round(window.__cf.worst) }; })()`;

(async () => {
  // 100k numbered lines (~2.6MB) for the search corner; 20k (~0.5MB) per heavy tab.
  const big = path.join(os.tmpdir(), 'wm-corner-100k.txt');
  const mid = path.join(os.tmpdir(), 'wm-corner-20k.txt');
  if (!fs.existsSync(big)) fs.writeFileSync(big, Array.from({ length: 100000 }, (_, i) => 'line ' + (i + 1) + ' lorem ipsum').join('\r\n'));
  if (!fs.existsSync(mid)) fs.writeFileSync(mid, Array.from({ length: 20000 }, (_, i) => 'row ' + (i + 1) + ' lorem ipsum').join('\r\n'));

  const server = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(PORT), WINMUX_NO_INSTANCE: '1' }),
  });
  await waitUp(PORT, 15000);
  // Scrollback must actually hold 100k lines before the page creates its terminals.
  await fetch('http://127.0.0.1:' + PORT + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { scrollback: 120000 } }),
  }).catch(() => {});

  const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => {
    try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {}
  });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const winmuxOn = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT), WINMUX_HOST: '127.0.0.1' }) });
    let o = ''; p.stdout.on('data', (d) => o += d);
    p.on('exit', () => resolve(o.trim()));
  });
  const results = {};

  // ── A. window-resize frame rate ─────────────────────────────────────────
  await page.evaluate(FRAMES_ON);
  const t0a = Date.now();
  for (let i = 0; i < 24; i++) {
    const w = 1440 - Math.round(Math.sin((i / 23) * Math.PI) * 440);
    await page.setViewportSize({ width: w, height: 900 - Math.round(i * 4) });
    await wait(40);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const winA = Date.now() - t0a;
  const fa = await page.evaluate(FRAMES_OFF);
  results.resize = { frames: fa.n, worstGap: fa.worst, fps: Math.round(fa.n / (winA / 1000)) };

  // ── B. split-drag frame rate ────────────────────────────────────────────
  await winmuxOn(['split']);
  await page.waitForTimeout(2500);
  const div = await page.locator('.wsdiv').first().boundingBox();
  if (div) {
    const cy = div.y + div.height / 2, cx = div.x + div.width / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.evaluate(FRAMES_ON);
    const t0b = Date.now();
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(cx + Math.round(Math.sin((i / 39) * Math.PI * 2) * 220), cy, { steps: 2 });
      await wait(16);
    }
    const winB = Date.now() - t0b;
    const fb = await page.evaluate(FRAMES_OFF);
    await page.mouse.up();
    results.splitDrag = { frames: fb.n, worstGap: fb.worst, fps: Math.round(fb.n / (winB / 1000)) };
  } else {
    results.splitDrag = { error: 'no divider found' };
  }

  // ── C. search across 100k lines ─────────────────────────────────────────
  await page.evaluate(() => {
    const th = [...document.querySelectorAll('.term-host')].find((h) => h.style.display !== 'none' && h.querySelector('textarea'));
    const ta = th ? th.querySelector('textarea') : document.querySelector('.xterm textarea');
    if (ta) ta.focus();
  });
  await page.keyboard.type('cmd /c type "' + big + '"', { delay: 3 });
  await page.keyboard.press('Enter');
  let lines = 0;
  for (let i = 0; i < 240 && lines < 100000; i++) {
    await wait(500);
    lines = await page.evaluate(() => {
      const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
      return at && at.term ? at.term.buffer.active.length : 0;
    });
  }
  results.buffer = { lines };
  const search = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm();
    const time = (fn) => { const t0 = performance.now(); const hit = fn(); return { ms: Math.round((performance.now() - t0) * 10) / 10, hit }; };
    const far = time(() => at.search.findNext('line 2 lorem'));          // near the TOP -> scans ~the whole scrollback
    const miss = time(() => at.search.findNext('zebra-quixotic-warp'));  // no match -> full scan, the worst case
    let dense = 0;
    for (let i = 0; i < 10; i++) dense += time(() => at.search.findNext('lorem')).ms;
    return { farMs: far.ms, farHit: far.hit, missMs: miss.ms, denseAvgMs: Math.round(dense / 10 * 10) / 10 };
  });
  results.search = search;

  // ── D. tab switch with 30 heavy sessions ────────────────────────────────
  for (let i = 0; i < 28; i++) await winmuxOn(['new-tab']);
  await page.waitForTimeout(2000);
  let ids = [];
  try { const l = JSON.parse(await winmuxOn(['list', '--json'])); ids = (l.sessions || []).map((s) => s.id); } catch (e) {}
  for (const id of ids.slice(0, 30)) await winmuxOn(['send', 'cmd /c type "' + mid + '"', '--id', String(id), '--enter']);
  await page.waitForTimeout(12000);   // let the drains land in every buffer
  const switches = [];
  for (let i = 0; i < 12; i++) {
    const ms = await page.evaluate(async (idx) => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const tabs = [...document.querySelectorAll('.ptab')].filter((x) => x.offsetParent);
      const tab = tabs[(idx * 7) % tabs.length];
      if (!tab || tab.hasAttribute('data-active')) return -1;
      const t0 = performance.now();
      tab.click();
      const deadline = t0 + 4000;
      while (performance.now() < deadline) { if (tab.hasAttribute('data-active')) break; await frame(); }
      await frame();
      return Math.round(performance.now() - t0);
    }, i);
    if (ms >= 0) switches.push(ms);
    await page.waitForTimeout(150);
  }
  switches.sort((a, b) => a - b);
  results.tabSwitch30 = {
    n: switches.length,
    tabs: ids.length,
    median: switches[Math.floor(switches.length / 2)],
    worst: switches[switches.length - 1],
  };

  await browser.close();
  try { await fetch('http://127.0.0.1:' + PORT + '/api/shutdown', { method: 'POST' }); await wait(1500); } catch (e) {}
  try { server.kill(); } catch (e) {}

  console.log('\n=== WinMux corner speed (SP-6) ===');
  console.log('window resize : ' + JSON.stringify(results.resize));
  console.log('split drag    : ' + JSON.stringify(results.splitDrag));
  console.log('search buffer : ' + JSON.stringify(results.buffer));
  console.log('search 100k   : ' + JSON.stringify(results.search));
  console.log('tab switch @30: ' + JSON.stringify(results.tabSwitch30));
  console.log(JSON.stringify(results));
  process.exit(0);
})().catch((e) => { console.error('perf-corners ERR', e && e.stack || e); process.exit(2); });
