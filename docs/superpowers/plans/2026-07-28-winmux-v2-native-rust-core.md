# WinMux v2 — Native Rust Core (Electron-now / Tauri-later)

> Direction-level staged plan. Each stage gets its own bite-sized implementation
> plan (superpowers writing-plans) when we start it. This doc is the contingency
> plan Edward asked for: it ships fully on Electron even if Tauri never happens.

**Goal:** Rebuild WinMux's core as a single native **Rust** binary that is agent-first,
serves the existing web frontend to browser/phone unchanged, and runs inside a desktop
shell — **Electron now** (safe fallback) and **Tauri later** (native shell + native
desktop GPU renderer) *if* the WebView2 browser-panel spike passes.

## Locked decisions (from the 2026-07-28 architecture dialogue)

- **Core — Rust single binary, from day 1** (not Node-then-port). Finish line = the
  existing **200-check `verify` harness passes green against the Rust core**. Today's
  Node WinMux is the executable spec; the harness is the definition of done, so this is
  a *bounded, verifiable* rebuild, not an open-ended one.
- **Shell — a swappable outer layer.** Because the core is a standalone binary, the shell
  stops being foundational. Electron-now spawns the core as a child process and keeps its
  proven `<webview>` + CDP browser panel. Tauri-later hosts the same core plus a native
  desktop renderer. ~90% of the work (core + web frontend + agent engine) is shared, so
  nothing is thrown away by starting on Electron.
- **Renderer — native GPU on desktop, best-effort on mobile.** Native desktop renderer on
  the Tauri path; xterm.js + WebGL on browser/phone. On the Electron fallback, it's
  xterm.js + WebGL everywhere (the only thing given up by staying on Electron).
- **UI process — demo-first (Layer 4 rule).** Every UI surface is built as a standalone
  HTML file, approved on Edward's eye, *then* wired into the app. Nothing renders into the
  product before it passes the standalone demo.
- **Governing principle:** most native, never heavier than it needs to be. Prefer the
  lightest path that still reaches native + full features.

## The seam that makes the shell swappable

The Rust core is a standalone binary exposing exactly today's surface:
- HTTP: static frontend (`public/` served verbatim, unchanged) + `/api/*`.
- WebSocket: shell I/O + `/control` (RPC).
- The agent-state + orchestration engine.
- Binds loopback + Tailscale; owns PTYs, persistence, trust, phone keys.

It is **renderer-agnostic — it streams bytes.** Any shell (Electron or Tauri) spawns it as
a child process and points a webview at `http://127.0.0.1:<port>`; browser/phone hit the
same port over Tailscale. Nothing shell-specific lives in the core.

## Stages (effort: S/M/L — sequencing is the milestone, dates are not invented)

### Stage 0 — Toolchain + decision spike  (S, gated)
- Install the Rust toolchain (rustup/cargo). Global install, reversible.
- **Tauri + WebView2 browser-panel spike:** minimal Tauri window, embed a second WebView2,
  prove CDP control of it (navigate / snapshot / click). **PASS → Tauri is on the table
  (Stage 5 unlocks). FAIL → Electron-stay is the plan; no native desktop renderer, no loss
  to the foundation.**
- WebView2 runtime already present on this machine (confirmed v150.x), so the spike is
  gated only on the Rust install.

### Stage 1 — Rust core skeleton  (M)
- Cargo project: HTTP server (serves `public/` verbatim — frontend untouched) + WebSocket.
- PTY layer via `portable-pty` (Rust) spawning PowerShell / CMD / Git Bash / WSL over ConPTY.
- One shell wired end-to-end: browser connects, real PowerShell runs.
- Finish line: the shell-I/O subset of `verify` passes against the Rust core.

### Stage 2 — Feature parity port  (L)
Port each verified subsystem until its harness checks pass:
session survival (registry + grace window + scrollback), auto-reconnect, single-socket
handoff, trusted devices + phone-key rotation, palette theme config, workspaces-as-code,
`/control` + `/rpc` + the `winmux` CLI, pre-warm spare, atomic trust writes, graceful
shutdown, port/Tailscale collision guards, markdown `/api/md`, browser-panel control endpoint.
- **Finish line: full 200-check harness green against the Rust core.** The Node core is
  retired only when this is true.

### Stage 3 — Agent-first engine  (M) — the new value, Rust from day 1
- **Agent-state engine:** classify each shell *blocked / working / done / idle* from process
  name + terminal output (herdr's model). New harness checks for state transitions.
- **Orchestration API:** extend `/control` + CLI so agents can spawn panes, read other
  panes' output, and wait on state (`winmux agent wait <id> --until done`). New harness checks.
- Attention state exposed to all faces as data (UI arrives via Layer-4 demos in Stage 6).

### Stage 4 — Shell: Electron on the Rust core  (S/M) — fallback path, ships first
- Electron main spawns the Rust core as a **sidecar** (replaces booting `server.cjs`
  in-process). Keep the proven `<webview>` browser panel + native window controls.
- Electron smoke check green. **This is a shippable WinMux v2 on the fallback path** —
  full features, agent-first, Rust core, no Tauri required.

### Stage 5 — Shell: Tauri + native desktop renderer  (L) — only if Stage-0 spike passed
- Tauri shell hosting the Rust core; WebView2 for mobile-parity rendering; a **native GPU
  terminal surface** for the desktop renderer (Layer 3). Sheds Electron's weight.

### Stage 6 — UI parity surfaces (Layer-4 rule)  (ongoing)
- wmux notification center, fleet / agents view, browser-panel chrome, cmux-style attention
  rings — each built as a standalone HTML demo, approved on Edward's eye, then wired in.

## What ships on the Electron fallback vs the Tauri bonus

- **Electron fallback (Stages 0–4, 6):** Rust core, agent-first backend, full wmux+cmux+herdr
  feature parity, phone/web reach, xterm.js+WebGL rendering everywhere. Complete product.
- **Tauri bonus (Stage 5):** adds native GPU desktop rendering + lighter weight. Isolated
  behind the Stage-0 spike; skippable without touching the foundation.

## Risks

- **`portable-pty` ↔ node-pty ConPTY parity on Windows** — the main technical risk;
  de-risked by the harness (rewrite until the same checks pass).
- **Tauri WebView2 browser-panel control** — the Stage-0 spike settles it before any
  commitment.
- **Effort** — this is a multi-week rebuild. The harness makes it *safe*, not *fast*.
