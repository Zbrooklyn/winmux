# WinMux Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WinMux Tailscale phone link actually work on this machine and survive the terminal that started it, so Edward can open WinMux on his phone and run a real shell without asking anyone to start anything first.

**Architecture:** Three independent defects, three tasks. (1) The server picks its own port when none is forced, refusing any port whose *Tailscale* face is already taken — this is what makes the default experience work instead of politely failing. (2) A PowerShell launcher (`winmux.ps1`) starts the server detached from any console so it outlives the shell, records pid+port in a state file, and exposes stop/status/link. (3) `verify.cjs` grows a `remote` group that proves the link end-to-end against the real Tailscale address, plus a `port` group that proves the auto-selection contract.

**Tech Stack:** Node 20 (CommonJS), `net` for port probing, `ws`, `node-pty`, `qrcode`, Playwright for the verification harness, Windows PowerShell 5.1 for the launcher.

## Global Constraints

- `public/cockpit.css` is the mockup verbatim (lines 8–399) and is **never edited**. All app CSS lives in the `<style>` block in `public/index.html`.
- The phone door binds the **Tailscale address only, never `0.0.0.0`**. The desk door is always `127.0.0.1`.
- The phone door can only be opened or closed **from the desk door**. `POST /api/phone` arriving at the phone door returns 403.
- The phone link is a live shell on Edward's PC. It is **never** pasted into chat, a screenshot, a commit, or a log that leaves the machine. Screenshots that would contain it get the key redacted before they ship.
- An **explicitly set `PORT` is honoured exactly** — auto-selection must never override it, because `verify.cjs` uses `PORT=8799` as its deliberate busy-port fixture.
- A failure to open the phone door must **never** take the desk door down. Both listeners keep their error handlers.
- `npm run verify` stays **zero-argument**. Any behaviour added here adds its check in the same commit.
- Repo: `C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux`, branch `master`. Commit and push each task.

## File Structure

- `server.cjs` — **modify.** Port becomes mutable and self-selecting; a `net`-based probe checks both faces of a candidate port before committing to it. Everything else (the two doors, auth, PTY bridge) is untouched.
- `winmux.ps1` — **create.** The only new file with real logic. Start/stop/status/link for a detached server. Owns the state file and the log.
- `verify.cjs` — **modify.** Two new check groups (`port`, `remote`) and one new plumbing helper that captures stdout so the auto-chosen port can be read back.
- `.gitignore` — **modify.** Ignore the runtime state file and log.
- `package.json` — **modify.** `remote` / `stop` / `status` scripts wrapping `winmux.ps1`.
- `PLAN.md` — **modify.** Add the Phase 2 section and its decisions so the Control Tower reflects reality.

---

### Task 1: The server picks a port whose Tailscale side is actually free

On this machine `tailscaled.exe` (PID 8564) permanently holds `100.120.237.49:8799`. The desk door on `127.0.0.1:8799` binds fine, so the app looks healthy — and then the phone switch can never turn on. Today that surfaces as a polite failure. It should not arise at all: when nobody forced a port, the server should decline a port it cannot fully use.

**Files:**
- Modify: `server.cjs:17-29` (requires + port constants), `server.cjs:391-405` (startup)
- Test: `verify.cjs` (new `port` group)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PORT` is now `let` and holds the *actual* listening port by the time `server.listen` fires — `phoneURL()`, `phoneState()`, and the EADDRINUSE message all read the real value with no change. Startup logs the exact line `WinMux running at http://127.0.0.1:<port>` (unchanged format, load-bearing for Task 2's log scrape) and, when it moved off the requested port, an additional line `port <requested> was busy on your Tailscale address — using <chosen> instead`.

- [ ] **Step 1: Write the failing check in `verify.cjs`**

Add this plumbing helper directly after the existing `server()` function (which ends at `verify.cjs:75`). It differs from `server()` in exactly two ways: it sets **no** `PORT`, and it pipes stdout so the chosen port can be read back.

```js
// Start a server with NO port forced, and read back the port it chose for
// itself. Never borrows a running server — the whole point is the choice.
function serverAuto() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
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
```

Then add the check itself. Put it immediately before the `// --- brand:` block at `verify.cjs:102`, so port behaviour is proven before any browser starts. It takes `PORT_FREE` as its nominal port because the runner requires one, but it starts its own server and never touches it.

