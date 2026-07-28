# WinMux Phase 9 — `winmux` CLI + control channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give WinMux a `winmux` command-line that drives the *running* app — `winmux new-tab`, `split`, `send`, `read-screen`, `list`, `focus` — so a human or an agent can script the live cockpit, at parity with wmux's CLI.

**Architecture:** The server is passive and owns pty `SESSIONS`; the *app* (`public/app.js`) owns layout (groups/tabs/panes/active). So the CLI cannot talk only to the server — it must reach the running app. Transport: the short-lived **CLI → server** hop is `POST /rpc` (HTTP, request/response); the server **forwards** each command over a persistent **WS `/control`** channel to a connected app client, which executes it against its real layout and replies with a correlated result. The server writes `~/.winmux/instance.json` in `start()` so the CLI can find the running port. Loopback is trusted (the existing desk-door model), so a local CLI needs no key.

**Tech Stack:** Node (existing `server.cjs` http + `ws`), vanilla JS (`public/app.js`), a new `bin/winmux.cjs` CLI, Playwright harness (`verify.cjs`).

## Global Constraints

- Platform: **Windows-first**; **one repo** (`projects/winmux`).
- `public/cockpit.css` is a **frozen contract — never edit it.**
- **Pure-web/phone mode must keep working unchanged.** The `/control` client in `app.js` must be additive and must not break the terminal, phone door, or reconnect logic.
- The RPC/control surface is **loopback-trusted** exactly like the rest of the desk door: on `127.0.0.1` it is open; over the tailnet it obeys the same key check the server already applies (`keyMatches`). The CLI is a *local* tool.
- New standalone code (`bin/winmux.cjs`) is plain CommonJS JS, matching `server.cjs`.
- Keep the committed harness green: `npm run verify` gains a `cli` check.
- Command vocabulary mirrors wmux where sensible: `new-tab`, `split`, `send`, `read-screen`, `list`, `focus`. `browser`/`agent`/`markdown` are **Phase 10/11** — the CLI may reserve the names with a "not yet" stub but must not implement them here.

---

### Task 1: Server control channel + `/rpc` + instance discovery

**Files:**
- Modify: `server.cjs` (add `/control` WS server, `POST /rpc` route, instance-file write in `start()`)

**Interfaces:**
- Produces:
  - A `/control` WebSocket path. App clients connect; the server tracks them in a `CONTROL` set, each `{ ws, id, lastSeen }`.
  - Request/response correlation: server → client `{ rpc: reqId, cmd, args }`; client → server `{ rpc: reqId, ok, result }` or `{ rpc: reqId, ok:false, error }`.
  - `POST /rpc` with body `{ cmd, args }` → forwards to the most-recently-active control client, awaits its reply (timeout 8s), responds `200 {ok:true, result}` / `409 {ok:false,error:'no app connected'}` / `504` on timeout / `400` on bad body. Subject to the same door check as the rest of the server.
  - `start()` writes `os.homedir()/.winmux/instance.json` = `{ port, host, pid, started }` after listen, and best-effort removes it on `SIGINT`/`exit`.

- [ ] **Step 1: Add the control registry + a helper near the top of the module scope**

After the `const SESSIONS = new Map();` line, add:

```js
// Control clients: the running app(s) that a `winmux` CLI command drives. Each
// entry is { ws, id, lastSeen }. The CLI never connects here — it POSTs /rpc and
// the server forwards to the most-recently-active app.
const CONTROL = new Map();               // id -> { ws, lastSeen }
let controlSeq = 0;
const RPC = new Map();                   // reqId -> { resolve, timer }
let rpcSeq = 0;

function pickControl() {
  let best = null;
  for (const c of CONTROL.values()) if (!best || c.lastSeen > best.lastSeen) best = c;
  return best;
}

// Forward one command to a live app and await its reply. Rejects if no app is
// connected or the app does not answer in time.
function callApp(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = pickControl();
    if (!c || c.ws.readyState !== c.ws.OPEN) return reject(new Error('no app connected'));
    const reqId = ++rpcSeq;
    const timer = setTimeout(() => {
      RPC.delete(reqId);
      reject(new Error('the app did not answer in time'));
    }, 8000);
    RPC.set(reqId, { resolve, reject, timer });
    c.ws.send(JSON.stringify({ rpc: reqId, cmd, args: args || {} }));
  });
}
```

