// WinMux verification harness.
//
//   node verify.cjs
//
// No arguments. Ever. If this file needs an argument to run, it is broken —
// every argument is a chance to invoke it wrong and burn a whole browser run.
// It finds its own ports, starts (or reuses) its own servers, shares one
// browser across every check, and writes its screenshots next to itself.
//
//   node verify.cjs --headed     watch it drive
//   node verify.cjs phone brand  run only the named checks
//
// Exit code is 0 only when every check that could run, passed.

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'verify-out');

// Two ports on purpose. The whole point of the busy one is that tailscaled
// already owns its tailnet side, so turning phone access on there MUST fail
// politely instead of taking the app down with it.
const PORT_BUSY = 8799;
const PORT_FREE = 9912;

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const ONLY = argv.filter((a) => !a.startsWith('-'));

// ---------------------------------------------------------------- plumbing

function tailscaleIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && /^100\./.test(n.address)) return n.address;
  }
  return null;
}

function inUse(host, port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(true));
    s.once('listening', () => s.close(() => res(false)));
    s.listen(port, host);
  });
}

function waitUp(port, ms) {
  const stop = Date.now() + ms;
  return new Promise(function poll(res, rej) {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(); });
    s.once('error', () => {
      s.destroy();
      if (Date.now() > stop) return rej(new Error('server never came up on ' + port));
      setTimeout(() => poll(res, rej), 250);
    });
  });
}

// Reuse a server that is already listening — Edward often has one running, and
// killing it out from under him would be worse than sharing it.
async function server(port) {
  if (await inUse('127.0.0.1', port)) return { port, borrowed: true, stop() {} };
  const proc = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port) }), stdio: 'ignore',
  });
  await waitUp(port, 15000);
  return { port, borrowed: false, stop() { try { proc.kill(); } catch (e) {} } };
}

// ------------------------------------------------------------------ checks
// Each check gets a fresh page, records its own results, and never assumes a
// server is already running. `port` says which of the two it needs.

const CHECKS = [];
const check = (id, port, run) => CHECKS.push({ id, port, run });

const desktop = (browser) =>
  browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

async function phoneCtx(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 384, height: 745 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, colorScheme: 'dark',
  });
  return ctx.newPage();
}

const settings = async (p, tab) => {
  await p.locator('#open-settings').click();
  await p.waitForTimeout(500);
  await p.locator('[data-settab="' + tab + '"]').click();
  await p.waitForTimeout(900);
};

// --- brand: the name is really rendered, in the right colours -------------
check('brand', PORT_BUSY, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);

  t('tab title is WinMux', (await p.title()) === 'WinMux');
  const chip = await p.evaluate(() => {
    const el = document.querySelector('#version-chip');
    return el && el.getAttribute('title');
  });
  t('version chip says WinMux', /^WinMux v1\.0/.test(chip || ''), chip);

  await settings(p, 'About');
  const about = (await p.locator('#settings-pane').textContent()).replace(/\s+/g, ' ').trim();
  t('About says WinMux, not cockpit-terminal', /WinMux v1\.0/.test(about) && !/cockpit-terminal/i.test(about));
  await shot(p, 'about');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  await shot(p, 'desktop');
  t('no "cockpit-terminal" left in the desktop UI',
    !/cockpit-terminal/i.test(await p.evaluate(() => document.body.innerText)));

  // The mockup's only in-app brand slot is .nhead, which is the phone header —
  // hidden at desktop width, so it has to be measured at phone width.
  const p2 = await phoneCtx(browser);
  await p2.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(4500);
  const b = await p2.evaluate(() => {
    const el = document.querySelector('.nhead .brand');
    if (!el) return null;
    const bb = el.querySelector('b'), cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), bText: bb.textContent, color: cs.color,
             bColor: getComputedStyle(bb).color, weight: cs.fontWeight, size: cs.fontSize,
             w: Math.round(r.width), h: Math.round(r.height),
             vis: r.width > 0 && cs.visibility === 'visible' && cs.display !== 'none' };
  });
  t('brand reads WinMux', b && b.text === 'WinMux', b);
  t('accent lands on "Mux"', b && b.bText === 'Mux');
  t('"Mux" computes to the accent purple', b && b.bColor === 'rgb(138, 92, 245)', b && b.bColor);
  t('"Win" inherits --text, distinct from the accent', b && b.color === 'rgb(218, 218, 218)' && b.color !== b.bColor);
  t('brand is visibly rendered at 12.5px/600', b && b.vis && b.h >= 10 && b.w >= 40 && b.size === '12.5px' && b.weight === '600');
  await shot(p2, 'phone');
});

