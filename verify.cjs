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
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'verify-out');

// Two ports on purpose. The busy one is where we prove that a phone flip which
// cannot bind MUST fail politely instead of taking the app down with it.
// It used to be 8799, borrowed from tailscaled's accidental hold on that port —
// which meant the check silently skipped on any machine where the accident
// wasn't happening, and "a skip is not a pass". Now the harness creates the
// collision itself (holdTailnet below), so the check runs everywhere Tailscale
// runs. 9914 is deliberately outside PORT_CANDIDATES and outside the serve
// rules on this machine.
const PORT_BUSY = 9914;
const PORT_FREE = 9912;
// The remote group opens the phone door for real, so it gets its own port —
// sharing PORT_FREE would have two groups fighting over one phone switch.
const PORT_REMOTE = 9911;
// The trust group needs a guest list nobody else is writing to, and a fresh one
// — "the switch is off on a fresh install" is only provable from empty.
const PORT_TRUST = 9915;
// The phone group opens and closes the door for real, so it must never borrow
// @edward's live WinMux — that would flip his own switch mid-run, and when his
// door is already open on 9912 the group used to skip instead. A skip is not a
// pass, so it gets a port of its own.
const PORT_PHONE = 9913;
// The survival group counts running shells, so it must be the only thing
// talking to its server — borrowing @edward's would count his terminals as
// leaks and kill a tab he is using.
const PORT_SURVIVE = 9916;
// The drop group makes twin folders on disk and asks the server to tell them
// apart, so it wants a server whose answers nobody else is racing.
const PORT_DROP = 9917;
// The colour group types into a real shell and reads the painted result back,
// so it needs a server whose terminals nobody else is writing to.
const PORT_COLOUR = 9918;
const PORT_GROUPS = 9919;
// Reopening the page must reattach to the running shell, not orphan it.
const PORT_RELOAD = 9920;
// The CLI check needs its own server + a connected app, on a port nobody else
// is driving, so `winmux new-tab` counts don't race another group's terminals.
const PORT_CLI = 9921;
// The markdown check opens a viewer surface and edits the file under it, so it
// needs a server whose /api/md nobody else is racing and a /control of its own.
const PORT_MD = 9922;

// Every server this harness starts gets its own scratch guest list. Two reasons,
// both real: @edward's actual remembered phones must never be edited by a test
// run, and three concurrent servers sharing one file would clobber each other's
// writes and make the trust checks flap for no product reason.
const trustFile = (port) => path.join(OUT, 'trust-' + port + '.json');

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

// Take the Tailscale side of a port and hold it, so the app's phone door has
// something real to collide with. The desk door is unaffected — it binds
// 127.0.0.1, which is a different socket — so this reproduces exactly the
// situation the polite failure exists for, on demand, on any machine.
function holdTailnet(port) {
  const ip = tailscaleIp();
  if (!ip) return Promise.resolve(null);
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(null));            // already held by something else: fine
    s.once('listening', () => res({ ip, port, stop() { try { s.close(); } catch (e) {} } }));
    s.listen(port, ip);
  });
}

// Held once for the whole run, not once per check. The two checks that need
// the collision run concurrently, and a second bind of the same socket would
// fail — which the check would then misread as "Tailscale isn't running".
let busyHold = null;

// The servers this run started, by port. A check that asserts fresh-install
// state has to know whether it got a fresh server or borrowed @edward's.
const SERVERS = {};

// Ports that tailscale already forwards into loopback. The harness reads the
// same source the app does, so "we moved off a tunnelled port" is checked
// against reality rather than against a hardcoded number.
function tunnelled() {
  return new Promise((resolve) => {
    const found = new Set();
    let left = 2;
    const done = () => { if (--left === 0) resolve(found); };
    for (const sub of ['serve', 'funnel']) {
      require('child_process').execFile('tailscale', [sub, 'status'],
        { timeout: 4000, windowsHide: true }, (err, out) => {
          if (!err && out) {
            const re = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})/g;
            let m;
            while ((m = re.exec(out))) found.add(parseInt(m[1], 10));
          }
          done();
        });
    }
  });
}

function get(url, headers) {
  return new Promise((res, rej) => {
    http.get(url, { headers: headers || {} }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    }).on('error', rej);
  });
}

function post(url, body, headers) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        headers || {}),
    }, (rs) => {
      let b = '';
      rs.on('data', (d) => { b += d; });
      rs.on('end', () => res({ status: rs.statusCode, body: b }));
    });
    r.on('error', rej);
    r.write(body); r.end();
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
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), WINMUX_TRUST_FILE: trustFile(port), WINMUX_NO_INSTANCE: '1' }),
    stdio: 'ignore',
  });
  await waitUp(port, 15000);
  return { port, borrowed: false, stop() { try { proc.kill(); } catch (e) {} } };
}

// Start a server with NO port forced, and read back the port it chose for
// itself. Never borrows a running server — the choice IS the thing under test.
function serverAuto() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { WINMUX_TRUST_FILE: trustFile('auto'), WINMUX_NO_INSTANCE: '1' });
    delete env.PORT;
    const proc = spawn(process.execPath, ['server.cjs'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      reject(new Error('auto-port server never announced itself'));
    }, 20000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      clearTimeout(timer);
      resolve({ port: Number(m[1]), log: buf, stop() { try { proc.kill(); } catch (e) {} } });
    });
  });
}

// ------------------------------------------------------------------ checks
// Each check gets a fresh page, records its own results, and never assumes a
// server is already running. `port` says which of the two it needs.

const CHECKS = [];
const check = (id, port, run) => CHECKS.push({ id, port, run });

const desktop = (browser) =>
  browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