- [ ] **Step 2: Add the `/control` WebSocket server**

Below the existing `const wss = new WebSocketServer({ server, path: '/pty' });` add a second server on `/control`:

```js
const ctlWss = new WebSocketServer({ server, path: '/control' });
ctlWss.on('connection', (ws, req) => {
  // Same door as everything else: loopback is open; tailnet must carry the key.
  if (!isLoopback(req) && phone.on && !keyMatches(req)) { try { ws.close(); } catch (e) {} return; }
  const id = ++controlSeq;
  CONTROL.set(id, { ws, lastSeen: Date.now() });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const c = CONTROL.get(id); if (c) c.lastSeen = Date.now();
    // A reply to a forwarded command.
    if (m && m.rpc && RPC.has(m.rpc)) {
      const pend = RPC.get(m.rpc);
      RPC.delete(m.rpc);
      clearTimeout(pend.timer);
      if (m.ok) pend.resolve(m.result);
      else pend.reject(new Error(m.error || 'the app rejected the command'));
    }
  });
  ws.on('close', () => CONTROL.delete(id));
  ws.on('error', () => CONTROL.delete(id));
});
```

If `isLoopback(req)` does not already exist in `server.cjs`, add it near `keyMatches`:

```js
function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
```

(If a loopback helper already exists under another name, reuse it and skip this.)

- [ ] **Step 3: Add the `POST /rpc` route**

In the HTTP request handler, alongside the other `if (urlPath === '/api/...')` blocks, add (it must be reachable for both GET-body-less and POST; the CLI always POSTs JSON):

```js
if (urlPath === '/rpc') {
  // Loopback is trusted; over the tailnet the same key rule as the desk door.
  if (!isLoopback(req) && phone.on && !keyMatches(req)) { res.writeHead(401); return res.end('winmux: /rpc needs the access key over the network'); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let msg; try { msg = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'bad JSON' })); }
    if (!msg || typeof msg.cmd !== 'string') { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'missing cmd' })); }
    try {
      const result = await callApp(msg.cmd, msg.args);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      const code = /no app connected/.test(e.message) ? 409 : /in time/.test(e.message) ? 504 : 422;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
  return;
}
```

- [ ] **Step 4: Write the instance file in `start()`**

Inside `start()`, immediately after the server is listening (right after `announce()` resolves / before `return { port, host }`), add:

```js
try {
  const dir = path.join(os.homedir(), '.winmux');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'instance.json'),
    JSON.stringify({ port: PORT, host: HOST, pid: process.pid, started: Date.now() }));
  const cleanup = () => { try { fs.unlinkSync(path.join(dir, 'instance.json')); } catch (e) {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
} catch (e) { /* discovery is best-effort; the app still runs */ }
```

Confirm `os`, `fs`, and `path` are already required at the top of `server.cjs` (they are).

- [ ] **Step 5: Prove the server side in isolation (no app yet → 409)**

Run:
```bash
node -e "const {start}=require('./server.cjs'); start().then(async r=>{ const http=require('http'); const body=JSON.stringify({cmd:'list'}); const req=http.request({host:'127.0.0.1',port:r.port,path:'/rpc',method:'POST',headers:{'content-type':'application/json','content-length':body.length}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>{console.log('STATUS',res.statusCode,b); process.exit(0);});}); req.end(body); });"
```
Expected: `STATUS 409 {"ok":false,"error":"no app connected"}` — the route works and correctly reports that no app is connected. Also confirm `~/.winmux/instance.json` was written with the right port.

- [ ] **Step 6: Commit**

```bash
git add server.cjs
git commit -m "feat(rpc): /control WS + POST /rpc forwarder + instance discovery file (Phase 9 T1)"
```

---

### Task 2: App-side control client

**Files:**
- Modify: `public/app.js` (connect to `/control`, handle forwarded commands against real layout)

**Interfaces:**
- Consumes: `callApp` forwarding `{ rpc, cmd, args }` (Task 1); the existing layout functions `activeTerm()`, `paneById(activePaneId)`, `newTerm(p, shellKey, cwd)`, `splitRight(p, shellKey, cwd)`, `splitDown(p, shellKey, cwd)`, `startShell()`, `allTerms()`, and the input path `t.ws.send(JSON.stringify({ t: 'i', d }))`.
- Produces: a `/control` client that answers `list`, `send`, `read-screen`, `new-tab`, `split`, `focus`.

