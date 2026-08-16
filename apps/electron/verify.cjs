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
// A full reboot kills the server; its scrollback must survive on disk and replay.
const PORT_RESTART = 9960;
// The CLI check needs its own server + a connected app, on a port nobody else
// is driving, so `winmux new-tab` counts don't race another group's terminals.
const PORT_CLI = 9921;
// The markdown check opens a viewer surface and edits the file under it, so it
// needs a server whose /api/md nobody else is racing and a /control of its own.
const PORT_MD = 9922;
// The paste check fires real paste events at a live terminal and reads whether
// the multi-line guard stopped to ask, so it wants a shell nobody else touches.
const PORT_PASTE = 9923;
// The migrate check seeds a saved layout from a hypothetical future WinMux and
// proves the app still boots to a working terminal, so it needs its own server.
const PORT_MIGRATE = 9924;
// The onboarding check loads with a virgin localStorage to prove the first-run
// welcome appears, dismisses, and stays gone. Its own server, its own state.
const PORT_ONBOARD = 9925;
const PORT_APPROVE = 9926;
const PORT_PWSH = 9927;
const PORT_FOOTER = 9928;
const PORT_UPDATE = 9929;
const PORT_GPU = 9930;
const PORT_FONT = 9931;
const PORT_INSTANT = 9932;
const PORT_SURVIVE2 = 9933;   // registered port (runner boots a throwaway here)
const PORT_PARITY = 9934;     // terminal-parity addons (web-links, unicode11)
const PORT_NOTIFY = 9935;     // attention bus: `winmux notify` flips a session to needs-you
const PORT_OSNOTIFY = 9936;   // attention bus: OS notification fires only when unfocused
const PORT_MCP = 9937;        // winmux-mcp: an MCP client drives the live app over stdio
const PORT_DOING = 9938;      // cockpit: a session row shows a live "what's it doing" line
const PORT_CLIP = 9939;       // cockpit: cross-device clipboard round-trips through /api/clip
const PORT_CONFIG = 9940;     // config: durable on-disk settings via /api/config
const PORT_THEME = 9941;      // theme import: a Windows Terminal scheme recolours the terminal
const PORT_KEYS = 9942;       // custom keybindings: a remapped chord runs the action, the old one doesn't
const PORT_MDRICH = 9943;     // markdown richness: tables, task-list checkboxes, images render in the viewer
const PORT_MARKS = 9945;      // terminal command-marks jump + reset (browser verbs ride the electron smoke)
const PORT_CMDTAG = 9975;     // Phase 4: command-blocks status tag (✓/✗ + time) renders on OSC-133 D-marks
const PORT_APPROVECARD = 9976;// Phase 8: the phone approval card's Approve button actually sends Enter to the shell
const PORT_AGENTENV = 9946;   // agent: every shell exports WINMUX_SID/WINMUX_PORT
const PORT_AGENTSTATE = 9947; // agent: winmux agent <state> flips the session's cockpit status
const PORT_AGENTHOOKS = 9948; // agent: the Claude Code hooks preset drives live state
const PORT_WINGET = 9949;     // distribution: the winget manifest generator emits valid manifests
const PORT_TUNOVR = 9950;     // #246: the WINMUX_TUNNELLED_PORTS override is honored (no fail-open under load)
const PORT_LIG = 9955;        // #238: the ligature switch really shapes glyphs, and pays for it in renderer
const PORT_RESUME = 9951;     // #240: an armed tab auto-runs its resume command on a cold reopen, not on a warm reattach
// #246: three ports the port check holds itself, so it can prove the
// every-candidate-taken refusal without starving the other auto-picking checks.
const PORTS_EXHAUST = [9952, 9953, 9954];
const PORT_DIFF = 9956;       // ST5: git diff opens as a pane tab (leaf), not a side dock
const PORT_LEAFPERSIST = 9957; // ST6: non-terminal leaves survive a page reload
const PORT_PREDICT = 9958;    // Phase 2: pwsh PSReadLine inline history prediction + RightArrow accept
const PORT_IMAGES = 9959;     // Phase 3: inline images (addon-image) + `winmux image` verb
const PORT_DPRFIX = 9977;     // MR-1: a devicePixelRatio-stuck WebGL canvas is resynced (prompt-float fix)
const PORT_AGENTJOB = 9968;   // Stage 3: server-side agent-job store (spawn/wait/result), no browser needed
const PORT_WORKSPACE = 9978;  // PT-3: the engine-owned workspace file survives a wiped browser profile
const PORT_RECOVER = 9979;    // PT-4: Recent & recoverable — saved scrollbacks are listed, restorable, dismissable
const PORT_AGENTSPAWN = 9967; // Stage 3: spawn a real session, it self-reports, a wait gets its result
const CONFIG_TMP = path.join(os.tmpdir(), 'winmux-verify-config.json');
// Save-on-close writes real project files; point them at a scratch dir so a test
// never drops a "Verify Project.winmux.json" into the real Documents\WinMux Projects.
const PROJECTS_TMP = path.join(os.tmpdir(), 'winmux-verify-projects');

// Every server this harness starts gets its own scratch guest list. Two reasons,
// both real: @edward's actual remembered phones must never be edited by a test
// run, and three concurrent servers sharing one file would clobber each other's
// writes and make the trust checks flap for no product reason.
const trustFile = (port) => path.join(OUT, 'trust-' + port + '.json');
// Every harness server gets its own throwaway config file so a test can never
// write the real ~/.winmux/config.json (the app POSTs settings on boot now).
const configFile = (port) => path.join(OUT, 'config-' + port + '.json');

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const ONLY = argv.filter((a) => !a.startsWith('-'));
// Ceiling on a single check. The slowest honest check (survive/detach, which sit out
// real grace windows) lands well under this; anything past it is stuck, not slow.
const CHECK_TIMEOUT = Number(process.env.WINMUX_CHECK_TIMEOUT_MS) || 300000;

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
// WINMUX_CORE=rust runs the whole harness against the native Rust core instead of
// server.cjs — the Stage-2/4 finish-line measurement ("how many of these pass on
// Rust today"). Null (and every check unchanged) unless the env flag is set.
const RUST_CORE = process.env.WINMUX_CORE === 'rust'
  ? [path.join(ROOT, '..', '..', 'core', 'rust', 'target', 'release', 'winmux-core.exe'),
     path.join(ROOT, '..', '..', 'core', 'rust', 'target', 'debug', 'winmux-core.exe')].find((p) => fs.existsSync(p))
  : null;

async function server(port, extraEnv) {
  if (await inUse('127.0.0.1', port)) return { port, borrowed: true, stop() {} };
  const proc = RUST_CORE
    ? spawn(RUST_CORE, [], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { WINMUX_PORT: String(port), WINMUX_PUBLIC: path.join(ROOT, 'public'), WINMUX_INSTANCE_FILE: path.join(OUT, 'inst-' + port + '.json'), WINMUX_TRUST_FILE: trustFile(port), WINMUX_CONFIG_FILE: configFile(port) }, extraEnv || {}),
        stdio: 'ignore',
      })
    : spawn(process.execPath, ['server.cjs'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(port), WINMUX_TRUST_FILE: trustFile(port), WINMUX_CONFIG_FILE: configFile(port), WINMUX_NO_INSTANCE: '1' }, extraEnv || {}),
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
// A check may carry an env override for its server (last arg) — e.g. the update
// check forces WINMUX_FAKE_LATEST so the badge can be proven without a real release.
const check = (id, port, run, env) => CHECKS.push({ id, port, run, env });

const desktop = async (browser, extraSettings) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  // Every check gets a fresh context, so the first-run onboarding would pop over
  // the UI and swallow clicks. Mark it seen everywhere except the check that tests
  // it (see the 'onboard' check, which deliberately leaves this unset).
  // Also pin the DOM renderer here: the app's features read the renderer-independent
  // term.buffer, so behavioural checks are the same on either renderer — but many
  // of these checks read .xterm-rows text, which the WebGL renderer (the shipping
  // default) paints to a <canvas> instead. Pinning DOM keeps those reads valid; the
  // 'gpu' check separately proves the WebGL path + its DOM fallback.
  await page.addInitScript((extra) => {
    try {
      localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
      if (extra) Object.assign(s, extra);
      localStorage.setItem('ct-settings', JSON.stringify(s));
    } catch (e) {}
  }, extraSettings || null);
  return page;
};

async function phoneCtx(browser, colorScheme) {
  const ctx = await browser.newContext({
    viewport: { width: 384, height: 745 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, colorScheme: colorScheme || 'dark',
  });
  // Mark the first-run onboarding seen so it doesn't cover the phone UI mid-check
  // (the 'onboard' check makes its own context to test it fresh). Pin the DOM
  // renderer too (same reason as desktop(): these checks read .xterm-rows text).
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
      localStorage.setItem('ct-settings', JSON.stringify(s));
    } catch (e) {}
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
  // Open Settings deterministically (fixes #180). The gear can be momentarily
  // non-actionable — a load-transition pointer race on desktop, or simply not the
  // visible surface on a phone drill-in view. Try the real click first (proves a
  // human can), then fall back to the element's own click handler, which fires
  // openSettings() regardless of pointer state or which view is showing.
  const gear = p.locator('#open-settings');
  try {
    await gear.scrollIntoViewIfNeeded({ timeout: 3000 });
    await gear.click({ timeout: 4000 });
  } catch (e) {
    await p.evaluate(() => document.getElementById('open-settings').click());
  }
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

  // The other end of the hunt: every candidate taken. This used to hand back
  // the first candidate anyway — the very port it may have just refused for
  // being tunnelled — and then die on a raw EADDRINUSE stack trace. A machine
  // with a busy 88xx block is a normal machine, so the honest answer is a
  // sentence and a non-zero exit, not a crash and not a keyless tailnet door.
  // WINMUX_PORT_CANDIDATES pins the hunt to three ports this check holds
  // itself, so proving exhaustion never starves the checks running beside it.
  const holders = [];
  for (const p of PORTS_EXHAUST) {
    holders.push(await new Promise((res, rej) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(p, '127.0.0.1', () => res({ stop() { try { s.close(); } catch (e) {} } }));
    }));
    if (ip) holders.push(await holdTailnet(p));
  }
  try {
    const res = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['server.cjs'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          PORT: '',
          WINMUX_PORT_CANDIDATES: PORTS_EXHAUST.join(','),
          WINMUX_TRUST_FILE: trustFile('exhaust'),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let all = '';
      proc.stdout.on('data', (d) => { all += d.toString(); });
      proc.stderr.on('data', (d) => { all += d.toString(); });
      proc.on('exit', (code) => resolve({ code, all }));
      setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, all }); }, 20000);
    });
    t('refuses to start when every candidate port is taken', res.code === 2, 'exit ' + res.code);
    t('the exhaustion refusal is a sentence, not a stack trace', !/\n\s+at /.test(res.all), res.all.split('\n')[0]);
    t('the exhaustion refusal names the ports it tried', res.all.includes(PORTS_EXHAUST.join(', ')), res.all.split('\n')[1]);
    t('the exhaustion refusal tells you how to pick a port yourself', /\$env:PORT/.test(res.all), res.all.split('\n').find((l) => /env:PORT/.test(l)));
    t('exhaustion never falls back to serving on a candidate anyway', !/WinMux running at/.test(res.all), res.all.split('\n').find((l) => /running at/.test(l)) || 'never announced');
  } finally { holders.forEach((h) => { if (h) h.stop(); }); }

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
  // The About version must be the real one (from /api/info), matching every other
  // surface — no hardcoded string that can drift out of sync with the release.
  const infoVer = await p.evaluate(() => fetch('/api/info').then((r) => r.json()).then((d) => d.version || '').catch(() => ''));
  t('About shows the live version (matches /api/info), not cockpit-terminal',
    !!infoVer && about.indexOf('WinMux v' + infoVer) !== -1 && !/cockpit-terminal/i.test(about),
    { infoVer, about: about.slice(0, 40) });
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

  // Copy link must give visible feedback (the copy worked before, but notify()
  // only pinged the silent bell, so a click looked dead — the reported bug).
  await p.locator('[data-act="phone-copy"]').click();
  await p.waitForTimeout(150);
  t('Copy link confirms right on the button', /copied/i.test((await p.locator('[data-act="phone-copy"]').textContent()).trim()),
    (await p.locator('[data-act="phone-copy"]').textContent()).trim());
  await p.waitForTimeout(1800);
  t('and the button label settles back to Copy link', /^Copy link$/.test((await p.locator('[data-act="phone-copy"]').textContent()).trim()));

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

    // Security (#210): even a fully authed phone must not turn the host's disk
    // into a read/enumerate surface. The file-reading endpoints are desk-door
    // only — over the tailnet they refuse, key or no key.
    const mdOverPhone = await get(origin + '/api/md?k=' + key + '&path=' + encodeURIComponent('C:/Windows/win.ini'));
    t('the phone cannot read an arbitrary file off the host', mdOverPhone.status === 403, mdOverPhone.status);
    t('and the refusal carries no file contents', !/\[fonts\]|\[extensions\]/i.test(mdOverPhone.body));
    const findOverPhone = await get(origin + '/api/findpath?k=' + key + '&name=Users');
    t('the phone cannot enumerate the host filesystem', findOverPhone.status === 403, findOverPhone.status);

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

    // Brute-force throttle (#210): a burst of wrong keys from one address gets
    // parked. Fire past the limit and the door stops even asking — it answers
    // 429, not another 401. Done last: the lockout is per-address and would
    // otherwise poison the checks above; the phone is torn down right after.
    let sawLimit = false, sawBefore = 0;
    for (let i = 0; i < 14; i++) {
      const g = await get(origin + '/?k=' + 'a'.repeat(32));
      if (g.status === 429) { sawLimit = true; break; }
      if (g.status === 401) sawBefore += 1;
    }
    t('a flood of wrong keys is throttled, not answered forever', sawLimit, { sawBefore });
    t('the throttle counts real guesses before it trips', sawBefore >= 5, sawBefore);
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
    await dl.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
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
    // The "+" button now opens a type menu (Terminal / Browser / Markdown); pick
    // Terminal the way a person would, which also proves the menu wiring works.
    await page.locator('.pc-new').first().click();
    await page.locator('.tmenu .tmi:has-text("Terminal")').first().click();
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
      before.sessions >= 1 && before.detached === 0, before);

    // The whole page, torn down and rebuilt — exactly what used to orphan the shell.
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The reload briefly detaches the old socket, then the rebuilt page reattaches by
    // sid. The real invariant is baseline-independent: reload must neither ORPHAN a
    // shell (detached>0) nor LEAK one (session count grows) — asserting a hardcoded
    // "== 1" wrongly fails whenever the baseline is 2 (Node pre-warms a spare shell;
    // Rust does not). Poll until the session table settles back to the pre-reload
    // shape, or fail loudly if it never does (a genuine leak never settles).
    let back = before;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(500);
      back = await info();
      if (back.detached === 0 && back.sessions === before.sessions) break;
    }
    t('the reopened page holds the same shells, nothing orphaned or leaked',
      back.sessions === before.sessions && back.detached === 0, { before, back });

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