async function phoneCtx(browser, colorScheme) {
  const ctx = await browser.newContext({
    viewport: { width: 384, height: 745 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, colorScheme: colorScheme || 'dark',
  });
  return ctx.newPage();
}

// A screenshot of the Phone tab is a photograph of a working key — the printed
// link AND a QR anyone can scan. These images get shown to people, so blank
// both before the shutter, and report whether anything key-shaped survived.
async function redact(p) {
  return p.evaluate(() => {
    const u = document.querySelector('#phone-url');
    if (u) u.textContent = 'http://100.x.x.x:0000/?k=<redacted>';
    // Dropping the src leaves a broken-image glyph and its alt text, which
    // reads as a bug in a screenshot people are shown. Replace the square with
    // something that says, deliberately, that it was hidden on purpose.
    document.querySelectorAll('.phone-qr').forEach((box) => {
      // Size off the QR it replaces, not off the box — with the image gone the
      // box collapses, and a tall grey sliver looks like a layout bug.
      const img = box.querySelector('img');
      const r = img ? img.getBoundingClientRect() : box.getBoundingClientRect();
      const side = Math.max(150, Math.round(r.width || r.height));
      box.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;' +
        'width:' + side + 'px;height:' + side + 'px;border-radius:6px;' +
        'font:600 11px/1 system-ui,sans-serif;letter-spacing:.06em;color:#6b6b6b;' +
        'background:repeating-linear-gradient(45deg,#dcdcdc 0 7px,#d0d0d0 7px 14px)">QR HIDDEN</div>';
    });
    return !/\?k=[a-f0-9]{32}/.test(document.body.innerHTML);
  });
}

const settings = async (p, tab) => {
  // NOTE (#180): the phone check calls this from the terminal (focus) view, where
  // #open-settings is present but not visible — the gear only surfaces at the top
  // of the phone drill-in. Root-caused 2026-07-28; the proper fix is to climb the
  // drill-in to a gear-visible view first, but the back-control path needs more
  // work, so this stays the original (desktop-solid) helper rather than ship a
  // half-fix. The trust check's forget-terminal flake IS hardened (see below).
  await p.locator('#open-settings').click();
  await p.waitForTimeout(500);
  await p.locator('[data-settab="' + tab + '"]').click();
  await p.waitForTimeout(900);
};

// --- port: the app refuses a port it cannot fully use ---------------------
// The desk door binding is not enough. If the Tailscale side of a port is
// taken, phone access can never turn on there, so with no PORT forced the
// server must move off it by itself instead of failing politely later.
check('port', PORT_FREE, async ({ t }) => {
  const ip = tailscaleIp();
  const auto = await serverAuto();
  try {
    const answered = await get('http://127.0.0.1:' + auto.port + '/');
    t('auto-picked port really serves the desk door', answered.status === 200, auto.port);
    if (ip) {
      t('auto-picked port is free on the Tailscale side', !(await inUse(ip, auto.port)), ip + ':' + auto.port);
      if (await inUse(ip, 8799)) {
        t('auto-picked away from the busy default', auto.port !== 8799, 'chose ' + auto.port);
      } else {
        t('SKIP moved-off-default — 8799 is not busy on this tailnet', true);
      }
      // A tunnelled port is the dangerous one: a serve rule makes the whole
      // tailnet arrive looking like loopback, so the keyless desk door would
      // be handing out shells. The app must never settle on one.
      const tun = await tunnelled();
      t('auto-picked a port no tailscale serve rule forwards into',
        !tun.has(auto.port), 'chose ' + auto.port + ', tunnelled: ' + (tun.size ? [...tun].join(',') : 'none'));
      if (tun.has(8799)) {
        t('said out loud that it stepped around a serve rule',
          /serve rule/.test(auto.log), auto.log.split('\n').find((l) => /serve rule|busy on your/.test(l)));
      } else {
        t('SKIP serve-rule message — nothing tunnels 8799 on this machine', true);
      }
    } else {
      t('SKIP tailnet side — Tailscale is not running', true);
    }
  } finally { auto.stop(); }

  // The same rule with an explicit PORT: obeying it exactly would mean serving
  // a keyless shell to the tailnet, so this is the one case where an explicit
  // port is refused rather than honoured. It must refuse by exiting, not by
  // starting anyway and hoping.
  const tun2 = await tunnelled();
  const victim = [...tun2][0];
  if (victim) {
    const res = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['server.cjs'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(victim), WINMUX_TRUST_FILE: trustFile('refusal') }),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('exit', (code) => resolve({ code, err }));
      setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, err }); }, 15000);
    });
    t('refuses to start on a tunnelled port even when PORT forces it', res.code === 2, 'exit ' + res.code + ' for port ' + victim);
    t('the refusal explains itself in plain English', /tailscale serve/i.test(res.err) && /without a key/.test(res.err), res.err.split('\n')[1]);
  } else {
    t('SKIP tunnelled-PORT refusal — no serve rules on this machine', true);
  }

  // An explicit port is never overridden — the busy-port fixture below depends
  // on actually getting the busy port.
  const forced = await server(PORT_BUSY);
  try {
    const onBusy = await get('http://127.0.0.1:' + PORT_BUSY + '/');
    t('an explicit PORT is honoured exactly, not auto-moved', onBusy.status === 200, PORT_BUSY);
  } finally { forced.stop(); }
});

// --- brand: the name is really rendered, in the right colours -------------
check('brand', PORT_BUSY, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);

  t('tab title is WinMux', (await p.title()) === 'WinMux');
  // The header no longer carries a version chip — @edward's call: the version
  // lives only in Settings → About (asserted just below), not the chrome.
  t('the version chip was removed from the header',
    (await p.locator('#version-chip').count()) === 0);

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

// --- fresh: the browser must never serve yesterday's app ------------------
// This one is not cosmetic. The app lives at a fixed local address and gets
// rebuilt constantly, so an asset a browser is allowed to cache means the next
// visit can render a version of the app that no longer exists — which reads,
// correctly, as "the server is broken."
check('fresh', PORT_BUSY, async ({ base, t }) => {
  for (const asset of ['/', '/app.js', '/cockpit.css']) {
    const r = await get(base + asset);
    const cc = (r.headers['cache-control'] || '').toLowerCase();
    t('served ' + asset, r.status === 200, r.status);
    t(asset + ' tells the browser not to store it', cc.includes('no-store'), cc || '(no Cache-Control at all)');
  }
});

// --- busyport: a failed phone flip must not take the app down -------------
check('busyport', PORT_BUSY, async ({ browser, base, t, shot, skip }) => {
  if (!busyHold) return skip('Tailscale is not running, so there is no tailnet side to collide with');
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
  // Same manufactured collision as busyport, from the same run-long hold: the
  // reason only exists because the flip failed, so the harness has to cause the
  // failure rather than wait for a machine where it happens to be true.
  if (!busyHold) return skip('Tailscale is not running, so there is no tailnet side to collide with');
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
check('phone', PORT_PHONE, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip) return skip('Tailscale is not running on this PC');
  if (await inUse(ip, PORT_PHONE)) return skip('something already holds ' + ip + ':' + PORT_PHONE);

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
  t('the shot of the Phone tab carries no live key', await redact(p));
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

// --- remote: the link works FROM the tailnet, and only with its key -------
// Everything else talks to 127.0.0.1. This group talks to the Tailscale
// address the way Edward's phone does, because that is the thing being
// claimed, and a claim proved on the desk door is not proved at all.
check('remote', PORT_REMOTE, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip) return skip('Tailscale is not running on this PC');
  if (await inUse(ip, PORT_REMOTE)) return skip('something already holds ' + ip + ':' + PORT_REMOTE);

  // Open the phone door from the desk door — the only place allowed to.
  const opened = JSON.parse((await post(base + '/api/phone', JSON.stringify({ on: true }))).body);
  t('the desk door opened the phone door', opened.ok === true && opened.on === true);
  const url = opened.url || '';
  t('it handed back a tailnet link with a key',
    new RegExp('^http://' + ip.replace(/\./g, '\\.') + ':' + PORT_REMOTE + '/\\?k=[a-f0-9]{32}$').test(url),
    url.replace(/k=.*/, 'k=…'));
  const key = (url.match(/k=([a-f0-9]{32})/) || [])[1];
  const origin = 'http://' + ip + ':' + PORT_REMOTE;

  try {
    // The door is shut to anyone without the key — tested over the tailnet.
    const bare = await get(origin + '/');
    t('no key over the tailnet is refused', bare.status === 401, bare.status);
    t('the refusal is plain English, not a stack trace', /needs its access key/.test(bare.body), bare.body.slice(0, 60));

    // Typing the address by hand is how people actually arrive here, so the
    // refusal has to name the fix, not just the problem.
    const asPerson = await get(origin + '/', { accept: 'text/html' });
    t('a person gets a page, not a bare line', asPerson.status === 401 && /^<!doctype html>/i.test(asPerson.body.trim()));
    t('it says where to get the key', /Settings/.test(asPerson.body) && /scan the QR/i.test(asPerson.body.replace(/&\w+;/g, ' ')));
    t('it still carries the original sentence', /needs its access key/.test(asPerson.body));
    t('the page leaks no key', !/[a-f0-9]{32}/.test(asPerson.body));

    const wrong = await get(origin + '/?k=' + 'f'.repeat(32));
    t('a wrong key of the right length is refused', wrong.status === 401, wrong.status);
    t('a wrong key sets no cookie', !wrong.headers['set-cookie']);

    const right = await get(origin + '/?k=' + key);
    t('the real key is let in', right.status === 200, right.status);
    const cookie = String((right.headers['set-cookie'] || [])[0] || '');
    t('it parks the key in an HttpOnly cookie', /^ct_k=[a-f0-9]{32};/.test(cookie) && /HttpOnly/.test(cookie));
    t('the cookie is SameSite=Strict', /SameSite=Strict/.test(cookie));

    // The cookie alone must carry the rest of the page, or the app is broken
    // the moment the URL loses its ?k=.
    const viaCookie = await get(origin + '/api/phone', { cookie: 'ct_k=' + key });
    t('the cookie alone authenticates', viaCookie.status === 200, viaCookie.status);
    t('the phone is told it may not flip the switch',
      JSON.parse(viaCookie.body).canChange === false);

    // A holder of the link can never widen their own access.
    const widen = await post(origin + '/api/phone?k=' + key, JSON.stringify({ on: false }));
    t('the phone door refuses to change the switch', widen.status === 403, widen.status);
    t('the door is still open after the attempt',
      JSON.parse((await get(base + '/api/phone')).body).on === true);

    const qr = await get(origin + '/api/phone/qr?k=' + key);
    t('the QR is a real SVG over the link', qr.status === 200 && /^<svg/.test(qr.body.trim()));

    // What Edward saw when he typed the address by hand — measured, on a phone.
    const p0 = await phoneCtx(browser);
    await p0.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    const m = await p0.evaluate(() => {
      const h = document.querySelector('h1'), b = document.querySelector('.brand b');
      const steps = document.querySelectorAll('ol li');
      return h && b ? {
        head: h.textContent, accent: getComputedStyle(b).color, steps: steps.length,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        size: getComputedStyle(document.body).fontSize,
      } : null;
    });
    t('the page really renders on a phone', !!m && m.steps === 3, m);
    t('it is branded in the app accent', !!m && m.accent === 'rgb(138, 92, 245)', m && m.accent);
    t('no sideways scroll at 384px', !!m && m.overflow === false);
    await shot(p0, 'needs-key');
    await p0.close();

    // The app follows the device's light/dark setting (cockpit.css:7), so the
    // door in front of it has to as well — a dark refusal ahead of a light app
    // reads as two different products. Measured in both schemes, not asserted.
    const scheme = async (which) => {
      const q = await phoneCtx(browser, which);
      await q.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      const v = await q.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
      }));
      await shot(q, 'needs-key-' + which);
      await q.close();
      return v;
    };
    const dark = await scheme('dark');
    const light = await scheme('light');
    t('the door is dark on a dark phone',
      dark.bg === 'rgb(30, 30, 30)' && dark.text === 'rgb(218, 218, 218)', dark);
    t('the door is light on a light phone',
      light.bg === 'rgb(255, 255, 255)' && light.text === 'rgb(35, 35, 35)', light);

    // The whole point: a phone-shaped browser, over the tailnet, running a
    // real PowerShell command on this PC.
    const p = await phoneCtx(browser);
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(5500);
    await p.locator('.xterm-helper-textarea').first().focus();
    await p.keyboard.type('"tailnet says " + $env:COMPUTERNAME');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(3000);
    const said = await p.evaluate(() =>
      [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent.trim())
        .filter((r) => /tailnet says/.test(r)));
    t('a real shell answers over the tailnet', said.some((r) => /tailnet says \w/i.test(r)), said);

    // This screenshot gets shown to people, so the key must not be in it.
    const clean = await redact(p);
    t('no live key survives in the shipped screenshot', clean);
    await shot(p, 'phone');
  } finally {
    await post(base + '/api/phone', JSON.stringify({ on: false }));
  }

  const shut = JSON.parse((await get(base + '/api/phone')).body);
  t('the door is shut again at the end', shut.on === false);
  let dead = false;
  try { await get(origin + '/?k=' + key); } catch (e) { dead = true; }
  t('the tailnet address stops answering entirely', dead);
});

