# WinMux Config File + Custom Keybindings + Theme Import Implementation Plan

> **For agentic workers:** Execute task-by-task. Each keeps `npm run verify` green, ships a committed harness check, and a screenshot for any rendered change.

**Goal:** Make WinMux's settings, keybindings, and terminal themes durable, portable, and user-owned — a hand-editable on-disk config file that survives reinstall, remappable keyboard shortcuts, and importable color schemes.

**Architecture:** A single `~/.winmux/config.json` (sibling of the existing `instance.json`) becomes the durable home for settings, imported themes, and keybinding overrides. The server reads/writes it atomically over `/api/config` (same guard/atomic-write patterns as the trust file); the client fetches it on boot, merges it over its `DEFAULTS`, and writes back on change. localStorage stays as an offline mirror so the standalone `node server.cjs` phone/web path keeps working with no disk dependency. Keybindings gain a chord→action indirection so the hardcoded keydown chain becomes data. Themes reuse the existing 16-colour `PALETTES` structure; import maps a Windows Terminal colour scheme onto it.

## Global Constraints

- `cockpit.css` is FROZEN — new styles go in the `index.html` override layer only.
- Keep the standalone `node server.cjs` phone/web path working with NO disk-config dependency (config is an enhancement, not a requirement).
- Every task keeps `npm run verify` green + ships its own committed check.
- Rendered changes ship a screenshot to Edward (rule 21).
- Commit + push per task on `feature/phase8-electron-shell`.
- Atomic writes for `config.json` (write temp + rename), like the trust file — never a half-written config.

## Grounded current state (verified this session)

- **Settings:** `DEFAULTS` object at `public/app.js:64`; `S` hydrated from localStorage `ct-settings` (`app.js:70`); `saveSettings()` writes localStorage only; `applySettings()` applies. No disk config today.
- **Palettes:** `PALETTES` at `app.js:37` — each entry `{ label, dark[16], light[16] }` in ANSI order (`ANSI_KEYS`, `app.js:60`); `themeColors()` (`app.js:87`) maps the active palette to the xterm theme. A Settings palette picker already exists.
- **Keybindings:** a hardcoded keydown chain at `app.js:~2986-3040` (`if (ctrl && e.shiftKey && e.key==='P') openPalette()` …). The command-palette `actions` list (`app.js:~2842+`) already pairs a human action with a `kbd` label and a `run` fn — the seed of an action registry. Cheat-sheet `KEYS` at `app.js:2761`.
- **Server:** no config file yet; `instance.json` lives at `~/.winmux/` (`server.cjs:1238`); `TRUST_FILE` uses atomic writes. Endpoint + guard pattern established (`/api/*`, `viaPhone`).

---

### Task 1: Config file — durable, hand-editable settings on disk

**Files:**
- Modify: `server.cjs` (add `CONFIG_FILE` = `~/.winmux/config.json` + `readConfig()`/`writeConfigAtomic()`; add `/api/config` GET/POST)
- Modify: `public/app.js` (on boot, `fetch('/api/config')` and merge disk settings over `DEFAULTS` before first paint; on `saveSettings()`, also POST the settings blob to `/api/config`)
- Test: `verify.cjs` (`config` check — POST a settings blob, GET it back; boot a page and assert a disk-set value is reflected in the live `S`)

**Interfaces:**
- Produces (server): `GET /api/config` → `{ ok, config: { settings, themes, keymap } }`; `POST /api/config` `{ settings?, themes?, keymap? }` merges + persists, returns `{ ok }`. Loopback + tailnet allowed (it's this user's own settings; same cookie auth as the rest). Size-capped.
- Produces (client): `S` is `DEFAULTS` ← disk `config.settings` ← localStorage (disk wins over localStorage for keys it defines; localStorage is the offline fallback when `/api/config` is unreachable).

**Done-criteria:** A settings change persists to `~/.winmux/config.json`, survives a full reinstall/localStorage-wipe, and can be hand-edited to change the app. The phone/web path still boots with no config file present.

- [x] Server: `CONFIG_FILE`, `readConfig()` (missing/corrupt → `{}`), `writeConfigAtomic()` (temp+rename).
- [x] Server: `/api/config` GET/POST (merge per sub-object, 1 MB cap, atomic write).
- [x] Client: boot fetch (`loadDiskConfig`) + merge (disk over defaults) + `applySettings`; localStorage fallback preserved.
- [x] Client: `saveSettings()` also POSTs `{ settings: S }` to `/api/config` (fire-and-forget); `localOnly` flag for the mirror path.
- [x] `config` harness check (POST/GET round-trip + real file on disk + a fresh empty-localStorage page adopts the on-disk fontSize on the live term) — 4/4. Harness isolates every server's config to a temp file so no test touches the real `~/.winmux/config.json`.
- [x] Screenshot: app booted from disk (fontSize 17 applied) shipped. Commit + push.

**STATUS: DONE.** Settings now persist to `~/.winmux/config.json` (atomic write), survive a reinstall / localStorage wipe, are hand-editable, and ride the tailnet so they follow you to the phone. The standalone phone/web path still boots with no config file. 18/18 across config+cli+migrate+parity — no regression.

### Task 2: Theme import — bring your own colour scheme