// --- busyport: a failed phone flip must not take the app down -------------
check('busyport', PORT_BUSY, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip || !(await inUse(ip, PORT_BUSY))) {
    return skip('needs tailscaled holding ' + (ip || '100.x') + ':' + PORT_BUSY + ' — the collision cannot be reproduced');
  }
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);

  await p.locator('.xterm-helper-textarea').first().focus();
  await p.keyboard.type('"before " + $env:COMPUTERNAME');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(2500);
  const rows = () => p.evaluate(() =>
    [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent).join('|'));
  t('a shell is alive before the flip', /before \w/.test(await rows()));

  await settings(p, 'Phone');
  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(3000);

  t('the switch stayed off — it did not lie', !/\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  t('the label still says Off', /^Off\b/.test((await p.locator('.frow .fhint').first().textContent()).trim()));
  const reason = await p.evaluate(() => {
    const e = document.querySelector('#phone-err');
    return e && e.innerText.replace(/\s+/g, ' ').trim();
  });
  t('a plain-English reason was shown', !!reason && /port/i.test(reason), reason);
  t('the app is still serving', (await p.evaluate(async () => (await fetch('/api/phone')).status)) === 200);

  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  await p.locator('.xterm-helper-textarea').first().focus();
  await p.keyboard.type('"after " + $env:COMPUTERNAME');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(2500);
  t('the same terminal still runs commands', /after \w/.test(await rows()));
  await shot(p, 'busyport');
});

// --- reason: the failure block's mechanics, measured not eyeballed --------
check('reason', PORT_BUSY, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip || !(await inUse(ip, PORT_BUSY))) return skip('needs a failing flip to render a reason');

  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  await settings(p, 'Phone');
  t('no reason shown before anything fails', (await p.locator('#phone-err').count()) === 0);

  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(3000);
  const m = await p.evaluate(() => {
    const e = document.querySelector('#phone-err');
    if (!e) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    const sw = document.querySelector('[data-phone-toggle]').getBoundingClientRect();
    return { color: cs.color, fs: cs.fontSize, w: Math.round(r.width), h: Math.round(r.height),
             below: Math.round(r.top - sw.bottom), role: e.getAttribute('role'),
             text: e.innerText.replace(/\s+/g, ' ').trim().length };
  });
  t('it renders with real size', !!m && m.w > 200 && m.h >= 28, m);
  t('it uses the error colour (--err)', !!m && m.color === 'rgb(251, 70, 76)');
  t('it sits under the switch it explains', !!m && m.below >= 0 && m.below < 40);
  t('it is announced to screen readers', !!m && m.role === 'alert');
  t('it carries a real sentence', !!m && m.text > 40);
  await shot(p, 'reason');

  await p.locator('[data-settab="About"]').click();
  await p.waitForTimeout(400);
  await p.locator('[data-settab="Phone"]').click();
  await p.waitForTimeout(900);
  t('a stale reason clears when you come back', (await p.locator('#phone-err').count()) === 0);
});