- [ ] **Step 1: Add a screen-serializer helper (reuse the existing buffer walk)**

`app.js` already reads `t.term.buffer.active` (around line 312). Add a small reusable function near `activeTerm()`:

```js
function serializeTerm(t, maxLines) {
  if (!t || !t.term) return '';
  var buf = t.term.buffer.active, out = [], n = buf.length;
  var start = maxLines ? Math.max(0, n - maxLines) : 0;
  for (var i = start; i < n; i++) {
    var line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n').replace(/\n+$/, '');
}
```

- [ ] **Step 2: Add a resolver from a `target` arg to a terminal**

```js
// A control command may target a terminal by id; default is the active one.
function termByTarget(target) {
  if (!target) return activeTerm();
  var all = allTerms();
  for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(target)) return all[i];
  return null;
}
```

- [ ] **Step 3: Add the control dispatcher**

```js
function runControl(cmd, args) {
  args = args || {};
  if (cmd === 'list') {
    return { sessions: allTerms().map(function (t) {
      return { id: t.id, title: termName(t), shell: t.shell, cwd: t.cwd || '',
               group: t.groupId, active: activeTerm() === t };
    }) };
  }
  if (cmd === 'read-screen') {
    var t = termByTarget(args.target);
    if (!t) throw new Error('no such terminal');
    return { id: t.id, title: termName(t), screen: serializeTerm(t, args.lines || 0) };
  }
  if (cmd === 'send') {
    var ts = termByTarget(args.target);
    if (!ts) throw new Error('no such terminal');
    var data = String(args.data == null ? '' : args.data);
    if (args.enter) data += '\r';
    if (ts.ws && ts.ws.readyState === WebSocket.OPEN) ts.ws.send(JSON.stringify({ t: 'i', d: data }));
    else throw new Error('that terminal is not connected');
    return { id: ts.id, sent: data.length };
  }
  if (cmd === 'new-tab') {
    var p = paneById(activePaneId) || panes[0];
    if (!p) throw new Error('no pane to add a tab to');
    var nt = newTerm(p, args.shell || startShell(), args.cwd);
    focusPane(p.id);
    return { id: nt && nt.id };
  }
  if (cmd === 'split') {
    var sp = paneById(activePaneId) || panes[0];
    if (!sp) throw new Error('no pane to split');
    var fn = (args.dir === 'down') ? splitDown : splitRight;
    fn(sp, args.shell || startShell(), args.cwd);
    return { ok: true, dir: args.dir === 'down' ? 'down' : 'right' };
  }
  if (cmd === 'focus') {
    var tf = termByTarget(args.target);
    if (!tf) throw new Error('no such terminal');
    var pf = paneOfTerm(tf) || paneById(activePaneId);
    if (pf) { activateTerm(pf, tf.id); focusPane(pf.id); }
    return { id: tf.id };
  }
  throw new Error('unknown command: ' + cmd);
}
```

If `paneOfTerm` / `focusPane` / `activateTerm` / `paneById` / `panes` are named differently, use the actual names (confirm by reading `app.js`). `newTerm` must return the created terminal object; if it does not, capture the terminal it creates (read `newTerm` and, if needed, have it `return t;` — a one-line additive change, no behaviour change).

- [ ] **Step 4: Open the `/control` socket and wire the dispatcher**

Near where the app finishes first render (after the initial layout is built), add:

```js
(function connectControl() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var cws;
  function open() {
    cws = new WebSocket(proto + '//' + location.host + '/control' + location.search);
    cws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.rpc) return;
      try { cws.send(JSON.stringify({ rpc: m.rpc, ok: true, result: runControl(m.cmd, m.args) })); }
      catch (e) { cws.send(JSON.stringify({ rpc: m.rpc, ok: false, error: String(e && e.message || e) })); }
    };
    cws.onclose = function () { setTimeout(open, 1500); };  // survive server restarts
    cws.onerror = function () { try { cws.close(); } catch (e) {} };
  }
  open();
})();
```

- [ ] **Step 5: Manual smoke — CLI-less, via curl-equivalent**

