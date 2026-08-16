// SP-4: throughput — drain an identical 9.3MB payload in the INSTALLED WinMux.
// Same self-timed command every terminal runs; frame stats collected in-page.
// Built on the proven perf-installed.cjs attach pattern; input goes through the
// terminal's own textarea (DOM focus), not a visibility-gated click.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const { chromium } = require(String.raw`C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux\apps\electron\node_modules\playwright`);
const EXE = String.raw`C:\Users\EDWAR\AppData\Local\Programs\WinMux\WinMux.exe`;
const OUTFILE = 'C:\\Users\\EDWAR\\AppData\\Local\\Temp\\wm-bench-winmux.txt';
const CDP = 9227;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log('[sp4] ' + m);
(async () => {
  try { fs.unlinkSync(OUTFILE); } catch (e) {}
  const app = spawn(EXE, ['--remote-debugging-port=' + CDP], { detached: true, stdio: 'ignore' });
  app.unref();
  log('app spawned pid=' + app.pid);
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) { await wait(500); try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP); } catch (e) {} }
  if (!browser) { log('no CDP'); process.exit(2); }
  log('cdp connected');
  const ctx = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { page = ctx.pages().find((p) => /127\.0\.0\.1/.test(p.url())); if (!page) await wait(500); }
  if (!page) { log('no page'); process.exit(2); }
  log('page found ' + page.url());
  await page.waitForTimeout(5000);
  await page.evaluate(() => { const b = document.getElementById('wc-start'); if (b && b.offsetParent) b.click(); }).catch(() => {});
  const focused = await page.evaluate(() => {
    const th = [...document.querySelectorAll('.term-host')].find((h) => h.style.display !== 'none' && h.querySelector('textarea'));
    const ta = th ? th.querySelector('textarea') : document.querySelector('.xterm textarea');
    if (!ta) return false;
    ta.focus();
    return true;
  });
  log('terminal focused: ' + focused);
  const renderer = await page.evaluate(() => !!document.querySelector('.xterm canvas'));
  log('renderer: ' + (renderer ? 'WebGL/canvas' : 'DOM'));
  await page.evaluate(() => {
    window.__frames = { n: 0, worst: 0, last: performance.now(), on: true };
    (function tick() {
      if (!window.__frames.on) return;
      const now = performance.now();
      const gap = now - window.__frames.last;
      if (window.__frames.n > 0 && gap > window.__frames.worst) window.__frames.worst = gap;
      window.__frames.last = now; window.__frames.n++;
      requestAnimationFrame(tick);
    })();
  });
  const cmd = '(Measure-Command { cmd /c type C:\\Users\\EDWAR\\AppData\\Local\\Temp\\wm-bench.txt }).TotalMilliseconds | Out-File -Encoding ascii ' + OUTFILE;
  await page.keyboard.type(cmd, { delay: 3 });
  await page.keyboard.press('Enter');
  log('command sent, polling for result file…');
  let ms = null;
  for (let i = 0; i < 240 && ms === null; i++) {
    await wait(500);
    try {
      const raw = fs.readFileSync(OUTFILE);
      const t = raw.toString(raw[1] === 0 ? 'utf16le' : 'utf8').trim();
      if (t) ms = parseFloat(t.replace(/[^0-9.]/g, ''));
    } catch (e) {}
  }
  const frames = await page.evaluate(() => { window.__frames.on = false; return { n: window.__frames.n, worst: Math.round(window.__frames.worst) }; });
  if (ms === null) { log('RESULT FILE NEVER APPEARED'); }
  else {
    log('winmux drain: ' + Math.round(ms) + 'ms for 9.3MB = ' + (9.34 / (ms / 1000)).toFixed(1) + ' MB/s');
    log('frames during window: ' + frames.n + ', worst gap ' + frames.worst + 'ms');
  }
  try { await page.evaluate(() => fetch('/api/shutdown', { method: 'POST' }).catch(() => {})); } catch (e) {}
  await wait(1500);
  try { execSync('taskkill /PID ' + app.pid + ' /T /F 2>NUL', { stdio: 'ignore' }); } catch (e) {}
  process.exit(ms === null ? 3 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