```js
// --- port: the app refuses a port it cannot fully use ---------------------
check('port', PORT_FREE, async ({ t }) => {
  const ip = tailscaleIp();
  const auto = await serverAuto();
  try {
    const answered = await get('http://127.0.0.1:' + auto.port + '/');
    t('auto-picked port really serves the desk door', answered.status === 200, auto.port);
    if (ip) {
      const busyOnTailnet = await inUse(ip, auto.port);
      t('auto-picked port is free on the Tailscale side', !busyOnTailnet, ip + ':' + auto.port);
      if (await inUse(ip, 8799)) {
        t('auto-picked away from the busy default', auto.port !== 8799, 'chose ' + auto.port);
        t('said why it moved', /busy on your Tailscale address/.test(auto.log));
      }
    } else {
      t('SKIP tailnet side — Tailscale is not running', true);
    }
  } finally { auto.stop(); }

  // An explicitly requested port is never overridden, because the busy-port
  // fixture below depends on actually getting the busy port.
  const forced = await server(PORT_BUSY);
  try {
    const onBusy = await get('http://127.0.0.1:' + PORT_BUSY + '/');
    t('an explicit PORT is honoured exactly, not auto-moved', onBusy.status === 200, PORT_BUSY);
  } finally { forced.stop(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux"; npm run verify -- port`

Expected: FAIL — `auto-picked port is free on the Tailscale side` fails, because the server still hardcodes 8799 and `tailscaled` holds its tailnet face. The `said why it moved` check fails too (no such log line exists).

- [ ] **Step 3: Implement port self-selection in `server.cjs`**

Add `net` to the requires at `server.cjs:17-25`:

```js
const net = require('net');
```

Replace the single `PORT` line at `server.cjs:27`:

```js
// An explicitly requested port is obeyed exactly, even if it cannot serve the
// phone door — verify.cjs depends on that to test the busy-port failure. With
// no PORT set we choose for ourselves, and we refuse a port whose Tailscale
// face is taken, because that port can host the desk door and never the phone.
const PORT_REQUESTED = process.env.PORT ? parseInt(process.env.PORT, 10) : 8799;
const PORT_FORCED = !!process.env.PORT;
const PORT_CANDIDATES = [8799, 9912, 9911, 9913, 8800, 8801, 8802];
let PORT = PORT_REQUESTED;
```

Add these two functions immediately after `tailscaleIP()` (which ends at `server.cjs:42`):

```js
// Can we actually bind this exact host:port right now?
function bindable(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

// A port is only usable if BOTH doors can open on it. Checking just the desk
// door is how you end up with an app that looks fine and a phone switch that
// can never turn on.
async function pickPort() {
  const ip = tailscaleIP();
  const tried = [];
  for (const p of PORT_CANDIDATES) {
    if (!(await bindable(HOST, p))) { tried.push(p); continue; }
    if (ip && !(await bindable(ip, p))) { tried.push(p); continue; }
    return { port: p, movedFrom: tried.length && p !== PORT_CANDIDATES[0] ? PORT_CANDIDATES[0] : null };
  }
  // Nothing was clean. Fall back to the default and let the existing polite
  // failure explain itself rather than refusing to start at all.
  return { port: PORT_CANDIDATES[0], movedFrom: null };
}
```

- [ ] **Step 4: Make startup await the choice**

Replace the whole `server.listen(...)` block at `server.cjs:391-405` with:

```js
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

(async () => {
  if (!PORT_FORCED) {
    const chosen = await pickPort();
    if (chosen.port !== PORT_REQUESTED) {
      console.log('port ' + PORT_REQUESTED + ' was busy on your Tailscale address — using ' + chosen.port + ' instead');
    }
    PORT = chosen.port;
  }
  server.listen(PORT, HOST, announce);
})();
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `npm run verify -- port`

Expected: PASS on all five — the chosen port is free on both faces, it moved off 8799, it said why, and an explicit `PORT=8799` still lands on 8799.

- [ ] **Step 6: Run the whole harness to prove nothing regressed**

Run: `npm run verify`

Expected: every pre-existing group still passes — in particular `busyport` (the polite failure) and `phone` (the 12/12 flow), which both depend on explicit ports.

- [ ] **Step 7: Commit**

```bash
git add server.cjs verify.cjs
git commit -m "port: refuse a port whose Tailscale side is already taken"
git push
```

---

### Task 2: A launcher that outlives the terminal that started it

Every WinMux so far has died with its shell. That is the whole reason Edward has never had a working link: there was nothing to connect to by the time he looked.

**Files:**
- Create: `winmux.ps1`
- Modify: `package.json:6-9` (scripts), `.gitignore`

**Interfaces:**
- Consumes: Task 1's startup line `WinMux running at http://127.0.0.1:<port>` — scraped from `winmux.log` to learn the auto-chosen port.
- Produces: `.winmux-state.json` — `{ "pid": <int>, "port": <int>, "started": "<ISO8601>" }`, read by `stop`, `status`, and `link`. Commands: `winmux.ps1 start|stop|status|link`.