Run `node server.cjs` on a known port, open `http://127.0.0.1:<port>` in a browser, then from another shell:
```bash
node -e "const http=require('http');const b=JSON.stringify({cmd:'list'});const r=http.request({host:'127.0.0.1',port:<port>,path:'/rpc',method:'POST',headers:{'content-type':'application/json','content-length':b.length}},x=>{let s='';x.on('data',d=>s+=d);x.on('end',()=>console.log(x.statusCode,s));});r.end(b);"
```
Expected: `200 {"ok":true,"result":{"sessions":[{"id":...,"title":"PowerShell",...}]}}`. Then try `{cmd:'send',args:{data:'Get-Date',enter:true}}` and watch the browser's terminal run it; then `{cmd:'read-screen'}` and see the date in the returned `screen`.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(control): app answers list/send/read-screen/new-tab/split/focus over /control (Phase 9 T2)"
```

---

### Task 3: The `winmux` CLI

**Files:**
- Create: `bin/winmux.cjs`
- Modify: `package.json` (add `"bin"` + keep it runnable via `node bin/winmux.cjs`)

**Interfaces:**
- Consumes: `~/.winmux/instance.json` (Task 1) for the port; `POST /rpc` (Task 1).
- Produces: `winmux <command> [args]` for `list`, `new-tab`, `split`, `send`, `read-screen`, `focus`, plus `--json`. `browser`/`agent`/`markdown` print a "coming in a later phase" notice and exit non-zero.

- [ ] **Step 1: Write `bin/winmux.cjs`**

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function instance() {
  const f = path.join(os.homedir(), '.winmux', 'instance.json');
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    die('WinMux is not running (no ~/.winmux/instance.json). Start it with `winmux` or `npm start`.');
  }
  return j;
}

function rpc(cmd, args) {
  const inst = instance();
  const body = JSON.stringify({ cmd, args: args || {} });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: inst.host === '0.0.0.0' ? '127.0.0.1' : (inst.host || '127.0.0.1'),
      port: inst.port, path: '/rpc', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let b = ''; res.on('data', (d) => b += d);
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch (e) { return reject(new Error('bad reply: ' + b.slice(0, 120))); }
        if (res.statusCode === 200 && j.ok) resolve(j.result);
        else reject(new Error(j && j.error ? j.error : ('HTTP ' + res.statusCode)));
      });
    });
    req.on('error', (e) => reject(new Error('cannot reach WinMux: ' + e.message)));
    req.end(body);
  });
}

function die(msg) { process.stderr.write('winmux: ' + msg + '\n'); process.exit(1); }
function out(v) { process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n'); }

const HELP = [
  'winmux <command> [args]', '',
  '  list                     list the open terminals (id, title, shell, cwd)',
  '  new-tab [shell]          open a new tab in the active pane',
  '  split [right|down] [sh]  split the active pane',
  '  send <text> [--id N]     type text into a terminal (default: the active one)',
  '  send <text> --enter      ...and press Enter',
  '  read-screen [--id N] [--lines N]   print a terminal\'s visible text',
  '  focus <id>               focus a terminal',
  '', '  --json                   raw JSON output where relevant',
].join('\n');

function flag(argv, name) { const i = argv.indexOf(name); if (i < 0) return null; return argv[i + 1]; }
function has(argv, name) { return argv.indexOf(name) >= 0; }

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { out(HELP); return; }
  try {
    if (cmd === 'list') {
      const r = await rpc('list');
      if (has(argv, '--json')) return out(r);
      if (!r.sessions.length) return out('(no terminals open)');
      return out(r.sessions.map((s) => (s.active ? '* ' : '  ') + s.id + '  ' + s.title + '  [' + s.shell + ']  ' + (s.cwd || '')).join('\n'));
    }
    if (cmd === 'new-tab') { return out(await rpc('new-tab', { shell: argv[1] })); }
    if (cmd === 'split') {
      const dir = (argv[1] === 'down' || argv[1] === 'right') ? argv[1] : 'right';
      const shell = (argv[1] === 'down' || argv[1] === 'right') ? argv[2] : argv[1];
      return out(await rpc('split', { dir, shell }));
    }
    if (cmd === 'send') {
      const text = argv[1];
      if (text == null) die('send needs text: winmux send "Get-Date" --enter');
      return out(await rpc('send', { data: text, enter: has(argv, '--enter'), target: flag(argv, '--id') }));
    }
    if (cmd === 'read-screen') {
      const r = await rpc('read-screen', { target: flag(argv, '--id'), lines: Number(flag(argv, '--lines')) || 0 });
      if (has(argv, '--json')) return out(r);
      return out(r.screen);
    }
    if (cmd === 'focus') { if (!argv[1]) die('focus needs a terminal id'); return out(await rpc('focus', { target: argv[1] })); }
    if (cmd === 'browser' || cmd === 'agent' || cmd === 'markdown') {
      die(cmd + ' arrives in a later phase (Phase 10/11). Run `winmux help` for what works today.');
    }
    die('unknown command: ' + cmd + '. Run `winmux help`.');
  } catch (e) { die(e.message); }
})();
```

