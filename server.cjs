// cockpit-terminal — serves the cockpit UI and bridges a real PowerShell process
// to the browser terminal over a websocket. Localhost only (it runs real shell
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
const SHELL = 'powershell.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

// Static file server, locked to the public/ directory (no path traversal).
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// One PowerShell process per websocket connection.
const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws) => {
  const cwd = os.homedir();
  let term;
  try {
    term = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env,
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'meta', error: 'Failed to start PowerShell: ' + e.message }));
    ws.close();
    return;
  }

  // Tell the client what shell + folder it's looking at (for the sidebar).
  ws.send(JSON.stringify({ type: 'meta', shell: 'PowerShell', cwd }));

  // Shell output -> browser (binary frames so they never collide with JSON control frames).
  term.onData((d) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, 'utf8'));
  });
  term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(); });

  // Browser -> shell. Text frames are JSON control messages (input / resize).
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      term.write(msg.d);
    } else if (msg.t === 'r' && msg.c > 0 && msg.r > 0) {
      try { term.resize(msg.c, msg.r); } catch { /* ignore transient resize errors */ }
    }
  });

  ws.on('close', () => { try { term.kill(); } catch { /* already gone */ } });
});

server.listen(PORT, HOST, () => {
  console.log('cockpit-terminal running at http://' + HOST + ':' + PORT);
});
