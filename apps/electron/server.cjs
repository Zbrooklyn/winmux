// WinMux — serves the cockpit UI and bridges real shell processes to
// the browser terminals over websockets.
//
// This server hands out a real shell, so reaching it IS full control of the
// machine. It therefore listens in two separate places, never one merged one:
//
//   the desk door   — always open, always 127.0.0.1. Only this PC can knock,
//                     so it needs no key.
//   the phone door  — closed until you open it in Settings → Phone. When open
//                     it binds the Tailscale address ONLY (never 0.0.0.0) and
//                     every request must carry a key. Tailscale already
//                     encrypts the traffic and only admits your own devices;
//                     the key is the second lock, in case a device is lost.
//
// The phone door can only be opened or closed from the desk door, so someone
// holding the link can never widen their own access.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const qrcode = require('qrcode');

// The shipping version, read from package.json so it never drifts from the build.
let VERSION = '0.0.0';
try { VERSION = require('./package.json').version || VERSION; } catch (e) {}

// Update check: ask GitHub Releases whether a newer WinMux exists. We only ever
// TELL the user (the .upbadge pill links to the download) — we never auto-install.
// The result is cached for 6h so we don't hammer GitHub, and every failure path
// (offline, private repo, no release yet, rate-limited) degrades to "no update".
const UPDATE_REPO = 'Zbrooklyn/winmux';
const UPDATE_URL = 'https://github.com/' + UPDATE_REPO + '/releases/latest';
let _updCache = { at: 0, data: null };
function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  const pb = String(b).replace(/^v/, '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
async function checkUpdate() {
  // Test hook: the harness sets WINMUX_FAKE_LATEST to prove the badge lights up
  // without a real published release.
  if (process.env.WINMUX_FAKE_LATEST) {
    const fl = process.env.WINMUX_FAKE_LATEST.replace(/^v/, '');
    return { current: VERSION, latest: fl, updateAvailable: cmpSemver(fl, VERSION) > 0, url: UPDATE_URL };
  }
  if (_updCache.data && Date.now() - _updCache.at < 6 * 3600 * 1000) return _updCache.data;
  const out = { current: VERSION, latest: null, updateAvailable: false, url: UPDATE_URL };
  try {
    const ctl = new AbortController();
    const to = setTimeout(function () { ctl.abort(); }, 4000);
    // WINMUX_UPDATE_API points the same request somewhere else, so the harness
    // can prove this whole path — request, parse, version compare — instead of
    // short-circuiting on WINMUX_FAKE_LATEST and proving only the short-circuit.
    const api = process.env.WINMUX_UPDATE_API
      || 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';
    const r = await fetch(api, {
      headers: { 'User-Agent': 'WinMux', 'Accept': 'application/vnd.github+json' }, signal: ctl.signal,
    });
    clearTimeout(to);
    if (r.ok) {
      const j = await r.json();
      if (j && j.tag_name) {
        out.latest = String(j.tag_name).replace(/^v/, '');
        out.url = j.html_url || UPDATE_URL;
        out.updateAvailable = cmpSemver(out.latest, VERSION) > 0;
      }
    }
  } catch (e) { /* offline / private / rate-limited → no update */ }
  _updCache = { at: Date.now(), data: out };
  return out;
}

// An explicitly requested port is obeyed exactly, even when it cannot serve the
// phone door — verify.cjs depends on that to test the busy-port failure. With no
// PORT set we choose for ourselves, and we refuse a port whose Tailscale face is
// taken, because such a port can host the desk door and never the phone one.
const PORT_REQUESTED = process.env.PORT ? parseInt(process.env.PORT, 10) : 8799;
const PORT_FORCED = !!process.env.PORT;
// WINMUX_PORT_CANDIDATES pins the hunt to an exact list — for a locked-down box
// where only certain ports are allowed out, and for the harness, which needs to
// prove the every-port-taken refusal without holding a hundred ports hostage
// from every other check running beside it. An explicit list means "these,
// exactly", so it also turns off the neighbourhood scan below.
const PORT_CANDIDATES = process.env.WINMUX_PORT_CANDIDATES
  ? [...parsePortList(process.env.WINMUX_PORT_CANDIDATES)]
  : [8799, 9912, 9911, 9913, 8800, 8801, 8802];
const PORT_SCAN = !process.env.WINMUX_PORT_CANDIDATES;
// A machine whose whole 88xx block is already spoken for is a normal machine,
// not a broken one — a dev box with three other servers on it hits this on day
// one. So when the curated list runs out we keep walking, in the same
// neighbourhood, rather than giving up on a list of seven. Bounded on purpose:
// a hunt that can end must never turn into a scan of every port on the box.
const PORT_SCAN_FROM = 8803;
const PORT_SCAN_TO = 8899;
let PORT = PORT_REQUESTED;
const PUBLIC = path.join(__dirname, 'public');
const HOST = '127.0.0.1';

// Tailscale hands out addresses in 100.64.0.0/10. We bind that exact address
// rather than 0.0.0.0 so the shell is never offered to a coffee-shop network.
function tailscaleIP() {
  const ifs = os.networkInterfaces();
  for (const name in ifs) {
    for (const a of ifs[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) return a.address;
    }
  }
  return null;
}

// How many other machines are on the tailnet right now. Only ever a label: the
// tailnet-trust switch says "any of these N devices gets in with no key", and a
// switch that cannot tell you how many is a switch nobody can judge. On this
// tailnet the count is not 1 — one of the peers belongs to someone else.
const tailnet = { peers: null, at: 0 };
function refreshTailnetPeers() {
  execFile('tailscale', ['status', '--json'], { timeout: 4000, windowsHide: true }, (err, out) => {
    tailnet.at = Date.now();
    if (err) return;                                   // no CLI, no tailnet, no claim
    try {
      const j = JSON.parse(out);
      tailnet.peers = Object.keys(j.Peer || {}).length;
    } catch (e) {}
  });
}
function tailnetPeers() {
  if (Date.now() - tailnet.at > 60000) refreshTailnetPeers();  // refreshes for NEXT read
  return tailnet.peers;
}
refreshTailnetPeers();

// Can we actually bind this exact host:port right now?
function bindable(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

// Ports that `tailscale serve` / `funnel` already forwards into 127.0.0.1.
// These are the dangerous ones: a serve rule proxies the whole tailnet — or, with
// funnel, the open internet — into loopback, so the request ARRIVES looking like
// it came from this PC. The desk door needs no key precisely because only this PC
// can knock, and a serve rule quietly makes that untrue. It cannot be detected by
// checking who is calling; it can only be stepped around, so we step around it.
// Other rules belong to @edward's other projects — we move, we never rewrite his
// config.
function parsePortList(s) {
  const set = new Set();
  String(s).split(',').forEach((x) => { const n = parseInt(x.trim(), 10); if (n > 0) set.add(n); });
  return set;
}
function tunnelledPorts() {
  // An authoritative override (set even to '' for "known none") skips the
  // subprocess entirely. This is how a caller that already knows the tailscale
  // state — the harness booting many servers at once — avoids a spawn storm of
  // contending `tailscale status` calls that would time out and, worse, fail OPEN.
  if (process.env.WINMUX_TUNNELLED_PORTS != null) {
    return Promise.resolve(parsePortList(process.env.WINMUX_TUNNELLED_PORTS));
  }
  // A timeout means "I couldn't tell," NOT "nothing tunnelled" — failing open on
  // it would hand the tailnet a keyless door. So a killed (timed-out) query is
  // retried once with more headroom before we settle for what we saw. A genuine
  // "no tailscale / no such subcommand" (ENOENT) is not a timeout and resolves empty.
  function query(attempt) {
    return new Promise((resolve) => {
      const found = new Set();
      let left = 2, timedOut = false;
      const done = () => {
        if (--left) return;
        if (timedOut && attempt === 0) { resolve(query(1)); return; }
        resolve(found);
      };
      for (const sub of ['serve', 'funnel']) {
        execFile('tailscale', [sub, 'status'], { timeout: attempt === 0 ? 4000 : 8000, windowsHide: true }, (err, out) => {
          if (err && err.killed) timedOut = true;   // SIGTERM from the timeout, not ENOENT
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
  return query(0);
}

// A port is only usable if BOTH doors can open on it, and if nothing is already
// tunnelling the tailnet into its loopback side. Checking just the desk door is
// how you end up with an app that looks fine and a phone switch that can never
// turn on — on this machine tailscaled itself holds the Tailscale side of the
// old default.
async function pickPort() {
  const ip = tailscaleIP();
  const tunnelled = await tunnelledPorts();
  const usable = async (p) => {
    if (tunnelled.has(p)) return false;
    if (!(await bindable(HOST, p))) return false;
    if (ip && !(await bindable(ip, p))) return false;
    return true;
  };
  for (const p of PORT_CANDIDATES) {
    if (tunnelled.has(p)) {
      console.log('port ' + p + ' is already forwarded to this PC by a tailscale serve rule — skipping it, so the keyless door stays local');
      continue;
    }
    if (await usable(p)) return p;
  }
  if (PORT_SCAN) for (let p = PORT_SCAN_FROM; p <= PORT_SCAN_TO; p++) {
    if (PORT_CANDIDATES.includes(p)) continue;
    if (await usable(p)) return p;
  }
  // Nothing was clean anywhere. This used to `return PORT_CANDIDATES[0]` — the
  // port we may have just refused for being tunnelled — on the theory that a
  // later failure would explain itself. It doesn't: on the auto-pick path there
  // is no later check, so that fallback either crashed on a raw EADDRINUSE or,
  // on a box where the tunnelled port is free, quietly served the keyless desk
  // door to the whole tailnet. Say so instead and let the caller refuse.
  return null;
}

// --- The phone door --------------------------------------------------------
// Held in one place so the toggle, the status readout and the auth check can
// never disagree about whether it is open.
const phone = {
  on: false,
  ip: null,          // the Tailscale address currently bound
  token: '',
  server: null,      // http.Server, or null while closed
  wss: null,
};
function phoneURL() {
  return phone.on ? 'http://' + phone.ip + ':' + PORT + '/?k=' + phone.token : '';
}

// Cross-device clipboard (opt-in). Holds only the most recently copied text, in
// memory — never written to disk — so a copy on the PC can be pulled on the phone
// over the tailnet and back. Ephemeral and small; a client only touches it when
// the user has turned "Sync clipboard across devices" on (default off).
let CLIP = { text: '', at: 0 };

function tokenFrom(req) {
  try {
    const k = new URL(req.url, 'http://x').searchParams.get('k');
    if (k) return k;
  } catch (e) {}
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ct_k=([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

// --- Who we already trust ---------------------------------------------------
// The access key rotates every time the switch is flipped, which is right for a
// link that might leak and wrong for the phone in @edward's pocket — it made a
// scanned QR die at the next restart. A device that has proved it holds the key
// once gets its own long-lived id here, so the key stays disposable and the
// phone stays remembered. This file outlives the process on purpose.
// Overridable so the verification harness can run against a scratch guest list
// instead of @edward's real one. Nothing else sets it; the default is the only
// path the app itself ever uses.
const TRUST_FILE = process.env.WINMUX_TRUST_FILE || path.join(__dirname, '.winmux-devices.json');
const trust = { trustTailnet: false, devices: [] };
function loadTrust() {
  try {
    const t = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
    trust.trustTailnet = !!t.trustTailnet;
    trust.devices = Array.isArray(t.devices) ? t.devices.filter((d) => d && /^[a-f0-9]{32}$/.test(d.id)) : [];
  } catch (e) { /* no file yet, or unreadable — start closed, never open */ }
}
function saveTrust() {
  // Write to a temp file then rename — an atomic swap, so a crash mid-write can
  // never leave a half-written (corrupt, unparseable) guest list that bricks the
  // phone door on the next boot. The rename is atomic on the same filesystem.
  try {
    const tmp = TRUST_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trust, null, 2));
    fs.renameSync(tmp, TRUST_FILE);
  } catch (e) {}
}
loadTrust();

// The durable, hand-editable config: settings, imported terminal themes, and
// keybinding overrides, living beside instance.json in ~/.winmux. The client
// seeds itself from it on boot, so a setting survives a reinstall (localStorage
// does not) and a person can edit the file by hand. Missing or corrupt reads as
// empty — the app still boots on its built-in defaults, and the standalone
// `node server.cjs` path needs no config file at all. WINMUX_CONFIG_FILE overrides
// the path (the harness points it at a temp file so a test never touches the real
// config); a dev profile gets its own file so installed and dev copies never
// clobber each other.
const CONFIG_FILE = process.env.WINMUX_CONFIG_FILE
  || path.join(os.homedir(), '.winmux', process.env.WINMUX_PROFILE === 'dev' ? 'config.dev.json' : 'config.json');
function readConfig() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); return (c && typeof c === 'object') ? c : {}; }
  catch (e) { return {}; }   // no file yet, or unreadable — the app runs on its defaults
}
function writeConfigAtomic(obj) {
  // Temp file + rename, like the trust file: a crash mid-write can never leave a
  // half-written config that bricks the next boot. Create the dir on first write.
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const tmp = CONFIG_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
    return true;
  } catch (e) { return false; }
}

// The live workspace file (PT-3). Per-identity: derived from the instance file's
// name (instance.json → workspace.json, instance.rust.json → workspace.rust.json)
// so each installed identity keeps its own, exactly like discovery and trust.
// WINMUX_WORKSPACE_FILE overrides for tests. Under WINMUX_NO_INSTANCE with no
// override there is no identity to own a file, so the workspace is held in memory
// only — a harness or perf server must never write into the real ~/.winmux.
// Resolved LAZILY, not as a load-time const: under Electron, main.ts sets
// WINMUX_INSTANCE_FILE for the identity AFTER this module is required — a
// load-time snapshot silently derived the PRIMARY identity's workspace.json for
// every packaged variant and the dev copy (a cross-identity leak the harness
// caught as the electron smoke restoring another run's layout).
function workspaceFile() {
  if (process.env.WINMUX_WORKSPACE_FILE) return process.env.WINMUX_WORKSPACE_FILE;
  if (process.env.WINMUX_NO_INSTANCE) return null;   // memory-only
  const inst = process.env.WINMUX_INSTANCE_FILE || path.join(os.homedir(), '.winmux', 'instance.json');
  // A custom WINMUX_INSTANCE_FILE whose name doesn't start with "instance" would
  // make the prefix-swap a no-op — and a workspace write would then CLOBBER the
  // instance file (port/pid discovery). Prefix instead so the two never collide.
  const base = path.basename(inst);
  const wsBase = base.startsWith('instance') ? base.replace(/^instance/, 'workspace') : 'workspace.' + base;
  return path.join(path.dirname(inst), wsBase);
}
let memWorkspace = null;
function readWorkspace() {
  const file = workspaceFile();
  if (!file) return memWorkspace;
  try { const w = JSON.parse(fs.readFileSync(file, 'utf8')); return (w && typeof w === 'object') ? w : null; }
  catch (e) { return null; }
}
function writeWorkspace(doc) {
  const file = workspaceFile();
  if (!file) { memWorkspace = doc; return true; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

// ---- projects: workspaces saved as real files on disk -----------------------
// A project is a `.json` the user can back up, move, or share; the server owns the
// filesystem so every face (Electron, browser, phone) and both engines reach it the
// same way, over /api/project(s). The recents index lives beside config in ~/.winmux
// (a cache, not the source of truth), so it honours WINMUX_CONFIG_FILE and never
// pollutes the real home during tests — same trick as BACKLOG_DIR.
function projectsDir() {
  const d = process.env.WINMUX_PROJECTS_DIR || path.join(os.homedir(), 'Documents', 'WinMux Projects');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
const RECENTS_FILE = path.join(path.dirname(CONFIG_FILE), 'recents.json');
function readRecents() {
  try { const r = JSON.parse(fs.readFileSync(RECENTS_FILE, 'utf8')); return Array.isArray(r.recents) ? r.recents : []; }
  catch (e) { return []; }
}
function writeRecents(list) {
  try {
    fs.mkdirSync(path.dirname(RECENTS_FILE), { recursive: true });
    const tmp = RECENTS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ recents: list.slice(0, 30) }, null, 2));
    fs.renameSync(tmp, RECENTS_FILE);
  } catch (e) {}
}
// Only ever touch a real .json file — reject anything without the extension so a
// bad path can't be steered at an arbitrary host file.
function safeProjectPath(p) {
  if (!p || typeof p !== 'string') return null;
  const r = path.resolve(p);
  return /\.json$/i.test(r) ? r : null;
}
function tabCount(layout) {
  try { return (layout.cols || []).reduce((a, c) => a + c.reduce((b, pd) => b + (pd.tabs || []).length, 0), 0); }
  catch (e) { return 0; }
}
// The recents row wants more than a count: the project's primary folder and the
// shells/leaf-types it opens, so the panel can show folder + chips like a real card.
function projectMeta(layout) {
  let dir = ''; const shells = [];
  try {
    (layout.cols || []).forEach((c) => (c || []).forEach((pd) => (pd.tabs || []).forEach((t) => {
      if (!dir && t.cwd) dir = t.cwd;
      shells.push(t.type && t.type !== 'terminal' ? t.type : (t.shell || 'shell'));
    })));
  } catch (e) {}
  return { dir, shells: shells.slice(0, 6) };
}

// Start WinMux at logon. A copy of a tiny launcher in the user's Startup folder
// makes the app simply present after a reboot instead of "not running until
// someone remembers", which is what makes the scrollback-restore above actually
// pay off. OFF by default: the file only exists once the Settings toggle writes
// it, and turning the toggle off deletes it — nothing else to undo. Under the
// packaged app the launcher reopens the app exe (server + window + layout +
// history); run bare from source it relaunches the detached server via winmux.ps1.
const STARTUP_DIR = process.env.WINMUX_STARTUP_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const AUTOSTART_FILE = path.join(STARTUP_DIR, 'WinMux.vbs');
function autostartVbs() {
  // The pause lets Tailscale finish coming up before WinMux binds its phone door.
  let run;
  if (process.versions && process.versions.electron) run = '"' + process.execPath + '"';
  else run = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'winmux.ps1') + '" start';
  const vbsArg = run.replace(/"/g, '""');   // double every quote for the VBS string literal
  return 'Dim shell : Set shell = CreateObject("WScript.Shell")\r\n'
    + 'WScript.Sleep 20000\r\n'
    + 'shell.Run "' + vbsArg + '", 0, False\r\n';
}
function autostartOn() { try { return fs.existsSync(AUTOSTART_FILE); } catch (e) { return false; } }
function setAutostart(on) {
  try {
    if (on) { fs.mkdirSync(STARTUP_DIR, { recursive: true }); fs.writeFileSync(AUTOSTART_FILE, autostartVbs()); }
    else if (fs.existsSync(AUTOSTART_FILE)) fs.unlinkSync(AUTOSTART_FILE);
    return true;
  } catch (e) { return false; }
}

function deviceIdFrom(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ct_dev=([a-f0-9]{32})/);
  return m ? m[1] : '';
}
function knownDevice(req) {
  const id = deviceIdFrom(req);
  if (!id) return null;
  for (const d of trust.devices) {
    const a = Buffer.from(id), b = Buffer.from(d.id);
    if (a.length !== b.length) continue;
    try { if (crypto.timingSafeEqual(a, b)) return d; } catch (e) {}
  }
  return null;
}
// A label for the Settings list only. Never load-bearing for auth — it comes
// straight from a header the caller controls.
function describeDevice(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iPhone/iPad'
    : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return os + ' · ' + br;
}
function rememberDevice(req, ip) {
  const existing = knownDevice(req);
  const now = new Date().toISOString();
  if (existing) { existing.last = now; existing.ip = ip || existing.ip; saveTrust(); return existing.id; }
  const id = crypto.randomBytes(16).toString('hex');
  trust.devices.push({ id, name: describeDevice(req), first: now, last: now, ip: ip || '' });
  saveTrust();
  console.log('phone access: remembered a new device — ' + describeDevice(req));
  return id;
}
function forgetDevice(id) {
  const before = trust.devices.length;
  trust.devices = trust.devices.filter((d) => d.id !== id);
  const gone = before !== trust.devices.length;
  if (gone) saveTrust();
  // Forgetting has to mean something to a terminal that is open right now,
  // otherwise a revoked device keeps its shell until it feels like leaving.
  if (gone) {
    endSessionsOfDevice(id);
    if (phone.wss) for (const ws of phone.wss.clients) {
      if (ws._ctDev === id) { try { ws.close(4003, 'device forgotten'); } catch (e) {} }
    }
    rotatePhoneKey();
  }
  return gone;
}
function forgetAllDevices() {
  trust.devices = [];
  saveTrust();
  endSessionsOfDevice('');
  if (phone.wss) for (const ws of phone.wss.clients) { try { ws.close(4003, 'devices forgotten'); } catch (e) {} }
  rotatePhoneKey();
}
// Forgetting a device must also invalidate any access key it still holds, or a
// revoked phone walks straight back in on the link it already has and re-mints
// itself. Trusted phones ride their device cookie (ct_dev), not the key, so
// rotating here locks out only the forgotten one. A no-op while the door is shut.
function rotatePhoneKey() {
  if (!phone.on) return;
  phone.token = crypto.randomBytes(16).toString('hex');
  console.log('phone access: key rotated after a device was forgotten');
}
// What Settings is allowed to see. The id is a credential — it goes to the PC,
// which is the only place that can revoke anything, and never back out over the
// phone door, where it would hand one guest the keys of every other.
function deviceList(viaPhone) {
  return trust.devices.map((d) => (viaPhone
    ? { name: d.name, first: d.first, last: d.last }
    : { id: d.id, name: d.name, first: d.first, last: d.last, ip: d.ip }));
}

function keyMatches(req) {
  const got = tokenFrom(req);
  const a = Buffer.from(got), b = Buffer.from(phone.token);
  if (a.length !== b.length) return false;          // length differs → no match
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// Only ever called for requests arriving at the phone door. Three ways in, in
// descending order of how deliberate they are: this device already proved it
// holds the key, the request carries the key right now, or @edward has decided
// the whole tailnet counts (off unless he says otherwise).
function authed(req) {
  if (!phone.on) return false;
  if (trust.trustTailnet) return true;
  if (keyMatches(req)) return true;
  return !!knownDevice(req);
}

// --- Brute-force throttle for the phone door -------------------------------
// The key is 128-bit, so guessing it is already hopeless; this is defence in
// depth and a stop on resource abuse. Only a *deliberate* wrong key (a request
// carrying ?k= that doesn't match) counts — innocent no-credential page hits
// don't — so a legitimate phone never trips it. Too many wrong guesses from one
// address parks that address for a cooldown. In-memory only; cleared on restart.
const AUTH_FAILS = new Map();          // remoteAddress -> { n, resetAt, lockUntil }
const AUTH_MAX = 10;                   // wrong-key guesses within the window...
const AUTH_WINDOW_MS = 60000;          // ...trip a 60s lockout
function authThrottleLocked(req) {
  const rec = AUTH_FAILS.get((req.socket && req.socket.remoteAddress) || '?');
  return !!(rec && rec.lockUntil > Date.now());
}
function noteBadKey(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '?';
  const now = Date.now();
  let rec = AUTH_FAILS.get(ip);
  if (!rec || rec.resetAt < now) rec = { n: 0, resetAt: now + AUTH_WINDOW_MS, lockUntil: 0 };
  rec.n += 1;
  if (rec.n >= AUTH_MAX) { rec.lockUntil = now + AUTH_WINDOW_MS; rec.n = 0; rec.resetAt = now + AUTH_WINDOW_MS; }
  AUTH_FAILS.set(ip, rec);
}

// --- Shell detection -------------------------------------------------------
function onPath(exe) {
  var dirs = (process.env.PATH || '').split(path.delimiter);
  for (var i = 0; i < dirs.length; i++) {
    try { var f = path.join(dirs[i], exe); if (fs.existsSync(f)) return f; } catch (e) {}
  }
  return null;
}
function firstExisting(paths) {
  for (var i = 0; i < paths.length; i++) { try { if (fs.existsSync(paths[i])) return paths[i]; } catch (e) {} }
  return null;
}
// PowerShell 7 (pwsh) is fussy to find. A Microsoft Store install exposes it ONLY
// as an App Execution Alias — a reparse-point stub that fs.existsSync reports as
// MISSING even though node-pty spawns it fine (verified: it runs a real 7.x). So we
// check the MSI/winget path and PATH with existsSync, then fall back to lstat on the
// Store alias, which sees the stub where existsSync can't. Whichever is found spawns.
function detectPwsh() {
  var msi = firstExisting([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
  ]);
  if (msi) return msi;
  var onp = onPath('pwsh.exe');
  if (onp) return onp;
  var alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe');
  try { fs.lstatSync(alias); return alias; } catch (e) {}
  return null;
}

function detectShells() {
  var list = [];
  // -NoLogo suppresses the "Windows PowerShell / Copyright (C) Microsoft..." banner
  // so a new tab opens straight to a prompt instead of two lines of boilerplate.
  list.push({ key: 'powershell', label: 'PowerShell', exec: 'powershell.exe', args: ['-NoLogo'] });
  var pwsh = detectPwsh();
  if (pwsh) list.push({ key: 'pwsh', label: 'PowerShell 7', exec: pwsh, args: ['-NoLogo'] });
  list.push({ key: 'cmd', label: 'Command Prompt', exec: 'cmd.exe', args: [] });
  var gb = firstExisting([
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ]) || onPath('bash.exe');
  if (gb) list.push({ key: 'gitbash', label: 'Git Bash', exec: gb, args: ['--login', '-i'] });
  var wsl = onPath('wsl.exe');
  if (wsl) list.push({ key: 'wsl', label: 'WSL', exec: wsl, args: [] });
  return list;
}
const SHELLS = detectShells();
function shellByKey(key) {
  for (var i = 0; i < SHELLS.length; i++) if (SHELLS[i].key === key) return SHELLS[i];
  return SHELLS[0];
}

// --- Changes panel: real `git` output for a folder -------------------------
function git(args, cwd, cb) {
  execFile('git', args, { cwd, maxBuffer: 12 * 1024 * 1024, windowsHide: true, timeout: 10000 },
    (err, stdout) => cb(err, stdout || ''));
}

// Turn `git diff -U3` text into the file/hunk shape the diff panel renders.
function parsePatch(patch) {
  const files = [];
  let f = null, h = null;
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith('diff --git ')) {
      const m = ln.match(/ b\/(.+)$/);
      f = { path: m ? m[1] : ln.slice(11), st: 'M', add: 0, del: 0, hunks: [] };
      files.push(f); h = null;
      continue;
    }
    if (!f) continue;
    if (ln.startsWith('new file mode')) { f.st = 'A'; continue; }
    if (ln.startsWith('deleted file mode')) { f.st = 'D'; continue; }
    if (ln.startsWith('rename to ')) { f.st = 'R'; continue; }
    if (ln.startsWith('Binary files')) { f.binary = true; continue; }
    if (ln.startsWith('@@')) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (!m) continue;
      h = { h: '@@ -' + m[1] + ' +' + m[2] + ' @@' + (m[3] || ''), ls: +m[1], rs: +m[2], lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h || ln.startsWith('index ') || ln.startsWith('--- ') || ln.startsWith('+++ ')) continue;
    if (ln[0] === '+') { h.lines.push(['a', ln.slice(1)]); f.add++; }
    else if (ln[0] === '-') { h.lines.push(['d', ln.slice(1)]); f.del++; }
    else if (ln[0] === ' ') h.lines.push(['c', ln.slice(1)]);
  }
  // Keep the payload sane on very large diffs.
  files.forEach((x) => {
    let budget = 600;
    x.hunks = x.hunks.filter((hh) => { if (budget <= 0) return false; budget -= hh.lines.length; return true; });
  });
  return files;
}

function gitChanges(cwd, done) {
  git(['rev-parse', '--show-toplevel'], cwd, (err, root) => {
    if (err) return done({ ok: false, error: 'Not a git repository' });
    root = root.trim();
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, (e2, branch) => {
      git(['diff', 'HEAD', '-U3'], cwd, (e3, patch) => {
        const files = e3 ? [] : parsePatch(patch);
        git(['status', '--porcelain'], cwd, (e4, status) => {
          if (!e4) {
            status.split('\n').forEach((l) => {
              if (l.slice(0, 2) !== '??') return;
              const rel = l.slice(3).trim().replace(/^"|"$/g, '');
              if (!rel || rel.endsWith('/')) { files.push({ path: rel, st: 'A', add: 0, del: 0, untracked: true, hunks: [] }); return; }
              const abs = path.join(root, rel);
              let body = [];
              try {
                const st = fs.statSync(abs);
                if (st.size < 200 * 1024) {
                  const txt = fs.readFileSync(abs, 'utf8');
                  if (!/\u0000/.test(txt)) body = txt.split(String.fromCharCode(10)).slice(0, 400).map((t) => ['a', t]);
                }
              } catch (e) {}
              files.push({ path: rel, st: 'A', add: body.length, del: 0, untracked: true,
                hunks: body.length ? [{ h: '@@ new file @@', ls: 1, rs: 1, lines: body }] : [] });
            });
          }
          done({ ok: true, root, branch: (branch || '').trim(), files });
        });
      });
    });
  });
}

// --- Static file server (locked to public/) --------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
// Someone typed the tailnet address by hand instead of scanning the QR. That
// is the common way to arrive here, and "needs its access key" is a dead end —
// it names the problem and hides the fix. This page is self-contained on
// purpose: every asset is behind the same door, so it can load nothing.
function keyNeededPage() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>WinMux — one step left</title><style>' +
    // The app itself follows the device (cockpit.css:7), so the door must too —
    // otherwise a light-mode phone gets a dark refusal in front of a light app.
    // Same four tokens, same values as the stylesheet.
    ':root{color-scheme:light dark;--bg:#1e1e1e;--text:#dadada;--muted:#a8a8a8;--line:#333}' +
    '@media (prefers-color-scheme:light){:root{--bg:#ffffff;--text:#232323;--muted:#5c5c5c;--line:#e2e2e2}}' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:var(--bg);color:var(--text);font:400 16px/1.55 "Segoe UI",system-ui,sans-serif;padding:28px}' +
    '.card{max-width:23rem}' +
    '.brand{font-size:19px;font-weight:600;letter-spacing:-.01em;margin:0 0 26px}' +
    '.brand b{color:#8a5cf5;font-weight:600}' +
    'h1{font-size:21px;font-weight:600;margin:0 0 10px;letter-spacing:-.01em}' +
    'p{margin:0 0 18px;color:var(--muted)}' +
    'ol{margin:0 0 22px;padding-left:1.25em;color:var(--text)}' +
    'li{margin-bottom:9px}' +
    '.note{font-size:13.5px;color:var(--muted);border-top:1px solid var(--line);padding-top:16px;margin:0}' +
    '</style></head><body><main class="card">' +
    '<p class="brand">Win<b>Mux</b></p>' +
    '<h1>One step left</h1>' +
    '<p>WinMux: this link needs its access key. The address on its own can&rsquo;t open a ' +
    'terminal &mdash; the key is what proves it&rsquo;s your phone.</p>' +
    '<ol><li>On your PC, open WinMux.</li>' +
    '<li>Go to <strong>Settings &rarr; Phone</strong>.</li>' +
    '<li>Scan the QR code with your phone&rsquo;s camera.</li></ol>' +
    '<p class="note">Scan it once and this phone is remembered &mdash; it keeps working after ' +
    'restarts, without scanning again. Typing the address by hand never works: the key is the ' +
    'part that&rsquo;s missing.</p>' +
    '</main></body></html>';
}