- [ ] **Step 1: Write `winmux.ps1`**

```powershell
# WinMux launcher — starts the server detached, so it outlives this terminal.
# Usage: .\winmux.ps1 start | stop | status | link
param([Parameter(Position=0)][ValidateSet('start','stop','status','link')][string]$Command = 'status')

$ErrorActionPreference = 'Stop'
$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateFile = Join-Path $Root '.winmux-state.json'
$LogFile   = Join-Path $Root 'winmux.log'

function Get-State {
  if (-not (Test-Path $StateFile)) { return $null }
  try { $s = Get-Content $StateFile -Raw | ConvertFrom-Json } catch { return $null }
  $proc = Get-Process -Id $s.pid -ErrorAction SilentlyContinue
  if (-not $proc) { Remove-Item $StateFile -Force -ErrorAction SilentlyContinue; return $null }
  return $s
}

function Start-WinMux {
  $existing = Get-State
  if ($existing) {
    Write-Host "WinMux is already running (pid $($existing.pid)) at http://127.0.0.1:$($existing.port)"
    return
  }
  Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
  # CT_REMOTE=1 pre-opens the phone door; the child inherits this process's env.
  $env:CT_REMOTE = '1'
  # -WindowStyle Hidden detaches from this console, so closing the terminal
  # (or ending an agent turn) does not take the server with it.
  $proc = Start-Process -FilePath 'node' -ArgumentList 'server.cjs' `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $LogFile -RedirectStandardError (Join-Path $Root 'winmux.err.log')

  $port = $null
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline -and -not $port) {
    Start-Sleep -Milliseconds 300
    if (Test-Path $LogFile) {
      $m = Select-String -Path $LogFile -Pattern 'running at http://127\.0\.0\.1:(\d+)' -ErrorAction SilentlyContinue
      if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
    }
  }
  if (-not $port) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    Write-Error "WinMux did not start. See $LogFile and $(Join-Path $Root 'winmux.err.log')."
    return
  }
  @{ pid = $proc.Id; port = $port; started = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content $StateFile -Encoding UTF8
  Write-Host "WinMux running   pid $($proc.Id)   http://127.0.0.1:$port"
  Write-Host "It stays up after you close this window. Stop it with: .\winmux.ps1 stop"
  Write-Host ""
  Write-Host "For your phone: open http://127.0.0.1:$port  ->  Settings -> Phone  ->  scan the QR."
}

function Stop-WinMux {
  $s = Get-State
  if (-not $s) { Write-Host 'WinMux is not running.'; return }
  Stop-Process -Id $s.pid -Force
  Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
  Write-Host "WinMux stopped (pid $($s.pid)). The phone link is dead."
}

function Get-Status {
  $s = Get-State
  if (-not $s) { Write-Host 'WinMux is not running.'; return }
  Write-Host "WinMux running   pid $($s.pid)   http://127.0.0.1:$($s.port)   since $($s.started)"
  try {
    $p = Invoke-RestMethod -Uri "http://127.0.0.1:$($s.port)/api/phone" -TimeoutSec 5
    if ($p.on) { Write-Host "phone access: ON  (bound to $($p.ip):$($p.port))" }
    else       { Write-Host 'phone access: off — turn it on in Settings -> Phone' }
  } catch { Write-Host 'phone access: unknown (the desk door did not answer)' }
}

function Show-Link {
  $s = Get-State
  if (-not $s) { Write-Host 'WinMux is not running. Start it with: .\winmux.ps1 start'; return }
  $p = Invoke-RestMethod -Uri "http://127.0.0.1:$($s.port)/api/phone" -TimeoutSec 5
  if (-not $p.on) { Write-Host 'Phone access is off. Turn it on in Settings -> Phone.'; return }
  Write-Host ''
  Write-Host 'THIS LINK IS A SHELL ON THIS PC. Do not paste it into chat, email, or a screenshot.'
  Write-Host ''
  Write-Host $p.url
  Write-Host ''
  Write-Host "Easier: open http://127.0.0.1:$($s.port) -> Settings -> Phone and scan the QR code."
}