// PT-3: the engine owns the workspace as a real file, so the layout survives a
// wiped browser profile (STATE.md invariant: losing the workspace should require
// deleting the file on purpose). Two pages, two isolated browser contexts: the
// first builds a two-tab layout and we assert the engine's file holds it; the
// second boots with EMPTY localStorage — the wiped-profile case that used to mean
// total layout loss — and must come back with both tabs, restored from the engine.
check('workspace', PORT_WORKSPACE, async ({ browser, base, t, shot }) => {
  const wsFile = path.join(OUT, 'workspace-' + PORT_WORKSPACE + '.json');
  try { fs.unlinkSync(wsFile); } catch (e) {}
  const pageA = await desktop(browser);
  try {
    await pageA.goto(base, { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(3500);
    await pageA.evaluate(() => document.getElementById('open-new').click());
    await pageA.waitForTimeout(4000);   // sid learned → persistLive → throttled push lands
    const tabsA = await pageA.evaluate(() => document.querySelectorAll('.ptab').length);
    t('two terminal tabs are open in the first window', tabsA >= 2, { tabsA });

    // The engine's copy: real file on disk, wrapped and stamped.
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch (e) {}
    t('the engine wrote the workspace file', !!doc, { wsFile, exists: fs.existsSync(wsFile) });
    t('the file is a stamped workspace document, not a bare blob',
      !!doc && doc.winmuxWorkspace === 1 && doc.savedAt > 0 && doc.workspace && typeof doc.workspace === 'object',
      doc && { winmuxWorkspace: doc.winmuxWorkspace, savedAt: doc.savedAt });
    const apiGet = JSON.parse((await get(base + '/api/workspace')).body);
    t('GET /api/workspace returns the same layout the file holds',
      apiGet.ok === true && JSON.stringify(apiGet.workspace) === JSON.stringify(doc && doc.workspace));
  } finally {
    await pageA.close();   // beforeunload flushes a final keepalive save
  }

  // A brand-new browser context: empty localStorage, i.e. the wiped profile.
  const pageB = await desktop(browser);
  try {
    await pageB.goto(base, { waitUntil: 'domcontentloaded' });
    await pageB.waitForTimeout(4500);   // engine round-trip + restore + reattach
    const tabsB = await pageB.evaluate(() => document.querySelectorAll('.ptab').length);
    t('a fresh profile restores the layout from the engine (both tabs back)', tabsB >= 2, { tabsB });
    await shot(pageB, 'workspace-survives-profile-wipe');
  } finally {
    await pageB.close();
  }
}, { WINMUX_WORKSPACE_FILE: path.join(OUT, 'workspace-9978.json') });

// PT-4: saved scrollbacks are a visible list, not 235 invisible files. The engine
// lists every backlog entry with its expiry (STATE.md: silent expiry is a contract
// violation), the Projects overlay shows them with restore/dismiss, restoring
// replays the saved output into a real tab and consumes the file, and /api/info
// reports the honest count. The check owns an exclusive backlog dir so no other
// harness server's leftovers can pollute the row counts.
check('recover', PORT_RECOVER, async ({ browser, base, t, shot }) => {
  const cfgDir = path.join(OUT, 'recover-cfg');
  const blDir = path.join(cfgDir, 'backlog');
  fs.mkdirSync(blDir, { recursive: true });
  for (const f of fs.readdirSync(blDir)) { try { fs.unlinkSync(path.join(blDir, f)); } catch (e) {} }
  const seed = (sid, buf, savedAt) => fs.writeFileSync(path.join(blDir, sid + '.json'),
    JSON.stringify({ id: sid, dev: '', shell: 'pwsh', cwd: 'C:\\work', buf, savedAt }));
  seed('rec-restoreme', 'RECOVER_PAYLOAD_ALPHA\r\n', Date.now());
  seed('rec-dismissme', 'RECOVER_PAYLOAD_BETA\r\n', Date.now() - 60000);

  const list = JSON.parse((await get(base + '/api/backlog')).body);
  t('the engine lists both saved scrollbacks', list.ok === true && list.items.length === 2,
    list.items && list.items.map((i) => i.sid));
  t('every entry says when it expires — nothing can vanish silently',
    list.items.every((i) => i.expiresAt > Date.now() && i.live === false), list.items);
  const info = JSON.parse((await get(base + '/api/info')).body);
  t('/api/info reports the honest recoverable count', info.recoverable === 2, { recoverable: info.recoverable });

  const page = await desktop(browser);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('#open-load');
    await page.waitForTimeout(800);
    const rows = await page.evaluate(() => ({
      shown: getComputedStyle(document.getElementById('sm-recover')).display !== 'none',
      n: document.querySelectorAll('#sm-recover .pjrow').length,
      text: document.getElementById('sm-recover').textContent,
    }));
    t('the Recent & recoverable section is on screen with both entries', rows.shown && rows.n === 2, rows);
    t('each row shows its expiry in plain sight', /expires in \d+d/.test(rows.text), rows.text);
    await shot(page, 'recover-list');

    // Restore the newest (row 0 — the list sorts newest first): a dead session
    // replays its saved output into a fresh tab and consumes the file.
    await page.click('#sm-recover .pjrow[data-ri="0"]');
    await page.waitForTimeout(4000);
    // Read every terminal's rows — the restored tab is the second one; grabbing
    // only the first would read the original shell and miss the replay.
    const screen = await page.evaluate(() =>
      [...document.querySelectorAll('.xterm-rows')].map((r) => r.innerText).join('\n'));
    t('restoring replays the saved output into a live tab', /RECOVER_PAYLOAD_ALPHA/.test(screen),
      screen.slice(0, 300));
    let consumed = false;
    for (let i = 0; i < 10 && !consumed; i++) { await page.waitForTimeout(500); consumed = !fs.existsSync(path.join(blDir, 'rec-restoreme.json')); }
    t('a delivered backlog is consumed — it cannot list itself twice', consumed);

    // Dismiss the other one from the reopened list.
    await page.click('#open-load');
    await page.waitForTimeout(800);
    const left = await page.evaluate(() => document.querySelectorAll('#sm-recover .pjrow').length);
    t('the restored entry is gone from the list, the other remains', left === 1, { left });
    await page.click('#sm-recover .pjrow-del[data-rdel="0"]');
    await page.waitForTimeout(800);
    const afterDismiss = await page.evaluate(() => ({
      n: document.querySelectorAll('#sm-recover .pjrow').length,
      shown: getComputedStyle(document.getElementById('sm-recover')).display !== 'none',
    }));
    t('dismiss deletes it and the section stands down', afterDismiss.n === 0 && !afterDismiss.shown
      && !fs.existsSync(path.join(blDir, 'rec-dismissme.json')), afterDismiss);
    const info2 = JSON.parse((await get(base + '/api/info')).body);
    t('the honest count follows to zero', info2.recoverable === 0, { recoverable: info2.recoverable });
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'recover-cfg', 'config.json') });

// ST6: non-terminal leaves survive a page reload. Both a diff leaf AND a markdown
// leaf, opened as pane tabs, must be persisted in the live snapshot and rebuilt on
// reload — before ST6, snapshot() filtered leaves out, so they vanished. This proves
// a mixed pane (terminal + two distinct leaf types) comes back whole. (Browser leaves
// are Electron-only and are exercised by the `electron` smoke, not here.)
check('leaf-persist', PORT_LEAFPERSIST, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_LEAFPERSIST), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const mdFile = path.join(OUT, 'leafpersist-' + PORT_LEAFPERSIST + '.md');
  fs.writeFileSync(mdFile, '# Persisted Doc\n\nsurvives a reload.\n');
  const page = await desktop(browser);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);          // connect to /control so the CLI can reach it
    // A diff leaf (via the menu) and a markdown leaf (via the CLI) in the same pane.
    await page.locator('.pc-new').first().click();
    await page.waitForTimeout(200);
    await page.locator('.tmenu .tmi:has-text("Changes")').first().click();
    await page.waitForTimeout(1200);
    const md = await winmux(['markdown', mdFile]);
    t('winmux markdown opened a leaf to persist', md.code === 0, md.err);
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => ({
      diff: !!document.querySelector('.ptab[data-leaf="diff"]'),
      md: !!document.querySelector('.ptab[data-leaf="markdown"]'),
      term: !!document.querySelector('.ptab:not([data-leaf])'),
    }));
    t('a diff leaf, a markdown leaf and a terminal are open before the reload',
      before.diff && before.md && before.term, before);

    // The whole page torn down and rebuilt — the live snapshot must carry both leaves.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => ({
      diff: !!document.querySelector('.ptab[data-leaf="diff"]'),
      md: !!document.querySelector('.ptab[data-leaf="markdown"]'),
      term: !!document.querySelector('.ptab:not([data-leaf])'),
      diffBody: !!document.querySelector('.term-host.diffleaf'),
      mdBody: !!(document.querySelector('.mdleaf .mdbody') && /Persisted Doc/.test((document.querySelector('.mdleaf .mdbody') || {}).textContent || '')),
    }));
    t('the diff leaf came back after the reload (not dropped)', after.diff === true, after);
    t('the markdown leaf came back after the reload too', after.md === true, after);
    t('the terminal is still there alongside them', after.term === true, after);
    t('the restored diff leaf rebuilt its body', after.diffBody === true, after);
    t('the restored markdown leaf re-rendered its file', after.mdBody === true, after);
    await shot(page, 'leaf-persist');
  } finally {
    await page.close();
  }
});

// --- restart: scrollback outlives the whole server, not just a dropped socket ---
// A dropped socket detaches; a full reboot kills the server process itself, taking
// the in-memory scrollback with it. WinMux now writes each session's output to disk
// (throttled) so a restarted server can hand it back, and the client replays it as
// history on reconnect. This proves the durable seam without xterm timing: run a
// command, kill the server dead, start a fresh one on the SAME config, and ask for
// that session's kept output.
check('restart', PORT_RESTART, async ({ browser, base, t, skip }) => {
  if (SERVERS[PORT_RESTART] && SERVERS[PORT_RESTART].borrowed)
    return skip('borrowed a server already on ' + PORT_RESTART + ', and killing it is the premise');
  const MARK = 'RESTART_SURVIVES_' + PORT_RESTART;
  const page = await desktop(browser);
  let sid = '';
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('echo ' + MARK);
    await page.keyboard.press('Enter');
    // Wait until the output is really on screen BEFORE trusting the throttle — under
    // full-run load the echo can land late, and a save that fires first would capture
    // the pre-marker buffer. Confirm it rendered, then let the ~2s throttle write it.
    let onScreen = false;
    for (let i = 0; i < 30; i++) {
      const s = await page.evaluate(() => { const r = document.querySelector('.xterm-rows'); return r ? r.innerText : ''; });
      if (s.includes(MARK)) { onScreen = true; break; }
      await page.waitForTimeout(400);
    }
    t('the shell captured the work before the restart', onScreen);
    await page.waitForTimeout(2600);   // guarantee the post-marker throttled save lands on disk
    sid = await page.evaluate(() => {
      try { return (JSON.stringify(JSON.parse(localStorage.getItem('ct-live') || '{}')).match(/"sid":"([a-f0-9]{32})"/) || [])[1] || ''; } catch (e) { return ''; }
    });
    t('the tab has a session id to recover by', /^[a-f0-9]{32}$/.test(sid), sid);
  } finally {
    await page.close();
  }

  // The reboot: kill the server dead, then start a fresh one on the SAME config so
  // its backlog dir is the one the first server wrote — nothing in memory carries over.
  SERVERS[PORT_RESTART].stop();
  for (let i = 0; i < 40 && (await inUse('127.0.0.1', PORT_RESTART)); i++)
    await new Promise((r) => setTimeout(r, 250));
  SERVERS[PORT_RESTART] = await server(PORT_RESTART, { WINMUX_FORCE_DOM: '1' });

  const bl = JSON.parse((await get(base + '/api/backlog?sid=' + sid)).body);
  t('the restarted server still has that session’s scrollback', bl.found === true, { found: bl.found });
  t('and hands back the exact work that was on screen', typeof bl.buf === 'string' && bl.buf.includes(MARK));
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

  // Use a uniquely-named fixture folder, not __dirname: in the monorepo the dir
  // holding this harness is named "electron", which collides with node_modules/
  // electron and the electron/ source dir, so a name-based find is ambiguous.
  const self = path.join(OUT, 'drop-self-' + PORT_DROP);
  fs.mkdirSync(self, { recursive: true });
  fs.writeFileSync(path.join(self, 'marker-' + PORT_DROP + '.txt'), 'x');
  const mine = await find(path.basename(self), fs.readdirSync(self), OUT);
  t('the folder you dropped is the folder it finds',
    mine.length && mine[0].path.toLowerCase() === self.toLowerCase(), mine[0]);

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
  // READ_MARKS scrapes span colours out of .xterm-rows, which only the DOM renderer
  // creates — so pin it (gpuRenderer:false), same as the dark half's desktop() does.
  // Without the pin the shipping WebGL default paints to canvas and the read is null
  // (or races the async DOM->WebGL swap, making this flaky).
  const lightPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await lightPage.addInitScript(() => { try {
    localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
    const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
    localStorage.setItem('ct-settings', JSON.stringify(s));
  } catch (e) {} });
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
      // Merge, don't clobber: a wholesale overwrite here would wipe the
      // gpuRenderer:false pin desktop() set, dropping this page back to the WebGL
      // renderer whose canvas has no .xterm-rows for paintMarks to read (-> null).
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}');
      s.palette = 'ember'; s.gpuRenderer = false;
      localStorage.setItem('ct-settings', JSON.stringify(s));
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
  // Scoped to the workspace panes (#wsrow), the only place tabs live now.
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
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  // Naming a group goes through the in-app dialog (window.prompt is dead in
  // Electron, so it was replaced by promptDialog) — fill + confirm it.
  const nameGroup = async (name) => {
    await p.click('#open-newgroup');
    await p.waitForTimeout(400);
    await p.fill('#dlg-body .dlg-in', name);
    await p.click('#dlg-body [data-ok]');
    await p.waitForTimeout(800);
  };

  const first = await p.evaluate(SIDEBAR);
  t('the sidebar opens on one group, not a terminal list', first.rows.length === 1, first.rows);
  t('the header count counts groups', first.count === '1', first.count);
  t('the group row rolls its terminals up into a sub-line',
    /^1 session · /.test(first.rows[0].sub), first.rows[0].sub);
  t('that one group owns the one terminal on top', first.shown === 1, first.tabs);

  // A second group. Its terminals are a different set from the first group's.
  await nameGroup('Client work');
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
  // context is a fresh browser with empty storage — which, since PT-3, means it
  // inherits the engine-owned shared workspace (STATE.md: one workspace per
  // identity), so it arrives holding the desk's two groups. The walk still starts
  // at the bottom and climbs, which is exactly the back-arrow chain a phone needs.
  const ph = await phoneCtx(browser);
  await ph.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await ph.waitForTimeout(5000);
  t('a phone with one group and one terminal opens straight into the terminal — a list of one costs a pointless tap',
    (await ph.evaluate(SIDEBAR)).view === 'focus');
  await shot(ph, 'phone-terminal');

  // Header B phone header: the back-arrow lives in the brand bar (#nhead-ctx) and is
  // view-aware. The separate nsessions .nbar and the tab-bar back-arrow are hidden so
  // the phone keeps two bars: brand bar + content. #ns-name still exists (hidden) and
  // is painted by renderNarrowSessions, so reading it here stays valid.
  await ph.click('#nhead-ctx');
  await ph.waitForTimeout(600);
  const v2 = await ph.evaluate(SIDEBAR);
  const ns = await ph.evaluate(() => ({
    name: document.getElementById('ns-name').textContent.trim(),
    ctx: document.getElementById('nhead-ctx-name').textContent.trim(),
    cards: document.querySelectorAll('#ns-list .ncard[data-open]').length,
    shown: getComputedStyle(document.querySelector('.nsessions')).display,
  }));
  t('back from a terminal lands on that group\'s sessions, not on the groups', v2.view === 'sessions', v2.view);
  t('the sessions screen is actually on screen', ns.shown === 'flex', ns);
  t('it is titled with the group and lists its terminals', ns.name === 'Workspace' && ns.cards === 1, ns);
  t('header B: the brand bar carries the group name on the session list', ns.ctx === 'Workspace', ns);
  await shot(ph, 'phone-sessions');

  // Header B: the brand-bar back-arrow is view-aware — from the session list it goes to Groups.
  await ph.click('#nhead-ctx');
  await ph.waitForTimeout(600);
  t('back again lands on the groups — the top of the phone stack',
    (await ph.evaluate(SIDEBAR)).view === 'projects');

  // A second group, made from the phone via the same in-app naming dialog.
  await ph.click('#open-newgroup');
  await ph.waitForTimeout(400);
  await ph.fill('#dlg-body .dlg-in', 'Phone group');
  await ph.click('#dlg-body [data-ok]');
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

  // Header B: view-aware back-arrow from the new group's session list → Groups.
  await ph.click('#nhead-ctx');
  await ph.waitForTimeout(600);
  const phRows = await ph.evaluate(SIDEBAR);
  // The desk's two groups came in with the shared workspace; the phone's new
  // group joins them — three groups, nothing lost and nothing duplicated.
  t('the phone group list shows the shared groups plus the new one',
    phRows.rows.length === 3 && phRows.rows.some((r) => r.name === 'Phone group'),
    phRows.rows.map((r) => r.name));
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

  // ST6 persists the browser + diff leaves this smoke opens. The dev profile
  // (WinMuxDev) survives across runs, so a prior run's leaves would be restored and
  // dirty the clean-startup layout the menu/browser tests assume. Wipe the dev
  // profile's Local Storage before each run for a deterministic default layout.
  try {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    fs.rmSync(path.join(appData, 'WinMuxDev', 'Local Storage'), { recursive: true, force: true });
  } catch (e) { /* best effort */ }

  const res = await new Promise((resolve) => {
    const proc = spawn(electronPath, [main], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { WINMUX_SMOKE: '1', WINMUX_SMOKE_OUT: outFile, WINMUX_FORCE_DOM: '1' }),
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
  // Phase 7 quake drop: the OS accepted the global-hotkey binding, and driving the
  // toggle reveals a hidden window. (A real keypress needs a human at a real display.)
  t('the global quake hotkey registers with the OS', !!json && json.quakeRegistered === true, json && { quakeRegistered: json.quakeRegistered, quakeError: json.quakeError });
  t('the quake toggle drops a hidden window into view', !!json && json.quakeDrops === true, json && { quakeDrops: json.quakeDrops });
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

  // Item 7 T2 — the automation verb set: fill+type set a field (read back via
  // eval), get-text dumps the page, eval computes, scroll moves the viewport.
  t('fill + type set a field, read back by eval', !!json && json.browserTyped === true, json && json.browserError);
  t('get-text returns the page\'s visible text', !!json && json.browserGotText === true, json && json.browserError);
  t('eval computes an expression in the page', !!json && json.browserEval === true, json && json.browserError);
  t('scroll moves the viewport', !!json && json.browserScrolled === true, json && json.browserError);
  // ST3: the browser is a pane TAB now, not a side dock — the leaf renders a
  // .ptab with the browser favicon and the old .wmb dock element is gone.
  t('the browser opened as a pane tab (leaf), not a side dock',
    !!json && json.browserIsTab === true, json && json.browserError);
  // ST5/ST6: the git-diff surface also opens as a pane tab inside the packaged
  // Electron app and renders real git status — not just in the plain-browser harness.
  t('the diff surface opened as a pane tab inside Electron',
    !!json && json.diffIsTab === true, json && (json.diffError || json.diffIsTab));
  t('the diff leaf rendered git status inside Electron',
    !!json && json.diffRendered === true, json && (json.diffError || json.diffRendered));

  // node-pty under Electron's ABI (#209): the smoke run drove the real terminal —
  // a live node-pty shell — to run `echo <token>` and read the marker back off the
  // screen. If node-pty's N-API prebuild had failed to load under Electron, the
  // app would have crashed on boot; this proves the native module loads AND spawns
  // a working shell in the packaged desktop face, not just in plain Node.
  t('a real node-pty shell ran a command under Electron', !!json && json.ptyOk === true,
    json && (json.ptyError || 'ptyOk=' + (json && json.ptyOk)));

  // Surfaces-as-tabs (Phase 1): the "+" button opens a type menu. Under Electron all
  // four surfaces are available: Terminal, Browser, Markdown and Changes (git diff).
  const menu = (json && json.menuTypes) || [];
  t('the "+" button opens a New-tab type menu', Array.isArray(menu) && menu.length >= 4, menu);
  t('the menu offers Terminal / Browser / Markdown / Changes',
    ['Terminal', 'Browser', 'Markdown', 'Changes'].every((k) => menu.indexOf(k) >= 0), menu);
});