function handle(req, res, viaPhone) {
  // Phone door: no key, no anything. Checked before the URL is even read.
  if (viaPhone) {
    // An address that has burned through its guesses waits out the cooldown
    // before it is even asked for a key again.
    if (authThrottleLocked(req)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
      res.end('WinMux: too many attempts. Wait a minute and try again.');
      return;
    }
    if (!authed(req)) {
      // Count only deliberate wrong keys toward the throttle — a request that
      // carried a ?k= that didn't match. Browsing with no key at all is not a
      // guess; it just gets the key-needed page.
      try { if (new URL(req.url, 'http://x').searchParams.get('k')) noteBadKey(req); } catch (e) {}
      // A person gets the page; a script, an asset, or the websocket gets the line.
      if (/text\/html/.test(req.headers.accept || '')) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(keyNeededPage());
        return;
      }
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('WinMux: this link needs its access key.');
      return;
    }
  }
  // Arriving with a valid ?k= parks it in a cookie so the rest of the page
  // (scripts, fonts, the websocket) authenticates without the key in every URL,
  // and mints the device id that lets this phone skip the QR next time. Both
  // only ever on a real key match — never because trustTailnet waved it in, or
  // switching the tailnet on and off again would silently trust the room.
  if (viaPhone) {
    try {
      if (new URL(req.url, 'http://x').searchParams.get('k') && keyMatches(req)) {
        const dev = rememberDevice(req, req.socket.remoteAddress);
        res.setHeader('Set-Cookie', [
          'ct_k=' + phone.token + '; Path=/; HttpOnly; SameSite=Strict',
          // A year, because the point is to outlive restarts and key rotation.
          'ct_dev=' + dev + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000',
        ]);
      } else if (/text\/html/.test(req.headers.accept || '')) {
        // Page loads only — refreshing "last seen" on every asset would rewrite
        // the file dozens of times per screen.
        const d = knownDevice(req);
        if (d) { d.last = new Date().toISOString(); saveTrust(); }
      }
    } catch (e) {}
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  // Phone access: read the state from anywhere, change it only from this PC.
  if (urlPath === '/api/phone') {
    if (req.method === 'POST') {
      if (viaPhone) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Phone access can only be changed at the PC itself.' }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        let msg = {};
        try { msg = JSON.parse(body || '{}'); } catch (e) {}
        // Trusting the whole tailnet is a separate decision from opening the
        // door at all, so it is a separate field — and it persists, because
        // re-deciding it every restart is the chore we are removing.
        if (Object.prototype.hasOwnProperty.call(msg, 'trustTailnet')) {
          trust.trustTailnet = !!msg.trustTailnet;
          saveTrust();
          console.log('phone access: tailnet trust ' + (trust.trustTailnet ? 'ON — any device on the tailnet, no key' : 'OFF'));
        }
        if (!Object.prototype.hasOwnProperty.call(msg, 'on')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(Object.assign({ ok: true }, phoneState(false))));
          return;
        }
        setPhone(!!msg.on, (r) => {
          res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r));
        });
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(phoneState(viaPhone)));
    return;
  }
  // Remembered devices: readable anywhere, revocable only at the PC. Same rule
  // as the switch itself — a leaked link must never be able to edit the guest
  // list, and never learns another device's id (only its own, which it holds).
  if (urlPath === '/api/phone/devices') {
    if (req.method === 'POST') {
      if (viaPhone) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Remembered devices can only be changed at the PC itself.' }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        let msg = {};
        try { msg = JSON.parse(body || '{}'); } catch (e) {}
        if (msg.all) forgetAllDevices();
        else if (typeof msg.forget === 'string') forgetDevice(msg.forget);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, devices: deviceList(viaPhone) }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ devices: deviceList(viaPhone), canChange: !viaPhone }));
    return;
  }
  // The link as a scannable square, so nobody types a 32-character key.
  if (urlPath === '/api/phone/qr') {
    if (!phone.on) { res.writeHead(404); res.end('off'); return; }
    qrcode.toString(phoneURL(), { type: 'svg', margin: 1, width: 190 }, (err, svg) => {
      if (err) { res.writeHead(500); res.end('qr failed'); return; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      res.end(svg);
    });
    return;
  }
  // Small API: the list of shells the picker can offer.
  if (urlPath === '/shells') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SHELLS.map((s) => ({ key: s.key, label: s.label }))));
    return;
  }
  // Changes panel: real `git` state for a folder.
  if (urlPath === '/api/git') {
    let q = {};
    try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) {}
    // No folder given → read the server's launch directory (the repo WinMux was
    // started from), not $HOME. $HOME is never a repo; the launch dir usually is.
    const cwd = q.cwd && fs.existsSync(q.cwd) ? q.cwd : process.cwd();
    gitChanges(cwd, (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Object.assign({ cwd }, payload)));
    });
    return;
  }

  // The durable config: GET hands the client its on-disk settings/themes/keymap on
  // boot; POST persists them. This is the user's own config, so it rides the same
  // cookie auth as the rest and is allowed over the tailnet (settings follow you to
  // the phone). It only ever reads/writes the one fixed config path — never arbitrary
  // disk — and is size-capped.
  if (urlPath === '/api/config') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1000000) req.destroy(); });
      req.on('end', () => {
        let incoming = {};
        try { incoming = JSON.parse(body || '{}') || {}; } catch (e) {}
        const cur = readConfig();
        // The client owns whole sub-objects (all of settings, all themes, all
        // keymap overrides) — replace each provided one, leave the others intact.
        ['settings', 'themes', 'keymap'].forEach((k) => {
          if (incoming[k] && typeof incoming[k] === 'object') cur[k] = incoming[k];
        });
        const ok = writeConfigAtomic(cur);
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, config: readConfig() }));
    return;
  }

  // The live workspace — the always-auto-saved current layout (STATE.md contract).
  // The engine owns it as a real file so it survives a wiped browser profile and a
  // reinstall; the window's localStorage copy is only a warm cache. One workspace
  // per installed identity, so the file rides the identity's instance-file name
  // (instance.rust.json → workspace.rust.json). Desk-door only, like projects: the
  // phone attaches to the desk's workspace and never owns one.
  if (urlPath === '/api/workspace') {
    if (viaPhone) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'the workspace lives at the PC, not over the network' }));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4000000) req.destroy(); });
      req.on('end', () => {
        let incoming = {};
        try { incoming = JSON.parse(body || '{}') || {}; } catch (e) {}
        const ok = (incoming.workspace && typeof incoming.workspace === 'object')
          ? writeWorkspace({ winmuxWorkspace: 1, savedAt: Date.now(), workspace: incoming.workspace })
          : false;
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }
    const doc = readWorkspace();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, workspace: doc ? doc.workspace : null, savedAt: doc ? doc.savedAt || 0 : 0 }));
    return;
  }

  // Projects — save / list / read / forget a workspace file. Reads and writes host
  // disk, so it is desk-door only: a phone attaches to an already-open workspace and
  // has no business writing .json files onto the PC. Same guard as /api/md.
  if (urlPath === '/api/projects' || urlPath === '/api/project') {
    if (viaPhone) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'projects are available only at the PC, not over the network' }));
    }
    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    // GET /api/projects — recents (with missing flags) + the default folder.
    if (urlPath === '/api/projects') {
      const list = readRecents().map((r) => Object.assign({}, r, { missing: !fs.existsSync(r.path) }));
      return sendJson(200, { dir: projectsDir(), recents: list });
    }
    // GET /api/project?path= — one project's contents.
    if (req.method === 'GET') {
      let q = {}; try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) {}
      const p = safeProjectPath(q.path);
      if (!p || !fs.existsSync(p)) return sendJson(404, { error: 'not found' });
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return sendJson(200, { name: j.name || path.basename(p, '.json'), layout: j.layout || j, modified: j.modified || 0 });
      } catch (e) { return sendJson(400, { error: 'unreadable' }); }
    }
    // POST /api/project { name, path?, layout } — write the file, upsert recents.
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4000000) req.destroy(); });
      req.on('end', () => {
        let incoming = {}; try { incoming = JSON.parse(body || '{}') || {}; } catch (e) {}
        const name = String(incoming.name || 'Untitled').trim() || 'Untitled';
        let p = safeProjectPath(incoming.path);
        if (!p) {
          const slug = name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'project';
          p = path.join(projectsDir(), slug + '.winmux.json');
        }
        const now = Date.now();
        let created = now; try { created = JSON.parse(fs.readFileSync(p, 'utf8')).created || now; } catch (e) {}
        const doc = { winmuxProject: 1, name, created, modified: now, layout: incoming.layout || {} };
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          const tmp = p + '.' + process.pid + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
          fs.renameSync(tmp, p);
        } catch (e) { return sendJson(500, { error: 'write failed: ' + e.message }); }
        const meta = projectMeta(incoming.layout || {});
        const rec = { path: p, name, tabs: tabCount(incoming.layout || {}), dir: meta.dir, shells: meta.shells, opened: now };
        writeRecents([rec].concat(readRecents().filter((r) => r.path !== p)));
        return sendJson(200, { path: p });
      });
      return;
    }
    // DELETE /api/project?path=&trash=1 — drop from recents; unlink only with trash.
    // The path rides in the query, not a request body: DELETE-with-body is unevenly
    // supported across HTTP clients/proxies (the body can arrive empty), so a query
    // param is the one form every client sends reliably.
    if (req.method === 'DELETE') {
      let q = {}; try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) {}
      const p = safeProjectPath(q.path);
      if (!p) return sendJson(400, { error: 'bad path' });
      // Delete first, and only forget the project once the file is really gone.
      // A file another program is holding open (Dropbox, an editor, a virus
      // scan) survives the unlink — dropping the recents row then would tell the
      // user it was deleted while leaving it on disk with nothing left pointing
      // at where it lives. Already-missing counts as deleted; anything else is
      // reported, not swallowed.
      const wantTrash = q.trash === '1' || q.trash === 'true';
      if (wantTrash) {
        try { fs.unlinkSync(p); }
        catch (e) { if (e.code !== 'ENOENT') return sendJson(409, { ok: false, error: 'could not delete the file (' + (e.code || e.message) + ')' }); }
      }
      writeRecents(readRecents().filter((r) => r.path !== p));
      return sendJson(200, { ok: true, deleted: wantTrash });
    }
    return sendJson(405, { error: 'method not allowed' });
  }

  // Start WinMux at logon. GET reports whether the Startup launcher exists; POST
  // { on } writes or removes it. Desk-door only — it changes THIS machine's
  // startup, which is nothing a networked phone should ever reach in to touch.
  if (urlPath === '/api/autostart') {
    if (viaPhone) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ on: false, error: 'available only at the PC' })); }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        let want = false;
        try { want = !!(JSON.parse(body || '{}') || {}).on; } catch (e) {}
        const ok = setAutostart(want);
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok, on: autostartOn() }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ on: autostartOn() }));
    return;
  }

  // Save-terminal-history switch (saved scrollback is secrets-at-rest: tokens and
  // passwords a command printed live in those files). GET reports whether saving
  // is on; POST { persist } flips it — turning it off also wipes what's already on
  // disk. Desk-door only, like autostart: it governs THIS machine's files.
  if (urlPath === '/api/history') {
    if (viaPhone) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ persist: true, error: 'available only at the PC' })); }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        let persist = true;
        try { const b = JSON.parse(body || '{}') || {}; persist = b.persist !== false; } catch (e) {}
        const wiped = setHistoryPersist(persist);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ persist, wiped }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ persist: !historyOff }));
    return;
  }

  // Cross-device clipboard (opt-in). POST { text } stores the latest clip in
  // memory; GET returns it. Allowed over the tailnet on purpose — that is the whole
  // point (copy on the PC, paste on the phone) — and safe because it only ever hands
  // back text a client chose to sync, never touches the disk, and the client only
  // uses it when the toggle is on. Size-capped so it can't be used to hoard memory.
  if (urlPath === '/api/clip') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
      req.on('end', () => {
        let text = '';
        try { text = String((JSON.parse(body || '{}') || {}).text || ''); } catch (e) {}
        CLIP = { text: text.slice(0, 100000), at: Date.now() };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, at: CLIP.at, len: CLIP.text.length }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, text: CLIP.text, at: CLIP.at }));
    return;
  }

  // The markdown viewer reads a file off this disk and hands back its text +
  // mtime, so the surface can render it and re-poll to live-update on save.
  if (urlPath === '/api/md') {
    // Reads an arbitrary file off this disk — desk-door only. Never let the phone
    // (or any tailnet device) turn the markdown viewer into a file-exfiltration
    // hole for .ssh keys, .env, or anything else on the host.
    if (viaPhone) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'reading files is available only at the PC, not over the network' }));
    }
    let q = {};
    try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) {}
    const file = q.path || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const st = fs.statSync(file);
      const text = fs.readFileSync(file, 'utf8');
      res.end(JSON.stringify({ ok: true, path: file, text, mtime: st.mtimeMs }));
    } catch (e) {
      res.end(JSON.stringify({ ok: false, error: 'cannot read: ' + (e.code || e.message), path: file }));
    }
    return;
  }
  // Dragging a folder from Explorer onto a terminal is how people say "cd here".
  // A browser refuses to tell a page where a dropped folder actually lives — it
  // hands over the name and the child names and withholds the path on purpose.
  // That is a hard wall in the browser, but not on this machine: the server is
  // standing on the same disk, so it can just go and find the folder whose name
  // and contents match what the browser saw.
  if (urlPath === '/api/findpath') {
    // Walks the host's folders to resolve a dropped-folder path — desk-door only.
    // A phone can't drag from Explorer anyway, so there is nothing to lose by
    // refusing, and everything to lose by letting the network enumerate the disk.
    if (viaPhone) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ hits: [] }));
    }
    let q = {};
    try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) {}
    findFolder(q.name || '', (q.kids || '').split('|').filter(Boolean), q.near || '', (hits) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ hits }));
    });
    return;
  }
  // Diagnostics modal: what this server actually is right now.
  if (urlPath === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: VERSION,
      // `runtime` is the row Diagnostics shows: which engine is actually serving
      // you. `node` stays for anything still reading it.
      pid: process.pid, node: process.version, runtime: 'Node ' + process.version,
      platform: process.platform,
      arch: process.arch, uptime: Math.round(process.uptime()), host: HOST, port: PORT,
      home: os.homedir(), cpus: os.cpus().length,
      mem: Math.round(os.totalmem() / 1073741824) + ' GB',
      shells: SHELLS.map((s) => s.label),
      sessions: SESSIONS.size,
      // Shells still running with nobody watching them — the ones waiting out
      // a sleeping phone. Worth seeing, because they are real processes.
      detached: [...SESSIONS.values()].filter((s) => !s.ws).length,
      // Saved scrollbacks with no live session behind them — the honest count
      // beside `detached`, so 235 recovery files can never again hide behind a
      // "detached: 0" (PT-4). Live sessions keep their own backlog files current;
      // those aren't "recoverable", they're running, so they don't count here.
      recoverable: (() => {
        try { return fs.readdirSync(BACKLOG_DIR).filter((f) => f.endsWith('.json') && !SESSIONS.has(f.slice(0, -5))).length; }
        catch (e) { return 0; }
      })(),
      // Where this identity's state actually lives on disk — real paths, so the
      // Diagnostics panel and the cheat-sheet "Where your stuff lives" card can
      // answer the question without a docs hunt (PT-7).
      workspaceFile: workspaceFile() || '(memory only)',
      projectsDir: projectsDir(),
      backlogDir: BACKLOG_DIR,
      configFile: CONFIG_FILE,
      phone: phone.on ? 'on (' + phone.ip + ')' : 'off',
    }));
    return;
  }

  // Scrollback that outlived a reboot. When WinMux restarts and the layout restore
  // reopens a tab whose live session the server no longer holds, the client asks
  // here for that session's saved output and replays it as dimmed history above the
  // fresh prompt. Only the device that owned the session may read it — the same
  // guest-list rule as picking a live shell back up.
  if (urlPath === '/api/backlog') {
    let sid = '';
    try { sid = new URL(req.url, 'http://x').searchParams.get('sid') || ''; } catch (e) {}
    // DELETE ?sid= — dismiss a saved scrollback for good. The visible Recent &
    // recoverable list's second verb; also fired after a successful replay, so a
    // delivered backlog never lists itself again as if it were still waiting.
    if (req.method === 'DELETE') {
      const bl = sid ? readBacklog(sid) : null;
      let ok = false;
      if (bl && (bl.dev || '') === deviceIdFrom(req)) {
        try { fs.unlinkSync(backlogPath(sid)); ok = true; } catch (e) {}
      }
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok }));
    }
    // No sid — the list (PT-4): everything this device could get back, each entry
    // carrying its expiry so nothing ever vanishes silently (STATE.md invariant 1).
    // Parsing is bounded: each file carries a whole scrollback, and this server is
    // single-threaded — parsing thousands of them here would stall every request
    // queued behind the list (a real freeze, seen in the harness at 2400 files).
    // So: cheap stat pass over everything, full parse only for the newest 30, and
    // the honest total rides along so a capped list never reads as "that's all".
    if (!sid) {
      const LIST_CAP = 30;
      let names = [];
      try {
        names = fs.readdirSync(BACKLOG_DIR).filter((f) => f.endsWith('.json')).map((f) => {
          let m = 0; try { m = fs.statSync(path.join(BACKLOG_DIR, f)).mtimeMs; } catch (e) {}
          return { f, m };
        }).sort((a, b) => b.m - a.m);
      } catch (e) {}   // no backlog dir yet — an empty list, not an error
      const items = [];
      for (const { f, m } of names) {
        if (items.length >= LIST_CAP) break;
        const id = f.slice(0, -5);
        const o = readBacklog(id);
        if (!o || (o.dev || '') !== deviceIdFrom(req)) continue;
        items.push({ sid: id, shell: o.shell || '', cwd: o.cwd || '', savedAt: o.savedAt || Math.round(m),
          expiresAt: Math.round(m + BACKLOG_MAX_AGE_MS), live: SESSIONS.has(id) });
      }
      // mtime picked the cheap cap; savedAt (the document's own stamp) orders what
      // the user sees — files written in the same instant must not flip around.
      items.sort((a, b) => b.savedAt - a.savedAt);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, items, total: names.length, maxAgeMs: BACKLOG_MAX_AGE_MS }));
    }
    const bl = readBacklog(sid);
    if (!bl || (bl.dev || '') !== deviceIdFrom(req)) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ found: false }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ found: true, buf: bl.buf || '', shell: bl.shell || '', cwd: bl.cwd || '', savedAt: bl.savedAt || 0 }));
  }

  // Is a newer WinMux out? Tells the UI's update badge; never installs anything.
  if (urlPath === '/api/update') {
    checkUpdate().then(function (u) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(u));
    }).catch(function () {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ current: VERSION, latest: null, updateAvailable: false, url: UPDATE_URL }));
    });
    return;
  }

  // Which Claude Code conversations belong to a folder. An armed tab pins ONE of
  // these ids so reopening WinMux resumes exactly that conversation (`claude
  // --resume <id>`) instead of guessing at "the latest". Claude keeps one directory
  // per cwd under ~/.claude/projects, named by replacing every non-alphanumeric
  // character of the path with '-', holding one <conversation-id>.jsonl each. We
  // read file NAMES and mtimes in that one directory — never a transcript's
  // contents, and never other folders. Desk-door only, like /rpc.
  if (urlPath === '/api/claude-sessions') {
    if (viaPhone) { res.writeHead(403); return res.end('winmux: available only at the PC, not over the network'); }
    const reply = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(o));
    };
    let cwd = '';
    try { cwd = new URL(req.url, 'http://x').searchParams.get('cwd') || ''; } catch (e) {}
    if (!cwd) return reply({ ok: false, error: 'missing cwd', sessions: [] });
    let dir;
    try { dir = path.join(os.homedir(), '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')); }
    catch (e) { return reply({ ok: false, error: 'bad cwd', sessions: [] }); }
    fs.readdir(dir, (err, names) => {
      // No directory = this folder has never run Claude. That is a normal answer,
      // not an error: the UI must say "nothing to resume here" rather than arm
      // something that would fail on reopen.
      if (err) return reply({ ok: true, dir, sessions: [] });
      const out = [];
      for (const n of names || []) {
        if (!/\.jsonl$/i.test(n)) continue;
        let st = null;
        try { st = fs.statSync(path.join(dir, n)); } catch (e) { continue; }
        if (!st.size) continue;                     // an empty transcript resumes into nothing
        out.push({ id: n.replace(/\.jsonl$/i, ''), mtime: st.mtimeMs, size: st.size });
      }
      out.sort((a, b) => b.mtime - a.mtime);
      reply({ ok: true, dir, sessions: out.slice(0, 25) });
    });
    return;
  }

  // The command channel for the `winmux` CLI. Desk-door only: the phone must
  // never be able to drive the app. Forwards to a connected /control client.
  if (urlPath === '/rpc') {
    if (viaPhone) { res.writeHead(403); return res.end('winmux: /rpc is available only at the PC, not over the network'); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let msg; try { msg = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'bad JSON' })); }
      if (!msg || typeof msg.cmd !== 'string') { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'missing cmd' })); }
      try {
        // Agent-job verbs (Stage 3) are handled by the server itself so a wait
        // works with no browser attached; everything else is relayed to the app.
        let result;
        if (msg.cmd === 'job-wait') result = await agentJobWait(msg.args);
        else { const jr = agentJobDispatch(msg.cmd, msg.args); result = (jr !== null) ? jr : await callApp(msg.cmd, msg.args); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        const code = /no app connected/.test(e.message) ? 409 : /in time/.test(e.message) ? 504 : 422;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Deliberate shutdown of the (usually detached) server — the "quit WinMux
  // completely" path. Desk-door only: the phone must never be able to kill the PC's
  // server and strand nothing. Replies first, then kills every shell and exits, which
  // fires the exit handlers that clean up the instance file.
  if (urlPath === '/api/shutdown') {
    if (viaPhone) { res.writeHead(403); return res.end('winmux: shutdown is available only at the PC, not over the network'); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bye: true }));
    setTimeout(() => { try { killAllShells(); } catch (e) {} process.exit(0); }, 60);
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // Harness-only: WINMUX_FORCE_DOM makes the app use the DOM renderer instead of
    // the shipping WebGL default, so verify.cjs checks that read .xterm-rows text
    // stay valid (WebGL paints to a <canvas>). Never set in production, so the
    // phone/browser serving path is byte-identical there.
    if (process.env.WINMUX_FORCE_DOM && /index\.html$/.test(filePath)) {
      data = Buffer.from(String(data).replace('</head>', '<script>window.__winmuxForceDom=true;</script></head>'));
    }
    // Never let a browser hold on to yesterday's app. This is a local server on
    // a fixed port that gets rebuilt constantly, so a cached index.html/app.js
    // shows a version of the app that no longer exists — and the person reads
    // that as "the server is broken." Bandwidth here is a loopback copy.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
}