// --- phone: the whole two-door flow, on a port whose tailnet side is free --
check('phone', PORT_FREE, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip) return skip('Tailscale is not running on this PC');
  if (await inUse(ip, PORT_FREE)) return skip('something already holds ' + ip + ':' + PORT_FREE);

  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  await settings(p, 'Phone');

  t('it starts off', !/\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  const offText = (await p.locator('.phone-off').textContent().catch(() => '')) || '';
  t('it explains what it does', /scan/i.test(offText) && /Tailscale/i.test(offText));

  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(2200);
  t('the switch reads on', /\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  t('the label agrees with the switch', /^On\b/.test((await p.locator('.frow .fhint').first().textContent()).trim()));

  const qr = await p.evaluate(() => {
    const i = document.querySelector('.phone-qr img');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { w: Math.round(r.width), complete: i.complete, nw: i.naturalWidth };
  });
  t('a real QR rendered', !!qr && qr.w >= 120 && qr.complete && qr.nw > 0, qr);

  const url = (await p.locator('#phone-url').textContent()).trim();
  t('the link is a tailnet URL carrying a key', /^http:\/\/100\.\d+\.\d+\.\d+:\d+\/\?k=[a-f0-9]{32}$/.test(url),
    url.replace(/k=.*/, 'k=…'));
  await shot(p, 'phone-on');

  // The point of the whole feature: that link opens a real shell.
  const p2 = await phoneCtx(browser);
  await p2.goto(url, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(5500);
  await p2.locator('.xterm-helper-textarea').first().focus();
  await p2.keyboard.type('"phone says " + $env:COMPUTERNAME');
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(3000);
  const said = await p2.evaluate(() =>
    [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent.trim())
      .filter((r) => /phone says/.test(r)));
  t('a real shell answers over the link', said.some((r) => /phone says \w/.test(r)), said);
  await shot(p2, 'phone-shell');

  // Nobody holding the link can widen their own access.
  const guard = await p2.evaluate(async () => {
    const r = await fetch('/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false }) });
    return { status: r.status, canChange: (await (await fetch('/api/phone')).json()).canChange };
  });
  t('the phone cannot flip the switch', guard.status === 403 && guard.canChange === false, guard);

  const back = p2.locator('.pane.focused .nbar .back').first();
  if (await back.isVisible().catch(() => false)) { await back.click(); await p2.waitForTimeout(600); }
  await settings(p2, 'Phone');
  t('the switch is visibly disabled on the phone, and says why',
    /off-disabled/.test(await p2.locator('[data-phone-toggle]').getAttribute('class')) &&
    /only works at the PC/i.test(await p2.locator('.frow .fhint').first().textContent()));
  await shot(p2, 'phone-settings');

  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(2000);
  t('flipping it back reads off', !/\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  t('the label agrees again', /^Off\b/.test((await p.locator('.frow .fhint').first().textContent()).trim()));
  await shot(p, 'phone-off');

  const p3 = await (await browser.newContext()).newPage();
  let dead = false;
  try { const r = await p3.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 }); dead = !r || r.status() >= 400; }
  catch (e) { dead = true; }
  t('the old link is dead', dead);
});

// -------------------------------------------------------------------- main

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const run = CHECKS.filter((c) => !ONLY.length || ONLY.includes(c.id));
  if (!run.length) {
    console.log('no such check. known: ' + CHECKS.map((c) => c.id).join(', '));
    process.exit(2);
  }

  const ports = [...new Set(run.map((c) => c.port))];
  const servers = {};
  for (const port of ports) servers[port] = await server(port);
  for (const port of ports) {
    console.log((servers[port].borrowed ? 'using the server already on ' : 'started a server on ') + port);
  }

  const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
  const report = [];

  await Promise.all(run.map(async (c) => {
    const lines = [];
    let fails = 0, skipped = null;
    const t = (name, pass, note) => {
      if (!pass) fails++;
      lines.push('  ' + (pass ? 'PASS  ' : 'FAIL  ') + name +
        (note === undefined ? '' : '\n          ' + JSON.stringify(note)));
    };
    const skip = (why) => { skipped = why; };
    const shot = (page, name) => page.screenshot({ path: path.join(OUT, c.id + '-' + name + '.png') });
    const errs = [];
    try {
      await c.run({ browser, base: 'http://127.0.0.1:' + c.port, t, skip, shot, errs });
    } catch (e) {
      fails++;
      lines.push('  FAIL  the check itself threw\n          ' + String(e.message || e).slice(0, 200));
    }
    report.push({ id: c.id, port: c.port, lines, fails, skipped });
  }));

  await browser.close();
  for (const port of ports) servers[port].stop();

  let bad = 0, skipped = 0, total = 0;
  console.log('');
  for (const r of report.sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.skipped) {
      skipped++;
      console.log('SKIP  ' + r.id + ' — ' + r.skipped);
      continue;
    }
    total += r.lines.length;
    if (r.fails) bad += r.fails;
    console.log((r.fails ? 'FAIL  ' : 'PASS  ') + r.id + '  (:' + r.port + ')');
    console.log(r.lines.join('\n'));
  }
  console.log('');
  console.log(bad ? bad + ' of ' + total + ' checks FAILED' : total + '/' + total + ' checks passed');
  if (skipped) console.log(skipped + ' group(s) skipped — see the reasons above; a skip is not a pass');
  console.log('screenshots: ' + OUT);
  process.exit(bad ? 1 : 0);
})();