// --- trust: scan once, stay in — without widening who else gets in --------
// The product claim is "the phone you already scanned keeps working." That
// only means something if it survives the two things that actually happen: a
// key rotation and a restart. Both are performed here for real.
check('trust', PORT_TRUST, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip) return skip('Tailscale is not running on this PC');
  if (SERVERS[PORT_TRUST] && SERVERS[PORT_TRUST].borrowed)
    return skip('borrowed a server already on ' + PORT_TRUST + ', and a fresh guest list is the premise');
  if (await inUse(ip, PORT_TRUST)) return skip('something already holds ' + ip + ':' + PORT_TRUST);

  const origin = 'http://' + ip + ':' + PORT_TRUST;
  const state = async () => JSON.parse((await get(base + '/api/phone')).body);
  const open = async () => {
    const o = JSON.parse((await post(base + '/api/phone', JSON.stringify({ on: true }))).body);
    return (String(o.url || '').match(/k=([a-f0-9]{32})/) || [])[1];
  };
  // A real process restart, not a reasoned one — the guest list is a file, and
  // a file claim is only proved by killing the thing that wrote it.
  const restart = async () => {
    SERVERS[PORT_TRUST].stop();
    for (let i = 0; i < 40 && (await inUse('127.0.0.1', PORT_TRUST)); i++)
      await new Promise((r) => setTimeout(r, 250));
    SERVERS[PORT_TRUST] = await server(PORT_TRUST);
  };

  // 1. A fresh install trusts nobody and waives nothing.
  const fresh = await state();
  t('a fresh install remembers no phones', Array.isArray(fresh.devices) && fresh.devices.length === 0, fresh.devices);
  t('the tailnet switch ships off', fresh.trustTailnet === false);
  t('it can count the tailnet, or says it cannot',
    fresh.tailnetPeers === null || typeof fresh.tailnetPeers === 'number', fresh.tailnetPeers);

  const key1 = await open();
  try {
    // 2. Scanning once mints a durable id alongside the disposable key.
    const scan = await get(origin + '/?k=' + key1, {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0 (Linux; Android 14; SM-S938U) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
    });
    const set = [].concat(scan.headers['set-cookie'] || []);
    const devCookie = String(set.find((c) => /^ct_dev=/.test(c)) || '');
    const devA = (devCookie.match(/^ct_dev=([a-f0-9]{32})/) || [])[1];
    t('scanning the QR mints a device id', !!devA);
    t('the device id is built to outlive the key', /Max-Age=31536000/.test(devCookie));
    t('and it is HttpOnly, SameSite=Strict',
      /HttpOnly/.test(devCookie) && /SameSite=Strict/.test(devCookie), devCookie.replace(/=[a-f0-9]{32}/, '=…'));

    const listed = (await state()).devices;
    t('the PC lists the phone that scanned', listed.length === 1 && listed[0].id === devA, listed);
    t('it names it in plain English, not a hash', /Android/i.test(String(listed[0] && listed[0].name)), listed[0] && listed[0].name);

    // 3. The phone door can read the guest list but never edit it, and never
    // learns another device's id — an id is a credential.
    const seen = JSON.parse((await get(origin + '/api/phone/devices', { cookie: 'ct_dev=' + devA })).body);
    t('the phone can see the guest list', Array.isArray(seen.devices) && seen.devices.length === 1);
    t('without being handed anyone\'s id', seen.devices[0].id === undefined && !!seen.devices[0].name, seen.devices[0]);
    t('and is told it may not change it', seen.canChange === false);
    // Probed with the cookie, not ?k=, because that is how a phone that has
    // already scanned actually talks — and because any keyed request mints a
    // device by design, which would have made this check invent its own guests.
    const asPhone = { cookie: 'ct_dev=' + devA };
    const tryForget = await post(origin + '/api/phone/devices', JSON.stringify({ all: true }), asPhone);
    t('the phone cannot forget anyone', tryForget.status === 403, tryForget.status);
    const tryTrust = await post(origin + '/api/phone', JSON.stringify({ trustTailnet: true }), asPhone);
    t('the phone cannot waive the key for the whole tailnet', tryTrust.status === 403, tryTrust.status);
    const afterTries = await state();
    t('neither attempt changed anything',
      afterTries.trustTailnet === false && afterTries.devices.length === 1, afterTries.devices.length);

    // 4. The key rotates on every flip. That is correct for a leakable link,
    //    and it is exactly what used to lock Edward's own phone out.
    await post(base + '/api/phone', JSON.stringify({ on: false }));
    const key2 = await open();
    t('the key really did rotate', !!key2 && key2 !== key1);
    const stale = await get(origin + '/?k=' + key1);
    t('the old key is refused', stale.status === 401, stale.status);
    const remembered = await get(origin + '/', { cookie: 'ct_dev=' + devA, accept: 'text/html' });
    t('the phone that scanned once gets in with no key at all', remembered.status === 200, remembered.status);

    // 5. Restart the server for real. The door closes on boot by design; what
    //    has to survive is the guest list, not the switch.
    await restart();
    const revived = await state();
    t('the guest list survived a restart',
      revived.devices.length === 1 && revived.devices[0].id === devA, revived.devices);
    t('the phone door is shut again after a restart', revived.on === false);
    const key3 = await open();
    t('the key rotated again across the restart', !!key3 && key3 !== key2);
    const afterBoot = await get(origin + '/', { cookie: 'ct_dev=' + devA, accept: 'text/html' });
    t('and the same phone still walks in', afterBoot.status === 200, afterBoot.status);

    // 6. Remembering one phone must not quietly let in every other one.
    const stranger = await get(origin + '/', { cookie: 'ct_dev=' + 'a'.repeat(32), accept: 'text/html' });
    t('a phone that never scanned still meets the door', stranger.status === 401, stranger.status);
    t('and is told how to get in', /scan the QR/i.test(stranger.body.replace(/&\w+;/g, ' ')));

    // 7. A second, real phone: scan, get a shell, then get forgotten.
    const p = await phoneCtx(browser);
    await p.goto(origin + '/?k=' + key3, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(5500);
    await p.locator('.xterm-helper-textarea').first().focus();
    await p.keyboard.type('"trusted says " + $env:COMPUTERNAME');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(3000);
    const said = await p.evaluate(() =>
      [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent.trim())
        .filter((r) => /trusted says/.test(r)));
    t('the scanned phone gets a real shell', said.some((r) => /trusted says \w/i.test(r)), said);
    const devB = ((await p.context().cookies()).find((c) => c.name === 'ct_dev') || {}).value;
    t('the second phone was remembered too', !!devB && devB !== devA);

    // 8. The Phone panel as Edward sees it — measured, then shipped.
    const d = await desktop(browser);
    await d.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await d.waitForTimeout(1200);
    await settings(d, 'Phone');
    const sw = await d.evaluate(() => {
      const el = document.querySelector('[data-trust-toggle]');
      if (!el) return null;
      const row = el.closest('.frow'), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return {
        on: / on\b/.test(' ' + el.className), disabled: /off-disabled/.test(el.className),
        name: row.querySelector('.fname').textContent.trim(),
        hint: row.querySelector('.fhint').textContent.replace(/\s+/g, ' ').trim(),
        w: Math.round(r.width), h: Math.round(r.height),
        shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
      };
    });
    t('the tailnet switch is really rendered', !!sw && sw.shown && sw.w >= 30 && sw.h >= 16, sw);
    t('it reads off', !!sw && sw.on === false);
    t('it is changeable at the PC', !!sw && sw.disabled === false);
    t('its line recommends leaving it off', !!sw && /Recommended/.test(sw.hint), sw && sw.hint);
    const rows = await d.evaluate(() => [].map.call(document.querySelectorAll('.devs .devrow'), (r) => ({
      name: (r.querySelector('.devname') || {}).textContent,
      meta: ((r.querySelector('.devmeta') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
      forget: !!r.querySelector('[data-act="forget"]'),
    })));
    t('both remembered phones have a row', rows.length === 2, rows);
    t('each row names it, dates it, and offers Forget',
      rows.length === 2 && rows.every((r) => r.name && /last/i.test(r.meta) && r.forget), rows);
    // The list grows. If the panel cannot reach the bottom of it, a remembered
    // phone quietly becomes unforgettable — and a screenshot of the top of a
    // clipped list looks perfectly fine, so this is measured.
    const reach = await d.evaluate(async () => {
      const rows = document.querySelectorAll('.devs .devrow');
      const last = rows[rows.length - 1];
      const pane = document.querySelector('#settings-pane');
      if (!last || !pane) return null;
      const scrolls = getComputedStyle(pane).overflowY;
      pane.scrollTop = pane.scrollHeight;
      await new Promise((r) => setTimeout(r, 400));
      const lr = last.getBoundingClientRect(), pr = pane.getBoundingClientRect();
      const btn = last.querySelector('[data-act="forget"]');
      const br = btn ? btn.getBoundingClientRect() : null;
      return {
        scrolls, inside: lr.bottom <= pr.bottom + 1 && lr.top >= pr.top - 1,
        forgetClickable: !!br && br.width >= 44 && br.height >= 20,
      };
    });
    t('the settings pane scrolls rather than clipping the list',
      !!reach && /auto|scroll/.test(reach.scrolls), reach && reach.scrolls);
    t('the last remembered phone can be scrolled fully into view', !!reach && reach.inside === true, reach);
    t('and its Forget button is a real target', !!reach && reach.forgetClickable === true, reach);

    t('no key is on screen', await redact(d));
    await shot(d, 'devices-dark');
    const dl = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await dl.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await dl.waitForTimeout(1200);
    await settings(dl, 'Phone');
    await dl.evaluate(async () => {
      const pane = document.querySelector('#settings-pane');
      if (pane) { pane.scrollTop = pane.scrollHeight; await new Promise((r) => setTimeout(r, 400)); }
    });
    await redact(dl);
    // A screenshot named "light" has to actually be the light theme. The app's
    // manual override is an attribute that outranks the mockup's media query, so
    // this reads the resolved token rather than trusting the emulated OS hint.
    const paint = (pg) => pg.evaluate(() => {
      const r = getComputedStyle(document.documentElement);
      const m = document.querySelector('.modal');
      return {
        attr: document.documentElement.getAttribute('data-theme'),
        bg0: r.getPropertyValue('--bg0').trim(),
        body: getComputedStyle(document.body).backgroundColor,
        modal: m ? getComputedStyle(m).backgroundColor : null,
      };
    });
    const [pd, pl] = [await paint(d), await paint(dl)];
    t('the dark shot really is the dark theme', pd.body === 'rgb(30, 30, 30)', pd);
    t('the light shot really is the light theme', pl.body === 'rgb(255, 255, 255)', pl);
    t('the settings sheet follows the theme instead of pinning one',
      pd.modal !== pl.modal, { dark: pd.modal, light: pl.modal });
    await shot(dl, 'devices-light');
    await dl.close();

    // 9. Forget is a real revocation: the list, the live shell, and the door.
    const forgot = JSON.parse((await post(base + '/api/phone/devices', JSON.stringify({ forget: devB }))).body);
    t('forgetting drops it from the list',
      forgot.devices.length === 1 && forgot.devices[0].id === devA, forgot.devices);
    // The forced socket-close is async: it can take a beat to reach the page, so
    // a single fixed wait flaps. Poll the real end-state instead — type a
    // per-attempt marker and confirm none of them ever echo. Once the shell is
    // gone, nothing echoes, so this settles deterministically on "stopped".
    let stillTalking = true;
    for (let i = 0; i < 6 && stillTalking; i++) {
      await p.waitForTimeout(800);
      await p.locator('.xterm-helper-textarea').first().focus().catch(() => {});
      await p.keyboard.type('"after forget ' + i + ' " + $env:COMPUTERNAME');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(1200);
      stillTalking = await p.evaluate(() =>
        [].some.call(document.querySelectorAll('.xterm-rows > div'),
          (d2) => /after forget \d+ \w/i.test(d2.textContent)));
    }
    t('the forgotten phone\'s terminal stopped answering', stillTalking === false);
    const lockedOut = await get(origin + '/', { cookie: 'ct_dev=' + devB, accept: 'text/html' });
    t('and it has to scan again before it gets back in', lockedOut.status === 401, lockedOut.status);
    await p.close();
    await d.close();

    // 10. The tailnet switch itself. Flipped with the phone door SHUT, so the
    //     keyless state is never actually reachable during a test run — the
    //     tailnet has other people's devices on it. What is proved here is
    //     that the switch holds, says so, and can be taken back.
    await post(base + '/api/phone', JSON.stringify({ on: false }));
    const flipped = JSON.parse((await post(base + '/api/phone', JSON.stringify({ trustTailnet: true }))).body);
    t('the PC can turn the tailnet switch on', flipped.ok === true && flipped.trustTailnet === true);
    t('and it stays on', (await state()).trustTailnet === true);
    const d2 = await desktop(browser);
    await d2.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await d2.waitForTimeout(1200);
    await settings(d2, 'Phone');
    const onState = await d2.evaluate(() => {
      const el = document.querySelector('[data-trust-toggle]');
      if (!el) return null;
      const warn = [].filter.call(document.querySelectorAll('.phone-warn'),
        (w) => /not always only yours/i.test(w.textContent))[0];
      return {
        on: / on\b/.test(' ' + el.className),
        hint: el.closest('.frow').querySelector('.fhint').textContent.replace(/\s+/g, ' ').trim(),
        warn: warn ? warn.textContent.replace(/\s+/g, ' ').trim() : '',
      };
    });
    t('the switch shows on', !!onState && onState.on === true);
    // It must count the other devices out loud rather than say "your devices" —
    // the tailnet has someone else's iPad on it.
    t('the line counts who this lets in',
      !!onState && /other device/i.test(onState.hint) && /without scanning/i.test(onState.hint), onState && onState.hint);
    t('and it warns instead of reassuring',
      !!onState && /a device someone else owns can be on it/i.test(onState.warn), onState && onState.warn);
    await shot(d2, 'trust-on');
    await d2.close();
    const back = JSON.parse((await post(base + '/api/phone', JSON.stringify({ trustTailnet: false }))).body);
    t('and it can be taken straight back off', back.trustTailnet === false);
  } finally {
    await post(base + '/api/phone', JSON.stringify({ on: false }));
    await post(base + '/api/phone', JSON.stringify({ trustTailnet: false }));
  }

  const end = await state();
  t('the run leaves the door shut and the switch off',
    end.on === false && end.trustTailnet === false, { on: end.on, trustTailnet: end.trustTailnet });
});

// --- survive: losing the socket is not losing the shell -------------------
// The thing a phone actually does to a backgrounded tab is reap its websocket.
// That used to kill the shell on the other side and print "[session ended]"
// forever, taking the person's work with it. So the harness does exactly what
// the browser does — closes the page's own sockets — and then asks the only
// questions that matter: did the shell keep running while nobody held it, did
// the app pick it back up by itself, and is the work still there.
check('survive', PORT_SURVIVE, async ({ browser, base, t, shot }) => {
  const info = async () => JSON.parse((await get(base + '/api/info')).body);

  const page = await desktop(browser);
  // Take a handle on every socket the app opens, before the app opens any.
  await page.addInitScript(() => {
    window.__socks = [];
    const Native = window.WebSocket;
    window.WebSocket = function (...a) { const s = new Native(...a); window.__socks.push(s); return s; };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
  });
  const screen = () => page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    return r ? r.innerText : '';
  });

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('$mywork = "IMPORTANT"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const started = await info();
    t('a shell is running and someone is holding it',
      started.sessions === 1 && started.detached === 0, started);

    // The reap. Not setOffline — that leaves an established socket alone, which
    // is why this bug survived so long: the emulation was politer than a phone.
    await page.evaluate(() => window.__socks.forEach((s) => s.close()));
    await page.waitForTimeout(250);
    const orphan = await info();
    t('the shell keeps running with nobody attached',
      orphan.sessions === 1 && orphan.detached === 1, orphan);

    await page.waitForTimeout(6000);
    const back = await info();
    const socks = await page.evaluate(() => window.__socks.length);
    t('the app reconnects on its own', socks > 1, { sockets: socks });
    t('and is holding the same shell again',
      back.sessions === 1 && back.detached === 0, back);

    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('echo $mywork');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const after = await screen();
    t('the work in the shell survived the trip', /IMPORTANT/.test(after.split('echo $mywork')[1] || ''));
    t('and it never claimed the session ended', !/session ended/i.test(after));
    await shot(page, 'reconnected');

    // The other half of the contract: a shell that outlives a dropped socket
    // must NOT outlive a tab its owner closed, or WinMux quietly leaves live
    // PowerShells on the machine every time someone tidies up.
    await page.locator('.pc-new').first().click();
    await page.waitForTimeout(2500);
    t('a second tab is a second shell', (await info()).sessions === 2);
    await page.locator('.ptab[data-active] .x').first().click();
    // Closing a live terminal asks first — click through it the way a person
    // does, which also proves that confirmation actually reaches the shell.
    const ok = page.locator('#dlg-body [data-ok]');
    if (await ok.count()) await ok.click();
    await page.waitForTimeout(1200);
    const tidied = await info();
    t('closing a tab on purpose ends its shell right away',
      tidied.sessions === 1 && tidied.detached === 0, tidied);
  } finally {
    await page.close();
  }
});

