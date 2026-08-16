// WinMux action-latency harness (IF-2, instant-feel arc).
//
//   node perf-actions.cjs            measure, print ranked table
//   node perf-actions.cjs --headed   watch it
//
// Measures click -> painted-response for the everyday interactions where
// "doesn't feel snappy" lives. Same conventions as perf.cjs: boots server.cjs
// on its own port, drives a real browser, is a committed instrument.
//
// Method: for each action, t0 = performance.now() at dispatch; poll on
// requestAnimationFrame until the action's visible condition holds, then one
// more frame so the result is actually painted. The number is "time until the
// user sees the response", not "time until our code ran".

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const HEADED = process.argv.includes('--headed');
// --load: run the same probes while 10 terminals stream heavy output — the
// "agents are working and I'm clicking around" reality, not an idle demo.
const LOAD = process.argv.includes('--load');
const PORT = 9944;
// Pre-registered target, set before optimizing: a response painted within
// 100ms reads as instant. Anything above is a named offender.
const INSTANT_MS = 100;

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

// In-page probe. `actName` keys a click function and a "the user can see the
// result" condition, both evaluated inside the page so timing has no
// harness/CDP overhead in it.
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
    'settings-toggle':{ go: function () { const sw = $('#settings-ovl .sw'); this._was = sw.classList.contains('on'); sw.click(); },
                        done: function () { const sw = $('#settings-ovl .sw'); return sw && sw.classList.contains('on') !== this._was; } },
    'settings-close': { go: () => $('#settings-ovl .mx').click(),
                        done: () => !$('#settings-ovl[data-open]') },
    'cheat-open':     { go: () => byLabel('Keyboard shortcuts').click(),
                        done: () => $('#cheat-ovl[data-open]') && /Words WinMux uses/i.test(($('#cheat-body') || {}).textContent || '') },
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
                        go: function () { this._t.click(); },
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
  return { name: actName, ms: Math.round(performance.now() - t0), err: 'timeout (condition never held)' };
}
`;

(async () => {
  const server = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(PORT), WINMUX_NO_INSTANCE: '1' }),
  });
  await waitUp(PORT, 15000);
  const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ct-onboard', '1');
      localStorage.setItem('ct-close-notice', '1');
    } catch (e) {}
  });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);                   // first shell attaches
  await page.evaluate('(() => { ' + PROBE + '\n window.__probe = __probe; })()');
  // A second tab so tab-switch has something to switch to.
  await page.evaluate(() => document.getElementById('open-new').click());
  await page.waitForTimeout(1500);

  if (LOAD) {
    // Same load recipe as perf.cjs: 10 terminals, every one streaming a long
    // burst, actions measured while the bursts are in flight.
    const winmuxOn = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
        { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT), WINMUX_HOST: '127.0.0.1' }) });
      let o = ''; p.stdout.on('data', (d) => o += d);
      p.on('exit', () => resolve(o.trim()));
    });
    for (let i = 0; i < 8; i++) await winmuxOn(['new-tab']);
    await page.waitForTimeout(1800);
    let ids = [];
    try { const l = JSON.parse(await winmuxOn(['list', '--json'])); ids = (l.sessions || []).map((s) => s.id); } catch (e) {}
    const burst = '1..60000 | % { "perf ' + 'x'.repeat(72) + ' $_" }';
    ids.forEach((id) => { winmuxOn(['send', burst, '--id', String(id), '--enter']); });
    await page.waitForTimeout(900);
    console.log('load mode: ' + ids.length + ' terminals streaming');
  }

  // Each action twice: cold (first ever) and warm (second time). The gap between
  // them is the "is the second time instant?" scorecard question, measured.
  const SEQ = [
    'palette-open', 'palette-close',
    'settings-open', 'settings-tab', 'settings-toggle', 'settings-close',
    'cheat-open', 'cheat-close',
    'notif-open',
    'sidebar-hide', 'sidebar-show',
    'tab-switch', 'tab-menu',
  ];
  const cold = {}, warmR = {};
  for (const name of SEQ) {
    const r = await page.evaluate((n) => window.__probe(n), name);
    cold[name] = r;
    await page.waitForTimeout(250);
  }
  // Reset transient UI (menus/popovers) before the warm pass.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  for (const name of SEQ) {
    const r = await page.evaluate((n) => window.__probe(n), name);
    warmR[name] = r;
    await page.waitForTimeout(250);
  }

  await browser.close();
  try { server.kill(); } catch (e) {}

  const rows = SEQ.map((n) => ({
    action: n,
    coldMs: cold[n].ms, warmMs: warmR[n].ms,
    err: cold[n].err || warmR[n].err || '',
  })).sort((a, b) => Math.max(b.coldMs, b.warmMs) - Math.max(a.coldMs, a.warmMs));

  console.log('\n=== WinMux action latency (target: painted response <= ' + INSTANT_MS + 'ms) ===');
  console.log('action            cold(ms)  warm(ms)  verdict');
  for (const r of rows) {
    const worst = Math.max(r.coldMs, r.warmMs);
    const verdict = r.err ? 'ERR ' + r.err : (worst <= INSTANT_MS ? 'instant' : 'SLOW');
    console.log(r.action.padEnd(18) + String(r.coldMs).padStart(7) + String(r.warmMs).padStart(10) + '  ' + verdict);
  }
  const offenders = rows.filter((r) => !r.err && Math.max(r.coldMs, r.warmMs) > INSTANT_MS);
  const errs = rows.filter((r) => r.err);
  console.log('\noffenders over ' + INSTANT_MS + 'ms: ' + offenders.length + (errs.length ? ' · probe errors: ' + errs.length : ''));
  console.log(JSON.stringify(rows));
  process.exit(errs.length ? 2 : 0);
})().catch((e) => { console.error('perf-actions ERR', e && e.stack || e); process.exit(2); });