// The desk door. Bound to 127.0.0.1, so it needs no key.
const server = http.createServer((req, res) => handle(req, res, false));

// --- Opening and closing the phone door ------------------------------------
function phoneState(viaPhone) {
  return {
    on: phone.on,
    ip: phone.ip,
    port: PORT,
    url: phoneURL(),
    // Whether THIS browser is allowed to flip the switch.
    canChange: !viaPhone,
    tailscale: !!tailscaleIP(),
    trustTailnet: trust.trustTailnet,
    // null when we could not ask tailscale — the UI must then say so rather
    // than print a confident number it does not have.
    tailnetPeers: tailnetPeers(),
    devices: deviceList(viaPhone),
  };
}

function setPhone(want, done) {
  if (want === phone.on) return done(Object.assign({ ok: true }, phoneState(false)));
  if (!want) {
    // Closing drops every phone terminal with it — that is the point of an off switch.
    try { if (phone.wss) phone.wss.close(); } catch (e) {}
    const s = phone.server;
    phone.on = false; phone.ip = null; phone.token = ''; phone.wss = null; phone.server = null;
    if (s) { try { s.closeAllConnections(); } catch (e) {} s.close(() => {}); }
    console.log('phone access: OFF');
    return done(Object.assign({ ok: true }, phoneState(false)));
  }
  const ip = process.env.CT_HOST || tailscaleIP();
  if (!ip) {
    return done({ ok: false, error: 'Tailscale is not running on this PC, so there is no private address to listen on. Start Tailscale and try again.' });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const srv = http.createServer((req, res) => handle(req, res, true));
  const wssP = new WebSocketServer({
    server: srv,
    path: '/pty',
    verifyClient: (info, cb) => (authed(info.req) ? cb(true) : cb(false, 401, 'Unauthorized')),
  });
  wssP.on('connection', onShellConnection);
  // A failed phone door must never take the desk door down with it. Both the
  // http server and the socket server get a handler, because an unhandled
  // 'error' on either one is a hard process exit — which would kill every
  // terminal the person has open just because a port was busy.
  let settled = false;
  const fail = (e) => {
    try { wssP.close(); } catch (x) {}
    try { srv.close(); } catch (x) {}
    phone.on = false; phone.ip = null; phone.token = ''; phone.server = null; phone.wss = null;
    if (settled) { console.log('phone access: failed after start — ' + e.message); return; }
    settled = true;
    const busy = e && e.code === 'EADDRINUSE';
    console.log('phone access: could not start — ' + e.message);
    done({ ok: false, error: busy
      ? 'Something else on this PC is already using port ' + PORT + ' on your Tailscale address. Close it, or start this app on a different port, then try again.'
      : 'Could not listen on ' + ip + ':' + PORT + ' — ' + e.message });
  };
  srv.on('error', fail);
  wssP.on('error', fail);
  srv.listen(PORT, ip, () => {
    settled = true;
    phone.on = true; phone.ip = ip; phone.token = token; phone.server = srv; phone.wss = wssP;
    console.log('phone access: ON  →  ' + phoneURL());
    done(Object.assign({ ok: true }, phoneState(false)));
  });
}

// --- Finding a folder the browser refused to name --------------------------
// Places that are enormous, uninteresting, or both. Walking into them turns a
// half-second answer into a minute of disk grinding for a folder nobody drags.
const FIND_SKIP = new Set([
  'node_modules', '.git', 'appdata', 'windows', 'program files', 'program files (x86)',
  'programdata', '$recycle.bin', 'system volume information', '.cache', '__pycache__',
  'venv', '.venv', 'dist', 'build', '.next', 'onedrivetemp',
]);
const FIND_DEPTH = 6;
const FIND_BUDGET = 12000;   // directories looked at before we give up
const FIND_MS = 4000;

// Chunked on purpose: a synchronous walk would freeze every terminal on the
// machine while it ran. 200 directories per tick keeps the shells responsive.
function findFolder(name, kids, near, done) {
  const want = String(name).toLowerCase();
  if (!want) return done([]);
  const kidSet = new Set(kids.map((k) => String(k).toLowerCase()));
  const seen = new Set();
  const hits = [];
  const started = Date.now();
  let budget = FIND_BUDGET;

  // Nearest first: the folder you are already sitting in, then home, then the
  // two places this machine actually keeps work.
  const roots = [near, os.homedir(), path.join(os.homedir(), 'Dropbox'), 'C:\\dev', 'C:\\']
    .filter(Boolean)
    .filter((r) => { try { return fs.statSync(r).isDirectory(); } catch (e) { return false; } });
  const queue = roots.map((r) => ({ dir: r, depth: 0 }));

  function score(dir) {
    if (!kidSet.size) return 0.5;   // an empty folder can only match by name
    let got = 0;
    try {
      for (const e of fs.readdirSync(dir)) if (kidSet.has(e.toLowerCase())) got++;
    } catch (e) { return 0; }
    return got / kidSet.size;
  }

  function tick() {
    let n = 0;
    while (queue.length && n++ < 200) {
      if (budget-- <= 0 || Date.now() - started > FIND_MS) { queue.length = 0; break; }
      const { dir, depth } = queue.shift();
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const low = e.name.toLowerCase();
        if (FIND_SKIP.has(low) || low.startsWith('$')) continue;
        const full = path.join(dir, e.name);
        if (low === want) {
          const s = score(full);
          if (s > 0) hits.push({ path: full, score: s });
          // A perfect content match is the folder. Stop paying for more.
          if (s === 1) { queue.length = 0; break; }
        }
        if (depth + 1 <= FIND_DEPTH) queue.push({ dir: full, depth: depth + 1 });
      }
    }
    if (queue.length) return setImmediate(tick);
    hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    done(hits.slice(0, 5));
  }
  setImmediate(tick);
}

