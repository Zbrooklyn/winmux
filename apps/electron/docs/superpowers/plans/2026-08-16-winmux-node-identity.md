# WinMux Node — a fourth side-by-side identity

**Date:** 2026-08-16 · **Owner:** Claude
**Edward's directive:** "we should have a WinMux Node version also" — following "I want both
versions plus a third turi version." The collection becomes four coexisting installed apps:

| App | Shell | Engine | discovery | trust | userData/appId |
|---|---|---|---|---|---|
| WinMux (primary) | Electron | Rust | instance.json | devices.json | WinMux / com.zbrooklyn.winmux |
| WinMux Rust | Electron | Rust | instance.rust.json | devices.rust.json | WinMuxRust / …winmux.rust |
| WinMux Tauri | Tauri | Rust | instance.tauri.json | devices.tauri.json | (Tauri appdata) / …winmux.tauri |
| **WinMux Node (new)** | Electron | **Node (server.cjs)** | **instance.node.json** | **devices.node.json** | **WinMuxNode / …winmux.node** |

## Why it's cheap

`dist:node` already builds an Electron+Node-engine installer — but under the PRIMARY identity
(it was the fallback that replaces WinMux, not a sibling). This arc gives that build its own
identity so it installs beside the other three instead of over the primary.

## Work items

| # | Item | Done when |
|---|------|-----------|
| N-1 | This plan | Committed first. |
| N-2 | Identity plumbing | `identity-node.flag` (next to main.js, written only by the new dist script) selects a fourth profile variant in profile.ts: name "WinMux Node", appId com.zbrooklyn.winmux.node, userData WinMuxNode, instance.node.json, devices.node.json. Flag precedence: core-rust.flag rust-identity > identity-node.flag > primary. parseCoreFlag untouched; new `parseIdentityFlags` covered by profile.test.cjs. |
| N-3 | `dist:node-app` script | build:electron → REMOVE core-rust.flag (must boot the Node engine) → write identity-node.flag → electron-builder with primary config + appId/productName/artifact overrides (`WinMux-Node-Setup-<v>.exe`). No Rust exe bundled. |
| N-4 | Discovery | CLI + MCP default chain gains instance.node.json as fourth candidate (dead-pid skip already shipped). |
| N-5 | Install + proof | Silent install, launch: spawns a DETACHED Node server registered in instance.node.json while the other engines run; CLI reaches it via its instance file. Known risk: node-pty native rebuild in the Dropbox tree was wedged once — if packaging trips on it, stop and report options (clean off-Dropbox build dir / reinstall node-pty), never force. |
| N-6 | Ship | Installer staged in ~/winmux-build + uploaded to the v0.2.1 release as a fourth asset. Ledger + docs updated. |

## Out of scope

Retiring anything; winget (primary stays the one winget package); feature changes to the Node
server (it is the legacy engine, frozen at parity as of the Stage 4 cutover).