// --- reload: reopening the page reattaches, it does not orphan the shell ---
// A dropped socket detaches for the grace window; a full page reload is different —
// the whole app is torn down and rebuilt. That used to lose the session id (it lived
// only in the page's memory), so the reopened page started a fresh shell and left the
// old one orphaned to die at the grace mark, silently taking the person's work. WinMux
// now saves the live layout with each session id and restores it on load, reconnecting
// by id. The harness reloads the whole page and asks the two questions that matter: is
// it the same one shell with nobody orphaned, and is the work still inside it.
check('reload', PORT_RELOAD, async ({ browser, base, t, shot }) => {
  const info = async () => JSON.parse((await get(base + '/api/info')).body);
  const page = await desktop(browser);
  const screen = () => page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    return r ? r.innerText : '';
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('$mywork = "RELOAD_KEEP"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const before = await info();
    t('a shell is running before the reload',
      before.sessions === 1 && before.detached === 0, before);

    // The whole page, torn down and rebuilt — exactly what used to orphan the shell.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const back = await info();
    t('the reopened page holds the same one shell, nothing orphaned',
      back.sessions === 1 && back.detached === 0, back);

    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('echo $mywork');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const after = await screen();
    t('the work in the shell survived the reload',
      /RELOAD_KEEP/.test(after.split('echo $mywork')[1] || ''));
    t('and it never claimed the session ended', !/session ended/i.test(after));
    await shot(page, 'reload-reattach');
  } finally {
    await page.close();
  }
});