// --- Shells that outlive their socket --------------------------------------
// A terminal used to be one shell welded to one websocket: close the socket and
// the shell died with it. That is fine at a desk and wrong everywhere else — a
// phone sleeping, a lid closing, a wifi hop, or a tab left in the background
// long enough all close that socket, and the person comes back to a dead
// rectangle with their work gone. So a shell belongs to the person, not to the
// connection. It keeps running while nobody is attached, remembers what it
// printed, and is picked up again by id when the browser returns.
const SESSIONS = new Map();

// Control clients: the running app(s) a `winmux` CLI command drives. The CLI
// never connects here — it POSTs /rpc on the desk door and the server forwards
// the command to the most-recently-active app over its /control socket. Only the
// desk door (127.0.0.1) carries /control, so this is a local-only channel.
const CONTROL = new Map();               // id -> { ws, lastSeen }
let controlSeq = 0;
const RPC = new Map();                   // reqId -> { resolve, reject, timer }
let rpcSeq = 0;

function pickControl() {
  let best = null;
  for (const c of CONTROL.values()) if (!best || c.lastSeen > best.lastSeen) best = c;
  return best;
}

// Forward one command to a live app and await its correlated reply. Rejects if
// no app is connected or the app does not answer in time.
function callApp(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = pickControl();
    if (!c || c.ws.readyState !== c.ws.OPEN) return reject(new Error('no app connected'));
    const reqId = ++rpcSeq;
    const timer = setTimeout(() => { RPC.delete(reqId); reject(new Error('the app did not answer in time')); }, 8000);
    RPC.set(reqId, { resolve, reject, timer });
    c.ws.send(JSON.stringify({ rpc: reqId, cmd, args: args || {} }));
  });
}