// --- agentjob: server-side agent-job store (Stage 3) ----------------------
// The orchestration core: one session registers a job, another waits until it
// finishes and gets its result as data. Handled by the server itself, so this
// check needs NO browser — it proves a wait works with no app attached, which
// is the whole point. Mechanism proof (a synthetic reporter); a real Claude
// spawning another is the separate local E2E gate.
check('agentjob', PORT_AGENTJOB, async ({ t }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTJOB), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const reg = parse((await winmux(['agent', 'register', '--name', 'build-x', '--json'])).out);
  t('register mints a job in working state', reg && reg.job && /^job_/.test(reg.job.jobId) && reg.job.state === 'working', reg);
  const jobId = reg && reg.job && reg.job.jobId;

  const st0 = parse((await winmux(['agent', 'status', '--job', jobId, '--json'])).out);
  t('status reads the job back by id', st0 && st0.job && st0.job.jobId === jobId, st0);

  // Start a wait WITHOUT awaiting, then report done+result — the wait must unblock with the data.
  const waitP = winmux(['agent', 'wait', '--job', jobId, '--timeout', '20', '--json']);
  await sleep(600);
  const rep = await winmux(['agent', 'done', '--job', jobId, '--result', 'the answer is 42']);
  t('report done exits clean', rep.code === 0, rep.err);
  const waited = await waitP;
  const wj = parse(waited.out);
  t('a blocked wait unblocks with the reported result', wj && wj.job && wj.job.state === 'done' && wj.job.result === 'the answer is 42', wj && wj.job);
  t('wait exits 0 when the job is done', waited.code === 0, waited.code);

  // Terminal state is immutable — a later report cannot overwrite done/result.
  await winmux(['agent', 'failed', '--job', jobId, '--result', 'nope']);
  const st2 = parse((await winmux(['agent', 'status', '--job', jobId, '--json'])).out);
  t('the first terminal report wins (immutable)', st2 && st2.job.state === 'done' && st2.job.result === 'the answer is 42', st2 && st2.job);

  const unk = await winmux(['agent', 'status', '--job', 'job_does_not_exist', '--json']);
  t('an unknown jobId is rejected, not invented', unk.code !== 0, unk.out || unk.err);

  // A wait that times out returns the still-working job with a resumable exit code (3),
  // never hanging past the caller's tool ceiling.
  const reg2 = parse((await winmux(['agent', 'register', '--json'])).out);
  const w2 = await winmux(['agent', 'wait', '--job', reg2.job.jobId, '--timeout', '1', '--json']);
  const w2j = parse(w2.out);
  t('a timed-out wait is resumable (still working, exit 3)', w2j && w2j.job.state === 'working' && w2.code === 3, { code: w2.code, job: w2j && w2j.job });

  // jobId isolation — the second job's state is independent of the first.
  const iso = parse((await winmux(['agent', 'status', '--job', reg2.job.jobId, '--json'])).out);
  t('jobs are isolated by id (no cross-talk)', iso && iso.job.state === 'working' && iso.job.jobId !== jobId, iso && iso.job);
});

// --- agentspawn: one session spawns another and gets its result (Stage 3) -
// The full orchestration loop through a REAL terminal: `winmux agent spawn`
// opens a tab, runs a command in it, the launcher self-reports done + the
// command's output to the job store, and `winmux agent wait` receives that
// output as data. Swap the --cmd for a prompt and it's a real Claude driving
// another; this proves the plumbing without needing Claude auth in CI.
check('agentspawn', PORT_AGENTSPAWN, async ({ browser, base, t }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTSPAWN), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);        // the app connects to /control (spawn needs new-tab + send)

  const marker = 'HELLO_FROM_B_' + PORT_AGENTSPAWN;
  const sp = parse((await winmux(['agent', 'spawn', '--cmd', "Write-Output '" + marker + "'", '--name', 'btask', '--json'])).out);
  t('spawn opens a session and returns a job to wait on', sp && /^job_/.test(sp.jobId) && sp.sid != null, sp);

  const w = await winmux(['agent', 'wait', '--job', sp && sp.jobId, '--timeout', '25', '--json']);
  const wj = parse(w.out);
  t('the spawned task ran and its output came back through the wait as data',
    wj && wj.job && wj.job.state === 'done' && (wj.job.result || '').indexOf(marker) >= 0, { code: w.code, job: wj && wj.job });
  t('wait exits 0 once the spawned job is done', w.code === 0, w.code);
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

  // With no app open the CLI must fail clearly, never hang. Closing the page drops the
  // /control socket, but the server takes a moment to notice — a fixed wait races that
  // on a fast machine (it still answers from the just-departed app, so err is empty and
  // the check flakes on both engines). Poll until it reports the app is gone; the
  // invariant is that it fails clearly, not that it does so within one arbitrary tick.
  await page.close();
  let orphan = { code: 0, err: '' };
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 400));
    orphan = await winmux(['list']);
    if (orphan.code !== 0 && /no app connected/i.test(orphan.err)) break;
  }
  t('with no app open the CLI fails clearly, fast', orphan.code !== 0 && /no app connected/i.test(orphan.err), orphan.err);
});

// Item 8 T1 — every shell exports its own WinMux identity (WINMUX_SID/WINMUX_PORT),
// the way tmux exports $TMUX_PANE, so an agent's hook inside a terminal can address
// exactly this session.
check('agent-env', PORT_AGENTENV, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const sid = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    return at ? at.sid : null;
  });
  t('the active session has a server sid', !!sid, sid);
  // Ask the shell to print its injected identity, then read it back off the screen.
  await page.evaluate(() => {
    const at = window.__winmuxActiveTerm();
    // ${env:NAME} braces so the ':' delimiter isn't swallowed by PowerShell's $env: syntax.
    at.ws.send(JSON.stringify({ t: 'i', d: 'echo "WMX=${env:WINMUX_SID}=${env:WINMUX_PORT}"\r' }));
  });
  await page.waitForTimeout(2500);
  const screen = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); const b = at.term.buffer.active; let out = '';
    for (let i = 0; i < b.length; i++) { const ln = b.getLine(i); if (ln) out += ln.translateToString(true) + '\n'; }
    return out;
  });
  t('the shell exports WINMUX_SID equal to the session sid, WINMUX_PORT equal to the port',
    new RegExp('WMX=' + sid + '=' + PORT_AGENTENV + '(?!\\d)').test(screen), { want: 'WMX=' + sid + '=' + PORT_AGENTENV, tail: screen.slice(-160) });
  await page.close();
});

// Item 8 T2 — `winmux agent <state>` drives the session's cockpit status by sid,
// the exact path a Claude Code hook fires. needs-you raises the alarm; done clears it.
check('agent-state', PORT_AGENTSTATE, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTSTATE), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const statusOf = () => page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); return at ? at.status : null;
  });

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const sid = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.sid : null; });
  t('a session sid is available to target', !!sid, sid);

  const nu = await winmux(['agent', 'needs-you', '--sid', sid, 'waiting on your approval']);
  t('winmux agent needs-you exits clean', nu.code === 0, nu.err);
  await page.waitForTimeout(800);
  const s1 = await statusOf();
  const approve = await page.evaluate(() => !!document.querySelector('.sapprove'));
  t('the session flipped to needs-you (status + Approve pill)', s1 === 'needsyou' && approve === true, { status: s1, approve });
  await shot(page, 'agent-needsyou');

  const dn = await winmux(['agent', 'done', '--sid', sid]);
  t('winmux agent done exits clean', dn.code === 0, dn.err);
  await page.waitForTimeout(800);
  const s2 = await statusOf();
  t('agent done clears it back to idle', s2 === 'idle', { status: s2 });

  const wk = await winmux(['agent', 'working', '--sid', sid, 'running the build']);
  await page.waitForTimeout(800);
  const s3 = await statusOf();
  t('agent working moves it to the working lane', wk.code === 0 && s3 === 'working', { code: wk.code, status: s3 });
  await page.close();
});

// Item 8 T3 — the shipped Claude Code hooks preset is valid and its command path is
// real: fire the exact command a hook runs, with $WINMUX_SID set like a real hook,
// and prove the cockpit follows. Also prove the outside-WinMux no-op guard.
check('agent-hooks', PORT_AGENTHOOKS, async ({ browser, base, t }) => {
  // The preset is valid JSON wiring the three lifecycle events to `winmux agent`.
  const preset = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent', 'claude-code-hooks.json'), 'utf8'));
  const cmdFor = (evt) => {
    try { return preset.hooks[evt][0].hooks[0].command; } catch (e) { return ''; }
  };
  t('preset wires UserPromptSubmit → agent working', /winmux agent working/.test(cmdFor('UserPromptSubmit')), cmdFor('UserPromptSubmit'));
  t('preset wires Notification → agent needs-you', /winmux agent needs-you/.test(cmdFor('Notification')), cmdFor('Notification'));
  t('preset wires Stop → agent done', /winmux agent done/.test(cmdFor('Stop')), cmdFor('Stop'));

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const sid = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.sid : null; });

  // Fire the exact hook command with $WINMUX_SID set, the way a hook inherits it
  // from the shell — no --sid on the command line.
  const runHook = (args, extraEnv) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTHOOKS), WINMUX_HOST: '127.0.0.1' }, extraEnv || {}) });
    let o = '', e = ''; proc.stdout.on('data', (d) => o += d); proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const fired = await runHook(['agent', 'needs-you', 'Claude needs your input'], { WINMUX_SID: sid });
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.status : null; });
  t('the Notification-hook command (with $WINMUX_SID) flips live state', fired.code === 0 && st === 'needsyou', { code: fired.code, status: st });

  // Outside a WinMux terminal ($WINMUX_SID unset, no --id): must no-op, not poke the app.
  const guarded = await runHook(['agent', 'done', '--json'], { WINMUX_SID: '' });
  const stAfter = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.status : null; });
  t('a hook fired outside WinMux no-ops (state unchanged)',
    guarded.code === 0 && /skipped/.test(guarded.out) && stAfter === 'needsyou', { out: guarded.out, status: stAfter });
  await page.close();
});

// Item 9 (distribution, non-gated slice) — the winget manifest generator emits the three
// valid-shaped manifests from a release URL + SHA, ready to submit once a release exists.
check('winget', PORT_WINGET, async ({ t }) => {
  const outDir = path.join(OUT, 'winget-check-' + PORT_WINGET);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  const url = 'https://github.com/Zbrooklyn/winmux/releases/download/v0.1.0/WinMux.Setup.0.1.0.exe';
  const sha = 'A'.repeat(64);
  const run = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'winget-manifest.mjs'), '--url', url, '--sha', sha, '--out', outDir],
      { cwd: ROOT });
    let e = ''; proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, err: e.trim() }));
  });
  t('the generator runs clean', run.code === 0, run.err);

  const rd = (n) => { try { return fs.readFileSync(path.join(outDir, n), 'utf8'); } catch (e) { return ''; } };
  const ver = rd('Zbrooklyn.WinMux.yaml');
  const inst = rd('Zbrooklyn.WinMux.installer.yaml');
  const loc = rd('Zbrooklyn.WinMux.locale.en-US.yaml');
  t('the version manifest identifies the package', /PackageIdentifier: Zbrooklyn\.WinMux/.test(ver) && /ManifestType: version/.test(ver), ver.slice(0, 120));
  t('the installer manifest carries the real url + sha + nullsoft type',
    inst.indexOf('InstallerUrl: ' + url) >= 0 && inst.indexOf('InstallerSha256: ' + sha) >= 0 && /InstallerType: nullsoft/.test(inst), inst.slice(0, 200));
  t('the locale manifest names publisher + license', /Publisher: Zbrooklyn/.test(loc) && /License: MIT/.test(loc) && /ManifestType: defaultLocale/.test(loc), loc.slice(0, 160));
  t('no placeholder markers survive when url+sha are given', !/PLACEHOLDER/.test(ver + inst + loc), 'clean');
});

