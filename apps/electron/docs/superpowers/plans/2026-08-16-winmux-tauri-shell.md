# WinMux Tauri — a third side-by-side identity (v2 Stage 5, unparked by Edward)

**Date:** 2026-08-16 · **Owner:** Claude
**Edward's directive:** "I want both versions plus a third turi version" — keep BOTH installed
Electron apps ("WinMux" primary + "WinMux Rust" side identity) and ADD a Tauri-shell app as a
third coexisting install. This extends the Phase 12 coexistence contract from two identities to
three; it does NOT replace or retire anything.

## Objective

A native Tauri 2 desktop app — **"WinMux Tauri"** — that hosts the exact same web UI on the
exact same Rust engine as the other two apps, installed side by side with its own identity so
all three can run at once without sharing state. The win over Electron: ~10-15MB installer vs
~90MB, no bundled Chromium (system WebView2), Rust end to end.

## Identity (coexistence contract, third column)

| | WinMux (primary) | WinMux Rust | **WinMux Tauri (new)** |
|---|---|---|---|
| appId | com.zbrooklyn.winmux | com.zbrooklyn.winmux.rust | **com.zbrooklyn.winmux.tauri** |
| discovery | instance.json | instance.rust.json | **instance.tauri.json** |
| trust | devices.json | devices.rust.json | **devices.tauri.json** |
| engine | winmux-core.exe (bundled) | winmux-core.exe (bundled) | **winmux-core.exe (bundled sidecar)** |

CLI/MCP discovery gains instance.tauri.json as the third fallback candidate (dead-pid skip
logic already shipped in v0.2.1).

## Phases

| # | Item | Done when |
|---|------|-----------|
| TS-1 | This plan file | Committed before the first Tauri-app commit. |
| TS-2 | Scaffold `apps/tauri` | Tauri 2 app (version PINNED in Cargo.lock; multiwebview `unstable` feature NOT enabled in v1), icon from build/icon.ico, bundle identifier + productName set, `public/` + `winmux-core.exe` bundled as resources. Builds clean. |
| TS-3 | Engine resolve/spawn (Rust port of server-host.ts) | On launch: read instance.tauri.json → pid-alive + `/api/info` ping → reattach, else spawn the bundled engine DETACHED (outlives the window; sessions survive close) with WINMUX_INSTANCE_FILE/WINMUX_TRUST_FILE/WINMUX_PUBLIC, poll for the advertised port. Window opens on `http://127.0.0.1:<port>`. |
| TS-4 | Shell parity shim | Undecorated window; injected init script provides `window.winmux` (isTauri flag, minimize/maximize/close via window API, openExternal via opener, pickFile → null fallback v1, setQuake no-op v1) + `.ptabs` drag→startDragging (capability MUST declare the remote 127.0.0.1 URL context or every permission silently fails). UI renders and behaves like the Electron shell: window controls work, drag works, terminal runs a real command. |
| TS-5 | Installer + coexistence proof | NSIS installer `WinMux-Tauri-Setup-<version>.exe` via tauri bundler to ~/winmux-build. Proof: ALL THREE apps running at once — three engines, three instance files, disjoint; `winmux` CLI reaches each via WINMUX_INSTANCE_FILE and the default chain. Screenshots to Edward. |
| TS-6 | Docs + release | PLAN.md Stage 5 section updated; coexistence doc gains the third column; installer uploaded to the current GitHub release. NOT submitted to winget (one canonical winget package stays WinMux primary). |
| TS-7 (Phase 2, later) | Embedded browser panel | Tauri multiwebview child (`unstable` flag, version pinned) reusing the spike's proven add_child approach. Until then the browser leaf shows its plain-browser fallback. Separate go decision — do not start inside this arc without checking in. |

## Out of scope

- Retiring/replacing either Electron app (Edward explicitly keeps both).
- Code signing, auto-update (Edward-deferred, unchanged).
- Quake hotkey, native file picker in v1 (graceful fallbacks exist in the web UI).
- winget submission for the Tauri identity.

## Standing gates

Never touch the live "WinMux Rust" engine (Edward's sessions). Builds off-Dropbox output.
Harness stays green (409/409) — the Tauri app adds its own checks rather than changing shared code.