switch ($Command) {
  'start'  { Start-WinMux }
  'stop'   { Stop-WinMux }
  'status' { Get-Status }
  'link'   { Show-Link }
}
```

- [ ] **Step 2: Ignore the runtime files**

Append to `.gitignore`:

```
.winmux-state.json
winmux.log
winmux.err.log
```

- [ ] **Step 3: Add the npm scripts**

In `package.json`, replace the `scripts` block:

```json
  "scripts": {
    "start": "node server.cjs",
    "remote": "powershell -NoProfile -ExecutionPolicy Bypass -File winmux.ps1 start",
    "stop": "powershell -NoProfile -ExecutionPolicy Bypass -File winmux.ps1 stop",
    "status": "powershell -NoProfile -ExecutionPolicy Bypass -File winmux.ps1 status",
    "link": "powershell -NoProfile -ExecutionPolicy Bypass -File winmux.ps1 link",
    "verify": "node verify.cjs"
  },
```

- [ ] **Step 4: Prove it starts, and prove it survives**

Run: `npm run remote`
Expected: `WinMux running   pid <n>   http://127.0.0.1:<port>` where `<port>` is *not* 8799, plus the Settings → Phone instruction.

Then, from a **separate** shell invocation (a new process, so the first one is gone):

Run: `npm run status`
Expected: same pid, `phone access: ON  (bound to 100.120.237.49:<port>)`.

This is the actual defect being closed — if `status` reports it running from a shell that did not start it, the process is genuinely detached.

- [ ] **Step 5: Prove stop really kills the link**

Run: `npm run stop` then `npm run status`
Expected: `WinMux stopped (pid <n>). The phone link is dead.` then `WinMux is not running.`

Confirm no listener remains: `netstat -ano | Select-String ":<port>"` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add winmux.ps1 package.json .gitignore
git commit -m "launcher: start WinMux detached so the link outlives the terminal"
git push
```

---

### Task 3: Prove the link works over the real Tailscale address

Everything so far is desk-side. This task proves the thing Edward actually asked for: that the tailnet address serves the app, refuses strangers, and runs a real shell.

**Files:**
- Modify: `verify.cjs` (new `remote` group), `PLAN.md` (Phase 2 + decisions)

**Interfaces:**
- Consumes: Task 1's `pickPort` (so `CT_REMOTE=1` reliably opens), Task 2's launcher only for the manual hand-off — the check starts its own server so `npm run verify` stays self-contained.
- Produces: `verify-out/remote-phone.png` — a phone-viewport screenshot of the app served **over the Tailscale address**, with the key redacted from the frame before it ships.

- [ ] **Step 1: Write the failing `remote` check**

Add after the `port` check from Task 1. It uses raw `http` (already required by `verify.cjs`? if not, add `const http = require('http');` beside the other requires at `verify.cjs:15-20`).

```js
// --- remote: the tailnet address really serves, and really refuses --------
check('remote', PORT_FREE, async ({ browser, t, shot }) => {
  const ip = tailscaleIp();
  if (!ip) { t('SKIP — Tailscale is not running on this PC', true); return; }

  const auto = await serverAuto();          // CT_REMOTE is not set here...
  auto.stop();                              // ...so start a real one that is.
  const proc = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT_FREE), CT_REMOTE: '1' }),
    stdio: 'ignore',
  });
  await waitUp(PORT_FREE, 15000);
  try {
    const state = await get('http://127.0.0.1:' + PORT_FREE + '/api/phone');
    const phone = JSON.parse(state.body);
    t('phone door opened on the Tailscale address', phone.on === true && phone.ip === ip, phone.ip);

    const base = 'http://' + ip + ':' + PORT_FREE;
    const token = new URL(phone.url).searchParams.get('k');

    const noKey = await get(base + '/');
    t('tailnet address refuses a request with no key', noKey.status === 401, noKey.status);

    const wrong = await get(base + '/?k=' + 'f'.repeat(token.length));
    t('tailnet address refuses a wrong key', wrong.status === 401, wrong.status);

    const ok = await get(base + '/?k=' + token);
    t('tailnet address serves the app with the right key', ok.status === 200);
    t('and sets the HttpOnly cookie', /ct_k=.*HttpOnly/i.test(String(ok.headers['set-cookie'])));

    const qr = await get(base + '/api/phone/qr?k=' + token);
    t('QR renders and encodes the live link', qr.status === 200 && /<svg/.test(qr.body));

    // A leaked link must never be able to widen its own access.
    const widen = await post(base + '/api/phone?k=' + token, '{"on":false}');
    t('the phone cannot flip the switch (403)', widen.status === 403, widen.status);

    // The real proof: a real shell, over the tailnet, at phone size.
    const p = await phoneCtx(browser);
    await p.goto(base + '/?k=' + token, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(4000);
    await p.keyboard.type('echo tailnet-says-$env:COMPUTERNAME');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(2500);
    const seen = await p.evaluate(() => document.body.innerText);
    t('a real command ran over the tailnet', /tailnet-says-MINISFORUM/i.test(seen));
    // Redact before the screenshot leaves the machine — the URL bar is not in
    // frame, but the Settings pane can render the link.
    await p.evaluate(() => {
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length === 0 && /\?k=[0-9a-f]{32}/.test(el.textContent || '')) {
          el.textContent = el.textContent.replace(/\?k=[0-9a-f]{32}/g, '?k=<redacted>');
        }
      });
    });
    await shot(p, 'remote-phone');
  } finally { try { proc.kill(); } catch (e) {} }
});
```

Add these two tiny helpers beside `inUse()` at `verify.cjs:44`:

```js
function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    }).on('error', rej);
  });
}