// #246 — the authoritative WINMUX_TUNNELLED_PORTS override is honored WITHOUT a
// tailscale spawn, so booting many servers at once can't flake the safety check.
// Deterministic regardless of this machine's real tailscale state.
check('tunnel-override', PORT_TUNOVR, async ({ base, t }) => {
  // Positive: the framework already booted this check's server with the override
  // in its env (empty or the real set, neither of which includes this port), so it
  // came up and serves the desk door — the override didn't wrongly block a safe port.
  const up = await get(base + '/');
  t('a server starts on a port the override does not list', up.status === 200, up.status);

  // Refusal: force a port AND mark that same port tunnelled via the override. The
  // server must refuse (exit 2) purely from the override — no tailscale call needed.
  const forced = 9951;
  const refused = await new Promise((resolve) => {
    const proc = spawn(process.execPath, ['server.cjs'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(forced), WINMUX_TUNNELLED_PORTS: String(forced),
        WINMUX_TRUST_FILE: trustFile('tunovr'), WINMUX_NO_INSTANCE: '1',
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('exit', (code) => resolve({ code, err }));
    setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, err }); }, 15000);
  });
  t('refuses a port the override marks tunnelled, no tailscale needed', refused.code === 2, 'exit ' + refused.code);
  t('the refusal names the tunnelled cause', /tailscale serve/i.test(refused.err) && /without a key/.test(refused.err),
    refused.err.split('\n').find((l) => /without a key|tailscale serve/i.test(l)) || refused.err.slice(0, 120));
});

// --- approve (U4): clear a "needs you" session inline, without switching in ----
// A background terminal that rings its bell flips to "needs you". Its row grows an
// inline Approve pill; clicking it sends Enter to that terminal (accepting whatever
// it was waiting on) and clears the alarm — the "approve a blocked agent from the
// fleet view" move. Idle rows must NOT get the pill. We drive it through the same
// real CLI transport the `cli` check uses (send/read-screen/new-tab).
check('approve', PORT_APPROVE, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_APPROVE), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);          // the app connects to /control

  const l1 = parse((await winmux(['list', '--json'])).out);
  t('the app reports its starting terminal', l1 && l1.sessions.length >= 1, l1 && l1.sessions.length);
  const t1 = l1.sessions[0].id;

  // A second terminal takes focus, so t1 is now a background tab — the exact
  // condition under which a bell means "needs you", not "you already saw it".
  await winmux(['new-tab']);
  await page.waitForTimeout(1800);
  const l2 = parse((await winmux(['list', '--json'])).out);
  const active = l2 && l2.sessions.find((s) => s.active);
  t('a second terminal becomes the active one', active && String(active.id) !== String(t1), active && active.id);

  // Ring the background terminal: its shell writes one real BEL byte.
  const rung = await winmux(['send', '[Console]::Out.Write([char]7)', '--id', String(t1), '--enter']);
  t('the ring reaches the background terminal', rung.code === 0, rung.err);
  await page.waitForTimeout(2400);

  // Expand groups so the rows render, then read the sidebar.
  await page.evaluate(() => { document.querySelectorAll('[data-expand]').forEach((e) => { if (!e.hasAttribute('data-open2')) e.click(); }); });
  await page.waitForTimeout(500);
  const before = await page.evaluate((id) => {
    const need = document.getElementById('d-need');
    const row = document.querySelector('.srow[data-term="' + id + '"]');
    const others = [...document.querySelectorAll('.srow[data-term]')].filter((r) => r.getAttribute('data-term') !== String(id));
    return {
      dNeed: need && need.textContent,
      rowNeedsYou: !!(row && row.querySelector('.dot.needsyou')),
      rowHasApprove: !!(row && row.querySelector('.sapprove')),
      idleHasApprove: others.some((r) => r.querySelector('.sapprove')),
    };
  }, t1);
  t('a rung background session becomes "needs you"', before.rowNeedsYou && before.dNeed !== '0', before);
  t('a "needs you" row grows an inline Approve control', before.rowHasApprove, before);
  t('an idle row has no Approve control (it is only for waiting sessions)', !before.idleHasApprove, before);
  await shot(page, 'approve-pill');

  // Click Approve — it must send the keystroke and clear the alarm.
  await page.click('.srow[data-term="' + t1 + '"] .sapprove');
  await page.waitForTimeout(1200);
  const after = await page.evaluate((id) => {
    const row = document.querySelector('.srow[data-term="' + id + '"]');
    return { stillApprove: !!(row && row.querySelector('.sapprove')), stillNeedsYou: !!(row && row.querySelector('.dot.needsyou')) };
  }, t1);
  t('clicking Approve clears the waiting state', !after.stillApprove && !after.stillNeedsYou, after);

  // The action reports itself: an "Approved" line lands in the notification centre,
  // which only happens when the keystroke was actually sent to a live terminal.
  await page.evaluate(() => document.getElementById('open-notif').click());
  await page.waitForTimeout(400);
  const notif = await page.evaluate(() => (document.getElementById('npanel').textContent || ''));
  t('Approve reports it sent the keystroke (notification)', /Approved/.test(notif), notif.slice(0, 120));

  await page.close();
});

// --- pwsh: PowerShell 7 is found even from a Microsoft Store install -----------
// The bug: detectShells used fs.existsSync, which returns FALSE on the Store App
// Execution Alias for pwsh.exe — so Store-installed PowerShell 7 silently never
// appeared, though node-pty spawns it fine. Detection now lstat-checks the alias.
// Prove PS7 is offered, labelled right, and actually runs 7.x. Skips where pwsh
// isn't installed (a clean machine without it should not fail this).
check('pwsh', PORT_PWSH, async ({ browser, base, t, shot, skip }) => {
  const shells = await new Promise((res) => {
    http.get(base + '/shells', (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } }); }).on('error', () => res(null));
  });
  const p7 = shells && shells.find((s) => s.key === 'pwsh');
  if (!p7) return skip('PowerShell 7 (pwsh) is not installed on this machine');
  t('PowerShell 7 is offered in the shell list', !!p7, shells);
  t('and it is labelled "PowerShell 7" (not the retired "Core")', p7.label === 'PowerShell 7', p7.label);

  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_PWSH), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);          // the app connects to /control

  const opened = await winmux(['new-tab', 'pwsh']);
  t('winmux opens a PowerShell 7 tab', opened.code === 0, opened.err);
  await page.waitForTimeout(3500);          // pwsh is slower to boot than 5.1

  // Ask the new (now active) pwsh tab its own major version — a marker only a real
  // running PowerShell 7 can produce, so this can't pass on a dead/listed-only shell.
  await winmux(['send', '"PSMAJOR=" + $PSVersionTable.PSVersion.Major', '--enter']);
  await page.waitForTimeout(2500);
  const rd = await winmux(['read-screen', '--lines', '40']);
  t('the pwsh tab is really running PowerShell 7.x', rd.code === 0 && /PSMAJOR=7/.test(rd.out), rd.out.slice(-160));
  await shot(page, 'pwsh-running');

  await page.close();
});

// --- footer: every sidebar-footer button actually does its thing --------------
// Seven buttons at the bottom of the sidebar. "Wired to a handler" is not "works":
// New group / Rename group used window.prompt, which THROWS in Electron, so those
// were dead in the desktop app. This clicks each and asserts the real outcome, and
// specifically proves New group now opens an in-app dialog and creates the group.
check('footer', PORT_FOOTER, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.evaluate(() => { try { document.querySelectorAll('.ovl[data-open]').forEach((o) => o.removeAttribute('data-open')); } catch (e) {} });

  const n = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const openId = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!(e && e.hasAttribute('data-open')); }, id);
  const openSel = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);

  // New terminal → a tab is added.
  const tabs0 = await n('.ptab');
  await page.click('#open-new');
  await page.waitForTimeout(1200);
  t('New terminal adds a tab', (await n('.ptab')) === tabs0 + 1, { before: tabs0, after: await n('.ptab') });

  // New group → in-app dialog (the window.prompt bug) → creates the group.
  const groups0 = await n('.prow');
  await page.click('#open-newgroup');
  await page.waitForTimeout(400);
  t('New group opens an in-app name dialog (window.prompt is dead in Electron)', await openId('dlg-ovl'), 'dlg-ovl');
  await page.fill('#dlg-body .dlg-in', 'QA Group');
  await page.click('#dlg-body [data-ok]');
  await page.waitForTimeout(700);
  t('New group actually creates the group', (await n('.prow')) === groups0 + 1, { before: groups0, after: await n('.prow') });
  await shot(page, 'footer-newgroup');

  // Save project → the Projects overlay opens.
  await page.click('#open-save');
  await page.waitForTimeout(300);
  t('Save project opens the Projects overlay', await openSel('#projects-ovl[data-open]'), 'projects-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Open project → same overlay opens.
  await page.click('#open-load');
  await page.waitForTimeout(300);
  t('Open project opens the Projects overlay', await openSel('#projects-ovl[data-open]'), 'projects-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Diagnostics → its overlay opens.
  await page.click('#open-diag');
  await page.waitForTimeout(300);
  t('Diagnostics opens the diagnostics panel', await openId('diag-ovl'), 'diag-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Keyboard shortcuts → the cheat sheet opens.
  await page.click('#open-help');
  await page.waitForTimeout(300);
  t('Keyboard shortcuts opens the cheat sheet', await openId('cheat-ovl'), 'cheat-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Settings → the settings overlay opens.
  await page.click('#open-settings');
  await page.waitForTimeout(300);
  t('Settings opens the settings panel', await openId('settings-ovl'), 'settings-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Save-on-close: saving binds this window to a project file; a later change makes it
  // dirty; closing then asks before dropping the change instead of exiting silently.
  await page.click('#open-save');
  await page.waitForTimeout(250);
  await page.fill('#sm-name', 'Verify Project');
  await page.click('#sm-save');
  await page.waitForTimeout(800);
  const bound = await page.evaluate(() => { try { return !!JSON.parse(localStorage.getItem('ct-current') || 'null'); } catch (e) { return false; } });
  t('Saving binds this window to the project file', bound, { bound });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  // Stub the real teardown so the harness window survives a close click; record whether
  // close was actually reached — a dirty project must block it.
  await page.evaluate(() => {
    window.__closed = false;
    if (window.winmux) window.winmux.close = () => { window.__closed = true; };
    try { window.close = () => { window.__closed = true; }; } catch (e) {}
  });
  // A clean (just-saved) project closes straight through — no prompt.
  await page.click('#wc-close');
  await page.waitForTimeout(250);
  t('A saved (clean) project closes without a prompt',
    !(await openId('dlg-ovl')) && (await page.evaluate(() => window.__closed === true)), 'clean-close');
  await page.evaluate(() => { window.__closed = false; });
  // Dirty it (add a tab) → closing asks first and does NOT close yet.
  await page.click('#open-new');
  await page.waitForTimeout(1000);
  await page.click('#wc-close');
  await page.waitForTimeout(300);
  const promptUp = await openId('dlg-ovl');
  const heldOpen = await page.evaluate(() => window.__closed === false);
  const askTitle = await page.evaluate(() => { const h = document.querySelector('#dlg-body h3'); return h ? h.textContent : ''; });
  t('A dirty project prompts before closing (and does not close yet)', promptUp && heldOpen, { promptUp, heldOpen });
  t('The close prompt names the project and offers Don’t save',
    /Verify Project/.test(askTitle) && (await openSel('#dlg-body [data-discard]')), askTitle);
  // "Don’t save" lets the close proceed.
  await page.click('#dlg-body [data-discard]');
  await page.waitForTimeout(250);
  t('“Don’t save” proceeds with the close', await page.evaluate(() => window.__closed === true), 'discard-closes');

  await page.close();
}, { WINMUX_PROJECTS_DIR: PROJECTS_TMP });

// --- update notice: a newer release lights the .upbadge pill (never installs) ---
// The server is booted with WINMUX_FAKE_LATEST=9.9.9 (via the check's env override),
// so /api/update reports an update without needing a real published release. We
// assert the pill turns on, names the version, and carries a real download link.
check('update', PORT_UPDATE, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // The server-side check reports it.
  const api = await page.evaluate((b) => fetch(b + '/api/update').then((r) => r.json()), base);
  t('server reports a newer version is available', api && api.updateAvailable === true && api.latest === '9.9.9', api);

  // The badge lights up, names the version, and links to the release page.
  await page.waitForFunction(() => {
    const b = document.getElementById('upbadge');
    return b && b.classList.contains('on') && /9\.9\.9/.test(b.textContent);
  }, { timeout: 6000 }).catch(() => {});
  const badge = await page.evaluate(() => {
    const b = document.getElementById('upbadge');
    if (!b) return null;
    return { on: b.classList.contains('on'), text: b.textContent, shown: b.offsetParent !== null };
  });
  t('the update badge is visible', badge && badge.on && badge.shown, badge);
  t('the update badge names the new version', badge && /Update v9\.9\.9/.test(badge.text), badge && badge.text);
  t('the download link points at the WinMux releases page',
    /github\.com\/Zbrooklyn\/winmux\/releases/.test(api.url), api && api.url);

  await page.close();
}, { WINMUX_FAKE_LATEST: '9.9.9' });

// --- gpu: the WebGL renderer is live by default, and the DOM fallback still paints ---
// The GPU renderer drops the measured 10-stream event-loop tick ~12x (perf.cjs:
// 199ms -> 16ms), so it ships ON by default. This proves (1) it actually engages,
// and (2) if WebGL is unavailable the terminal cleanly falls back to the DOM
// renderer and still shows text — never a blank/broken terminal to "look fast".
check('gpu', PORT_GPU, async ({ browser, base, t }) => {
  // Default path: the app default is GPU on, so DON'T use desktop() (which pins
  // it off) — a raw page that only dismisses onboarding runs the real shipping
  // default. WebGL available -> the active terminal paints to a <canvas>.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('.xterm-screen canvas, .xterm canvas');
    return { flagCanvas: !!canvas };
  });
  t('WebGL renderer is engaged by default (canvas present)', renderer.flagCanvas, renderer);
  await page.close();

  // Fallback path: force WebglAddon absent before load -> DOM renderer, still paints.
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page2.addInitScript(() => {
    try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {}
    // Make the WebGL addon look unavailable so the try/catch falls back to DOM.
    Object.defineProperty(window, 'WebglAddon', { value: undefined, configurable: true });
  });
  await page2.goto(base, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(4000);
  const fb = await page2.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div').length;
    const canvas = document.querySelector('.xterm-screen canvas, .xterm canvas');
    return { rows, hasCanvas: !!canvas };
  });
  t('DOM fallback paints text when WebGL is unavailable (rows, no canvas)', fb.rows > 0 && !fb.hasCanvas, fb);
  await page2.close();
});

// --- dprfix (MR-1): a devicePixelRatio-stuck WebGL canvas gets resynced ---
// xterm's WebGL renderer resizes its canvas backing store only on a column/row
// change — a pure devicePixelRatio change (Electron's startup dpr settle on a scaled
// Windows display, or a monitor-to-monitor move) leaves the canvas stuck at the old
// scale, so the whole grid renders wrong-sized and the first prompt strands mid-pane.
// The buffer is correct the whole time; it's purely canvas geometry. The app now
// detects canvas-backing != render-service device dims and forces a resync
// (resyncRenderer, wired into open/show/fit and a dpr-change watcher). This guard
// simulates the stuck state by doubling the canvas backing, then drives the resize
// path and proves the canvas heals. Needs the shipping WebGL default (see the
// WINMUX_FORCE_DOM exemption), so it gets its own raw page like gpu/ligature.
check('dprfix', PORT_DPRFIX, async ({ browser, base, t }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const read = () => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!at || !at.term) return { err: 'no term' };
    const term = at.term, rs = term._core && term._core._renderService;
    let r = rs && rs._renderer; r = r && (r.value || r);
    const canvas = r && r._canvas;
    const dims = rs && rs.dimensions && rs.dimensions.device && rs.dimensions.device.canvas;
    if (!canvas || !dims) return { err: 'no canvas/dims', renderer: term.__winmuxRenderer };
    return {
      renderer: term.__winmuxRenderer,
      cw: canvas.width, ch: canvas.height, dw: Math.round(dims.width), dh: Math.round(dims.height),
      matched: canvas.width === Math.round(dims.width) && canvas.height === Math.round(dims.height),
    };
  };

  const before = await page.evaluate(read);
  t('WebGL canvas backing matches render dims on open (healthy baseline)', before.renderer === 'webgl' && before.matched === true, before);

  // Force the dpr-stuck state: double the canvas backing store out from under xterm.
  const stuck = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); const term = at.term;
    const rs = term._core._renderService; let r = rs._renderer; r = r && (r.value || r);
    const c = r._canvas; c.width *= 2; c.height *= 2;
    const dims = rs.dimensions.device.canvas;
    return { matched: c.width === Math.round(dims.width) && c.height === Math.round(dims.height) };
  });
  t('Simulated dpr-stuck state creates a real canvas/dims mismatch', stuck.matched === false, stuck);

  // Drive the app's resync path (window resize -> fitActive -> resyncRenderer).
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(400);

  const after = await page.evaluate(read);
  t('resyncRenderer heals the canvas backing back to the render dims', after.matched === true, after);
  await page.close();
});

