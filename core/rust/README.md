# WinMux v2 — Native Rust Core

Scaffold for the v2 native core. **No implementation yet** — the shipping product
today is the Electron/JS app in [`apps/electron/`](../../apps/electron).

## Why a Rust core

v2 replaces the Node `server.cjs` backend with a native Rust core (HTTP+WS serving
the same `public/` frontend, `portable-pty` shells) for lower memory, faster start,
and a path to a native GPU desktop renderer — without rewriting the frontend.

## Staged plan

Full plan: [`docs/superpowers/plans/2026-07-28-winmux-v2-native-rust-core.md`](../../docs/superpowers/plans/2026-07-28-winmux-v2-native-rust-core.md)

- **Stage 0** — install Rust toolchain + Tauri/WebView2 browser-panel spike (decides Tauri vs Electron shell)
- **Stage 1** — Rust core skeleton: HTTP+WS serving `public/` + `portable-pty` shell end-to-end
- **Stage 2** — port every subsystem to the Rust core until the full harness is green
- **Stage 3** — agent-first engine (blocked/working/done state + orchestration API)
- **Stage 4** — Electron shell on the Rust-core sidecar (fallback path — shippable v2)
- **Stage 5** — Tauri shell + native GPU desktop renderer (only if the Stage-0 spike passes)

## Build

Requires the Rust toolchain (Stage 0). Once installed:

```
cd core/rust
cargo run          # prints the scaffold banner
```
