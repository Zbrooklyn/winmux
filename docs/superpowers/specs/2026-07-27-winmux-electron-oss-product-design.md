# WinMux → Real OSS Desktop Product — Design Spec

**Date:** 2026-07-27
**Status:** Approved design (pending spec review) → implementation plan
**Goal:** Turn WinMux from a web-served local terminal into a real, public **open-source desktop
product** that fully replaces (and exceeds) `wmux`, by wrapping the existing web app in Electron
while keeping the internal web server running so Tailscale phone access survives.

## 1. What we're building and why

WinMux today is a browser-served terminal multiplexer for Windows: `server.cjs` (Node + node-pty +
ws) spawns real shells and streams them over a websocket to a vanilla-JS + xterm.js frontend
(`public/`) wearing a frozen mockup stylesheet (`public/cockpit.css`). Its unique strength is
**phone access over Tailscale** — something the app it's modeled on, `wmux` (Electron + React), cannot
do.

`wmux` is a mature Electron app: a `wmux` CLI, a named-pipe RPC that agents drive, an Electron
`<webview>` browser panel driven by CDP, a markdown viewer, Claude Code hook/fleet integration, and a
full OSS release pipeline (installer, auto-update, winget).

**The decision:** make WinMux a *superset* of wmux. Not a rewrite — **wrap the existing app in
Electron and keep the server running inside it.** WinMux already owns the hard 80% (the Node/node-pty
backend and the entire cockpit UI). wmux's automation layer is transport-agnostic and maps cleanly
onto WinMux's existing HTTP/WS server. The only genuinely Electron-hard feature is the browser panel,
which Electron provides natively.

**Owner decisions (locked):** public **open-source** product · name **WinMux** · **MIT** license ·
**full-parity** first public release (v1.0), not an early shell release.

## 2. North star: three faces, one server

The core principle: **`server.cjs` is the core; everything is a client of it.**

```
                         ┌─────────────────────────┐
                         │   server.cjs (core)      │
                         │  ptys · sessions · ws    │
                         │  serves public/ · RPC    │
                         └───────────┬─────────────┘
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                             │
  Electron window              phone browser                 winmux CLI
  (BrowserWindow loads         (Tailscale, unchanged)        (+ agents / SSH)
   the served public/;         terminal + all surfaces       drives the RPC
   native chrome + webview      except desktop-only          control channel
   browser panel)               browser panel
```

- **One frontend, multiple hosts.** The Electron window loads the *same* `public/` UI the phone
  renders, over the in-process server at `http://127.0.0.1:<port>`. `cockpit.css` stays frozen.
- **Phone access survives** because the server runs inside Electron's main process (and still runs
  standalone). Electron is just another client of the same server.
- **The CLI/agents** are clients of a new authenticated RPC channel on that server.

## 3. Components

### 3.1 Electron shell (new)
- `electron/main.ts` — Electron main process. Boots `server.cjs` in-process (require + start, not a
  child process, so it shares state), creates a frameless `BrowserWindow` that loads the served URL,
  wires native window controls to the existing stub `window.winmux` bridge, owns the webview browser
  panel and native notifications.
- `electron/preload.ts` — context-bridge exposing `window.winmux` (window controls, browser-panel
  control, native notify, file/folder dialogs, native theme events). The web/phone build simply lacks
  this bridge; the UI already degrades (maximize→fullscreen, minimize inert) when it's absent.
- **Web/phone mode is unaffected:** `node server.cjs` still serves the pure-web app with no Electron.

### 3.2 `winmux` CLI + RPC control channel (new)
- **RPC surface** on `server.cjs`: an authenticated control channel (WS message type or HTTP
  endpoints under `/rpc`, reusing the existing key/device auth + a per-instance token injected into
  spawned shells' env, mirroring wmux's `WMUX_PIPE_TOKEN` model). Transport-agnostic → local, remote,
  and SSH-tunneled driving all fall out.
