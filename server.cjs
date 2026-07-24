// cockpit-terminal — serves the cockpit UI and bridges real shell processes to
// the browser terminals over websockets. Localhost only (it runs real shell
// commands, so it is deliberately NOT exposed to the network).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8799;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

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

// --- Static file server (locked to public/) --------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  // Small API: the list of shells the picker can offer.
  if (urlPath === '/shells') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SHELLS.map((s) => ({ key: s.key, label: s.label }))));
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
const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws, req) => {
  var key = 'powershell';
  try { key = new URL(req.url, 'http://x').searchParams.get('shell') || 'powershell'; } catch (e) {}
  var shell = shellByKey(key);
  const cwd = os.homedir();
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
  console.log('cockpit-terminal running at http://' + HOST + ':' + PORT);
  console.log('shells:', SHELLS.map((s) => s.label).join(', '));
});