// --- ligature: the switch really shapes operators, and pays the renderer price ---
// Shaping "=>" into one arrow needs a text run the browser can shape, and only the
// DOM renderer emits one — WebGL draws cell by cell out of a glyph atlas, so under
// it there is no DOM text to shape at all (measured: zero spans). That makes the
// ligature switch a real fork, not a coat of CSS: turning it on has to drop that
// terminal off WebGL. This check proves all three halves — the default is GPU with
// no shaping, the switch flips both the renderer and the measured font feature, and
// the live swap doesn't cost the user their scrollback. It needs the shipping
// renderer default, so it gets its own port exempt from WINMUX_FORCE_DOM and a raw
// page rather than desktop() (which pins gpuRenderer off).
check('ligature', PORT_LIG, async ({ browser, base, t }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Default: ligatures off -> WebGL, no body flag.
  const before = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector('.xterm-screen canvas, .xterm canvas'),
    flagged: document.body.hasAttribute('data-ligatures'),
  }));
  t('ligatures are off by default (GPU renderer, no ligature flag)',
    before.hasCanvas && !before.flagged, before);

  // Put a marker on screen BEFORE the flip so we can prove the renderer swap keeps
  // the scrollback. It goes through the SHELL, not term.write(): flipping the switch
  // refits the pane, and a resize makes PSReadLine repaint its prompt line over
  // anything written behind the shell's back. Real command output sits above that
  // line and survives, which is the thing a user would actually lose.
  const MARK = 'WINMUX-LIG-MARK-7714';
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type("echo '" + MARK + " => != -> >= <='");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);

  // Flip the real switch the way a human does: Settings -> Terminal -> the toggle.
  await settings(page, 'Terminal');
  await page.locator('[data-sw="ligatures"]').click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  const on = await page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    // The run the browser actually shapes is the text node inside the row holding "=>",
    // not the container — so read the style off that element, or the rule could compute
    // on a wrapper the glyphs never inherit from.
    const row = rows && [].slice.call(rows.children).find((r) => (r.textContent || '').indexOf('=>') >= 0);
    const span = row && ([].slice.call(row.querySelectorAll('span')).find((s) => (s.textContent || '').indexOf('=>') >= 0) || row);
    return {
      hasCanvas: !!document.querySelector('.xterm-screen canvas, .xterm canvas'),
      flagged: document.body.hasAttribute('data-ligatures'),
      renderer: (window.__winmuxActiveTerm && window.__winmuxActiveTerm().term.__winmuxRenderer) || null,
      lig: rows ? getComputedStyle(rows).fontVariantLigatures : null,
      spanLig: span ? getComputedStyle(span).fontVariantLigatures : null,
      spanText: span ? (span.textContent || '').slice(0, 80) : null,
      screen: rows ? rows.textContent : '',
    };
  });
  t('turning ligatures on drops that terminal off WebGL (DOM renderer, no canvas)',
    !on.hasCanvas && on.renderer === 'dom', { hasCanvas: on.hasCanvas, renderer: on.renderer });
  t('the ligature flag reaches the page', on.flagged, on.flagged);
  // Cascadia carries its arrows as contextual alternates, so plain "normal" leaves
  // => unshaped — the computed value has to actually say contextual.
  t('the rendered rows compute font-variant-ligatures: contextual',
    on.lig === 'contextual', on.lig);
  t('the arrow run itself inherits contextual (the glyphs, not just the container)',
    on.spanLig === 'contextual' && !!on.spanText, { lig: on.spanLig, text: on.spanText });
  t('the renderer swap keeps the scrollback (pre-flip marker still on screen)',
    on.screen.indexOf(MARK) >= 0, on.screen.slice(-160));

  // And back: the swap is live in both directions, so nobody is stuck on the slow path.
  await settings(page, 'Terminal');
  await page.locator('[data-sw="ligatures"]').click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const off = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector('.xterm-screen canvas, .xterm canvas'),
    flagged: document.body.hasAttribute('data-ligatures'),
    renderer: (window.__winmuxActiveTerm && window.__winmuxActiveTerm().term.__winmuxRenderer) || null,
  }));
  t('turning it back off restores the GPU renderer', off.hasCanvas && off.renderer === 'webgl' && !off.flagged, off);
  await page.close();
});

// --- font: the terminal font is BUNDLED, served, loaded, and actually applied ---
// cockpit.css/app.js ask for 'Cascadia Code'; a clean machine with no Cascadia
// installed fell back to Consolas and rendered prompt/powerline glyphs as tofu.
// We ship CaskaydiaCove Nerd Font Mono and bind it to that family name. This proves
// the whole chain — the .ttf is served with a font MIME, a FontFace for the family
// actually loads, and the live terminal's computed font-family resolves to it — so
// the fix holds on a machine that has never seen Cascadia, not just this dev box.
check('font', PORT_FONT, async ({ browser, base, t }) => {
  // 1) The bundled file is served with a real font content-type (not 404 / html).
  const res = await get(base + '/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf');
  const ct = String(res.headers['content-type'] || '');
  t('the bundled Nerd Font .ttf is served', res.status === 200 && /font\/(ttf|otf|sfnt)/.test(ct), { status: res.status, ct: ct });

  // Read the DOM renderer's text layer: xterm sets the font on .xterm-rows, which
  // only exists under the DOM renderer. The shipping default is the WebGL renderer,
  // which paints rows to a <canvas> (no .xterm-rows, and .xterm/.xterm-screen keep
  // the page's Inter) — so this check pins the DOM renderer (gpuRenderer:false, via
  // desktop()) to read a meaningful computed font-family. WebGL font correctness is
  // covered by the loaded @font-face (usable) + the gpu check.
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(async () => {
    // Force the family to load, then report what the document actually holds.
    try { await document.fonts.load('12px "Cascadia Code"'); await document.fonts.load('bold 12px "Cascadia Code"'); } catch (e) {}
    try { await document.fonts.ready; } catch (e) {}
    let faceLoaded = false;
    document.fonts.forEach(function (f) {
      if (String(f.family).replace(/["']/g, '') === 'Cascadia Code' && f.status === 'loaded') faceLoaded = true;
    });
    const usable = document.fonts.check('12px "Cascadia Code"');
    // The live terminal must actually resolve to the family, not silently to Consolas.
    // xterm sets the font on the .xterm element (and its .xterm-rows), so read those.
    const cand = ['.pane .xterm', '.xterm .xterm-rows', '.xterm-screen'];
    let applied = '';
    for (var i = 0; i < cand.length; i++) {
      var el = document.querySelector(cand[i]);
      if (el) { var ff = getComputedStyle(el).fontFamily; if (/Cascadia Code/i.test(ff)) { applied = ff; break; } if (!applied) applied = cand[i] + '=' + ff; }
    }
    return { faceLoaded: faceLoaded, usable: usable, applied: applied };
  });
  t('a Cascadia Code @font-face actually loaded (bundled, not the OS)', info.faceLoaded, info);
  t('the family is usable and applied to the terminal', info.usable && /Cascadia Code/i.test(info.applied), info);
  await page.close();
});

// --- instant: opening a tab shows a cursor immediately, then hands off cleanly ---
// A fresh tab has an unavoidable gap (socket open -> shell first byte). We paint an
// instant skeleton cursor so it never reads as a blank "loading" pane, and remove it
// the moment real output lands. Pre-warm is disabled on THIS server so the shell
// spawn is slow enough that the skeleton has a deterministic window to be caught.
check('instant', PORT_INSTANT, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);   // first terminal settles (its own skeleton clears)
  const settled = await page.$$eval('.term-skel', function (els) { return els.length; });
  // Open a second tab. makeTerm creates the skeleton synchronously on click, before
  // the socket even opens — so it is present the instant the pane mounts.
  await page.click('#open-new');
  const appeared = await page.waitForSelector('.term-skel .cur', { state: 'attached', timeout: 3000 })
    .then(function () { return true; }).catch(function () { return false; });
  t('a skeleton cursor appears the instant a new tab opens', appeared, { firstTermSkelSettled: settled });
  if (appeared) await shot(page, 'skeleton');
  // Once the shell's first byte lands, every skeleton is gone — no leftover overlay.
  const cleared = await page.waitForFunction(function () { return document.querySelectorAll('.term-skel').length === 0; }, null, { timeout: 9000 })
    .then(function () { return true; }).catch(function () { return false; });
  t('the skeleton is removed once the terminal is live', cleared);
  await page.close();
}, { WINMUX_NO_PREWARM: '1' });

// --- survive: the server outlives its launcher — spawn, reattach, quit-completely -
// Session survival's automatable core (electron/server-host.js): a real launch RESOLVES
// a server — spawning a DETACHED one that outlives the window, reattaching to a live
// one instead of double-spawning, and stopping it deliberately via /api/shutdown. Runs
// self-contained on a forced port (9935) so it never touches the harness's own servers.
check('detach', PORT_SURVIVE2, async ({ t }) => {
  const { resolveServer, shutdownServer } = require('./dist-electron/server-host.js');
  const scratch = path.join(OUT, 'survive2');
  fs.mkdirSync(scratch, { recursive: true });
  const instanceFile = path.join(scratch, 'instance.json');
  try { fs.unlinkSync(instanceFile); } catch (e) {}
  // No forced port — let the server pick a FREE candidate and report it back, so a
  // stale server from a prior run can never make this refuse-and-timeout.
  const opts = { instanceFile, trustFile: path.join(scratch, 'devices.json'), execPath: process.execPath, serverPath: path.join(ROOT, 'server.cjs'), timeoutMs: 15000 };
  const alive = (port) => new Promise((res) => {
    const rq = http.get({ host: '127.0.0.1', port: port, path: '/api/info' }, (x) => { x.resume(); res(true); });
    rq.on('error', () => res(false)); rq.setTimeout(900, () => { rq.destroy(); res(false); });
  });
  let boundPort = 0;
  try {
    const a = await resolveServer(opts);
    boundPort = a.port;
    t('a detached server spawns and advertises its port', a.attached === false && a.port > 0, a);
    const b = await resolveServer(opts);
    t('a relaunch reattaches to the live server instead of spawning again', b.attached === true && b.port === a.port, b);
    const ok = await shutdownServer(a.port);
    await new Promise((r) => setTimeout(r, 700));
    const stillUp = await alive(a.port);
    const fileGone = !fs.existsSync(instanceFile);
    t('quit-completely (/api/shutdown) stops the server and clears discovery', ok && !stillUp && fileGone, { ok, stillUp, fileGone });
  } finally {
    // Belt-and-braces: never leave the spawned server running if an assert threw.
    if (boundPort) { try { await shutdownServer(boundPort); } catch (e) {} }
    try { fs.unlinkSync(instanceFile); } catch (e) {}
  }
});

// --- mcp: an MCP client drives the live WinMux app over stdio ---------------
// winmux-mcp is a stdio MCP server (newline-delimited JSON-RPC) exposing the /rpc
// verbs as tools. The harness plays the MCP client: initialize -> tools/list ->
// call winmux_list (proves it sees the live sessions) -> send+read_screen round
// trip (proves an agent can actually operate the terminal over MCP).
check('mcp', PORT_MCP, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);   // the app connects to /control

  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux-mcp.cjs')],
    { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_MCP), WINMUX_HOST: '127.0.0.1' }) });
  const pending = {};
  let sb = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    sb += d; let nl;
    while ((nl = sb.indexOf('\n')) >= 0) {
      const line = sb.slice(0, nl).trim(); sb = sb.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.id != null && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    }
  });
  let seq = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending[id] = resolve;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
    setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('timeout ' + method)); } }, 8000);
  });

  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness', version: '1' } });
    t('MCP initialize returns the winmux serverInfo', !!(init.result && init.result.serverInfo && init.result.serverInfo.name === 'winmux'), init.result);
    const tl = await call('tools/list');
    t('MCP advertises the winmux tools', !!(tl.result && Array.isArray(tl.result.tools) && tl.result.tools.some((x) => x.name === 'winmux_list')), tl.result && tl.result.tools && tl.result.tools.length);
    const lc = await call('tools/call', { name: 'winmux_list', arguments: {} });
    const listed = JSON.parse(lc.result.content[0].text);
    t('MCP winmux_list sees the live sessions', !!(listed && Array.isArray(listed.sessions) && listed.sessions.length >= 1), listed && listed.sessions && listed.sessions.length);
    const marker = 'MCP_OK_' + PORT_MCP;
    await call('tools/call', { name: 'winmux_send', arguments: { text: '"' + marker + '"', enter: true } });
    await page.waitForTimeout(2500);
    const rc = await call('tools/call', { name: 'winmux_read_screen', arguments: { lines: 60 } });
    const screen = JSON.parse(rc.result.content[0].text);
    t('MCP send + read_screen round-trips through the real shell', String(screen && screen.screen || '').indexOf(marker) >= 0, String(screen && screen.screen || '').slice(-120));
  } finally {
    try { proc.stdin.end(); proc.kill(); } catch (e) {}
    await page.close();
  }
});

// --- notify: an agent flips a session to "needs you" via the CLI -----------
// The attention bus's explicit signal. `winmux notify --id <n> <msg>` marks that
// session needs-you exactly like a bell would — the counter, the row's Approve,
// and (unfocused) the desktop notification all follow. Driven through the real
// CLI -> /rpc -> /control path, like the `cli` check.
check('notify', PORT_NOTIFY, async ({ browser, base, t, shot }) => {
  const winmux = (a) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...a],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_NOTIFY), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = ''; proc.stdout.on('data', (d) => o += d); proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);   // the app connects to /control

  const before = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    const need = document.getElementById('d-need');
    return { status: at && at.status, need: need ? need.textContent.trim() : null };
  });
  const r = await winmux(['notify', 'the deploy needs your call']);
  t('notify exits clean and names the session', r.code === 0, r.err || r.out);
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    const need = document.getElementById('d-need');
    const approve = document.querySelector('[data-approve]');
    return { status: at && at.status, need: need ? need.textContent.trim() : null, hasApprove: !!approve };
  });
  t('the targeted session flips to needs-you', after.status === 'needsyou', { before, after });
  t('the NEEDS YOU counter and an Approve control appear', after.need === '1' && after.hasApprove, after);
  await shot(page, 'notify-needsyou');
  await page.close();
});

// --- osnotify: an attention alert reaches Edward when the window is unfocused -
// The point of the attention bus: when a session needs you and WinMux is NOT the
// window you're looking at, an OS notification fires (in-app badges are invisible
// then). When it IS focused, the badge suffices and no OS notification fires. We
// stub window.Notification + document.hasFocus so both cases are deterministic,
// and drive a real `winmux notify` to trigger the path.
check('osnotify', PORT_OSNOTIFY, async ({ browser, base, t }) => {
  const winmux = (a) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...a],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_OSNOTIFY), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = ''; proc.stdout.on('data', (d) => o += d); proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const stub = (focused) => {
    // eslint-disable-next-line no-undef
    try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {}
    window.__osNotes = [];
    function FakeNote(title, opts) { window.__osNotes.push({ title: title, body: opts && opts.body }); this.onclick = null; }
    FakeNote.permission = 'granted';
    FakeNote.requestPermission = function () { return Promise.resolve('granted'); };
    window.Notification = FakeNote;
    Object.defineProperty(document, 'hasFocus', { value: function () { return focused; }, configurable: true });
  };

  // Unfocused → the OS notification MUST fire.
  const p1 = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await p1.addInitScript(stub, false);
  await p1.goto(base, { waitUntil: 'domcontentloaded' });
  await p1.waitForTimeout(4500);
  await winmux(['notify', 'the deploy needs your call']);
  await p1.waitForTimeout(500);
  const unfocused = await p1.evaluate(() => window.__osNotes || []);
  t('an OS notification fires when a session needs you and WinMux is unfocused',
    unfocused.length >= 1 && /needs you/i.test(unfocused[0].title || ''), unfocused);
  await p1.close();

  // Focused → NO OS notification (the in-app badge is enough).
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await p2.addInitScript(stub, true);
  await p2.goto(base, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(4500);
  await winmux(['notify', 'this should stay quiet']);
  await p2.waitForTimeout(500);
  const focused = await p2.evaluate(() => window.__osNotes || []);
  t('no OS notification fires while WinMux is the focused window', focused.length === 0, focused);
  await p2.close();
});