// --- drop: a folder dragged in from Explorer becomes a path ---------------
// Every terminal on Windows lets you type "cd " and drag a folder in. A browser
// refuses to tell a page where a dropped folder lives, so WinMux asks the server
// to find it by name and contents. Two things have to hold or the feature is
// worse than not having it: the right folder wins when two share a name, and a
// drop that misses the pane must not navigate the whole app away.
check('drop', PORT_DROP, async ({ browser, base, t }) => {
  const find = async (name, kids, near) => JSON.parse((await get(base + '/api/findpath' +
    '?name=' + encodeURIComponent(name) +
    '&kids=' + encodeURIComponent((kids || []).join('|')) +
    '&near=' + encodeURIComponent(near || ''))).body).hits;

  const here = __dirname;
  const mine = await find(path.basename(here), fs.readdirSync(here).slice(0, 40));
  t('the folder you dropped is the folder it finds',
    mine.length && mine[0].path.toLowerCase() === here.toLowerCase(), mine[0]);

  // Two folders, same name, different contents — the only thing that can tell
  // them apart is what is inside, which is exactly what the browser hands over.
  const twin = path.join(OUT, 'twin-' + PORT_DROP);
  const right = path.join(twin, 'a', 'ledger');
  const wrong = path.join(twin, 'b', 'ledger');
  fs.mkdirSync(right, { recursive: true });
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(right, 'invoices.txt'), 'x');
  fs.writeFileSync(path.join(wrong, 'something-else.txt'), 'x');
  const picked = await find('ledger', ['invoices.txt'], twin);
  t('contents decide it when two folders share a name',
    picked.length && picked[0].path.toLowerCase() === right.toLowerCase(), picked[0]);

  const none = await find('no-folder-is-called-this-9917', ['a', 'b']);
  t('a folder that is not on this machine comes back empty, not wrong', none.length === 0, none);

  const page = await desktop(browser);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Dragging over a pane has to say something, or the drop looks broken until
    // it works.
    const hint = await page.evaluate(() => {
      const pane = document.querySelector('.pane');
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x.txt'));
      pane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const pv = pane.querySelector('.split-preview');
      return { text: pv ? pv.textContent : '', shown: pv ? pv.style.display : '' };
    });
    t('a folder dragged over a pane is invited in', /Drop to paste/.test(hint.text) && hint.shown === 'flex', hint);

    // The browser's own default for a dropped file is to leave the app and
    // display the file. That would look exactly like a crash.
    const stray = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x.txt'));
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, url: location.href };
    });
    t('a drop that misses the pane does not throw the app away',
      stray.prevented && stray.url.indexOf(':' + PORT_DROP) > 0, stray);
  } finally {
    await page.close();
  }
});