// ── Agent job store (Stage 3) ───────────────────────────────────────────────
// A server-side record of orchestrated agent jobs, so one session (A) can spawn
// another (B), wait until B actually finishes, and get B's result as data — not
// by screen-scraping. Lives in the server (not the renderer) so a wait works with
// no browser attached. In-memory, per-instance, keyed by a minted jobId (a session
// runs many jobs over its life, so the SID is not the unit of work). Desk-door
// only — /rpc already refuses the phone. Terminal states (done/failed) are the
// first report to win and are then immutable, so a stale report can't satisfy a
// new wait. The Rust core mirrors this exactly (WINMUX_CORE=rust).
const AGENT_JOBS = new Map();        // jobId -> job record
const AGENT_WAITERS = new Map();     // jobId -> Set<fn> resolvers blocked on it
let agentJobSeq = 0;
const JOB_RESULT_CAP = 64 * 1024;    // a result payload larger than this is truncated + flagged
const JOB_MAX = 200;                 // keep at most this many jobs (oldest evicted)
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
const JOB_TERMINAL = new Set(['done', 'failed']);
function mintJobId() { return 'job_' + Date.now().toString(36) + '_' + (++agentJobSeq).toString(36); }
function jobPublic(j) {
  return j ? { jobId: j.jobId, sid: j.sid, name: j.name, state: j.state, result: j.result,
    truncated: !!j.truncated, exitCode: j.exitCode, startedAt: j.startedAt, updatedAt: j.updatedAt, endedAt: j.endedAt } : null;
}
function evictJobs() {
  const now = Date.now();
  for (const [id, j] of AGENT_JOBS) if (j.endedAt && now - j.endedAt > JOB_TTL_MS) AGENT_JOBS.delete(id);
  while (AGENT_JOBS.size > JOB_MAX) { const first = AGENT_JOBS.keys().next().value; AGENT_JOBS.delete(first); }
}
function wakeJobWaiters(jobId) { const s = AGENT_WAITERS.get(jobId); if (s) for (const fn of [...s]) fn(); }
// P6 supervision (parity with the Rust core): a worker session that dies before
// reporting must fail its jobs so waiters wake with the reason instead of
// hanging until timeout. Idempotent — terminal jobs are immutable. Called from
// both death paths (pty onExit and the deliberate endSession).
function failJobsForSid(sid, exitCode) {
  if (!sid) return;
  const now = Date.now();
  for (const j of AGENT_JOBS.values()) {
    if (j.sid !== sid || JOB_TERMINAL.has(j.state)) continue;
    j.state = 'failed';
    j.result = 'worker session exited' + (exitCode != null ? ' (code ' + exitCode + ')' : '') + ' before reporting a result';
    if (exitCode != null) j.exitCode = exitCode;
    j.updatedAt = now; j.endedAt = now;
    wakeJobWaiters(j.jobId);
  }
}
// Handle a job verb server-side. Returns a result object, or null if `cmd` is not
// a job verb (the caller then relays it to the app as before).
function agentJobDispatch(cmd, args) {
  args = args || {};
  if (cmd === 'job-register') {
    const jobId = mintJobId(); const now = Date.now();
    const j = { jobId, sid: args.sid || null, name: args.name || null, state: 'working',
      result: null, truncated: false, exitCode: null, startedAt: now, updatedAt: now, endedAt: null };
    AGENT_JOBS.set(jobId, j); evictJobs();
    return { job: jobPublic(j) };
  }
  if (cmd === 'job-report') {
    const j = AGENT_JOBS.get(args.jobId);
    if (!j) throw new Error('unknown jobId: ' + args.jobId);
    if (JOB_TERMINAL.has(j.state)) return { job: jobPublic(j) };   // first terminal report wins; then immutable
    let st = String(args.state || '');
    if (st === 'needs-you') st = 'needsyou';
    if (['working', 'needsyou', 'done', 'failed'].indexOf(st) < 0) throw new Error('bad job state: ' + st);
    j.state = st;
    if (args.result != null) { let r = String(args.result); if (r.length > JOB_RESULT_CAP) { r = r.slice(0, JOB_RESULT_CAP); j.truncated = true; } j.result = r; }
    if (args.exitCode != null) j.exitCode = Number(args.exitCode);
    j.updatedAt = Date.now();
    if (JOB_TERMINAL.has(j.state)) { j.endedAt = j.updatedAt; wakeJobWaiters(j.jobId); }
    return { job: jobPublic(j) };
  }
  if (cmd === 'job-status') { const j = AGENT_JOBS.get(args.jobId); if (!j) throw new Error('unknown jobId: ' + args.jobId); return { job: jobPublic(j) }; }
  if (cmd === 'job-list') { return { jobs: [...AGENT_JOBS.values()].map(jobPublic) }; }
  return null;
}
// Block until a job reaches a terminal state or the (bounded, resumable) timeout.
// On timeout it returns the current record (state still 'working'), so the caller
// can immediately wait again — the default sits well under a Claude Bash-tool
// ceiling so `winmux agent wait` never gets killed mid-call.
function agentJobWait(args) {
  args = args || {};
  const j = AGENT_JOBS.get(args.jobId);
  if (!j) return Promise.reject(new Error('unknown jobId: ' + args.jobId));
  if (JOB_TERMINAL.has(j.state)) return Promise.resolve({ job: jobPublic(j), waited: false });
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 90000, 500), 570000);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer);
      const set = AGENT_WAITERS.get(args.jobId); if (set) { set.delete(finish); if (!set.size) AGENT_WAITERS.delete(args.jobId); }
      resolve({ job: jobPublic(AGENT_JOBS.get(args.jobId)), waited: true });
    };
    if (!AGENT_WAITERS.has(args.jobId)) AGENT_WAITERS.set(args.jobId, new Set());
    AGENT_WAITERS.get(args.jobId).add(finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// How long an unattended shell waits for you before giving up. Long enough to
// cover a commute or a meeting; short enough that a forgotten tab doesn't leave
// a PowerShell running on this PC all week.
const GRACE_MS = 10 * 60 * 1000;
// What it can show you when you get back. Roughly a few screens of output.
const SCROLLBACK = 256 * 1024;

// Phase 5 — scrollback that outlives the server. The in-memory buf (above) covers
// a detach/reattach, but a full Windows reboot kills this whole process, so the
// buf must also live on disk. We write each session's recent output to a small
// file keyed by its session id; after a reboot the client fetches it (GET
// /api/backlog) and replays it as dimmed history above the fresh prompt. Files
// are device-scoped by the meta they carry and pruned by age on start.
const BACKLOG_DIR = path.join(path.dirname(CONFIG_FILE), 'backlog');
const BACKLOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // a week of "come back to it"
const BACKLOG_THROTTLE_MS = 2000;                     // at most one write per session per 2s
function backlogPath(sid) {
  // sid is our own generated id (hex); keep the path from ever escaping the dir.
  if (!/^[a-zA-Z0-9_-]+$/.test(sid)) return null;
  return path.join(BACKLOG_DIR, sid + '.json');
}
// History-persistence switch (readiness #13): the flag file's presence disables
// saving terminal history to disk; disabling also wipes what's already there.
const HISTORY_OFF_FLAG = path.join(path.dirname(CONFIG_FILE), 'history-off.flag');
let historyOff = false;
try { historyOff = fs.existsSync(HISTORY_OFF_FLAG); } catch (e) {}
function setHistoryPersist(persist) {
  historyOff = !persist;
  let wiped = 0;
  try {
    if (persist) { if (fs.existsSync(HISTORY_OFF_FLAG)) fs.unlinkSync(HISTORY_OFF_FLAG); }
    else {
      fs.mkdirSync(path.dirname(HISTORY_OFF_FLAG), { recursive: true });
      fs.writeFileSync(HISTORY_OFF_FLAG, 'off\n');
      for (const f of fs.readdirSync(BACKLOG_DIR)) {
        if (!f.endsWith('.json')) continue;
        try { fs.unlinkSync(path.join(BACKLOG_DIR, f)); wiped++; } catch (e) {}
      }
    }
  } catch (e) {}   // no backlog dir yet is fine
  return wiped;
}
function saveBacklog(s) {
  if (historyOff) return;
  const p = backlogPath(s.id); if (!p) return;
  try {
    fs.mkdirSync(BACKLOG_DIR, { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ id: s.id, dev: s.dev || '', shell: s.shell, cwd: s.cwd, buf: s.buf, savedAt: Date.now() }));
    fs.renameSync(tmp, p);
  } catch (e) {}
}
function scheduleBacklogSave(s) {
  if (s._blTimer) return;                              // one pending write is enough
  s._blTimer = setTimeout(() => { s._blTimer = null; saveBacklog(s); }, BACKLOG_THROTTLE_MS);
}
function readBacklog(sid) {
  const p = backlogPath(sid); if (!p) return null;
  try { const o = JSON.parse(fs.readFileSync(p, 'utf8')); return (o && typeof o === 'object') ? o : null; }
  catch (e) { return null; }
}
function pruneBacklog() {
  try {
    for (const f of fs.readdirSync(BACKLOG_DIR)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(BACKLOG_DIR, f);
      try { if (Date.now() - fs.statSync(fp).mtimeMs > BACKLOG_MAX_AGE_MS) fs.unlinkSync(fp); } catch (e) {}
    }
  } catch (e) {}   // no dir yet is fine
}
pruneBacklog();

