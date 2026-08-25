# Master Plan — WinMux for Obsidian

v0.3 · 2026-08-25 · **standalone replacement** (Edward 8/25: installable without the WinMux app; everything WinMux does today must be in the plugin) · status **APPROVED by Edward 2026-08-25 (G1: full replacement, P0–P5, quake/auto-start accepted as v1 gaps)**.
Size: existing/high-risk → full plan, compressed. Critic: Codex (20 findings; 4 blockers resolved from source, see §31).

## 1. Executive Summary
- **Goal:** WinMux runs inside Obsidian **as a complete standalone product**: install the plugin on a machine with no WinMux app and you get everything WinMux does today — engine, sessions, sidebar, terminals, agents, projects, phone access, the `winmux` CLI and the Claude MCP tools. Obsidian supplies tabs / splits / stacking / palette / hotkeys.
- **User:** Edward on desktop Windows running Claude Code; agents (winmux CLI + MCP) are the second user.
- **Product:** desktop-only Obsidian plugin, `apps/obsidian` in Zbrooklyn/winmux. **Type:** new app inside an existing project.
- **Core problem:** WinMux's own window chrome breaks past ~4 panes; Obsidian already solves layout at scale.
- **Owner decisions:** D1 architecture (bundled engine + bundled CLI/MCP, full parity) · D2 the two things Obsidian cannot host — the quake drop-down window (global hotkey) and auto-start at login — accept as documented gaps, or keep a tiny helper · D3 release (later).
- **Top risks:** keymap conflicts inside Obsidian (R1) · shared-engine ownership between plugin and standalone (R2) · re-implementing 12 control verbs on Obsidian's workspace (R3).
- **First step:** P0 scaffold with the engine bundled and started by the plugin alone (no WinMux app running) → P1 one live terminal tab in real Obsidian, screenshot via CDP.

## 2. Current-State Recovery (evidence, not assumption)
- Repo: `C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux`, branch `feature/phase8-electron-shell` @ **3ffff3f**, `git status` clean except untracked `apps/electron/.verify-out/` (harness output, not ours). `master` owner-gated. `C:\dev\winmux-replay` is scratch — not used.
- Core exe: `core/rust/target/release/winmux-core.exe` 3,536,896 B, 2026-08-20 21:57, v0.2.7, MIT (ours). Binds 127.0.0.1; env `WINMUX_PORT`, `WINMUX_INSTANCE_FILE` (default `~/.winmux/instance.json`, currently `{"port":9909,"pid":44184,…}` → a standalone engine is alive now).
- Routes (main.rs L472–499): `/pty` `/control` `/rpc` `/api/info` (version, port, pid, sessions, detached, recoverable) `/api/backlog` (newest-30 recoverable) `DELETE /api/session` `/shells` `/api/claude-sessions?cwd` `/api/shutdown` `/api/workspace` `/api/projects` `/api/history` + phone routes.
- `/pty` protocol: `?shell&cwd&sid`; client `{t:"i"|"r"|"x"}`; server bytes + `{type:"meta",sid,shell,cwd,resumed,lost,exited,code,error}`; 30 s detach grace then backlog.
- **`/control` routing (resolves U2):** `pick_controller()` L227 = the highest-id (most recently connected) UI wins. No core change needed.
- **Live-session enumeration (resolves B1):** the core has **no list-live-sessions route** — only counts in `/api/info` and the recoverable backlog. So "all sessions" = sessions this plugin opened + everything recoverable from backlog. A session held live by standalone WinMux is invisible until it detaches (30 s). Adding a list route is a core change → Edward-gated, deferred (§18 D6).
- `runControl` verbs (app.js L5930+): list · read-screen · send · focus · close · split · new-tab · agent · browser · markdown · notify · project.
- Working/idle heuristic in standalone (app.js L1851): any PTY output → `working`; no output for **1200 ms** → `idle`; bell/exit while unfocused → `needsyou`.
- CLI discovery (`bin/winmux.cjs` L20–37): `WINMUX_PORT` env → else `~/.winmux/instance*.json` with pid-alive check. **Plugin must use the same default instance file** so CLI/MCP need no change (resolves B3).
- Obsidian 1.12.7 installed; `obsidian` npm 1.13.1 (types) — pin `minAppVersion` 1.12.0 and prove load in 1.12.7 at P0. esbuild 0.28.2, node 24.16, codex 0.144.5. Termy (`isDesktopOnly`, spawns bundled exe, local WS) proves the pattern in this Electron.
- Confidence: high on protocol/toolchain/routing; medium on keymap behaviour (U1); unknowns U1 keymap capture, U3 restore-after-relaunch UX.