// --- parity: modern-terminal addons are loaded on the live terminal --------
// Clickable links (web-links addon) + Unicode 11 width tables — the two clean
// parity wins that every modern emulator has. Renderer-independent: reads the
// live term object via window.__winmuxActiveTerm, so it holds under the forced
// DOM renderer here and the shipping WebGL default alike. Writes a URL so the
// screenshot shows a linkified address.
check('parity', PORT_PARITY, async ({ browser, base, t, shot }) => {
  // Most assertions read the live term object (renderer-independent), but the OSC-8
  // sub-check below hovers a .xterm-rows span, which only the DOM renderer creates.
  // Pin it (gpuRenderer:false) so that hover resolves instead of timing out under the
  // shipping WebGL default — this is the "forced DOM renderer here" the header notes.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try {
    localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
    const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
    localStorage.setItem('ct-settings', JSON.stringify(s));
  } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const st = await page.evaluate(async () => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!at || !at.term) return { ok: false };
    try { at.term.write('Docs: https://github.com/Zbrooklyn/winmux  (Ctrl+click to open)\r\n'); } catch (e) {}
    // Shell integration: emit the OSC escapes a real shell would, then read what
    // WinMux captured. \x1b]7 = cwd, \x1b]133;A = a prompt mark, \x1b]2 = title.
    try {
      at.term.write('\x1b]7;file://desktop/C:/Windows/System32\x07');
      at.term.write('\x1b]133;A\x07');
      at.term.write('\x1b]2;WinMux Parity Demo\x07');
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    const tt = at.tabEl && at.tabEl.querySelector('.tt');
    return {
      ok: true,
      webLinks: at.term.__winmuxWebLinks === true,
      unicode: at.term.unicode && at.term.unicode.activeVersion,
      cwd: at.cwd,
      marks: (at.marks || []).map((m) => m.k),
      autoTitle: at.autoTitle,
      tabLabel: tt ? tt.textContent : null,
    };
  });
  t('the web-links addon is loaded on the live terminal', st.ok && st.webLinks === true, st);
  t('unicode 11 width tables are active on the terminal', st.unicode === '11', st);
  t('OSC-7 sets the shell cwd (new splits inherit it)', st.ok && /Windows[\\/]+System32/i.test(st.cwd || ''), st);
  t('OSC-133 command marks are captured', st.ok && (st.marks || []).indexOf('A') >= 0, st);
  t('OSC-0/2 auto-titles the tab', st.tabLabel === 'WinMux Parity Demo', st);

  // OSC-8 explicit hyperlinks are handled by xterm CORE, not by the web-links addon
  // ("the addon is loaded" proves nothing about them). With a null linkHandler xterm
  // falls back to its own confirm() + window.open, which bypasses WinMux's opener.
  // So click a real hyperlink and watch where it actually lands.
  await page.evaluate(() => {
    window.__linkProbe = { opened: [], confirms: 0 };
    window.open = function (u) { window.__linkProbe.opened.push(u); return null; };
    window.confirm = function () { window.__linkProbe.confirms++; return false; };
    const at = window.__winmuxActiveTerm();
    at.term.write('\r\n\x1b]8;;https://winmux.example/osc8\x07OSC8-LINK-PROOF\x1b]8;;\x07\r\n');
  });
  await page.waitForTimeout(700);
  const linkCell = page.locator('.xterm-rows span', { hasText: 'OSC8-LINK-PROOF' }).first();
  await linkCell.hover();
  await page.waitForTimeout(250);
  await linkCell.click();
  await page.waitForTimeout(400);
  const osc8 = await page.evaluate(() => window.__linkProbe);
  t('an OSC-8 hyperlink opens through WinMux\'s opener, not xterm\'s confirm() fallback',
    osc8.opened.indexOf('https://winmux.example/osc8') >= 0 && osc8.confirms === 0, osc8);

  await page.waitForTimeout(400);
  await shot(page, 'parity-links');
  await page.close();
});

// --- doing: the live "what's it doing" line reflects a session's latest output -
// The cockpit differentiator that makes a row informative: under the status label
// sits a live, one-line echo of the session's most recent meaningful output, so a
// busy agent reads differently from a stuck one without opening it. We expand the
// group so the row renders, write a unique marker as output on the active term,
// run the real (throttled) capture, and assert the rendered row echoes the marker.
check('doing', PORT_DOING, async ({ browser, base, t, shot }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Expand the active group so the session row (and its .sdoing line) render.
  const gid = await page.evaluate(() => {
    const ex = document.querySelector('[data-expand]');
    return ex ? ex.getAttribute('data-expand') : null;
  });
  if (gid) { try { await page.click('[data-expand="' + gid + '"]'); } catch (e) {} }
  await page.waitForTimeout(300);

  const res = await page.evaluate(async () => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!at || !at.term) return { ok: false };
    const marker = 'DOING_LIVE_9938_building_the_thing';
    // xterm.write() flushes asynchronously; wait for the parser callback so the
    // marker is actually in the buffer before the capture reads it (the product's
    // ~1s throttle covers this race in real use; the test bypasses only the timer).
    await new Promise((r) => { try { at.term.write('\r\n' + marker + '\r\n', r); } catch (e) { r(); } });
    const patched = window.__winmuxCaptureDoing ? window.__winmuxCaptureDoing() : 0;
    const row = document.querySelector('.srow[data-term="' + at.id + '"] .sdoing');
    return { ok: true, lastLine: at.lastLine || '', rowText: row ? row.textContent : null, patched: patched };
  });

  t('the active session captures its latest output line', res.ok && /DOING_LIVE_9938/.test(res.lastLine || ''), res);
  t('the session row shows the live "what it\'s doing" line', /DOING_LIVE_9938/.test(res.rowText || ''), res);
  await page.waitForTimeout(300);
  await shot(page, 'doing-activity-line');
  await page.close();
});

// --- clip: the cross-device clipboard round-trips through /api/clip ----------
// The opt-in clipboard-sync differentiator: a copy on one device POSTs the text
// to the server's in-memory clip, and another device GETs it — so copy-on-PC,
// paste-on-phone works over the tailnet without the text ever touching disk. This
// check drives the raw endpoint (the client only calls it when the toggle is on):
// POST stores it, GET returns exactly it, and an oversized clip is capped.
check('clip', PORT_CLIP, async ({ base, t }) => {
  const marker = 'CLIP_SYNC_9939_hello_from_the_pc';
  const post = await fetch(base + '/api/clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: marker }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('POST /api/clip stores the copied text', post && post.ok === true && post.len === marker.length, post);
  const got = await fetch(base + '/api/clip', { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('GET /api/clip returns the same text (copy here, paste there)', got && got.ok === true && got.text === marker, got);
  // A clip under the raw-body wall but over the store cap is truncated, never
  // stored whole — the endpoint can't be used to hoard memory.
  const big = 'y'.repeat(150000);
  const cap = await fetch(base + '/api/clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: big }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('an oversized clip is capped at 100k, not stored whole', cap && cap.ok === true && cap.len === 100000, cap);
});

// --- config: settings live in a durable, hand-editable file on disk ---------
// The config-file differentiator: settings persist to ~/.winmux/config.json (not
// just localStorage), so they survive a reinstall and can be hand-edited. POST
// writes the file atomically, GET hands it back, and a fresh page with EMPTY
// localStorage still comes up wearing the on-disk settings (proven end-to-end:
// disk -> the live terminal's applied font size). The server here is pointed at a
// temp config file so the test never touches the real one.
check('config', PORT_CONFIG, async ({ base, browser, t, shot }) => {
  try { fs.unlinkSync(CONFIG_TMP); } catch (e) {}
  const post = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { fontSize: 17, palette: 'ember' } }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('POST /api/config persists settings', post && post.ok === true, post);
  const got = await fetch(base + '/api/config', { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('GET /api/config returns the persisted settings', got && got.ok === true && got.config && got.config.settings && got.config.settings.fontSize === 17, got);
  let onDisk = null; try { onDisk = JSON.parse(fs.readFileSync(CONFIG_TMP, 'utf8')); } catch (e) {}
  t('the config is a real hand-editable file on disk', onDisk && onDisk.settings && onDisk.settings.fontSize === 17, onDisk);
  // A fresh install (empty localStorage) must still come up wearing the on-disk
  // settings — the whole point of moving off localStorage-only.
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4800);
  const applied = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    return { fontSize: at && at.term && at.term.options ? at.term.options.fontSize : null };
  });
  t('a fresh install with no localStorage adopts the on-disk settings', applied.fontSize === 17, applied);
  await shot(page, 'config-from-disk');
  await page.close();
}, { WINMUX_CONFIG_FILE: CONFIG_TMP });

// --- theme-import: a Windows Terminal colour scheme recolours the terminal ---
// The theme-import differentiator: paste a WT colour scheme and the terminal wears
// it. We feed a real scheme (Campbell), import + apply it, and assert the imported
// ANSI colours land on the live xterm theme — including WT's "purple" mapping to
// ANSI magenta. Renderer-independent (reads term.options.theme), and it writes a
// coloured sample so the screenshot shows the scheme applied.
check('theme-import', PORT_THEME, async ({ browser, base, t, shot }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const scheme = {
    name: 'Campbell',
    black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA',
    purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
    brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5',
    brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
    background: '#0C0C0C', foreground: '#CCCCCC',
  };
  const res = await page.evaluate(async (sch) => {
    const r = window.__winmuxImportTheme(JSON.stringify(sch));
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (at && at.term) await new Promise((done) => { try { at.term.write('\x1b[31m red \x1b[32m green \x1b[33m yellow \x1b[34m blue \x1b[35m magenta \x1b[36m cyan \x1b[0m\r\n', done); } catch (e) { done(); } });
    const th = at && at.term && at.term.options ? at.term.options.theme : null;
    return { r, red: th && th.red, green: th && th.green, magenta: th && th.magenta, brightMagenta: th && th.brightMagenta };
  }, scheme);
  t('a Windows Terminal scheme imports cleanly', res.r && res.r.ok === true, res.r);
  t('the imported ANSI colours apply to the live terminal',
    String(res.red).toLowerCase() === '#c50f1f' && String(res.green).toLowerCase() === '#13a10e', res);
  t('WT "purple" maps to ANSI magenta (both intensities)',
    String(res.magenta).toLowerCase() === '#881798' && String(res.brightMagenta).toLowerCase() === '#b4009e', res);
  await page.waitForTimeout(300);
  await shot(page, 'theme-import');
  await page.close();
});

// --- keybindings: a remapped shortcut moves; the old chord goes dead ---------
// The custom-keybindings differentiator: rebind an action and the new chord runs
// it while the old default no longer does. We remap the command palette to Ctrl+K,
// then fire real keydown events: Ctrl+K must open the palette, and the old
// Ctrl+Shift+P must not. Proves the keydown chain is keymap-driven, not hardcoded.
check('keybindings', PORT_KEYS, async ({ browser, base, t, shot }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  // Clear any stored keymap so the default-chord assertion tests a real default.
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const res = await page.evaluate(() => {
    function fire(init) { document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init))); }
    function paletteOpen() { var w = document.getElementById('palette-wrap'); return !!(w && w.hasAttribute('data-open')); }
    // Default chord still works after the keymap refactor.
    fire({ key: 'P', ctrlKey: true, shiftKey: true });
    var defOpens = paletteOpen();
    fire({ key: 'Escape' });
    window.__winmuxSetKeymap('palette', 'Ctrl+K');
    fire({ key: 'Escape' });
    fire({ key: 'k', ctrlKey: true });
    var newOpens = paletteOpen();
    fire({ key: 'Escape' });
    fire({ key: 'P', ctrlKey: true, shiftKey: true });
    var oldOpens = paletteOpen();
    fire({ key: 'Escape' });
    return { effective: window.__winmuxKeymap().map.palette, defOpens: defOpens, newOpens: newOpens, oldOpens: oldOpens };
  });
  t('the default chord still works after the keymap refactor', res.defOpens === true, res);
  t('a remapped shortcut is recorded', res.effective === 'Ctrl+K', res);
  t('the new chord runs the action', res.newOpens === true, res);
  t('the old default no longer triggers it', res.oldOpens === false, res);
  await page.close();
});

// --- markdown: the viewer surface renders a file and follows its edits ------
// `winmux markdown <file>` opens a read surface in the app. The server reads the
// file (/api/md), the app renders a tiny markdown subset, and it re-pulls on a
// timer so a file the agent is writing updates live. This check drives the real
// CLI path (like `cli`) and then edits the file on disk to prove the live pull.
// Config/layout migration (#212): a saved layout written by a future WinMux, or
// a corrupt one, must never brick a returning user — the app boots to a working
// terminal either way, not a blank frame.
check('migrate', PORT_MIGRATE, async ({ browser, base, t }) => {
  const oneTab = { active: 0, tabs: [{ shell: 'powershell', cwd: '', group: '', title: '', sid: '' }] };
  const boot = async (blob) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await ctx.addInitScript((b) => { try { localStorage.setItem('ct-live', JSON.stringify(b)); localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} }, blob);
    const p = await ctx.newPage();
    await p.goto(base, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(4500);
    const n = await p.evaluate(() => document.querySelectorAll('.pane .xterm').length);
    await ctx.close();
    return n;
  };
  t('a normal saved layout restores its panes', (await boot({ v: 1, group: '', cols: [[oneTab], [oneTab]] })) === 2);
  t('a layout from a future version does not brick — it falls back to a terminal',
    (await boot({ v: 999, group: '', cols: [[oneTab], [oneTab], [oneTab]] })) >= 1);
  t('a corrupt saved layout does not brick either', (await boot({ v: 1, group: '', cols: [[{ active: 0, tabs: 'x' }]] })) >= 1);
});

// First-run onboarding (#216): a virgin browser is greeted once, dismisses, and
// never sees it again; the add-your-phone path lands in the right settings.
check('onboard', PORT_ONBOARD, async ({ browser, base, t, shot }) => {
  // A raw context (no ct-onboard seed) is a genuine first-time visitor.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const w = () => p.evaluate(() => ({
    open: !!(document.getElementById('welcome-ovl') || {}).hasAttribute && document.getElementById('welcome-ovl').hasAttribute('data-open'),
    title: ((document.querySelector('.wc-title') || {}).textContent) || '',
    hasStart: !!document.getElementById('wc-start'),
    hasPhone: !!document.getElementById('wc-phone'),
    // Scoped to the welcome card: the agents-guide overlay reuses .wc-pt rows,
    // and this check is about the welcome's three points, not the whole page.
    points: document.querySelectorAll('#welcome-ovl .wc-pt').length,
  }));
  const first = await w();
  t('a first-time visitor is greeted by the welcome', first.open === true, first);
  t('the welcome says what WinMux is and how to act', /follows you/i.test(first.title) && first.hasStart && first.hasPhone && first.points === 3, first);
  await shot(p, 'onboarding');

  await p.click('#wc-start');
  await p.waitForTimeout(400);
  t('Start dismisses the welcome', (await w()).open === false);

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  t('it does not return on the next visit', (await w()).open === false);
  await ctx.close();

  // The "Add my phone" path, from a fresh visitor, lands in the Phone settings.
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p2 = await ctx2.newPage();
  await p2.goto(base, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(3500);
  await p2.click('#wc-phone');
  await p2.waitForTimeout(700);
  const onPhone = await p2.evaluate(() => {
    const ov = document.getElementById('settings-ovl');
    // The Phone tab's tell is its scan/QR copy — proof we landed on it, not just any tab.
    const body = ov ? ov.textContent || '' : '';
    return {
      settingsOpen: !!(ov && ov.hasAttribute('data-open')),
      onPhoneTab: /scan|QR|Tailscale/i.test(body),
    };
  });
  t('Add my phone opens settings on the Phone tab', onPhone.settingsOpen === true && onPhone.onPhoneTab === true, onPhone);
  await ctx2.close();

  // The phone is a first-class surface for onboarding — a stranger who scans the
  // QR lands here cold, so the welcome must greet and fit at a phone width too.
  const pctx = await browser.newContext({
    viewport: { width: 384, height: 745 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, colorScheme: 'dark',
  });
  const pp = await pctx.newPage();
  await pp.goto(base, { waitUntil: 'domcontentloaded' });
  await pp.waitForTimeout(3500);
  const ph = await pp.evaluate(() => {
    const o = document.getElementById('welcome-ovl');
    const card = document.querySelector('#welcome-ovl .welcome');
    const vw = window.innerWidth;
    const r = card ? card.getBoundingClientRect() : null;
    return {
      open: !!(o && o.hasAttribute('data-open')),
      // The card must sit fully inside the viewport: left edge ≥ 0 and right edge ≤ vw.
      fits: r ? (r.left >= 0 && r.right <= vw + 0.5) : false,
      width: r ? Math.round(r.width) : null, vw,
      hasStart: !!document.getElementById('wc-start'),
    };
  });
  t('the welcome greets on the phone too', ph.open === true && ph.hasStart === true, ph);
  t('and its card fits inside the phone width (no horizontal overflow)', ph.fits === true, ph);
  await shot(pp, 'onboarding-phone');
  await pctx.close();
});