function endSession(s, why) {
  if (!s || !SESSIONS.has(s.id)) return;
  SESSIONS.delete(s.id);
  failJobsForSid(s.id, null);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  try { s.term.kill(); } catch (e) {}
  if (s.ws) { try { s.ws.close(4003, why || 'closed'); } catch (e) {} }
}
// Revocation cannot be outlived: forgetting a device has to reach the shells it
// left running unattended, not only the ones it happens to be holding open.
function endSessionsOfDevice(id) {
  for (const s of [...SESSIONS.values()]) if (id ? s.dev === id : s.dev) endSession(s, 'device forgotten');
}

// Point a socket at a shell, and arrange for the shell to survive losing it.
function attach(s, ws) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  // Two browsers, one shell: the newcomer wins, so a stale tab can't keep
  // swallowing the keystrokes meant for the one you are looking at.
  if (s.ws && s.ws !== ws) { try { s.ws.close(4004, 'picked up elsewhere'); } catch (e) {} }
  s.ws = ws;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') s.term.write(msg.d);
    else if (msg.t === 'r' && msg.c > 0 && msg.r > 0) {
      try { s.term.resize(msg.c, msg.r); } catch {}
      // A fresh shell rendered its first prompt into the blind 80x24 spawn buffer
      // (a pre-warmed spare has been sitting at that prompt for a while). Now that
      // the client's true size has landed, ask PSReadLine to repaint via Ctrl+L
      // (its default ClearScreen binding) so the prompt lands top-anchored at the
      // real width instead of stranded mid-screen where the 24-row coordinates put
      // it. Once only, and never on a resumed session — that would wipe scrollback.
      if (s.needsClear) { s.needsClear = false; try { s.term.write('\f'); } catch {} }
    }
    // Closing a tab on purpose is the one close that still means "kill it".
    // Everything else is treated as an interruption worth waiting out.
    else if (msg.t === 'x') endSession(s, 'closed by you');
  });
  ws.on('close', () => {
    if (s.ws !== ws) return;             // a newer socket already took over
    s.ws = null;
    if (!SESSIONS.has(s.id)) return;     // the shell is already gone
    s.timer = setTimeout(() => endSession(s, 'nobody came back'), GRACE_MS);
  });
}