// --- colour: the shell's sixteen colours are ours, and are readable ---------
// This one refuses to take the app's word for it. It runs a real PowerShell
// command that emits real ANSI escapes, then reads the colour off the span
// xterm actually painted — because "we set the option" and "the character on
// screen is that colour" are different claims, and only the second one is what
// @edward looks at.
const rgbToHex = (s) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || '');
  return m ? '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('') : null;
};
const relLum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// PSReadLine paints every command you type in bright yellow (SGR 93) and every
// parameter in bright black (SGR 90) — the exact two slots @edward is looking
// at all day, so those are the two this check reads back off the screen.
const MARKED = 'Write-Host ("{0}[93mQQAQQ{0}[90mQQBQQ{0}[0m" -f [char]27)';

// Walk the row's spans accumulating text, so it does not matter whether xterm
// emitted one span for the run or one per character.
const READ_MARKS = () => {
  const pick = (marker) => {
    for (const row of document.querySelectorAll('.xterm-rows > div')) {
      const spans = [...row.querySelectorAll('span')];
      let acc = '';
      const map = [];
      for (const s of spans) {
        map.push([acc.length, acc.length + s.textContent.length, s]);
        acc += s.textContent;
      }
      // The echoed input line contains the markers too — it is not the output.
      if (acc.includes('Write-Host')) continue;
      const i = acc.indexOf(marker);
      if (i < 0) continue;
      for (const [a, b, s] of map) if (i >= a && i < b) return getComputedStyle(s).color;
    }
    return null;
  };
  const vp = document.querySelector('.xterm-viewport') || document.querySelector('.xterm');
  return { yellow: pick('QQAQQ'), dim: pick('QQBQQ'), bg: getComputedStyle(vp).backgroundColor };
};

async function paintMarks(page, base) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.click('.xterm-screen');
  await page.keyboard.type(MARKED);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  const m = await page.evaluate(READ_MARKS);
  return { yellow: rgbToHex(m.yellow), dim: rgbToHex(m.dim), bg: rgbToHex(m.bg) };
}

check('colour', PORT_COLOUR, async ({ browser, base, t, shot }) => {
  // The palette that used to ship. Nobody chose it: naming no ANSI colours makes
  // xterm.js fall back to Tango, and Tango was drawn for a different background.
  const TANGO_BRIGHT_YELLOW = '#fce94f';
  const TANGO_BRIGHT_BLACK = '#555753';

  const dark = await desktop(browser);
  try {
    const d = await paintMarks(dark, base);
    t('dark: the shell is drawn on the near-black we designed against', d.bg === '#1a1a1a', d);
    t('dark: what you type is no longer Tango\'s #fce94f',
      d.yellow && d.yellow !== TANGO_BRIGHT_YELLOW, d.yellow);
    t('dark: bright yellow is the Aurora sand we chose', d.yellow === '#f2cf88', d.yellow);
    t('dark: parameters are no longer Tango\'s 2.4:1 mud',
      d.dim && d.dim !== TANGO_BRIGHT_BLACK, d.dim);
    t('dark: both clear 4.5:1 against the real background',
      contrast(d.yellow, d.bg) >= 4.5 && contrast(d.dim, d.bg) >= 4.5,
      { yellow: contrast(d.yellow, d.bg).toFixed(2), dim: contrast(d.dim, d.bg).toFixed(2) });
    // The old yellow was not too dim — it was a 14:1 shout. Prove we came down.
    t('dark: the glare is gone (was 14.01:1, a pure saturated yellow)',
      contrast(d.yellow, d.bg) < 12, contrast(d.yellow, d.bg).toFixed(2));
    await shot(dark, 'colour-dark');
  } finally { await dark.close(); }

  // One palette cannot serve both grounds — that is the whole reason there are
  // two. If light mode handed back the dark values, this check has no point.
  const lightPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    const l = await paintMarks(lightPage, base);
    t('light: the shell is drawn on the near-white we designed against', l.bg === '#fbfbfb', l);
    t('light: the colours are a different set, not the dark ones reused', l.yellow !== '#f2cf88', l.yellow);
    t('light: bright yellow is the dark amber that survives white', l.yellow === '#96620f', l.yellow);
    t('light: both clear 4.5:1 — where Tango\'s yellow was 1.20:1, invisible',
      contrast(l.yellow, l.bg) >= 4.5 && contrast(l.dim, l.bg) >= 4.5,
      { yellow: contrast(l.yellow, l.bg).toFixed(2), dim: contrast(l.dim, l.bg).toFixed(2) });
    await shot(lightPage, 'colour-light');
  } finally { await lightPage.close(); }

  // The Settings picker has to actually reach the shell, not just the dropdown.
  const ember = await desktop(browser);
  try {
    await ember.addInitScript(() => {
      localStorage.setItem('ct-settings', JSON.stringify({ palette: 'ember' }));
    });
    const e = await paintMarks(ember, base);
    t('picking a different palette repaints the terminal', e.yellow === '#f5c87c', e.yellow);
    t('every palette clears the floor, not just the default',
      contrast(e.yellow, e.bg) >= 4.5 && contrast(e.dim, e.bg) >= 4.5,
      { yellow: contrast(e.yellow, e.bg).toFixed(2), dim: contrast(e.dim, e.bg).toFixed(2) });
    await shot(ember, 'colour-ember');
  } finally { await ember.close(); }
});

// --- groups: the side is groups, the top is that group's sessions ---------
// The defect this exists to keep fixed: the sidebar shipped as a second copy of
// the tab bar. The design contract has always been two levels — a group row on
// the side owns many terminals, and the top strip shows only the open group's.
// Every assertion below is measured (computed style, counted nodes), never
// eyeballed, because a tab hidden by a `display:none` still looks fine in a shot.

// The sidebar as the DOM actually has it, in one round trip.
const SIDEBAR = () => {
  const rows = [...document.querySelectorAll('#sx-list .prow')].map((r) => ({
    id: r.getAttribute('data-switch'),
    name: r.querySelector('.pname').textContent.trim(),
    sub: r.querySelector('.psub').textContent.trim(),
    active: r.hasAttribute('data-active'),
    open: !!r.querySelector('.pexpand[data-open2]'),
  }));
  // Scoped to the workspace: the changes dock carries a decorative .ptab of its own.
  const tabs = [...document.querySelectorAll('#wsrow .ptabs .ptab')].map((el) => ({
    text: el.querySelector('.tt').textContent.trim(),
    shown: getComputedStyle(el).display !== 'none',
  }));
  return {
    rows,
    count: document.getElementById('sx-count').textContent.trim(),
    view: document.getElementById('root').getAttribute('data-view'),
    tabs,
    shown: tabs.filter((x) => x.shown).length,
    kids: document.querySelectorAll('#sx-list .skids .srow').length,
  };
};

