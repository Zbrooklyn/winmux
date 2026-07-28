# WinMux v2 — Native Rust Core (Electron-now / Tauri-later)

> The complete plan: every layer decision and the little details behind them.
> Direction-level staged plan — each stage gets its own bite-sized implementation
> plan (superpowers writing-plans) when we start it. This doc is also the
> contingency plan: it ships fully on Electron even if Tauri never happens.

---

## Why we're doing this (positioning)

**Lineage:** cmux (macOS original, native GPU, ~25k stars) → wmux (amirlehmam's Windows
Electron port) → **WinMux (our web-served rebuild).** Three of the tools in this space are
one bloodline; WinMux is the version rebuilt on a lighter, web-first architecture.

**WinMux's defensible moat — the thing none of the others have:** a **Windows-native**
terminal you reach from **any device's browser or phone over Tailscale, with no install**,
and **script from outside**. cmux is macOS-only with an iOS app; wmux is desktop-only
Electron; herdr is SSH-only TUI; Windows Terminal has no remote at all. That combination is
uniquely ours.

**The one gap we're closing:** **agent-attention.** Both 20k-star competitors (cmux, herdr)
built their identity on knowing *which agent is blocked and needs you*. Today WinMux's
"fleet" is only a count of open terminals. v2 adds real per-agent state — the table-stakes
of this category — while keeping the remote lane nobody else occupies.

**Goal:** the best of wmux + Windows Terminal + cmux + herdr, in one tool: as native and
optimized as possible, agent-first (especially the backend), reachable everywhere.

**Governing principle (Edward, 2026-07-28):** *most native, but never heavier than it needs
to be — if there's a lighter path to the same result, take it.* Adding everything the others
have does **not** mean carrying their weight.

---

## Locked decisions — the four layers

### Layer 1 — Core: a single native Rust binary, from day 1
- Rust, not Node-then-port. PTY, streaming, control channel, the agent engine, trust,
  phone, CLI — all Rust, matching herdr's single-binary model. Chosen over the "keep Node,
  swap later" path explicitly: **best direction from day 1, not the lazy one.**
- **Finish line = the existing 200-check `verify` harness passes green against the Rust
  core.** Today's Node WinMux is the executable spec, so the rewrite is *bounded and
  verifiable* — rewrite until the same checks pass — not open-ended, and low-regression.
- Why it's the right foundation and not wasteful: node-pty is already native C++, and Node
  was never the bottleneck for a terminal (PTY I/O + byte streaming are, and those are
  native). The Rust win is felt as **runtime weight, startup, and a single distributable
  binary** — the right base for something used heavily.
- The agent-first engine (Layer-4 value) is written in Rust from the start, not bolted onto
  Node and ported later.

### Layer 2 — Shell: a swappable outer layer (Electron-now / Tauri-later)
- Because the core is a standalone binary, the **shell stops being foundational.** It just
  spawns the core as a child process and points a webview at `http://127.0.0.1:<port>`.
- **Electron-now (the fallback):** Electron spawns the Rust core as a sidecar, renders the
  web frontend, and keeps its **already-proven `<webview>` + CDP browser panel** — zero risk
  on the single hardest feature. Cost: ~150MB, high RAM, slow start, and it *caps* how native
  we can get (locks rendering to Chromium). Ships a full, complete v2.
- **Tauri-later (the bonus):** Rust shell over Windows' built-in **WebView2** (~5–10MB, fast
  start, low RAM, native to Win11). It's the natural host for a native desktop renderer and
  a Rust core in one binary. **Open risk:** whether the controllable browser panel works on
  WebView2 the way `<webview>`+CDP does in Electron — settled by the Stage-0 spike.
- **~90% of the work — Rust core + web frontend + agent engine — is shared by both shells,**
  so starting on Electron and moving to Tauri later throws nothing away. Only the
  native-desktop renderer and the weight ride on the Tauri question — not the foundation,
  features, or timeline.
- Environment confirmed on this machine: **Rust 1.97.1 stable-msvc installed; WebView2 v150
  present.** The native path has no install friction here.

### Layer 3 — Renderer: native on desktop, best-effort on mobile
- The core streams **raw terminal bytes**; each face renders however it wants. So **two
  render paths, one core** — no conflict.
- **Desktop (Tauri path):** a native GPU terminal engine (libghostty-class, what cmux does).
  **Mobile/browser:** xterm.js + WebGL. **Electron fallback:** xterm.js + WebGL everywhere.
- **Lightest-path rule applied here (the "don't be heavy" principle bites hardest):** the
  lightest route to near-native desktop is the **WebGL renderer already shipped, running in a
  native WebView2 shell** — GPU-accelerated, ~90% of native, basically free. A *fully* native
  text engine is the last ~10% at real integration cost. **Ship WebGL-in-native-shell first;
  embed a native engine only if the difference is actually felt under heavy output.**
- Already done: WebGL renderer shipped as opt-in (`S.gpuRenderer`, default off). Flipping the
  default on is queued behind migrating the DOM-reading harness checks to the buffer API.
- Rendering bar to match: Windows Terminal's AtlasEngine and cmux's libghostty are the
  native-GPU references.

### Layer 4 — Feature parity + the UI process
- **Everything wmux / Windows Terminal / cmux / herdr have is UI or API sitting on the core:**
  - *wmux:* browser panel, notification center, fleet view → rebuilt on the web frontend.
  - *herdr:* blocked/working/done sidebar, wait-on-state events, and a socket API where
    **agents call back in** to spawn panes and read each other's output.
  - *cmux:* attention routing — pane rings, unread badges, a notification panel, desktop
    alerts when an agent needs input.
  - *Windows Terminal:* the rendering-quality bar (native GPU text, full unicode, ligatures).