// The desk door's sockets. The phone door gets its own, key-checked, in
// setPhone. Both desk sockets are noServer + one upgrade router below, because
// two {server,path} WebSocketServers on one HTTP server fight over the upgrade
// event (the first 400s the other's path).
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', onShellConnection);

// The control socket — only on the desk door, so only this PC's app can be
// driven by the local `winmux` CLI. Each app registers; the server forwards
// /rpc commands here and matches replies by reqId.
const ctlWss = new WebSocketServer({ noServer: true });
ctlWss.on('connection', (ws) => {
  const id = ++controlSeq;
  CONTROL.set(id, { ws, lastSeen: Date.now() });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const c = CONTROL.get(id); if (c) c.lastSeen = Date.now();
    if (m && m.rpc && RPC.has(m.rpc)) {          // a reply to a forwarded command
      const pend = RPC.get(m.rpc); RPC.delete(m.rpc); clearTimeout(pend.timer);
      if (m.ok) pend.resolve(m.result); else pend.reject(new Error(m.error || 'the app rejected the command'));
    }
  });
  ws.on('close', () => CONTROL.delete(id));
  ws.on('error', () => CONTROL.delete(id));
});

// Route desk-door upgrades to the right socket server by path.
server.on('upgrade', (req, socket, head) => {
  let p = '/'; try { p = new URL(req.url, 'http://x').pathname; } catch (e) {}
  if (p === '/pty') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else if (p === '/control') ctlWss.handleUpgrade(req, socket, head, (ws) => ctlWss.emit('connection', ws, req));
  else socket.destroy();
});
// A pre-warmed spare shell. Spawning a PowerShell (profile + modules) is the slow
// part of opening a tab; the loading beat you see is mostly that. So we keep one
// already-booted at the default shell + home dir, sitting OFF the books (never in
// SESSIONS, so it is not counted as a live terminal), and hand it over the instant
// a matching tab opens — then boot the next spare. WINMUX_NO_PREWARM=1 turns it off.
// A small POOL (not one) means two new tabs in a row are both instant, not just the
// first — the "predicted" feel. Sized by WINMUX_SPARE_POOL (default 2).
let spares = [];
const SPARE_POOL = Math.max(1, Number(process.env.WINMUX_SPARE_POOL) || 2);
// Prefer PowerShell 7 when it's installed: it renders inline history prediction
// ("smarter typing") natively, where Windows PowerShell 5.1 (PSReadLine 2.0) cannot.
// Falls back to 5.1 when pwsh is absent. This also warms the spare pool on the shell
// new tabs will actually request (the frontend's startShell() prefers pwsh the same
// way), so the instant-open handoff still matches.
const DEFAULT_SHELL_KEY = SHELLS.some((s) => s.key === 'pwsh') ? 'pwsh' : 'powershell';

