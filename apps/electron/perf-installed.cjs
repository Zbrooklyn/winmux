// IF-2 remainder: action latency INSIDE the installed primary WinMux app.
// Launches the installed Electron exe with a CDP port, connects Playwright,
// injects the same probe as perf-actions.cjs, runs the same action set, and
// prints the same ranked table. Read-only toward the app's state (no settings
// writes); the app is closed afterwards.
//
//   node perf-installed.cjs "C:\Users\EDWAR\AppData\Local\Programs\WinMux\WinMux.exe"

const { spawn, execSync } = require('child_process');
const { chromium } = require(String.raw`C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux\apps\electron\node_modules\playwright`);

const EXE = process.argv[2];
if (!EXE) { console.error('usage: node perf-installed.cjs <path-to-WinMux.exe>'); process.exit(2); }
const CDP = 9223;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Same probe as perf-actions.cjs (kept in sync by hand — this is a scratchpad
// instrument; the committed one is the source).
const PROBE = `
async function __probe(actName) {
  const $ = (s) => document.querySelector(s);
  const byLabel = (l) => document.querySelector('[aria-label="' + l + '"]');
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const acts = {
    'palette-open':   { go: () => byLabel('Command palette').click(),
                        done: () => { const w = $('#palette-wrap'); return w && getComputedStyle(w).display !== 'none' && $('#pl-list') && $('#pl-list').children.length > 0; } },
    'palette-close':  { go: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
                        done: () => { const w = $('#palette-wrap'); return !w || getComputedStyle(w).display === 'none'; } },
    'settings-open':  { go: () => byLabel('Settings').click(),
                        done: () => $('#settings-ovl[data-open]') && /Appearance|Theme/i.test(($('#settings-ovl') || {}).textContent || '') },
    'settings-tab':   { go: () => $('[data-settab="Terminal"]').click(),
                        done: () => /Scrollback lines/i.test(($('#settings-ovl') || {}).textContent || '') },
    'settings-close': { go: () => $('#settings-ovl .mx').click(),
                        done: () => !$('#settings-ovl[data-open]') },
    'cheat-open':     { go: () => byLabel('Keyboard shortcuts').click(),
                        done: () => $('#cheat-ovl[data-open]') },
    'cheat-close':    { go: () => $('#cheat-ovl').click(),
                        done: () => !$('#cheat-ovl[data-open]') },
    'notif-open':     { pre: () => { if ($('#npanel[data-open]')) $('#open-notif').click(); },
                        go: () => $('#open-notif').click(),
                        done: () => !!$('#npanel[data-open]') },
    'sidebar-hide':   { go: () => $('.pc-rail').click(),
                        done: () => document.getElementById('root').getAttribute('data-sidebar') !== 'open' },
    'sidebar-show':   { go: () => $('.pc-rail').click(),
                        done: () => document.getElementById('root').getAttribute('data-sidebar') === 'open' },
    'tab-switch':     { pre: function () { const tabs = document.querySelectorAll('.ptab'); this._t = [...tabs].find((x) => !x.hasAttribute('data-active')); },
                        go: function () { if (this._t) this._t.click(); },
                        done: function () { return this._t && this._t.hasAttribute('data-active'); } },
    'tab-menu':       { go: () => { const t = $('.ptab'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 })); },
                        done: () => { const m = $('.ofmenu[data-open]'); return m && m.querySelectorAll('.ofmi').length > 0; } },
  };
  const a = acts[actName];
  if (!a) return { name: actName, ms: -1, err: 'unknown action' };
  try { if (a.pre) a.pre(); } catch (e) { return { name: actName, ms: -1, err: 'pre: ' + e.message }; }
  const t0 = performance.now();
  try { a.go(); } catch (e) { return { name: actName, ms: -1, err: 'go: ' + e.message }; }
  const deadline = t0 + 5000;
  while (performance.now() < deadline) {
    if (a.done()) { await frame(); return { name: actName, ms: Math.round(performance.now() - t0) }; }
    await frame();
  }
  return { name: actName, ms: Math.round(performance.now() - t0), err: 'timeout' };
}
`;

(async () => {
  const t0 = Date.now();
  const app = spawn(EXE, ['--remote-debugging-port=' + CDP], { detached: true, stdio: 'ignore' });
  app.unref();
  // Wait for the CDP endpoint, then for the app page.
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    await wait(500);
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP); } catch (e) {}
  }
  if (!browser) { console.error('never connected to CDP on ' + CDP); process.exit(2); }
  const ctx = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    page = ctx.pages().find((p) => /127\.0\.0\.1|localhost/.test(p.url()));
    if (!page) await wait(500);
  }
  if (!page) { console.error('no app page found; pages: ' + ctx.pages().map((p) => p.url()).join(', ')); process.exit(2); }
  console.log('attached to installed app: ' + page.url() + ' (' + (Date.now() - t0) + 'ms after launch)');
  await page.waitForTimeout(4000);   // let first shell attach + welcome settle
  // Dismiss the welcome card if this profile never saw it.
  await page.evaluate(() => { const b = document.getElementById('wc-start'); if (b && b.offsetParent) b.click(); }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate('(() => { ' + PROBE + '\n window.__probe = __probe; })()');
  // Ensure a second tab exists for tab-switch; remember to close it after.
  const tabsAtStart = await page.evaluate(() => document.querySelectorAll('.ptab').length);
  if (tabsAtStart < 2) {
    await page.evaluate(() => document.getElementById('open-new').click());
    await page.waitForTimeout(1500);
  }
  const SEQ = ['palette-open', 'palette-close', 'settings-open', 'settings-tab', 'settings-close',
    'cheat-open', 'cheat-close', 'notif-open', 'sidebar-hide', 'sidebar-show', 'tab-switch', 'tab-menu'];
  const cold = {}, warm = {};
  for (const n of SEQ) { cold[n] = await page.evaluate((x) => window.__probe(x), n); await page.waitForTimeout(250); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  for (const n of SEQ) { warm[n] = await page.evaluate((x) => window.__probe(x), n); await page.waitForTimeout(250); }

  const rows = SEQ.map((n) => ({ action: n, coldMs: cold[n].ms, warmMs: warm[n].ms, err: cold[n].err || warm[n].err || '' }))
    .sort((a, b) => Math.max(b.coldMs, b.warmMs) - Math.max(a.coldMs, a.warmMs));
  console.log('\n=== INSTALLED app action latency (target <= 100ms) ===');
  console.log('action            cold(ms)  warm(ms)  verdict');
  for (const r of rows) {
    const worst = Math.max(r.coldMs, r.warmMs);
    console.log(r.action.padEnd(18) + String(r.coldMs).padStart(7) + String(r.warmMs).padStart(10) + '  ' + (r.err ? 'ERR ' + r.err : (worst <= 100 ? 'instant' : 'SLOW')));
  }
  console.log(JSON.stringify(rows));
  // Quit cleanly via the app's own shutdown (kills the engine + shells this run
  // started), then kill ONLY the process tree we spawned — never by image name:
  // Edward's live "WinMux Rust" app shares the WinMux.exe image and must not be
  // touched.
  try {
    await page.evaluate(() => fetch('/api/shutdown', { method: 'POST' }).catch(() => {}));
  } catch (e) {}
  await wait(1500);
  try { execSync('taskkill /PID ' + app.pid + ' /T /F 2>NUL', { stdio: 'ignore' }); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(2); });