- **UI process rule (Layer 4, locked):** every UI surface is built and demoed as a
  **standalone HTML file, approved on Edward's eye, THEN wired into the app** — the same way
  the cockpit mockup was done. Nothing renders into the product before it passes the
  standalone demo.

---

## The seam that makes the shell swappable

The Rust core is a standalone binary exposing exactly today's surface:
- **HTTP:** static frontend (`public/` served verbatim, unchanged) + `/api/*` (incl.
  `/api/md` for the markdown viewer).
- **WebSocket:** shell I/O + `/control` (RPC) + `/rpc` forwarder.
- The **agent-state + orchestration engine.**
- Binds loopback + Tailscale; owns PTYs, persistence, trust store, phone keys.

It is **renderer-agnostic — it streams bytes.** Any shell (Electron or Tauri) spawns it as a
child process; browser/phone hit the same port over Tailscale. Nothing shell-specific lives
in the core, which is what lets the shell swap without touching anything else.

---

## Stages (effort S/M/L; sequencing is the milestone — dates are not invented)

### Stage 0 — Toolchain + decision spike  (S, gated)
- Rust toolchain: **already installed** (cargo/rustc 1.97.1 stable-msvc) — Stage-0 blocker
  cleared.
- **Tauri + WebView2 browser-panel spike:** minimal Tauri window, embed a second WebView2,
  prove CDP control of it (navigate / snapshot / click). **PASS → Tauri on the table (Stage 5
  unlocks). FAIL → Electron-stay is the plan; no native desktop renderer, no loss to the
  foundation.**

### Stage 1 — Rust core skeleton  (M)
- Cargo project: HTTP server (serves `public/` verbatim — frontend untouched) + WebSocket.
- PTY layer via `portable-pty` (Rust) over Windows ConPTY, spawning PowerShell / CMD /
  Git Bash / WSL.
- One shell wired end-to-end: browser connects, real PowerShell runs.
- Finish line: the shell-I/O subset of `verify` passes against the Rust core.
- **Perf baked in from the start:** coalesce PTY output into **binary frames** (not
  per-keystroke JSON) — this is the fix for the measured 10-agent jank (132ms/tick vs the
  50ms target).

### Stage 2 — Feature parity port  (L)
Port each verified subsystem until its harness checks pass:
session survival (registry + grace window + scrollback), auto-reconnect, single-socket
handoff (phone takes over desktop), trusted devices + phone-key rotation, palette theme
config (3 palettes × dark/light), workspaces-as-code (`winmux open <file.json>`), `/control`
+ `/rpc` + the full `winmux` CLI (status / list / new-tab / split / send / read-screen /
focus / browser / markdown / open), pre-warm spare PTY, atomic trust writes, graceful
shutdown, port + Tailscale collision guards, markdown `/api/md`, the browser-panel control
endpoint.
- **Finish line: full 200-check harness green against the Rust core.** The Node core is
  retired only when this is true.

### Stage 3 — Agent-first engine  (M) — the new value, Rust from day 1
- **Agent-state engine:** classify each shell *blocked / working / done / idle* from process
  name + terminal output (herdr's model; ~15+ agents zero-config). New harness checks for
  state transitions.
- **Orchestration API:** extend `/control` + CLI so agents spawn panes, read other panes'
  output, and wait on state — e.g. `winmux agent wait <id> --until done`. This is the
  "agents can use WinMux too" capability. New harness checks.
- Attention state exposed to **all faces as data** (desktop, browser, phone get it
  identically because it lives in the core). UI presentation arrives in Stage 6.

### Stage 4 — Shell: Electron on the Rust core  (S/M) — fallback path, ships first
- Electron main spawns the Rust core as a **sidecar** (replaces booting `server.cjs`
  in-process). Keep the proven `<webview>` browser panel + native window controls.
- Electron smoke check green. **This is a shippable WinMux v2 on the fallback path** — full
  features, agent-first, Rust core, no Tauri required.

### Stage 5 — Shell: Tauri + native desktop renderer  (L) — only if the Stage-0 spike passed
- Tauri shell hosting the Rust core; WebView2 for mobile-parity rendering; a **native GPU
  terminal surface** for the desktop renderer (Layer 3). Sheds Electron's weight.

### Stage 6 — UI parity surfaces (Layer-4 demo-first rule)  (ongoing)
- wmux notification center, fleet / agents view, browser-panel chrome, cmux-style attention
  rings + desktop alerts — each built as a standalone HTML demo, approved on Edward's eye,
  then wired in.

---

## What ships on the Electron fallback vs the Tauri bonus

- **Electron fallback (Stages 0–4, 6):** Rust core, agent-first backend, full
  wmux+cmux+herdr feature parity, phone/web reach, xterm.js+WebGL rendering everywhere,
  demo-first UI. A complete product.
- **Tauri bonus (Stage 5):** adds native GPU desktop rendering + lighter weight. Isolated
  behind the Stage-0 spike; skippable without touching the foundation.

---

## Risks

- **`portable-pty` ↔ node-pty ConPTY parity on Windows** — the main technical risk;
  de-risked by the harness (rewrite until the same checks pass).
- **Tauri WebView2 browser-panel control** — the Stage-0 spike settles it before any
  commitment.
- **Effort** — this is a multi-week rebuild. The harness makes it *safe*, not *fast*.

---

## Already banked (2026-07-28)

- WebGL GPU renderer shipped opt-in (`S.gpuRenderer`), harness green.
- Seven backend quick-wins (key-rotation-on-forget, `winmux status`, clean-JSON CLI, PTY
  pre-warm, atomic trust writes, graceful shutdown, workspaces-as-code).
- 10-session stress test: backend held 10 sessions; UI jank measured (drives the Stage-1
  binary-frame + WebGL work).