check('groups', PORT_GROUPS, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  // Naming a group goes through a prompt; the harness answers it.
  const answers = ['Client work'];
  p.on('dialog', (d) => d.accept(answers.length ? answers.shift() : ''));
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);

  const first = await p.evaluate(SIDEBAR);
  t('the sidebar opens on one group, not a terminal list', first.rows.length === 1, first.rows);
  t('the header count counts groups', first.count === '1', first.count);
  t('the group row rolls its terminals up into a sub-line',
    /^1 session · /.test(first.rows[0].sub), first.rows[0].sub);
  t('that one group owns the one terminal on top', first.shown === 1, first.tabs);

  // A second group. Its terminals are a different set from the first group's.
  await p.click('#open-newgroup');
  await p.waitForTimeout(1200);
  const two = await p.evaluate(SIDEBAR);
  t('the new group appears on the side', two.rows.length === 2 && two.rows.some((r) => r.name === 'Client work'),
    two.rows.map((r) => r.name));
  t('the header count follows', two.count === '2', two.count);
  t('making a group opens it', (two.rows.find((r) => r.name === 'Client work') || {}).active === true);
  t('the top strip shows exactly the open group — one terminal, not two',
    two.shown === 1 && two.tabs.length === 2, two.tabs);
  await shot(p, 'desktop');

  // Two terminals in this group, so the sub-line has arithmetic to get wrong.
  await p.click('#open-new');
  await p.waitForTimeout(1200);
  const grown = await p.evaluate(SIDEBAR);
  const clientRow = grown.rows.find((r) => r.name === 'Client work');
  t('the sub-line counts this group only', /^2 sessions · /.test(clientRow.sub), clientRow.sub);
  t('and the top strip grew with it', grown.shown === 2, grown.tabs);

  // The chevron peeks into a group. Peeking is not switching.
  const otherId = grown.rows.find((r) => r.name !== 'Client work').id;
  await p.click('.prow[data-switch="' + otherId + '"] .pexpand');
  await p.waitForTimeout(400);
  const peeked = await p.evaluate(SIDEBAR);
  t('the arrow opens that group\'s sessions inline', peeked.kids === 1, peeked.kids);
  t('peeking did NOT switch groups', (peeked.rows.find((r) => r.name === 'Client work') || {}).active === true);
  t('the top strip did not move', peeked.shown === 2, peeked.shown);
  const caret = await p.evaluate((id) => {
    const svg = document.querySelector('.prow[data-switch="' + id + '"] .pexpand svg');
    return getComputedStyle(svg).transform;
  }, otherId);
  // cockpit.css:392 rotates the caret 90°; a right-pointing caret becomes a down one.
  t('the caret is rotated, so it reads as open', caret === 'matrix(0, 1, -1, 0, 0, 0)', caret);
  await shot(p, 'expanded');

  // Clicking the row itself IS switching — the whole two-level model.
  await p.click('.prow[data-switch="' + otherId + '"] .pinfo');
  await p.waitForTimeout(900);
  const swapped = await p.evaluate(SIDEBAR);
  t('clicking a group swaps the top tab strip', swapped.shown === 1, swapped.tabs);
  t('nothing from the other group is left reachable on top',
    swapped.tabs.filter((x) => x.shown).length === 1 && swapped.tabs.length === 3, swapped.tabs);

  // Closing the last terminal of the open group must leave a live shell, not an
  // empty frame and not a pane that eats the other group's terminals.
  await p.click('#wsrow .ptab[data-active] .x');
  await p.waitForTimeout(1200);
  const emptied = await p.evaluate(SIDEBAR);
  t('closing the group\'s last terminal leaves a live one, never a blank pane',
    emptied.shown === 1, emptied.tabs);

  // Names and the open group are the thing that has to survive a reload.
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  const back = await p.evaluate(SIDEBAR);
  t('both groups come back by name after a reload',
    back.rows.length === 2 && back.rows.some((r) => r.name === 'Client work'), back.rows.map((r) => r.name));
  t('and the group that was open is still the open one',
    (back.rows.find((r) => r.id === otherId) || {}).active === true, back.rows);
  await p.close();

  // The phone can only show one level at a time, so it is three screens. This
  // context is a fresh browser — one group, one terminal — so the walk starts at
  // the bottom and climbs, which is exactly the back-arrow chain a phone needs.
  const ph = await phoneCtx(browser);
  const phoneAnswers = ['Phone group'];
  ph.on('dialog', (d) => d.accept(phoneAnswers.length ? phoneAnswers.shift() : ''));
  await ph.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await ph.waitForTimeout(5000);
  t('a phone with one group and one terminal opens straight into the terminal — a list of one costs a pointless tap',
    (await ph.evaluate(SIDEBAR)).view === 'focus');
  await shot(ph, 'phone-terminal');

  // C1 phone header: the back-arrow lives in the brand bar (#nhead-ctx); both the
  // separate .nbar back header and the tab-bar back-arrow are hidden to keep two bars.
  await ph.click('#nhead-ctx');
  await ph.waitForTimeout(600);
  const v2 = await ph.evaluate(SIDEBAR);
  const ns = await ph.evaluate(() => ({
    name: document.getElementById('ns-name').textContent.trim(),
    cards: document.querySelectorAll('#ns-list .ncard[data-open]').length,
    shown: getComputedStyle(document.querySelector('.nsessions')).display,
  }));
  t('back from a terminal lands on that group\'s sessions, not on the groups', v2.view === 'sessions', v2.view);
  t('the sessions screen is actually on screen', ns.shown === 'flex', ns);
  t('it is titled with the group and lists its terminals', ns.name === 'Workspace' && ns.cards === 1, ns);
  await shot(ph, 'phone-sessions');

  await ph.click('#ns-back');
  await ph.waitForTimeout(600);
  t('back again lands on the groups — the top of the phone stack',
    (await ph.evaluate(SIDEBAR)).view === 'projects');

  // A second group, made from the phone, must show up as a second row here.
  await ph.click('#open-newgroup');
  await ph.waitForTimeout(1200);
  const madeIt = await ph.evaluate(() => ({
    view: document.getElementById('root').getAttribute('data-view'),
    name: document.getElementById('ns-name').textContent.trim(),
    cards: document.querySelectorAll('#ns-list .ncard[data-open]').length,
  }));
  t('making a group opens it on its own sessions screen', madeIt.view === 'sessions' && madeIt.name === 'Phone group', madeIt);
  // A new group is never an empty frame — it comes with one live shell, and that
  // shell belongs to the new group, not to the one you just left.
  t('a brand-new group arrives with exactly one live shell of its own', madeIt.cards === 1, madeIt);

  await ph.click('#ns-back');
  await ph.waitForTimeout(600);
  const phRows = await ph.evaluate(SIDEBAR);
  t('the phone group list shows both groups', phRows.rows.length === 2, phRows.rows.map((r) => r.name));
  await shot(ph, 'phone-groups');

  // And the way back down: group → its sessions → a terminal.
  await ph.click('#sx-list .prow[data-switch="1"] .pinfo');
  await ph.waitForTimeout(800);
  t('tapping a group opens its sessions, not a terminal',
    (await ph.evaluate(SIDEBAR)).view === 'sessions');
  await ph.click('#ns-list .ncard[data-open]');
  await ph.waitForTimeout(800);
  t('tapping a session opens the terminal', (await ph.evaluate(SIDEBAR)).view === 'focus');
});

