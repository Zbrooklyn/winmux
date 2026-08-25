# STATUS — WinMux for Obsidian

Plan: PLAN.md v0.3 (approved 2026-08-25). Branch `feature/obsidian-plugin` off 3ffff3f.

## Current
- Phase: **P2 Sidebar polish** next · P0 + P1 DONE (validated 2026-08-25)
- LKG: commit after P1 (see git log) — plugin loads in Obsidian 1.13.4 (Brain vault), engine boots from plugin alone, terminal tabs work.

## Done (with evidence)
- P0: scaffold (`manifest.json`, esbuild, `src/{main,core,terminal,sessions}.ts`, `styles.css`, `scripts/{bundle-engine,sync}.mjs`), engine bundled (3,536,896 B), plugin-spawned engine wrote `~/.winmux/instance.json` (port 9922) with NO WinMux app running.
- P1: terminal tab over `/pty`, I/O + resize, folder honoured, reload-restore by sid (2/2 tabs reconnected, `meta.resumed`), keymap matrix 15/15 (Ctrl+W/P/C/L/D/E/K/F/Tab/Shift+Tab/V/Shift+C reach shell or are absorbed; Obsidian never acts), theme follows vault, cursor 15×8 px, header/tab title = folder · shell. Evidence: `evidence/p1/*.png`.

## Corrections to PLAN
- Obsidian installed is **1.13.4** (plan said 1.12.7). `minAppVersion` 1.12.0 kept.
- `/api/backlog` items carry `live:true` for sessions held by another UI → sidebar CAN list standalone-owned sessions (plan §2 B1 was too pessimistic; D6 not needed).
- Engine HTTP must go through Obsidian `requestUrl` (CORS blocks `fetch` from app://obsidian.md). WebSocket is fine.
- Never spawn while `instance.json` pid is alive (first version double-spawned once; fixed).

## Gotchas
- Bash tool turns `\x1b` text into a raw ESC byte — patch such lines via a script file.
- Obsidian global CSS makes xterm's DOM cursor span block+absolute → overridden in styles.css.
- A Scope handler returning false stops the event before xterm sees it → plugin feeds the control code itself (`handleKey`).
- Engine exe is locked while running; `sync.mjs` keeps the existing copy.

## Blockers / risks
- None open. Ctrl+V paste relies on `navigator.clipboard.readText` (untested with real clipboard content).

## Next
- P2: sidebar rows (working/idle live for other-UI sessions needs a signal — currently only open tabs show working), shell picker "+" verified by eye, right-click end/forget verified, screenshots 1/4/8 rows.