- **Command parity set** (mapped from wmux's CLI): `ping`, `list-windows/tree`, workspace(group)
  CRUD, surface(tab) CRUD, `split`/`pane` verbs, `layout grid`, `send`/`send-key`/`read-screen`,
  `notify`/`list-notifications`, `browser …`, `agent spawn/list/status/kill`, `markdown`, `diff`,
  `set-status`/`set-progress`/`log` (sidebar), `hook` (agent activity).
- `cli/winmux.ts` + a `winmux`/`winmux.cmd` shim — thin client over the RPC; defaults the target
  surface to the caller's own via an injected `WINMUX_SURFACE_ID` env var.

### 3.3 Browser panel (new, **desktop-only**)
- Electron `<webview>` + `webContents.debugger` (CDP 1.3) — the exact model wmux uses:
  `Accessibility.getFullAXTree` → `@eN` refs, click/type/fill via `DOM.getBoxModel` +
  `Input.dispatchKeyEvent`, `Page.captureScreenshot`, `Runtime.evaluate`.
- Per-caller isolation (each agent gets its own browser pane, keyed by `WINMUX_SURFACE_ID`).
- **Honest degradation:** on the phone/web build there is no webview, so the browser *automation*
  panel is unavailable and the surface shows a "desktop-only" state. The existing git-diff dock is
  unchanged and remains available everywhere.

### 3.4 Markdown viewer surface (new)
- A `public/` surface type that renders a `.md` file/content read-only, live-updatable via
  `winmux markdown set <id>`. Pure web — available on desktop and phone.

### 3.5 Agent integration (new)
- **Claude Code hooks:** a `winmux-hook` binary Claude Code's `PostToolUse`/`Notification`/`Stop`
  hooks call; forwards events over the RPC tagged with `WINMUX_SURFACE_ID`.
- **Fleet + transcript:** read `~/.claude/projects/**` JSONL (WinMux built a fleet reader before)
  to show every Claude session with live status, expandable to a transcript tail. Web-renderable →
  works on the phone too (a real advantage over wmux).
- **Shell integration:** prompt hooks that report cwd / git branch+dirty / run-state to the server
  for live sidebar status (PowerShell + bash/WSL).

### 3.6 OSS distribution (new)
- `electron-builder` → NSIS installer + portable zip (Windows x64).
- `electron-updater` auto-update from GitHub Releases, hardened like wmux (no auto-download,
  quarantine window, explicit confirm). Web/phone mode needs no updater (redeploy = instant).
- winget PR workflow; `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`; public GitHub repo.

## 4. Technical decisions (owned)

- **Electron, not Tauri** — reuses 100% of the existing Node/node-pty backend; Tauri would force a
  Rust rewrite or Node sidecar. Electron is how VS Code, Hyper, Tabby, and wmux ship.
- **One repo** — `projects/winmux` stays canonical; add `electron/` and `cli/` dirs. (Canonical
  copy under `AI_Projects_Claude\projects\winmux`; GitHub is the real backup.)
- **New code in TypeScript** (Electron main/preload, CLI, RPC types), compiled alongside the
  **untouched** `server.cjs` and `public/`. Keeps the frozen contract; adds a credible, typed layer
  for a public project.
- **`cockpit.css` remains frozen** — every Electron-only affordance layers on via the `<style>`
  block / preload bridge, never by editing the mockup contract.

## 5. Testing / verification

- Extend the committed `verify.cjs` harness (zero-arg `npm run verify`) with: Electron smoke test
  (offscreen window boot + capture, like wmux's), CLI integration tests against a live server
  (spawn tab → send → read-screen assertions), browser-panel CDP round-trip, RPC auth tests.
- Every phase keeps the harness green; frontend changes ship screenshots (desktop + phone).

## 6. Phases (extend `winmux/PLAN.md`, not a competing file)

All phases complete before the public v1.0 launch.

- **Phase 8 — Electron shell.** BrowserWindow loads the in-process server; native chrome + real
  window controls; app runs offline as a window while still serving the phone. Proof: installed-ish
  app opens, runs a real command, phone still connects.
- **Phase 9 — `winmux` CLI + RPC.** Control channel + auth + the parity command set + CLI shim.
  Proof: `winmux new-tab`/`send`/`read-screen` drive the live app; agent can script it.
- **Phase 10 — Browser panel + markdown.** Electron webview+CDP browser automation surface;
  markdown viewer. Proof: `winmux browser open/snapshot/click` round-trips; markdown renders + live-updates.
- **Phase 11 — Agent integration.** Claude Code hooks, fleet/transcript view, shell integration.
  Proof: real Claude session activity shows live in the sidebar; cwd/git track.
- **Phase 12 — OSS distribution + launch.** Installer, auto-update, winget, README/LICENSE, public
  repo; full wmux-parity verification. Proof: clean-machine install runs; v1.0 tagged + public.

## 7. Explicitly out of scope (for v1.0)

- macOS/Linux builds (Windows-first, like wmux; cross-platform is a later consideration).
- Commercial/licensing/activation (this is free OSS).
- Rewriting `server.cjs` or `public/` in TS/React — the existing vanilla app is the product; only
  *new* layers are TS.
- Replacing the git-diff dock — it stays; the browser panel is additive.

## 8. Open questions

None blocking. Minor items to confirm during implementation: exact RPC transport (WS message vs
`/rpc` HTTP — decided in Phase 9 plan), and whether the phone build advertises the desktop-only
surfaces as "open on desktop" affordances or hides them.