- [ ] **Step 2: Register the bin in `package.json`**

Add a top-level `"bin"`:
```json
  "bin": { "winmux": "bin/winmux.cjs" },
```

- [ ] **Step 3: Smoke the CLI against a running app**

With `node server.cjs` running and a browser open on it (so an app is connected to `/control`):
```bash
node bin/winmux.cjs list
node bin/winmux.cjs send "Get-Date" --enter
node bin/winmux.cjs read-screen --lines 40
```
Expected: `list` prints the open terminal(s); `send` runs the command in the browser; `read-screen` prints the date. Without a browser open: `winmux list` prints `winmux: no app connected`.

- [ ] **Step 4: Commit**

```bash
git add bin/winmux.cjs package.json
git commit -m "feat(cli): winmux new-tab/split/send/read-screen/list/focus over /rpc (Phase 9 T3)"
```

---

### Task 4: Harness `cli` check

**Files:**
- Modify: `verify.cjs` (add a `cli` check)

**Interfaces:**
- Consumes: `spawn` (already imported), the running server on the check's port, a headless page acting as the connected app, `bin/winmux.cjs`.
- Produces: a `cli` check proving the CLI drives the live app — `send` runs a real command the app executes and `read-screen` reads it back, and `list` reflects a `new-tab`.

- [ ] **Step 1: Add a port constant**

Alongside the other `PORT_*` constants add:
```js
const PORT_CLI = 9921;
```

- [ ] **Step 2: Write the check (place it with the other `check(...)` blocks)**

```js
// --- cli: the `winmux` command-line drives the live app -------------------
// The CLI talks to POST /rpc, which forwards over /control to a connected app.
// So this check IS the app: a real headless page connected to /control, then
// the CLI is run as a child process and must make that page do things.
check('cli', PORT_CLI, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args], {
      cwd: ROOT, env: process.env,
    });
    let outb = '', errb = '';
    proc.stdout.on('data', (d) => outb += d);
    proc.stderr.on('data', (d) => errb += d);
    proc.on('exit', (code) => resolve({ code, out: outb.trim(), err: errb.trim() }));
  });

  // The instance file must point at THIS check's server. The harness may have
  // started several servers; write the file to this port so the CLI targets it.
  const fsx = require('fs'), osx = require('os'), px = require('path');
  const instFile = px.join(osx.homedir(), '.winmux', 'instance.json');
  fsx.mkdirSync(px.dirname(instFile), { recursive: true });
  fsx.writeFileSync(instFile, JSON.stringify({ port: PORT_CLI, host: '127.0.0.1', pid: 0, started: Date.now() }));

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);           // app connects to /control

  const list1 = await winmux(['list', '--json']);
  const parsed1 = (() => { try { return JSON.parse(list1.out); } catch (e) { return null; } })();
  t('list reaches the live app', list1.code === 0 && parsed1 && Array.isArray(parsed1.sessions), { code: list1.code, err: list1.err });
  t('the app reports its one starting terminal', parsed1 && parsed1.sessions.length >= 1, parsed1 && parsed1.sessions.length);

  // Send a real command and read it back off the screen the app painted.
  const marker = 'CLI_OK_' + PORT_CLI;
  const sent = await winmux(['send', '"' + marker + '"', '--enter']);
  t('send exits clean', sent.code === 0, sent.err);
  await page.waitForTimeout(2500);
  const rd = await winmux(['read-screen', '--lines', '60']);
  t('read-screen shows what send ran', rd.code === 0 && rd.out.indexOf(marker) >= 0, rd.out.slice(-160));

  // new-tab must grow the list the app reports.
  await winmux(['new-tab']);
  await page.waitForTimeout(1500);
  const list2 = await winmux(['list', '--json']);
  const parsed2 = (() => { try { return JSON.parse(list2.out); } catch (e) { return null; } })();
  t('new-tab adds a terminal the app can see',
    parsed2 && parsed1 && parsed2.sessions.length === parsed1.sessions.length + 1,
    { before: parsed1 && parsed1.sessions.length, after: parsed2 && parsed2.sessions.length });

  await shot(page, 'cli-drove-it');

  // No app connected → a clean, plain-English failure, not a hang.
  await page.close();
  await page.context().clearCookies().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const orphan = await winmux(['list']);
  t('with no app open the CLI fails clearly, fast', orphan.code !== 0 && /no app connected/i.test(orphan.err), orphan.err);
});
```