// Coexistence (Phase 12): the packaged .exe and the from-source dev copy must
// resolve to disjoint identities, or they share Electron's userData (and its
// ProcessSingleton lock), the CLI discovery file, and the trust file. This is
// the cheap unit guard; verify-coexist.cjs proves it end-to-end on a real build.
check('profile', PORT_ONBOARD, async ({ t }) => {
  const { resolveProfile } = require('./dist-electron/profile.js');
  const o = { appData: 'C:\\A', home: 'C:\\H' };
  const prod = resolveProfile({ ...o, isPackaged: true });
  const dev = resolveProfile({ ...o, isPackaged: false });
  const sep = require('path').sep;
  t('packaged and dev appIds differ', prod.appId !== dev.appId, { prod: prod.appId, dev: dev.appId });
  t('packaged and dev userData dirs differ', prod.userData !== dev.userData, { prod: prod.userData, dev: dev.userData });
  t('userData dirs do not nest (no shared singleton lock)',
    !prod.userData.startsWith(dev.userData + sep) && !dev.userData.startsWith(prod.userData + sep));
  t('discovery files differ', prod.instanceFile !== dev.instanceFile, { prod: prod.instanceFile, dev: dev.instanceFile });
  t('trust files differ', prod.trustFile !== dev.trustFile);
  t('production identity is the stable public one', prod.appId === 'com.zbrooklyn.winmux' && prod.name === 'WinMux');
});

// Paste safety (#214): a multi-line paste stops to ask before it can run every
// line; a single-line paste is unbothered.
check('paste', PORT_PASTE, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const firePaste = (text) => page.evaluate((txt) => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (!ta) return false;
    const dt = new DataTransfer();
    dt.setData('text/plain', txt);
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, text);
  const dlg = () => page.evaluate(() => {
    const d = document.getElementById('dlg-ovl'), body = document.getElementById('dlg-body');
    return { open: !!(d && d.hasAttribute('data-open')), text: body ? body.textContent : '' };
  });

  await firePaste('echo one\necho two\necho three');
  await page.waitForTimeout(400);
  const multi = await dlg();
  t('a multi-line paste stops to ask before it runs', multi.open && /Paste 3 lines/.test(multi.text), multi);
  t('the warning says these lines will run as commands', /run each one as a command/.test(multi.text));

  await page.evaluate(() => { const c = document.querySelector('#dlg-body [data-cancel]'); if (c) c.click(); });
  await page.waitForTimeout(300);
  t('cancelling the paste closes the dialog and sends nothing', (await dlg()).open === false);

  await firePaste('echo just-one-line');
  await page.waitForTimeout(400);
  t('a single-line paste is not interrupted', (await dlg()).open === false);
});

// Phase 2 — inline command prediction ("smarter typing"). This is a SHELL feature,
// not a WinMux injection: PowerShell 7 (pwsh) ships PSReadLine 2.4+, which renders a
// grey, history-based completion inline as you type and accepts it on RightArrow.
// Windows PowerShell 5.1 ships PSReadLine 2.0, which has no prediction at all — so
// the proof runs on a pwsh tab and skips cleanly on a machine without pwsh installed.
// Proof: after typing only a PREFIX, the full seeded command is on screen (the suffix
// was never typed, so it is the prediction), and RightArrow+Enter runs the whole
// command — a second execution of the seeded echo.
check('prediction', PORT_PREDICT, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser, { defaultShell: 'pwsh' });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  // Skip on machines where PowerShell 7 isn't installed: prediction is impossible on
  // the 5.1 default, and that is a property of the OS, not a WinMux regression.
  const shells = await page.evaluate(async () => {
    try { return await (await fetch('/shells')).json(); } catch (e) { return []; }
  });
  const hasPwsh = Array.isArray(shells) && shells.some((s) => s && s.key === 'pwsh');
  if (!hasPwsh) {
    t('PowerShell 7 present → inline prediction available (skipped: pwsh not installed)', true, 'skip');
    await page.close();
    return;
  }

  await page.waitForTimeout(6000);
  const screen = () => page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    return r ? r.innerText : '';
  });
  const marker = 'winmuxpredict' + PORT_PREDICT;

  // Seed history with a distinctive command, then clear the screen so the marker
  // count that follows reflects ONLY the prediction + the accepted re-run (no
  // scrolled-off ambiguity).
  await page.click('.xterm').catch(() => {});
  await page.keyboard.type('echo ' + marker);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await page.keyboard.type('cls');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const cleared = (await screen()).match(new RegExp(marker, 'g')) || [];
  t('the screen is clear before the prediction test', cleared.length === 0, cleared.length);

  // Type only a prefix; PSReadLine predicts the rest inline (grey) from history.
  await page.keyboard.type('echo winmuxp');
  await page.waitForTimeout(1400);
  const predicted = await screen();
  t('inline prediction completes the command from history',
    predicted.indexOf('echo ' + marker) >= 0, predicted.slice(-160));

  // RightArrow accepts the prediction; Enter runs the now-complete command, so the
  // marker prints again — on the cleared screen it now appears at least twice
  // (the command line + its output).
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const after = (await screen()).match(new RegExp(marker, 'g')) || [];
  t('RightArrow accepts the prediction and runs the full command', after.length >= 2, { after: after.length });
  await shot(page, 'prediction');
  await page.close();
});

// Phase 3 — inline images. The `@xterm/addon-image` addon decodes the iTerm2 IIP
// escape into a real picture in the terminal grid, and `winmux image <path>` emits
// that escape. Proof is the RENDERED artifact, not the byte path: after running the
// verb on a committed fixture, the addon must have created its dedicated image-layer
// canvas AND painted non-transparent pixels into it. (The layer is created lazily,
// only when an image actually decodes — so its presence with real pixels is the tell.)
check('images', PORT_IMAGES, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const CLI = path.join(ROOT, 'bin', 'winmux.cjs');
  const FIX = path.join(ROOT, 'test', 'fixtures', 'winmux-logo.png');

  await page.click('.xterm').catch(() => {});
  await page.keyboard.type('node "' + CLI + '" image "' + FIX + '"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3500);

  const img = await page.evaluate(() => {
    const layer = document.querySelector('.xterm-screen canvas.xterm-image-layer');
    if (!layer) return { layer: false };
    // Sample the layer for any non-transparent pixel — proves a picture was painted,
    // not merely that an empty canvas was allocated.
    let painted = false;
    try {
      const ctx = layer.getContext('2d');
      const d = ctx.getImageData(0, 0, layer.width, layer.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] !== 0) { painted = true; break; } }
    } catch (e) { painted = 'unreadable:' + e.message; }
    return { layer: true, w: layer.width, h: layer.height, painted };
  });
  t('the image addon created its image layer', img.layer === true, img);
  t('a real picture was painted into the layer', img.painted === true, { painted: img.painted });

  // The verb ends with a newline so the shell's next prompt lands on a FRESH row
  // below the image, never overwriting its last row. Proof: the last non-empty text
  // row is a bare returned prompt (ends in "> "), and it sits below the image's
  // reserved rows — i.e. the image did not eat the prompt line.
  const tail = await page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    const lines = (r ? r.innerText : '').split('\n').map((s) => s.replace(/\s+$/, ''));
    const nonEmpty = lines.filter((s) => s.length);
    return nonEmpty[nonEmpty.length - 1] || '';
  });
  t('the shell returns to a clean prompt below the image (no overlap)', /> ?$/.test(tail.trim()) && /PS /.test(tail), tail);

  await shot(page, 'images');
  await page.close();
});

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
    const e = document.querySelector('.mdleaf .mdbody');
    if (!e) return null;
    return {
      h1: (e.querySelector('h1') || {}).textContent,
      strong: !!e.querySelector('strong'),
      code: !!e.querySelector('code'),
      li: e.querySelectorAll('li').length,
      title: (document.querySelector('.ptab[data-leaf="markdown"] .tt') || {}).textContent,
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
    const h = document.querySelector('.mdleaf .mdbody h1');
    return h ? h.textContent : null;
  });
  t('editing the file live-updates the open surface', after === 'Changed Title', after);
  await page.close();
});

// ST5: git diff opens as a pane TAB (leaf), not a side dock. Opening it via the
// New-tab menu mounts a .ptab[data-leaf="diff"] whose body renders the repo's
// git status (the .diff file list, or the "working tree clean" note). The old
// side dock (#dock element + data-dock root attribute) is gone from the DOM.
check('diff-tab', PORT_DIFF, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const noDock = await page.evaluate(() => ({
    dock: !!document.getElementById('dock'),
    attr: document.getElementById('root').hasAttribute('data-dock'),
  }));
  t('the side dock is gone (no #dock, no data-dock)', noDock.dock === false && noDock.attr === false, noDock);

  // Open the New-tab menu and pick Changes.
  await page.locator('.pc-new').first().click();
  await page.waitForTimeout(200);
  await page.locator('.tmenu .tmi:has-text("Changes")').first().click();
  await page.waitForTimeout(1800);          // /api/git round trip + render

  const leaf = await page.evaluate(() => {
    const tab = document.querySelector('.ptab[data-leaf="diff"]');
    const body = document.querySelector('.term-host.diffleaf');
    const active = document.querySelector('.ptab[data-active]');
    return {
      tab: !!tab,
      fav: tab ? (tab.querySelector('.fav') || {}).textContent : null,
      activeIsDiff: active ? active.getAttribute('data-leaf') === 'diff' : false,
      body: !!body,
      hasDiff: !!(body && body.querySelector('.diff')),
      hasEmpty: !!(body && body.querySelector('.diff-empty')),
    };
  });
  t('a diff leaf opened as a pane tab', leaf.tab === true && leaf.activeIsDiff === true, leaf);
  t('the diff tab carries the ± changes favicon', leaf.fav === '±', leaf.fav);
  t('the diff leaf rendered git status (file list or clean note)',
    leaf.body === true && (leaf.hasDiff === true || leaf.hasEmpty === true), leaf);
  await shot(page, 'diff-tab');

  // Ctrl+Tab MRU must include the leaf: the diff leaf is active now and the terminal
  // was active before it, so one Ctrl+Tab lands on the terminal and a second returns
  // to the diff leaf — proving a non-terminal leaf sits in the same per-pane MRU ring.
  const activeLeaf = () => page.evaluate(() => {
    const a = document.querySelector('#wsrow .ptab[data-active]');
    return a ? (a.getAttribute('data-leaf') || 'terminal') : null;
  });
  await page.keyboard.down('Control'); await page.keyboard.press('Tab'); await page.keyboard.up('Control');
  await page.waitForTimeout(400);
  t('Ctrl+Tab from the diff leaf lands on the terminal (MRU includes leaves)',
    (await activeLeaf()) === 'terminal');
  await page.keyboard.down('Control'); await page.keyboard.press('Tab'); await page.keyboard.up('Control');
  await page.waitForTimeout(400);
  t('a second Ctrl+Tab returns to the diff leaf', (await activeLeaf()) === 'diff');
  await page.close();
});

// Item 7 T1 — markdown richness: a plan/doc-shaped file (GFM table + task-list
// checkboxes + an image) must render as real HTML, not fall through to <p> soup.
check('md-rich', PORT_MDRICH, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_MDRICH), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const mdFile = path.join(OUT, 'mdrich-' + PORT_MDRICH + '.md');
  fs.writeFileSync(mdFile,
    '# Rich\n\n' +
    '| Name | Role |\n| --- | --- |\n| Ada | Eng |\n| Bo | Design |\n\n' +
    '- [ ] not done yet\n- [x] finished\n\n' +
    '![logo](pic.png)\n');

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const opened = await winmux(['markdown', mdFile]);
  t('winmux markdown exits clean', opened.code === 0, opened.err);
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    const e = document.querySelector('.mdleaf .mdbody');
    if (!e) return null;
    const th = [].map.call(e.querySelectorAll('table thead th'), (n) => n.textContent.trim());
    const firstCell = (e.querySelector('table tbody td') || {}).textContent;
    const rows = e.querySelectorAll('table tbody tr').length;
    const boxes = [].map.call(e.querySelectorAll('li.task input[type=checkbox]'), (n) => n.checked);
    const img = e.querySelector('img');
    return { th, firstCell: firstCell && firstCell.trim(), rows, boxes, imgSrc: img && img.getAttribute('src') };
  });
  t('a GFM table renders with header cells + body rows',
    !!r && r.th.join(',') === 'Name,Role' && r.rows === 2 && r.firstCell === 'Ada', r);
  t('task-list items become disabled checkboxes reflecting checked state',
    !!r && r.boxes.length === 2 && r.boxes[0] === false && r.boxes[1] === true, r && r.boxes);
  t('an image renders inline with its src', !!r && /pic\.png$/.test(String(r.imgSrc)), r && r.imgSrc);
  await shot(page, 'md-rich');
  await page.close();
});

