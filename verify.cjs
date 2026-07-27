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
    env: Object.assign({}, process.env, { PORT: String(port), WINMUX_TRUST_FILE: trustFile(port) }),
    stdio: 'ignore',
  });
  await waitUp(port, 15000);
  return { port, borrowed: false, stop() { try { proc.kill(); } catch (e) {} } };
}

// Start a server with NO port forced, and read back the port it chose for
// itself. Never borrows a running server — the choice IS the thing under test.
function serverAuto() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { WINMUX_TRUST_FILE: trustFile('auto') });
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
    await p.waitForTimeout(1500);
    await p.locator('.xterm-helper-textarea').first().focus();
    await p.keyboard.type('"after forget " + $env:COMPUTERNAME');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(3000);
    const stillTalking = await p.evaluate(() =>
      [].map.call(document.querySelectorAll('.xterm-rows > div'), (d2) => d2.textContent.trim())
        .some((r) => /after forget \w/i.test(r)));
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