Note: closing the single page may not immediately drop the `/control` socket within the grace of the check; if `orphan` proves flaky, assert instead that `winmux list` still exits non-zero OR returns an empty session list — the point is "no hang, clean signal". Prefer the `no app connected` form; only relax if the socket close is not observed in time.

- [ ] **Step 3: Run the check**

Run: `node verify.cjs cli`
Expected: all `cli` assertions PASS; `verify-out/cli-drove-it.png` shows the terminal with the marker command run.

- [ ] **Step 4: Full harness stays green**

Run: `npm run verify`
Expected: the pre-existing failures are unchanged; the new `cli` group passes. (`phone`/`trust` pre-existing flakes are tracked separately and out of scope here.)

- [ ] **Step 5: Commit**

```bash
git add verify.cjs
git commit -m "test(verify): cli check — winmux drives the live app (send/read-screen/new-tab) (Phase 9 T4)"
```

---

### Task 5: Docs + push

**Files:**
- Modify: `PLAN.md` (add Phase 9 section)
- Modify: `README.md` (add a CLI section)
- Modify: `DESIGN.md` (one decisions-log entry: RPC transport chosen)

- [ ] **Step 1: Add a Phase 9 section to `PLAN.md`** (before `## Risks`), summarizing: the passive server + client-owned layout; the `/rpc`→`/control` forward; instance discovery; the command set; loopback-trusted auth; the `cli` harness check. Mark Live once Tasks 1–4 are done.

- [ ] **Step 2: Add a CLI section to `README.md`:**

```markdown
## Drive it from the command line

With WinMux running, the `winmux` command scripts the live app:

    winmux list                     # the open terminals
    winmux new-tab                  # open a tab in the active pane
    winmux split down               # split the active pane
    winmux send "Get-Date" --enter  # type into the active terminal and run it
    winmux read-screen --lines 40   # read what's on screen

An agent (e.g. Claude) can use these to open terminals and run tools for you.
```

- [ ] **Step 3: Add the DESIGN.md decisions-log entry:** RPC transport is `POST /rpc` (short-lived CLI) forwarded over a persistent `/control` WS to the running app, because the app — not the passive server — owns layout and "active". Loopback-trusted, keyed over the tailnet.

- [ ] **Step 4: Commit + push**

```bash
git add PLAN.md README.md DESIGN.md
git commit -m "docs: record Phase 9 CLI + control channel (Phase 9 T5)"
git push
```

---

## Self-Review

**Spec coverage (Phase 9 slice):** control channel + auth + parity command set + CLI shim → Tasks 1 (channel+auth+discovery), 2 (app executes), 3 (CLI), 4 (proof). ✓ Proof "`winmux new-tab`/`send`/`read-screen` drive the live app; agent can script it" → Task 4 `cli` check. ✓

**Out of Phase 9 scope (later phases):** `browser`/`agent`/`markdown` CLI verbs are stubbed with a "later phase" notice (Phase 10/11), not implemented.

**Placeholder scan:** every code step ships real code; every run step gives the exact command + expected output. The `newTerm` return-value and the exact layout function names are the one confirmation-before-writing item (Task 2 Step 3) — read `app.js` and use the real names.

**Type consistency:** `callApp(cmd,args)` (T1) ↔ `{rpc,cmd,args}` on the wire ↔ `runControl(cmd,args)` (T2) ↔ CLI `rpc(cmd,args)` (T3). Reply shape `{rpc, ok, result|error}` is symmetric between server forward (T1) and app reply (T2). The instance file shape `{port,host,pid,started}` is written in T1 and read in T3/T4.