function post(url, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (rs) => {
      let b = '';
      rs.on('data', (d) => { b += d; });
      rs.on('end', () => res({ status: rs.statusCode, body: b }));
    });
    r.on('error', rej);
    r.write(body); r.end();
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify -- remote`
Expected: FAIL — `get`/`post` are not defined yet on first authoring; once the helpers land, the check should pass. If it fails at `a real command ran over the tailnet`, the tailnet path is genuinely broken and that is the defect to chase, not the test.

- [ ] **Step 3: Run the full harness**

Run: `npm run verify`
Expected: PASS across every group including `port` and `remote`. Screenshots land in `verify-out/`.

- [ ] **Step 4: Ship the proof to Edward**

Send `verify-out/remote-phone.png` with `SendUserFile` (status `proactive`) — rule 21. Confirm by eye that no `?k=<32 hex>` appears anywhere in the frame before sending.

- [ ] **Step 5: Update `PLAN.md`**

Add after the Phase 1 section:

```markdown
## Phase 2 — Remote access that actually works

Objective: the Tailscale link works on this machine and survives the terminal that started it.
Gate: `npm run verify` proves the tailnet address end-to-end; the server is still up in a shell that did not start it.

- [x] Pick a port whose Tailscale side is free, instead of politely failing on 8799
      (proof: verify `port` group — chosen port free on both faces, moved off 8799, said why)
- [x] `winmux.ps1 start|stop|status|link` — a detached server that outlives its terminal
      (proof: `npm run status` reports the same pid from a separate shell invocation)
- [x] Prove the tailnet address serves, refuses, and runs a real shell
      (proof: verify `remote` group + `verify-out/remote-phone.png`)
- [ ] @edward — one-time elevated command to start WinMux at logon (optional; needs UAC)
```

And add to Decisions:

```markdown
- Default port (resolved: with no `PORT` set the server picks the first candidate free on BOTH 127.0.0.1 and the Tailscale address. An explicit `PORT` is still obeyed exactly, because verify.cjs needs 8799 as its busy fixture)
- Staying up (resolved: `winmux.ps1` starts node detached via `Start-Process -WindowStyle Hidden`, so the server outlives the shell. Logon autostart is a separate, Edward-gated step because registering a scheduled task needs UAC)
```

- [ ] **Step 6: Commit**

```bash
git add verify.cjs PLAN.md
git commit -m "remote: prove the tailnet link end-to-end, and write Phase 2 down"
git push
```

---

## Hand-off (not a task — Edward's call)

Logon autostart needs a one-time elevated approval, which cannot be self-granted. Offer it, do not run it:

```powershell
Start-Process schtasks -Verb RunAs -ArgumentList '/Create','/TN','WinMux','/SC','ONLOGON','/TR','powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux\winmux.ps1" start','/F'
```

Rollback: `schtasks /Delete /TN WinMux /F` (elevated).