function spawnSession(shell, cwd) {
  // Every shell learns its own WinMux identity, the way tmux exports $TMUX_PANE.
  // The session id exists before the pty so an agent's Claude Code hook running
  // inside this terminal can address exactly this session (winmux agent … --sid).
  const id = crypto.randomBytes(16).toString('hex');
  // node-pty's `name` option does NOT reliably export TERM into the child env on
  // Windows/ConPTY, so a fresh shell sees TERM=undefined and colour-aware programs
  // (Claude Code, git, vim, ls --color) fall back to flat, uncoloured output. Set
  // TERM + COLORTERM explicitly so the shell advertises 256-colour + truecolour,
  // which xterm here fully renders.
  const env = Object.assign({}, process.env, {
    WINMUX_SID: id, WINMUX_PORT: String(PORT),
    TERM: 'xterm-256color', COLORTERM: 'truecolor',
  });
  // Scrub the launching process's own agent/session pollution before handing the
  // shell to the user. If WinMux was started from inside a Claude Code session it
  // inherited NO_COLOR=1 — the universal "disable all colour" switch, which forces
  // Claude Code, git, ls, etc. to flat uncoloured output no matter what TERM says —
  // and the CLAUDE_CODE_* / CLAUDECODE markers, which make a `claude` run in this
  // terminal think it's a child session (no transcript, degraded mode). A WinMux
  // terminal must be a clean top-level shell regardless of what launched the app.
  for (const k of Object.keys(env)) {
    if (k === 'NO_COLOR' || k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  const term = pty.spawn(shell.exec, shell.args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
  // Inline command prediction (grey history completion, RightArrow to accept) is a
  // shell feature, not ours to inject: PowerShell 7 (pwsh) renders it by default via
  // PSReadLine 2.4+. Windows PowerShell 5.1 ships PSReadLine 2.0, which predates
  // -PredictionSource entirely, so no injection can turn it on there. We honour the
  // shell the user picked and leave prediction to it — a per-session Set-PSReadLineOption
  // would be dead on 5.1 and redundant on pwsh. The default-shell picker (Settings)
  // is how a user opts into the pwsh experience.
  const s = { id, term, dev: '', shell: shell.label, cwd, buf: '', ws: null, timer: null };
  term.onData((d) => {
    s.buf += d;
    if (s.buf.length > SCROLLBACK) s.buf = s.buf.slice(-SCROLLBACK);
    if (s.ws && s.ws.readyState === s.ws.OPEN) s.ws.send(Buffer.from(d, 'utf8'));
    if (SESSIONS.has(s.id)) scheduleBacklogSave(s);   // real sessions only; a spare isn't in SESSIONS yet
  });
  term.onExit((ev) => {
    const si = spares.indexOf(s);
    if (si !== -1) { spares.splice(si, 1); ensureSpare(); return; }   // a spare died before it was ever used
    failJobsForSid(s.id, ev && typeof ev.exitCode === 'number' ? ev.exitCode : null);
    if (!SESSIONS.has(s.id)) return;
    SESSIONS.delete(s.id);
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (s.ws && s.ws.readyState === s.ws.OPEN) {
      try { s.ws.send(JSON.stringify({ type: 'meta', exited: true })); } catch (e) {}
      try { s.ws.close(4005, 'shell exited'); } catch (e) {}
    }
  });
  return s;
}

function ensureSpare() {
  if (process.env.WINMUX_NO_PREWARM) return;
  while (spares.length < SPARE_POOL) {
    let s;
    try { s = spawnSession(shellByKey(DEFAULT_SHELL_KEY), os.homedir()); } catch (e) { break; }
    spares.push(s);
  }
}

// Kill every shell this server owns — the unattached spares AND every live session
// — so shutting the server down never strands PowerShell processes. Shared by the
// graceful-exit path (start) and the deliberate /api/shutdown route.
function killAllShells() {
  for (const sp of spares) { try { sp.term.kill(); } catch (e) {} }
  spares = [];
  // Flush each live session's scrollback before we kill it, so a graceful stop
  // (or /api/shutdown) leaves the same come-back-to-it history a crash would.
  for (const s of SESSIONS.values()) { try { saveBacklog(s); } catch (e) {} try { s.term.kill(); } catch (e) {} }
}

function onShellConnection(ws, req) {
  // Which remembered device this terminal belongs to, so that forgetting a
  // device closes the shell it is holding right now rather than at its leisure.
  const dev = deviceIdFrom(req);
  ws._ctDev = dev;
  let sid = '', key = 'powershell', want = '';
  try {
    const qs = new URL(req.url, 'http://x').searchParams;
    sid = qs.get('sid') || '';
    key = qs.get('shell') || 'powershell';
    want = qs.get('cwd') || '';
  } catch (e) {}

  // Coming back to a shell we kept warm. Only the device that started it may
  // pick it up, so a session id is not a way around the guest list.
  const held = sid ? SESSIONS.get(sid) : null;
  if (held && held.dev === dev) {
    attach(held, ws);
    ws.send(JSON.stringify({ type: 'meta', sid: held.id, shell: held.shell, cwd: held.cwd, resumed: true }));
    if (held.buf) ws.send(Buffer.from(held.buf, 'utf8'));
    return;
  }

  const shell = shellByKey(key);
  // Honour a requested start folder only when it really is one.
  let cwd = os.homedir();
  try { if (want && fs.statSync(want).isDirectory()) cwd = want; } catch (e) {}

  // Hand over the pre-warmed spare when the request matches it (the common case:
  // the default shell at home) — that is the instant open. Otherwise boot one
  // cold. Either way, refill the spare so the next tab is instant too. The spare's
  // onData/onExit were wired at spawn, so adopting it is just claiming the object.
  let s;
  if (spares.length && key === DEFAULT_SHELL_KEY && cwd === os.homedir()) {
    s = spares.shift();
  } else {
    try {
      s = spawnSession(shell, cwd);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'meta', error: 'Failed to start ' + shell.label + ': ' + e.message }));
      ws.close();
      return;
    }
  }
  s.dev = dev;
  SESSIONS.set(s.id, s);
  ensureSpare();

  // `lost` says we were asked for a session that is no longer here, so the app
  // can say that plainly instead of pretending this fresh shell is the old one.
  ws.send(JSON.stringify({ type: 'meta', sid: s.id, shell: s.shell, cwd: s.cwd, resumed: false, lost: !!sid }));
  // A brand-new shell printed its prompt blind at 80x24; the first client resize
  // will trigger a clean top-anchored repaint (see the resize handler in attach()).
  s.needsClear = true;
  attach(s, ws);
}

function announce() {
  console.log('WinMux running at http://' + HOST + ':' + PORT);
  console.log('shells:', SHELLS.map((s) => s.label).join(', '));
  // CT_REMOTE=1 just pre-opens the same door the Settings toggle opens.
  if (process.env.CT_REMOTE === '1') {
    setPhone(true, (r) => {
      if (!r.ok) { console.error('phone access could not start: ' + r.error); return; }
      console.log('');
      console.log('That link is a shell on this PC. Anyone holding it, on your tailnet,');
      console.log('has your machine. Keep it out of chats and screenshots.');
    });
  } else {
    console.log('phone access: off — turn it on in Settings → Phone');
  }
}

async function start() {
  if (!PORT_FORCED) {
    PORT = await pickPort();
    if (PORT == null) {
      console.error('WinMux could not find a free port to start on.');
      console.error('It tried ' + PORT_CANDIDATES.join(', ')
        + (PORT_SCAN ? ' and every port from ' + PORT_SCAN_FROM + ' to ' + PORT_SCAN_TO : '') + '.');
      console.error('Each one was either already in use or forwarded to this PC by a tailscale serve rule.');
      console.error('Close whatever is holding those ports, or pick one yourself:');
      console.error('  $env:PORT = 9200; node server.cjs');
      throw new Error('refused: no free port available');
    }
    if (PORT !== PORT_REQUESTED) {
      console.log('port ' + PORT_REQUESTED + ' was busy on your Tailscale address — using ' + PORT + ' instead');
    }
  } else if ((await tunnelledPorts()).has(PORT)) {
    // An explicit PORT is otherwise obeyed exactly. Not this one: serving the
    // keyless desk door on a port the whole tailnet is already forwarded into
    // would hand out a shell with no key at all. Refuse loudly instead.
    console.error('WinMux will not start on port ' + PORT + '.');
    console.error('A "tailscale serve" rule already forwards that port to this PC, so anything on your Tailscale');
    console.error('network would reach WinMux without a key. Start it on a different port, or run');
    console.error('  tailscale serve status');
    console.error('to find the rule that points at 127.0.0.1:' + PORT + ' and turn that one off.');
    throw new Error('refused: port ' + PORT + ' is already tunnelled by tailscale serve');
  }
  // A bind failure here is a sentence, not a stack trace. Without this handler
  // Node throws an unhandled 'error' event and the user's whole answer is
  // "listen EADDRINUSE" over eleven lines of internal frames.
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE'
      ? 'WinMux could not start: something else is already using port ' + PORT + '. Close it, or set PORT to a free port.'
      : 'WinMux could not start on port ' + PORT + ': ' + e.message)));
    server.listen(PORT, HOST, () => { announce(); resolve(); });
  });
  // Boot the first spare shell now, so the very first tab opens instantly too.
  ensureSpare();
  // On a graceful exit, take every real shell down with us — an unattached spare
  // AND every live session — so quitting WinMux never strands PowerShell processes
  // running on the machine. (A hard kill from outside can't run this, but a normal
  // quit and Ctrl-C both do.)
  const killShells = killAllShells;
  process.on('exit', killShells);
  process.once('SIGTERM', () => { killShells(); process.exit(0); });
  // Advertise the running port so the `winmux` CLI can find it. Best-effort:
  // the app still runs if the home dir is unwritable. WINMUX_NO_INSTANCE lets a
  // test harness spin up many servers without clobbering the real one's file.
  if (!process.env.WINMUX_NO_INSTANCE) try {
    // The desktop app hands each copy its own discovery file so two running
    // copies (installed vs dev) never clobber one shared ~/.winmux/instance.json.
    const inst = process.env.WINMUX_INSTANCE_FILE || path.join(os.homedir(), '.winmux', 'instance.json');
    fs.mkdirSync(path.dirname(inst), { recursive: true });
    fs.writeFileSync(inst, JSON.stringify({ port: PORT, host: HOST, pid: process.pid, started: Date.now() }));
    const cleanup = () => { try { fs.unlinkSync(inst); } catch (e) {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
  } catch (e) { /* discovery is best-effort */ }
  return { port: PORT, host: HOST };
}

module.exports = { start };

// Running `node server.cjs` directly auto-starts, exactly as before. When
// required by the Electron main process, nothing runs until start() is called.
if (require.main === module) {
  start().catch((e) => { console.error(e.message); process.exit(2); });
}
