# WinMux Session Survival — Implementation Plan

> **For agentic workers:** implement task-by-task; each task ends with an independently testable deliverable. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Closing the WinMux window (or an app crash) never kills the live shells/agents. Reopening reattaches to them, right where they were.

**Architecture:** Today `electron/main.ts` boots the server **in-process** (`start()` in the Electron main process), so the server's lifetime = the window's lifetime, and `killShells` on process exit takes every shell down. The fix: the app **spawns `server.cjs` as a detached child process** (or **reattaches** to one already running, discovered via the existing `~/.winmux/instance.<profile>.json` file) and connects the renderer to it over the loopback port. When the window closes, the detached server keeps running with its shells. On relaunch, the app finds the live server and reattaches; the renderer reconnects to existing sessions by `sid` (already supported). The server's own session registry + grace window + scrollback (Phase 4, shipped) already makes a shell outlive its socket — this plan makes the *server itself* outlive the *window*.

**Tech Stack:** Electron main process, Node `child_process.spawn` with `ELECTRON_RUN_AS_NODE`, the existing instance-file discovery + `/api/info` ping, `detached: true` + `.unref()`.

## Global Constraints (verbatim)
- `public/cockpit.css` is FROZEN — new styles go in the index.html override layer.
- The standalone `node server.cjs` phone/browser path stays byte-identical and unchanged.
- The `WINMUX_SMOKE` harness path (electron check) must stay green — keep its in-process boot so the existing electron smoke is unaffected; detached spawn is the real-launch path only.
- Every unit keeps `npm run verify` green and ships its own committed check where testable.
- No orphaned-process regressions: a detached server must be discoverable and stoppable; the app must never silently spawn a second server alongside a live one.
- Do NOT touch the owner-gated publish. Screenshots for rendered changes go to Edward.

---

## Task 1: Detached-server launcher + discovery (the core)

**Files:**
- Create: `electron/server-host.ts` — owns spawn-or-attach and returns `{ port, host, attached: boolean }`.
- Modify: `electron/main.ts:39-60` — `createWindow` calls `resolveServer()` instead of in-process `start()` for real launches; keep in-process `start()` when `WINMUX_SMOKE`.
- Modify: `server.cjs` instance file — ensure it records `port` + `pid` (it records the instance; confirm port+pid present for the ping+liveness check).

**Interfaces:**
- Produces: `resolveServer(profile, { smoke }): Promise<{ port, host, attached }>`.
  - If the instance file names a server that answers `GET /api/info` on its port → `{ attached: true }` (reuse it).
  - Else spawn `process.execPath` with `['server.cjs']`, env `{ ELECTRON_RUN_AS_NODE: '1', WINMUX_INSTANCE_FILE, WINMUX_TRUST_FILE }`, `{ detached: true, stdio: 'ignore' }`, `.unref()`, then poll the instance file / `/api/info` until it answers (≤15s), return its port.

- [ ] **Step 1:** Write `electron/server-host.ts` with `resolveServer`. Liveness = the instance file exists AND `/api/info` returns 200 with a matching `version`.
- [ ] **Step 2:** In `main.ts`, branch: `WINMUX_SMOKE` → keep `require('../server.cjs').start()` (unchanged); real launch → `await resolveServer(profile, {})`. Load the returned port.
- [ ] **Step 3:** Verify by hand-trace + `npm run verify` (electron check still boots in-process, stays green). Commit.

## Task 2: Closing the window leaves the server running

**Files:**
- Modify: `electron/main.ts:191-193` — on `window-all-closed`, quit the *app* but do NOT signal the detached server. (It's a separate process; app quit no longer reaches it.)
- Modify: `server.cjs` `killShells` wiring — confirm it fires only on the *server's* own exit (it already binds to the server process's `exit`/`SIGINT`), so a detached server surviving app-close keeps its shells. Add a loopback-only `POST /api/shutdown` so the app CAN stop it deliberately.

- [ ] **Step 1:** Add `/api/shutdown` (loopback + trust-guarded, like other control routes) that runs `killShells()` then exits.
- [ ] **Step 2:** `window-all-closed` → `app.quit()` only; the detached server persists.
- [ ] **Step 3:** Manual integration proof: launch app, open a shell running a marker loop, close window, confirm the server PID + shell still alive (Get-Process), relaunch, confirm reattach. Screenshot the reattached live shell. Commit.

## Task 3: "Keep running when I close" setting + a way to fully quit

**Files:**
- Modify: `public/app.js` Settings — a toggle "Keep sessions running when I close the window" (default ON), and a "Quit WinMux completely" action that calls `/api/shutdown` then closes.
- Modify: `public/index.html` override layer for any new control styling (cockpit.css frozen).

- [ ] **Step 1:** Setting persists to `ct-settings`; when OFF, `window-all-closed` calls `/api/shutdown` first (opt back into the old kill-on-close behavior).
- [ ] **Step 2:** "Quit completely" in the app menu/settings → `/api/shutdown` → app quits.
- [ ] **Step 3:** Harness `shutdown` check: `POST /api/shutdown` on a scratch server → server exits, shells gone, port frees. Screenshot the setting. Commit.

## Task 4: Reattach-on-relaunch harness proof + docs

**Files:**
- Modify: `verify.cjs` — a `reattach` check that boots a scratch server, opens a session (records its `sid`), then a SECOND "client" resolves the SAME instance (simulating relaunch) and finds the session still live by `sid` (proves the attach path, which is the automatable core of survival).
- Modify: `PLAN.md` + this plan — mark session survival shipped with the proof.

- [ ] **Step 1:** Write the `reattach` check (server-level: the discovery + reattach-by-sid path).
- [ ] **Step 2:** `npm run verify` green including the new check, 3× back-to-back.
- [ ] **Step 3:** Update PLAN.md (Phase 11 / production-readiness #1 → done). Commit + push.

---

## Self-Review
- **Coverage:** detached spawn (T1), reattach-to-live (T1), window-close-leaves-running (T2), deliberate full-quit + setting (T3), automatable proof + docs (T4).
- **Risk gate:** the SMOKE/electron harness path stays in-process, so the existing electron check can't regress. The one thing not fully automatable is the true "close the OS window, agent keeps running" — proven by manual integration (T2 Step 3) with a screenshot, since the Playwright harness can't own a full Electron app lifecycle. Orphan risk is bounded by discovery (never double-spawn) + `/api/shutdown` (always stoppable).
- **No placeholders:** every task names the exact file + the concrete mechanism.
