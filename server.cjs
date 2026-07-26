// cockpit-terminal — serves the cockpit UI and bridges real shell processes to
// the browser terminals over websockets.
//
// This server hands out a real shell, so reaching it IS full control of the
// machine. Two modes, and nothing in between:
//   default        — binds 127.0.0.1. Only this PC can reach it. No password
//                    needed because nothing else can knock on the door.
//   CT_REMOTE=1    — binds the Tailscale address only (never 0.0.0.0), and
//                    every request must carry a token. Tailscale already
//                    encrypts the traffic and only admits your own devices;
//                    the token is the second lock, in case a device is lost.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8799;
const PUBLIC = path.join(__dirname, 'public');

// --- Where to listen -------------------------------------------------------
const REMOTE = process.env.CT_REMOTE === '1';

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

const HOST = REMOTE ? (process.env.CT_HOST || tailscaleIP()) : '127.0.0.1';
if (REMOTE && !HOST) {
  console.error('CT_REMOTE=1 but no Tailscale address was found on this machine.');
  console.error('Start Tailscale first, or set CT_HOST to the exact address to bind.');
  console.error('Refusing to fall back to 0.0.0.0 — that would offer a shell to the whole network.');
  process.exit(1);
}

// --- Token (remote mode only) ----------------------------------------------
const TOKEN = REMOTE ? (process.env.CT_TOKEN || crypto.randomBytes(16).toString('hex')) : '';

function tokenFrom(req) {
  try {
    const k = new URL(req.url, 'http://x').searchParams.get('k');
    if (k) return k;
  } catch (e) {}
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ct_k=([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

function authed(req) {
  if (!REMOTE) return true;
  const got = tokenFrom(req);
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;          // length differs → no match
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
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

function detectShells() {
  var list = [];
  list.push({ key: 'powershell', label: 'PowerShell', exec: 'powershell.exe', args: [] });
  var pwsh = onPath('pwsh.exe');
  if (pwsh) list.push({ key: 'pwsh', label: 'PowerShell Core', exec: pwsh, args: [] });
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
  '.map': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
const server = http.createServer((req, res) => {
  // Remote mode: no token, no anything. Checked before the URL is even read.
  if (!authed(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('cockpit-terminal: this link needs its access key.');
    return;
  }
  // Arriving with a valid ?k= parks it in a cookie so the rest of the page
  // (scripts, fonts, the websocket) authenticates without the key in every URL.
  if (REMOTE) {
    try {
      if (new URL(req.url, 'http://x').searchParams.get('k')) {
        res.setHeader('Set-Cookie', 'ct_k=' + TOKEN + '; Path=/; HttpOnly; SameSite=Strict');
      }
    } catch (e) {}
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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
    const cwd = q.cwd && fs.existsSync(q.cwd) ? q.cwd : os.homedir();
    gitChanges(cwd, (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Object.assign({ cwd }, payload)));
    });
    return;
  }
  // Diagnostics modal: what this server actually is right now.
  if (urlPath === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pid: process.pid, node: process.version, platform: process.platform,
      arch: process.arch, uptime: Math.round(process.uptime()), host: HOST, port: PORT,
      home: os.homedir(), cpus: os.cpus().length,
      mem: Math.round(os.totalmem() / 1073741824) + ' GB',
      shells: SHELLS.map((s) => s.label), sessions: wss ? wss.clients.size : 0,
    }));
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- One shell process per websocket connection ----------------------------
// The websocket is the actual shell, so it gets the same lock as the page.
const wss = new WebSocketServer({
  server,
  path: '/pty',
  verifyClient: (info, cb) => (authed(info.req) ? cb(true) : cb(false, 401, 'Unauthorized')),
});
wss.on('connection', (ws, req) => {
  var key = 'powershell';
  var want = '';
  try {
    var qs = new URL(req.url, 'http://x').searchParams;
    key = qs.get('shell') || 'powershell';
    want = qs.get('cwd') || '';
  } catch (e) {}
  var shell = shellByKey(key);
  // Honour a requested start folder only when it really is one.
  let cwd = os.homedir();
  try { if (want && fs.statSync(want).isDirectory()) cwd = want; } catch (e) {}
  let term;
  try {
    term = pty.spawn(shell.exec, shell.args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: process.env });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'meta', error: 'Failed to start ' + shell.label + ': ' + e.message }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: 'meta', shell: shell.label, cwd }));
  term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, 'utf8')); });
  term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(); });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r' && msg.c > 0 && msg.r > 0) { try { term.resize(msg.c, msg.r); } catch {} }
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
});

server.listen(PORT, HOST, () => {
  if (REMOTE) {
    console.log('cockpit-terminal — REMOTE mode (Tailscale only, token required)');
    console.log('open on your phone:  http://' + HOST + ':' + PORT + '/?k=' + TOKEN);
    console.log('');
    console.log('That link is a shell on this PC. Anyone holding it, on your tailnet,');
    console.log('has your machine. Keep it out of chats and screenshots.');
    if (!process.env.CT_TOKEN) console.log('The key changes every restart. Set CT_TOKEN to pin it.');
  } else {
    console.log('cockpit-terminal running at http://' + HOST + ':' + PORT);
    console.log('local only — set CT_REMOTE=1 to reach it from your phone over Tailscale');
  }
  console.log('shells:', SHELLS.map((s) => s.label).join(', '));
});