## 3. Plan Control
Source of truth: `apps/obsidian/PLAN.md`; status `apps/obsidian/STATUS.md`. IDs `P0…P6`, `P1-T3`; statuses TODO/DOING/BLOCKED/DONE(validated). Status-only → STATUS.md; minor → plan edit; **Edward** → scope, release, any edit under `core/` or `apps/electron/`, `master`; new version → architecture change. Stale: core protocol bump, Obsidian major, >14 days idle.

## 4. Type + Lifecycle
New app in existing repo. Covered: intake, discovery, plan, build, validate, release (local zip → BRAT). Not needed now: migration, analytics, marketing (gated), sunset = uninstall.

## 5. Goal Definition
- **Parity inventory (what "everything" means, from app.js sections + bins):** engine (bundled) · sessions + backlog/recover · sidebar · terminal panes/tabs/groups · instant typing (local echo) · broadcast to group · command palette · keyboard map · notifications + needs-you attention · agents overlay + jobs · projects (save/open sets) · workspace save/load · settings · phone access (enable, QR, devices) · cheat sheet · diagnostics · markdown + browser tabs · `winmux` CLI 16 verbs (agent, browser, close, focus, image, list, markdown, new-tab, notify, open, read-screen, send, slash, split, status, transcript + job verbs) · MCP 16 tools · `winmux-orchestrate` skill + Claude hooks. **Obsidian provides natively:** tabs, splits, stacking, groups, sidebar shell, palette, hotkeys, workspace persistence, markdown, web viewer. **Obsidian cannot provide:** quake global-hotkey window, auto-start at login, winget updates (BRAT covers updates) → D2.
- **MVP (P0–P2):** with no WinMux app installed: plugin starts the engine → sidebar shows sessions → click opens a terminal tab → "+" new session → Claude Code runs → reload restores tabs.
- **Beta (P3–P5):** native chrome, local echo, broadcast, palette, notifications/attention, projects, workspace, settings, **phone access**, and the CLI/MCP/skill installed from the plugin ("Install WinMux tools" command) with all 16 verbs + 16 tools passing §10a.
- **Market (P6, gated):** BRAT release, README, Edward's full workday with the WinMux app **uninstalled**, 0 blocker defects.
- **Failure:** any feature in the inventory missing without a D2 decision; latency >1.2× standalone; dropped chars; lost sessions on reload; edits under `core/` or `apps/electron/` without approval.
- **Out of scope:** mobile Obsidian, reproducing WinMux's window chrome pixel-for-pixel, harness work, community submission.

## 6. Success Metrics (defaults)
Latency: `browser_press_sequentially` 200 chars, echo-complete time ≤ standalone ×1.2. Key loss: paste 1 KB fixed string into `cat`, diff = 0. Restore: reload ×10, every open tab re-attaches (`meta.resumed:true`), 0 `lost`. Engine ownership: exactly one `winmux-core.exe` before/after each cycle (`tasklist`). Verbs: 12/12 UI verbs + 16 CLI verbs + 16 MCP tools pass with the WinMux app closed. Workday: Edward uses it a day without switching back.