// --- electron: the third face — the desktop shell boots the same cockpit ----
// The other checks prove the web/phone face over a socket. This one proves the
// Electron face: the app boots server.cjs IN-PROCESS, loads the same cockpit in
// a frameless native window, and the window.winmux bridge is really injected.
// Playwright's _electron launcher hangs on the CDP handshake in this environment,
// so the shell is driven directly — electron runs dist-electron/main.js in
// WINMUX_SMOKE mode, which self-checks the rendered page, writes a JSON verdict
// plus verify-out/electron-shell.png, and quits. This check reads that verdict.
// It ignores `base`/`browser`: the Electron app is its own server and its own
// client, which is the whole point of the third face.
check('electron', PORT_GROUPS, async ({ t }) => {
  const main = path.join(ROOT, 'dist-electron', 'main.js');
  if (!fs.existsSync(main)) {
    t('the Electron bundle is built (npm run build:electron)', false, main);
    return;
  }
  let electronPath = null;
  try { electronPath = require('electron'); } catch (e) { /* not installed */ }
  if (typeof electronPath === 'string') electronPath = electronPath.trim();
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    t('the Electron binary is present', false, electronPath);
    return;
  }

  const outFile = path.join(OUT, 'electron-smoke.json');
  try { fs.unlinkSync(outFile); } catch (e) { /* fresh */ }

  const res = await new Promise((resolve) => {
    const proc = spawn(electronPath, [main], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { WINMUX_SMOKE: '1', WINMUX_SMOKE_OUT: outFile }),
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      resolve({ code: null, timedOut: true });
    }, 60000);
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: null, timedOut: false, err: String(e.message || e) }); });
  });
  t('the Electron app launched and exited on its own', res.timedOut === false && !res.err, res);

  let json = null;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* stays null */ }
  t('the shell wrote a smoke verdict', !!json, json);
  t('the cockpit rendered inside the native window', !!json && json.hasCockpit === true, json);
  t('the window.winmux bridge is injected', !!json && json.isElectron === true, json);
  t('the document is tagged data-electron', !!json && json.dataElectron === true, json);
  t('the frameless tab bar resolves to a real drag handle',
    !!json && json.ptabsRegion === 'drag', json && json.ptabsRegion);
  t('the smoke run hit no error', !!json && !json.error, json && json.error);

  // The Electron-only feature (Phase 10): a controllable <webview> browser panel,
  // driven through the real /rpc → /control chain that the `winmux` CLI uses.
  // The smoke run opened a data: page, snapshotted its interactive nodes, and
  // clicked one — proving the panel navigates and is scriptable, not just mounted.
  t('the browser panel opened a page over /rpc', !!json && json.browserOpened === true, json && json.browserError);
  t('the snapshot tagged the page\'s interactive elements as @refs',
    !!json && json.browserRefs >= 2, json && json.browserRefs);
  t('a snapshotted element was clickable through the CLI path',
    !!json && json.browserClicked === true, json && json.browserError);
});

// --- cli: the `winmux` command-line drives the live app -------------------
// The CLI POSTs /rpc, which forwards over /control to a connected app. So this
// check IS the app: a real headless page connected to /control, then the CLI is
// run as a child process and must make that page do things. The instance file
// is pointed at THIS check's server so the CLI targets it, not @edward's live one.
check('cli', PORT_CLI, async ({ browser, base, t, shot }) => {
  // Target THIS check's server directly via WINMUX_PORT — never the shared
  // instance file, which the harness's many servers would race over (and which
  // is @edward's real running app's file).
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_CLI), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);          // the app connects to /control

  const list1 = await winmux(['list', '--json']);
  const p1 = parse(list1.out);
  t('list reaches the live app', list1.code === 0 && p1 && Array.isArray(p1.sessions), { code: list1.code, err: list1.err });
  t('the app reports its starting terminal', p1 && p1.sessions.length >= 1, p1 && p1.sessions.length);

  const marker = 'CLI_OK_' + PORT_CLI;
  const sent = await winmux(['send', '"' + marker + '"', '--enter']);
  t('send exits clean', sent.code === 0, sent.err);
  await page.waitForTimeout(3000);
  const rd = await winmux(['read-screen', '--lines', '60']);
  t('read-screen shows what send ran', rd.code === 0 && rd.out.indexOf(marker) >= 0, rd.out.slice(-160));

  const before = p1 ? p1.sessions.length : 0;
  await winmux(['new-tab']);
  await page.waitForTimeout(1500);
  const p2 = parse((await winmux(['list', '--json'])).out);
  t('new-tab adds a terminal the app can see', p2 && p2.sessions.length === before + 1, { before, after: p2 && p2.sessions.length });
  await shot(page, 'cli-drove-it');

  // With no app open the CLI must fail clearly and fast, never hang.
  await page.close();
  await new Promise((r) => setTimeout(r, 800));
  const orphan = await winmux(['list']);
  t('with no app open the CLI fails clearly, fast', orphan.code !== 0 && /no app connected/i.test(orphan.err), orphan.err);
});

// --- markdown: the viewer surface renders a file and follows its edits ------
// `winmux markdown <file>` opens a read surface in the app. The server reads the
// file (/api/md), the app renders a tiny markdown subset, and it re-pulls on a
// timer so a file the agent is writing updates live. This check drives the real
// CLI path (like `cli`) and then edits the file on disk to prove the live pull.
check('markdown', PORT_MD, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_MD), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  // The file the viewer will show — written where the server can read it.
  const mdFile = path.join(OUT, 'md-' + PORT_MD + '.md');
  fs.writeFileSync(mdFile, '# Hello WinMux\n\nThis is **bold** and `code`.\n\n- one\n- two\n');

  // The server side on its own: /api/md reads the file and hands back its text.
  const api = JSON.parse((await get(base + '/api/md?path=' + encodeURIComponent(mdFile))).body);
  t('/api/md reads the file and returns its text', api.ok === true && /Hello WinMux/.test(api.text), { ok: api.ok });
  const missing = JSON.parse((await get(base + '/api/md?path=' + encodeURIComponent(mdFile + '.nope'))).body);
  t('/api/md fails cleanly on a file that is not there', missing.ok === false && !!missing.error, missing.error);

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);          // the app connects to /control

  const opened = await winmux(['markdown', mdFile]);
  t('winmux markdown exits clean', opened.code === 0, opened.err);
  await page.waitForTimeout(1500);

  const rendered = await page.evaluate(() => {
    const e = document.querySelector('.wmm[data-open] .wmm-body');
    if (!e) return null;
    return {
      h1: (e.querySelector('h1') || {}).textContent,
      strong: !!e.querySelector('strong'),
      code: !!e.querySelector('code'),
      li: e.querySelectorAll('li').length,
      title: (document.querySelector('.wmm-title') || {}).textContent,
    };
  });
  t('the viewer surface opened and rendered the markdown',
    !!rendered && rendered.h1 === 'Hello WinMux' && rendered.strong && rendered.code && rendered.li === 2, rendered);
  t('the surface is titled with the file name', !!rendered && /md-\d+\.md$/.test(String(rendered.title)), rendered && rendered.title);
  await shot(page, 'markdown');

  // Live update: the agent rewrites the file; the surface must follow it without
  // a reopen. This is the whole point of a viewer over `cat`.
  fs.writeFileSync(mdFile, '# Changed Title\n\nNew body.\n');
  await page.waitForTimeout(2200);
  const after = await page.evaluate(() => {
    const h = document.querySelector('.wmm[data-open] .wmm-body h1');
    return h ? h.textContent : null;
  });
  t('editing the file live-updates the open surface', after === 'Changed Title', after);
  await page.close();
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
  const servers = SERVERS;
  // Wipe each port's guest list BEFORE its first server, and only there — a
  // check that restarts its own server must find the file it left behind, which
  // is the whole point of "a scanned phone survives a restart".
  for (const port of ports) try { fs.unlinkSync(trustFile(port)); } catch (e) {}
  for (const port of ports) servers[port] = await server(port);
  for (const port of ports) {
    console.log((servers[port].borrowed ? 'using the server already on ' : 'started a server on ') + port);
  }

  // Manufacture the port collision the failure checks exist for, once, before
  // any of them run. Only when one of them is actually in this run — otherwise
  // it is a socket held for nothing.
  if (run.some((c) => c.id === 'busyport' || c.id === 'reason')) {
    busyHold = await holdTailnet(PORT_BUSY);
    console.log(busyHold
      ? 'holding ' + busyHold.ip + ':' + PORT_BUSY + ' so a phone flip has something real to fail against'
      : 'could not hold the tailnet side of ' + PORT_BUSY + ' — the failure checks will skip');
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
  if (busyHold) busyHold.stop();
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