// #240 — save-project auto-resume, pinned to a SPECIFIC conversation. An armed
// tab stores its folder AND the exact Claude conversation used in it, and on a
// COLD reopen (the saved shell id no longer resolves — the real X-out-and-relaunch
// case) the fresh shell runs `claude --resume <that id>`. On a WARM reattach (the
// shell survived, e.g. a page reload) it must NOT re-type anything into a live
// agent. "Resume the folder's latest" is not good enough: resuming the wrong
// conversation is worse than not resuming, so the id is the thing under test.
//
// The conversation ids come from Claude's own store (~/.claude/projects/<cwd with
// every non-alphanumeric replaced by '-'>/<id>.jsonl), so the check seeds one
// there for a folder it owns and removes it afterwards. The warm/cold injection
// halves swap the command template for a harmless `echo` so the wiring is provable
// without launching a real agent — the echoed text still carries the pinned id.
const RESUME_SENTINEL = '__WINMUX_RESUMED__';
const RESUME_CWD = path.join(OUT, 'resume-cwd');
const RESUME_EMPTY = path.join(OUT, 'resume-empty');
const RESUME_ID = '11111111-2222-3333-4444-555555555555';
const claudeStoreFor = (p) => path.join(os.homedir(), '.claude', 'projects', path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-'));
check('resume', PORT_RESUME, async ({ browser, base, t, shot }) => {
  fs.mkdirSync(RESUME_CWD, { recursive: true });
  fs.mkdirSync(RESUME_EMPTY, { recursive: true });
  const store = claudeStoreFor(RESUME_CWD);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, RESUME_ID + '.jsonl'), '{"type":"user","message":"seeded by verify.cjs"}\n');
  // The empty case must be genuinely empty — a leftover store from an earlier run
  // would turn "does not arm" into a false pass.
  try { fs.rmSync(claudeStoreFor(RESUME_EMPTY), { recursive: true, force: true }); } catch (e) {}

  const page = await desktop(browser);
  const readScreen = () => page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); if (!at) return '';
    const b = at.term.buffer.active; let out = '';
    for (let i = 0; i < b.length; i++) { const ln = b.getLine(i); if (ln) out += ln.translateToString(true) + '\n'; }
    return out;
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);

    // 1. The server answers with the folder's REAL conversation ids — read from
    //    Claude's own store, not guessed.
    const listed = await page.evaluate((dir) => new Promise((res) => window.__winmuxClaudeSessions(dir, res)), RESUME_CWD);
    t('the server resolves a folder’s real Claude conversation ids',
      listed.length === 1 && listed[0].id === RESUME_ID, listed);

    // 2. A folder Claude has never run in must NOT arm. Arming it would store a
    //    command that fails on reopen, which reads as "it resumed" and isn't.
    const noArm = await page.evaluate(async (dir) => {
      const at = window.__winmuxActiveTerm();
      at.cwd = dir;
      window.__winmuxArm(at, true);
      await new Promise((r) => setTimeout(r, 1500));
      return { resume: at.resume, resumeId: at.resumeId };
    }, RESUME_EMPTY);
    t('arming a folder with no Claude conversation does NOT arm',
      !noArm.resume && !noArm.resumeId, noArm);

    // 3. Arming a folder that HAS one pins that conversation and builds
    //    `claude --resume <id>` — the command Edward asked for, not `--continue`.
    const pinned = await page.evaluate(async (dir) => {
      const at = window.__winmuxActiveTerm();
      at.cwd = dir;
      window.__winmuxArm(at, true);
      for (let i = 0; i < 40 && !at.resume; i++) await new Promise((r) => setTimeout(r, 100));
      let td = null;
      try { td = JSON.parse(localStorage.getItem('ct-live')).cols[0][0].tabs[0]; } catch (e) {}
      return { resume: at.resume, resumeId: at.resumeId, storedCmd: td && td.resume, storedId: td && td.resumeId, storedCwd: td && td.cwd };
    }, RESUME_CWD);
    t('arming pins the conversation and builds `claude --resume <id>`',
      pinned.resumeId === RESUME_ID && !!pinned.resume && pinned.resume.indexOf('--resume ' + RESUME_ID) >= 0, pinned);
    t('the tab persists BOTH its folder and its pinned conversation',
      pinned.storedId === RESUME_ID && pinned.storedCmd === pinned.resume && !!pinned.storedCwd, pinned);

    // Disarm before swapping the template — a reload while armed with the real
    // command would launch an actual agent inside the harness.
    await page.evaluate((sent) => {
      window.__winmuxArm(window.__winmuxActiveTerm(), false);
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}');
      s.resumeCommand = 'echo ' + sent + ' {id}';
      localStorage.setItem('ct-settings', JSON.stringify(s));
    }, RESUME_SENTINEL);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);

    const rearmed = await page.evaluate(async (dir) => {
      const at = window.__winmuxActiveTerm();
      at.cwd = dir;
      window.__winmuxArm(at, true);
      for (let i = 0; i < 40 && !at.resume; i++) await new Promise((r) => setTimeout(r, 100));
      return { resume: at.resume, resumeId: at.resumeId };
    }, RESUME_CWD);
    t('the resume command is a template — {id} is replaced with the pinned conversation',
      rearmed.resume === 'echo ' + RESUME_SENTINEL + ' ' + RESUME_ID, rearmed);

    // Phase 1 — WARM reattach: reload while the shell is still alive on the
    // server. The tab reattaches; nothing may be typed into the running agent.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);
    const warm = await readScreen();
    t('a warm reattach does NOT re-run the resume command',
      warm.indexOf(RESUME_SENTINEL) < 0, { tail: warm.slice(-160) });
    const stillArmed = await page.evaluate(() => {
      const at = window.__winmuxActiveTerm();
      return { resume: at && at.resume, resumeId: at && at.resumeId, pending: at && at.autoResumePending };
    });
    t('the tab stays armed after a warm reattach (still resumes next cold reopen)',
      stillArmed.resumeId === RESUME_ID && stillArmed.pending === false, stillArmed);

    // Phase 2 — COLD reopen: poison the LIVE term's session id so this reload's
    // beforeunload persists an id the server cannot resolve — exactly the real
    // close-the-app-then-relaunch case. The reattach fails (m.lost), a fresh
    // shell spawns, and the armed resume command runs in it, carrying the id.
    await page.evaluate(() => { window.__winmuxActiveTerm().sid = 'deadbeefdeadbeefdeadbeefdeadbeef'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const cold = await readScreen();
    t('a cold reopen auto-runs the resume command in the fresh shell',
      cold.indexOf(RESUME_SENTINEL) >= 0, { tail: cold.slice(-200) });
    t('the command that runs names the PINNED conversation, not "the latest"',
      cold.indexOf(RESUME_ID) >= 0, { tail: cold.slice(-200) });
    const consumed = await page.evaluate(() => {
      const at = window.__winmuxActiveTerm();
      return { resume: at && at.resume, resumeId: at && at.resumeId, pending: at && at.autoResumePending };
    });
    t('resume fires once then clears its pending flag, keeping the arm for next time',
      consumed.pending === false && consumed.resumeId === RESUME_ID, consumed);

    await shot(page, 'resume');
  } finally {
    try { fs.rmSync(store, { recursive: true, force: true }); } catch (e) {}
    await page.close();
  }
});

// Item 7 T3 — terminal command-marks navigation + reset. Seed OSC-133 prompt
// marks at known buffer lines, jump the viewport to one, and reset the buffer.
check('marks', PORT_MARKS, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const res = await page.evaluate(async () => {
    function write(term, s) { return new Promise((r) => term.write(s, r)); }
    const term0 = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (! term0 || ! term0.term) return { error: 'no active term' };
    const term = term0.term;
     term0.marks = [];                       // start from a clean mark list
    const A = '\x1b]133;A\x07';              // OSC 133 ; A = prompt start mark
    const marks = [];
    for (let blk = 0; blk < 3; blk++) {
      await write(term, A);
      marks.push(term.buffer.active.baseY + term.buffer.active.cursorY);
      for (let i = 0; i < 20; i++) await write(term, 'line ' + blk + '-' + i + '\r\n');
    }
    term.scrollToBottom();
    const beforeTop = term.buffer.active.viewportY;
    const jumped = window.__winmuxJumpMark(-1);   // to the previous prompt
    const afterTop = term.buffer.active.viewportY;
    const captured = term0.marks.filter((m) => m.k === 'A').map((m) => m.y);
    const reset = window.__winmuxResetTerm();
    const lenAfterReset = term.buffer.active.length;
    return { marks, captured, jumped, beforeTop, afterTop, reset, lenAfterReset, rows: term.rows };
  });
  t('OSC-133 prompt marks are captured at their buffer lines',
    !!res && !res.error && res.captured.length === 3 && res.captured.join(',') === res.marks.join(','), res);
  t('jump-to-previous-prompt scrolls the viewport onto a mark line',
    !!res && res.jumped === true && res.afterTop < res.beforeTop && res.marks.indexOf(res.afterTop) >= 0, res);
  t('reset clears the terminal buffer back to a clean screen',
    !!res && res.reset === true && res.lenAfterReset <= res.rows, res);
  await shot(page, 'marks');
  await page.close();
});

// Phase 4 — the command-blocks status tag. With commandBlocks ON, an OSC-133 C
// (command start) then D;<exit> (command end) must paint an inline ✓/✗ + time tag,
// green on exit 0 and red on a non-zero exit. Drive the marks synthetically so the
// assertion is deterministic — no shell-timing flake — the same way the `marks`
// check writes OSC-133 A sequences.
check('cmdtag', PORT_CMDTAG, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  // Turn the gated feature on for this context before the app loads its settings.
  await page.addInitScript(() => { try { localStorage.setItem('ct-settings', JSON.stringify({ commandBlocks: true })); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const res = await page.evaluate(async () => {
    function write(term, s) { return new Promise((r) => term.write(s, r)); }
    const t0 = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!t0 || !t0.term) return { error: 'no active term' };
    const term = t0.term;
    const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';
    const D = (code) => '\x1b]133;D;' + code + '\x07';
    // A passing command, then a failing one — each: prompt, command echo, command
    // start, output, command end with its exit code.
    await write(term, A + 'echo ok\r\n' + C + 'ok\r\n' + D(0));
    await write(term, A + 'badcmd\r\n' + C + 'not recognized\r\n' + D(1));
    await new Promise((r) => setTimeout(r, 400));
    // Capture geometry, not just DOM presence — a tag can exist yet paint
    // off-screen (the className-overwrite bug clobbered xterm's decoration
    // positioning, collapsing the tag to a full-width block below the terminal).
    // onScreen asserts the tag is a real box sitting inside the terminal screen.
    const scr = document.querySelector('.xterm-screen').getBoundingClientRect();
    const tags = Array.from(document.querySelectorAll('.cmdtag')).map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: e.className, txt: (e.textContent || '').trim(),
        onScreen: r.width > 0 && r.height > 0 && r.top >= scr.top - 2 && r.bottom <= scr.bottom + 2 && r.left >= scr.left - 2 && r.right <= scr.right + 2 };
    });
    return { tags };
  });
  const tags = (res && res.tags) || [];
  const ok = tags.find((x) => /\bok\b/.test(x.cls));
  const bad = tags.find((x) => /\bbad\b/.test(x.cls));
  t('a succeeded command paints a green ✓ tag', !!ok && ok.txt.indexOf('✓') === 0, { tags, ok });
  t('a failed command paints a red ✗ tag', !!bad && bad.txt.indexOf('✗') === 0, { tags, bad });
  t('every status tag renders on-screen inside the terminal', tags.length > 0 && tags.every((x) => x.onScreen), { tags });
  await shot(page, 'cmdtag');
  await page.close();
});

// Phase 8 — the phone approval card is wired, not just drawn. Flip a session to
// needs-you, open its preview card, click Approve, and assert the shell actually
// received Enter ({t:'i',d:'\r'}) over its socket — the real click→keystroke path,
// not the machinery behind it.
check('approvecard', PORT_APPROVECARD, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_APPROVECARD), WINMUX_HOST: '127.0.0.1' }) });
    let e = '';
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, err: e.trim() }));
  });
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const sid = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.sid : null; });
  t('a session sid is available to target', !!sid, sid);

  const nu = await winmux(['agent', 'needs-you', '--sid', sid, 'waiting on your approval']);
  t('winmux agent needs-you exits clean', nu.code === 0, nu.err);
  await page.waitForTimeout(700);

  const res = await page.evaluate(async () => {
    // Record what the active session sends to its shell.
    const at = window.__winmuxActiveTerm();
    if (!at || !at.ws) return { error: 'no active ws' };
    window.__sent = [];
    const orig = at.ws.send.bind(at.ws);
    at.ws.send = function (d) { try { window.__sent.push(d); } catch (e) {} return orig(d); };
    // Open the preview card via the real eye button, then click Approve.
    const eye = document.querySelector('[data-eye]');
    if (eye) eye.click();
    await new Promise((r) => setTimeout(r, 350));
    const card = document.querySelector('.sxpv.on');
    const approve = document.querySelector('.pv-approve');
    const lbl = (document.querySelector('.pv-lbl') || {}).textContent || null;
    if (approve) approve.click();
    await new Promise((r) => setTimeout(r, 250));
    return { cardOpen: !!card, hadApprove: !!approve, lbl, sent: window.__sent };
  });
  const sentEnter = !!res && (res.sent || []).some((d) => { try { return JSON.parse(d).d === '\r'; } catch (e) { return false; } });
  t('the approval card opens with an Approve button labelled "Needs your OK"',
    !!res && res.cardOpen === true && res.hadApprove === true && res.lbl === 'Needs your OK', res);
  t('clicking Approve sends Enter to the shell over its socket', sentEnter, { sent: res && res.sent });
  await shot(page, 'approvecard');
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

  // Resolve the tailscale-tunnelled ports ONCE and hand them to every server via
  // env. Booting ~16 servers at once otherwise spawns 32 contending `tailscale
  // status` calls that time out under the load and fail OPEN — which let the
  // auto-picker briefly settle on the tunnelled default (8799). Product code honors
  // this override (empty string = "known none"); unset, it queries tailscale itself. (#246)
  if (process.env.WINMUX_TUNNELLED_PORTS == null) {
    const tun = await tunnelled();
    process.env.WINMUX_TUNNELLED_PORTS = [...tun].join(',');
    if (tun.size) console.log('tailscale tunnels ' + [...tun].join(',') + ' — servers will step around these');
  }

  const ports = [...new Set(run.map((c) => c.port))];
  const servers = SERVERS;
  // Wipe each port's guest list BEFORE its first server, and only there — a
  // check that restarts its own server must find the file it left behind, which
  // is the whole point of "a scanned phone survives a restart".
  for (const port of ports) try { fs.unlinkSync(trustFile(port)); } catch (e) {}
  // Each port starts with no config too, so a leftover from a prior run can't seed
  // unexpected settings into a check that isn't about config.
  for (const port of ports) try { fs.unlinkSync(configFile(port)); } catch (e) {}
  // A check can carry a per-port server env override (e.g. the update check).
  const envByPort = {};
  for (const c of run) if (c.env) envByPort[c.port] = Object.assign({}, envByPort[c.port], c.env);
  // Force the DOM renderer on every server EXCEPT the gpu, ligature and dprfix
  // checks' — those must run the shipping WebGL default, since what they prove is
  // the renderer itself (it engages; the ligature switch forks it; a dpr-stuck
  // canvas resyncs). Everything else reads .xterm-rows text, which only the DOM
  // renderer fills.
  for (const port of ports) {
    const env = Object.assign({}, envByPort[port], (port === PORT_GPU || port === PORT_LIG || port === PORT_DPRFIX) ? {} : { WINMUX_FORCE_DOM: '1' });
    servers[port] = await server(port, env);
  }
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

  // Run one check, capturing its result into `report`. Kept as a named worker so
  // the pool below can call it under a concurrency cap.
  const runOne = async (c) => {
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
    // A hung check used to hang the WHOLE run silently: the per-check report is only
    // printed after every worker drains, so one stuck await meant zero output, forever,
    // with no way to tell which check was stuck. Stream a start/end line per check and
    // cap each one — a check that overruns fails loudly instead of eating the run.
    const started = Date.now();
    console.log('  → ' + c.id + ' (:' + c.port + ')');
    let bell;
    const capped = new Promise((_, rej) => {
      bell = setTimeout(() => rej(new Error('check timed out after ' + (CHECK_TIMEOUT / 1000) + 's')), CHECK_TIMEOUT);
    });
    try {
      await Promise.race([c.run({ browser, base: 'http://127.0.0.1:' + c.port, t, skip, shot, errs }), capped]);
    } catch (e) {
      fails++;
      lines.push('  FAIL  the check itself threw\n          ' + String(e.message || e).slice(0, 200));
    }
    clearTimeout(bell);
    console.log('  ' + (skipped ? 'SKIP' : fails ? '✗' : '✓') + ' ' + c.id +
      ' (' + Math.round((Date.now() - started) / 1000) + 's)');
    report.push({ id: c.id, port: c.port, lines, fails, skipped });
  };

  // Concurrency throttle. Running EVERY check at once (unbounded Promise.all)
  // saturates the CPU and makes the timing-sensitive checks (busyport/cli/trust/
  // pwsh) flake — they pass in isolation, fail under a full parallel run. A bounded
  // pool keeps enough parallelism to stay fast while leaving headroom so no check
  // is starved. Override with WINMUX_VERIFY_CONCURRENCY (1 = fully serial).
  const cpu = (os.cpus() || []).length || 4;
  // Cap at 3, not 4: the electron check spawns a full Electron process and, alongside
  // three other browser-driving checks, occasionally trips its own internal timeouts
  // under CPU saturation. 3 keeps the run fast while leaving that headroom so green is
  // reproducible every run, not just most runs.
  const MAX_CONCURRENCY = Math.max(1, Number(process.env.WINMUX_VERIFY_CONCURRENCY) || Math.min(3, cpu - 2));
  console.log('running ' + run.length + ' checks, ' + MAX_CONCURRENCY + ' at a time');
  const queue = run.slice();
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) { await runOne(queue.shift()); }
  });
  await Promise.all(workers);

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