**Files:**
- Modify: `public/app.js` (an "Import theme" affordance in Appearance settings; parse a Windows Terminal colour-scheme JSON — 16 ANSI names + `background`/`foreground` — into a `PALETTES`-shaped entry; store under `config.themes`; make user themes selectable in the palette picker; persist via `/api/config`)
- Modify: `public/index.html` (override-layer styling for the import row/textarea, if any)
- Test: `verify.cjs` (`theme-import` check — feed a known scheme, select it, assert the live xterm theme's computed ANSI colours match the scheme)

**Interfaces:**
- Consumes: `PALETTES` shape `{ label, dark[16], light[16] }`, `ANSI_KEYS` order, `themeColors()`.
- Produces: `importTheme(schemeJson)` → adds `config.themes[id] = { label, dark, light }`; merged into the palette list the picker reads.

**Done-criteria:** A user pastes/loads a Windows Terminal colour scheme, it appears in the palette picker, selecting it recolours the terminal to that scheme (verified by computed xterm theme values), and it persists across reload via the config file.

- [x] Parser: `importTheme(text)` maps a WT scheme's 16 ANSI names (WT "purple"→ANSI magenta) onto a `PALETTES` entry, same colours dark/light; validates all 16 as `#rrggbb`.
- [x] UI: Appearance "Import terminal theme" button → paste-a-scheme dialog (`importThemeDialog`, textarea, inline error), selects the new theme + re-renders on success.
- [x] Persist to `config.themes` (`saveThemes` POSTs); picker + `themeColors()` read `allPalettes()` = built-in ∪ user themes; loaded on boot from disk.
- [x] `theme-import` harness check (PORT 9941): imports Campbell, asserts the ANSI colours (incl. purple→magenta both intensities) land on the live term — 3/3.
- [x] Screenshot: Settings → Appearance with "Campbell — imported" selected + the Import button, shipped. Commit + push.

**STATUS: DONE.** Import a Windows Terminal colour scheme and the terminal wears it; it persists via the config file. Fixed a real bug found by the `colour` check: a fresh boot's `applySettings` could POST defaults and clobber the on-disk config — now the disk write waits until the config is read (`configReady`), and localStorage (this device's explicit choice) wins per-key over disk on reconcile (`LS_KEYS`); disk still fills the gaps a fresh install leaves. 28/28 across colour+config+theme-import+cli+migrate.

### Task 3: Custom keybindings — remap the shortcuts

**Files:**
- Modify: `public/app.js` (an `ACTIONS` registry keyed by stable id with `{ label, defaultChord, run }`; a `chordOf(e)` normaliser → e.g. `"Ctrl+Shift+P"`; refactor the keydown chain to resolve `chordOf(e)` → user-or-default keymap → action; a Shortcuts settings tab listing actions with their current chord + rebind + reset-to-default; persist `config.keymap`)
- Modify: `public/index.html` (override-layer styling for the rebind rows)
- Test: `verify.cjs` (`keybindings` check — remap an action to a new chord, dispatch the new chord, assert the action ran; assert the old default chord no longer triggers it)

**Interfaces:**
- Consumes: the existing `run` fns already referenced by the command-palette `actions` list.
- Produces: `ACTIONS` (id → {label, defaultChord, run}); `keymapResolve(e)` → actionId|null; `config.keymap` (id → chord override). The "terminal is king" fall-through set (Ctrl+D/F/B while a shell is focused) stays hard-coded and is NOT remappable — those belong to the shell.

**Done-criteria:** A user rebinds an action in Settings, the new chord runs it, the old chord doesn't, and the binding persists via the config file. Unremapped actions behave exactly as before (no regression).

- [x] `ACTIONS` registry (18 remappable app actions) + `chordOf(e)` normaliser (fixed Ctrl/Alt/Shift order) + `effectiveChord`/`keymapLookup`.
- [x] Refactored keydown: the clean app-chord if-chain → one `keymapLookup(chordOf(e))` dispatch. Copy-mode capture, Ctrl+Tab MRU, the terminal-is-king fall-through, Escape, font-size (=/+/−/0) and Alt+1-9 tab-jump all kept hardcoded/verbatim (not remappable by design).
- [x] Shortcuts settings tab: every action with its current chord + Rebind (captures the next chord via a modal that stands the global handler down through `rebindCapture`) + per-row Reset + Reset-all; collision warning; requires a modifier or function key.
- [x] Persist `config.keymap` (`saveKeymap`, gated by `configReady`); localStorage mirror; disk fills gaps on boot.
- [x] `keybindings` harness check (PORT 9942): default chord still fires after the refactor · a remap is recorded · the new chord runs it · the old default goes dead — 4/4.
- [x] Screenshot: Shortcuts tab with "Command palette → Ctrl+K" (default-hint + Reset) shipped. Commit + push.

**STATUS: DONE.** Shortcuts are remappable in Settings → Shortcuts and persist via the config file; the keydown chain is keymap-driven, not hardcoded, with every special case preserved. 46/46 across keybindings+config+theme-import+colour+cli+migrate+doing+parity+notify+mcp — the core keyboard refactor is regression-clean.

---

## Item 6 — ALL THREE TASKS DONE
- T1 config file — DONE (10bd305).
- T2 theme import — DONE (735781e).
- T3 custom keybindings — DONE (this commit).

---

## Self-Review

- **Coverage:** config file (T1) · theme import (T2) · custom keybindings (T3) — the three named pieces of roadmap item 6.
- **Sequencing:** T1 first because it's the durable store T2/T3 persist through; T2 before T3 because it's lower-risk (reuses palette machinery) vs the keydown refactor.
- **Risk:** T3 is the only real refactor; it preserves the terminal-is-king fall-through and copy-mode capture verbatim and keeps every action reachable, so a bad rebind can't strand a command. Each task independently testable with a committed check; the phone/web path stays intact (config is additive, localStorage remains the fallback).
- **No owner gates here** — settings/keymap/theme mechanics are technical. The one product-ish default (import format = Windows Terminal schemes) is the right call for a Windows/PowerShell terminal and is reversible.