## 7. Assumptions
| # | Assumption | Conf | Verify | Approval |
|---|---|---|---|---|
| A1 | Sharing one engine with standalone via `~/.winmux/instance.json` is right (one engine per identity is the core's own rule, main.rs L418) | high | P1 attach to the live 9909 engine | D1 |
| A2 | xterm.js 5 renders in Obsidian's Electron | high | P1 screenshot | — |
| A3 | Plugin view can claim Ctrl+C/V/W/Tab via `Scope` when focused | medium | P1-T4 keymap matrix | — |
| A4 | Obsidian API used exists in 1.12 | high | P0 load proof | — |
| A5 | Phone door ships in the plugin (core already serves `/api/phone*`; UI is ~300 lines of app.js §phone access) | high | P5 pairing from phone | — |

## 8. Scope Boundaries
Now: P0–P2. Later: P3–P5. Not yet: P6 publish. Validate first: A3. Approve first: D6 core list route, D3b/c publishing.

## 9. Documents
`PLAN.md` + `STATUS.md` (required), `README.md` (P5). No `.env.example` (no secrets). ARCHITECTURE/DECISIONS merged here.

## 10. Roadmap
| ID | Purpose | Output | Evidence | Stop / escalate |
|---|---|---|---|---|
| **P0** Scaffold + engine | `apps/obsidian/` plugin skeleton; `binaries/winmux-core.exe` bundled; plugin starts the engine when none is alive (WinMux app closed/uninstalled); settings tab | Obsidian 1.12.7 loads plugin; `/api/info` answers from a plugin-spawned engine; screenshot | build/spawn fails twice → report |
| **P1** Terminal slice | `TerminalView` xterm over `/pty`; I/O/resize; reload restore; keymap matrix | CDP shot with `claude` running; reload proof; latency + 1 KB paste; one engine process | unrecoverable key → packet |
| **P2** Sidebar | `SessionsView`: open + backlog; folder · shell · cwd + status dot; open/focus; "+" shell picker; end/forget | shots 1/4/8 rows; measured rows | — |
| **P3** Native chrome + typing | auto tab names, close w/ grace, split/group commands, palette + hotkeys, tab menu, attention badge, **local echo**, **broadcast** | 2×2 / 4-across / stacked shots; echo timing | **G2 taste** |
| **P4** Orchestration + tools | `ControlClient` 12 UI verbs (§10a); **"Install WinMux tools"** command writes `winmux` CLI + MCP server + `winmux-orchestrate` skill + hooks to `~/.winmux/bin` and adds PATH; jobs verbs pass through | 16 CLI verbs + 16 MCP tools checklist run with the WinMux app closed | verb needs core change → D6 |
| **P5** Product surfaces | projects, workspace save/load, notifications, agents overlay, cheat sheet, diagnostics, **phone access** (enable/QR/devices UI over `/api/phone*`) | shot per surface; phone pairing proof from the S26 | — |
| **P6** Packaging | BRAT zip w/ engine + tools, README, STATUS closeout; full-workday run with app uninstalled | fresh-machine-style install shot | **G3** publish |
Order strict. P4 before P5 so agents can drive P5 QA.

### 10a. Verb contract (P4 acceptance)
| Verb | Plugin behaviour | Check |
|---|---|---|
| list | all TerminalViews → `{id,title,shell,cwd,active,sid}` | count = open tabs |
| read-screen | xterm buffer serialize of target | matches typed marker |
| send | write to target `/pty` | echoed |
| focus | `workspace.revealLeaf` | active leaf id |
| close | send `x`, detach leaf | tab gone, backlog +1 |
| split | `workspace.getLeaf('split', dir)` + new TerminalView | 2 leaves |
| new-tab | new TerminalView in root | +1 |
| agent | new-tab + send launcher line (same as standalone) | `claude` prompt visible |
| browser / markdown | open URL / file via `workspace.openLinkText` / Obsidian web viewer | leaf type |
| notify | Obsidian `Notice` + badge on tab | shot |
| project | open all terminals for saved project (`/api/project`) | N tabs |

## 11. Dependencies
Tech: core exe · xterm · obsidian types. Env: obsidian-lab vault, `Obsidian.exe --remote-debugging-port=9222` for CDP shots (fallback: Obsidian's own screenshot via `electron.screen`? no — fallback = Windows `Get-Process` window capture via PowerShell). Approvals: G1 → start; G2 → P3 accept; G3 → publish.

## 12–13. Skills / Installs
Direct implementation; design-taste-frontend + craft-software for P2/P3 polish; playwright-pool `browser_*` over CDP for proof; Codex critic. No new skills. npm (project-scoped, reversible, Claude-owned): `obsidian`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `esbuild`, `typescript`.

## 14. Human Input
Upfront: **G1 (D1 + D2)**.  Later: G2 taste, G3 publish, D6 if needed. Safe assumptions: A1–A4, D4, D5.

## 15. Credentials
None new. Core is spawned with the inherited environment exactly as standalone does (Claude's own auth lives in Edward's user env); the plugin never logs or persists env or terminal content beyond what the core already writes to `~/.winmux/backlog`.

## 16. Approval Gates
**G1 (now, bundled):** D1 full-replacement architecture + scope P0–P5 + D2 quake/auto-start accepted as v1 gaps. **G2:** P3 chrome taste. **G3a** local zip (Claude) · **G3b** GitHub release for BRAT (Edward — public) · **G3c** community submission (Edward). Hard rule: zero edits under `core/`, `apps/electron/`, `master`; any need → packet.

## 17. Validation per phase
Screenshot of the real Obsidian window via SendUserFile (fallback path `apps/obsidian/evidence/<phase>/`); measured sizes via `getComputedStyle`; `tasklist /fi "imagename eq winmux-core.exe"` before/after; `git diff --stat 3ffff3f -- core apps/electron` empty; commit hash in STATUS.md.

## 18. Decisions
| ID | Decision | Rec | Reversible | Owner |
|---|---|---|---|---|
| D1 | Plugin bundles engine + CLI/MCP/skill and is a full replacement; if the WinMux app is also installed they share one engine via `~/.winmux/instance.json` (plugin spawns only if none alive, never kills on unload; explicit "Stop engine" → `/api/shutdown`) | adopt | yes | Edward |
| D2 | Quake drop-down (global hotkey) + auto-start at login cannot live inside Obsidian | **accept as gaps for v1** (Obsidian hotkeys work while Obsidian is focused; Obsidian itself can auto-start) — alt: tiny tray helper exe later | yes | Edward |
| D3a/b/c | zip / BRAT release / community | zip now, rest later | yes | Claude / Edward / Edward |
| D4 | Branch `feature/obsidian-plugin` off 3ffff3f | adopt | yes | Claude |
| D5 | Tab name = folder · shell, renameable | adopt | yes | Claude |
| D6 | Core `GET /api/sessions` (live list) so sidebar can show standalone-owned sessions | defer; raise only if P2 proves painful | yes | Edward (core edit) |

## 19. Architecture
TS → esbuild → `main.js`. `CoreClient`: read `~/.winmux/instance.json` → pid alive + `/api/info` ok → attach; else spawn `<plugin>/binaries/winmux-core.exe` (no env override; it writes the same instance file). `TerminalView` (`winmux-terminal`, state `{sid,shell,cwd}`) → xterm + fit + `/pty` WS, resize `{t:"r"}`. `SessionsView` left leaf: open views + `/api/backlog` poll 2 s. `ControlClient` `/control` → verbs → `app.workspace`. Settings `data.json`: default shell, restore-on-start, hotkey pass-through list. Data: view state in Obsidian `workspace.json`; sessions/backlog owned by core. Tradeoff: shared engine = one process model and CLI parity for free; cost = last-connected UI owns `/control` (documented, "Reclaim" command).

## 20. Feasibility
Proven pattern (Termy, polyipseity). P0–P2 one session; P3–P4 one to two; P5 one (phone + 6 surfaces); P6 short. Roughly 4–5 working sessions to beta — the parity inventory is the cost driver, not the terminal. Risky: A3 keymap.

## 21–23. Lifecycle / Readiness / Research
Design reference = Proposal E rows, Obsidian dark. Working = P1; Beta = P4 + workday; Market = G3. Existing Obsidian terminal plugins have no session backlog or agent control plane — that is the differentiator (verified against installed plugins).

## 24. Risks + Rollback
R1 keymap → per-view `Scope`, configurable pass-through, documented remaps. R2 engine ownership → never kill, pid-validate, one process check each phase. R3 verb drift → §10a contract. R4 API drift → `minAppVersion` 1.12.0. R5 exe in Dropbox → gitignored, copied by build script.
Rollback (tested at P1): disable plugin → delete `.obsidian/plugins/winmux` → engine keeps running, sessions intact (verify `/api/info` counts unchanged) → `git checkout feature/phase8-electron-shell`. LKG = phase commit. Never delete: core, standalone app, `~/.winmux`.

## 25–27. Status / Test / Maintenance
STATUS.md carries phase, done, files, commands, evidence paths, blockers, next, LKG. Testing = manual proof scripts + screenshots (harness excluded by Edward). Security = loopback only. Maintenance triggers = core protocol bump, Obsidian release, xterm upgrade. Sunset = uninstall; sessions persist in core.

## 28. /super-run Handoff
Plan `apps/obsidian/PLAN.md` v0.2 · first P0-T1 · driver: direct execution, verify-then-continue · gate: per-phase evidence §17 · stop: §10 column · approvals before start: G1.

## 29. First Execution (exact)
```
cd C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux
git checkout -b feature/obsidian-plugin 3ffff3f
# write apps/obsidian/PLAN.md (this) + STATUS.md, commit
mkdir apps/obsidian; cd apps/obsidian; npm init -y; npm i -D obsidian esbuild typescript; npm i @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
copy ..\..\core\rust\target\release\winmux-core.exe binaries\
node esbuild.config.mjs            # → main.js
bash ../../../obsidian-lab/sync-plugins.sh   # or copy main.js manifest.json styles.css → obsidian-lab/.obsidian/plugins/winmux/
"C:\Users\EDWAR\AppData\Local\Programs\Obsidian\Obsidian.exe" --remote-debugging-port=9222
```
Expected: plugin listed + enabled, settings tab renders → screenshot → P1.

## 30. Next Action
**Approve G1** (full standalone replacement, scope P0–P5, quake window + auto-start accepted as v1 gaps). Nothing else needed. Then: PLAN.md lands → branch → P0 → P1 with screenshots. Not yet: publishing, core edits, harness.

## 31. Critic triage (Codex, 20 findings)
Fixed: B1 (goal narrowed + D6), B2 (never kill engine), B3 (shared default instance file), B4 (commit/paths/exe facts), 5–7, 9–10, 12–14, 16–17, 19. Pushed back: 11 licensing (core is our MIT code), 15 standalone regression tests (guard is zero edits under core/electron, enforced by diff check), 18 credentials (no new ones; env inheritance stated), 20 (fallback path added).
