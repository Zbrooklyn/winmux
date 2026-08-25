# STATUS — WinMux for Obsidian

Plan: PLAN.md v0.3 (approved 2026-08-25). Branch `feature/obsidian-plugin` off 3ffff3f.

## Current
- Phase: **P3 Native chrome** next · P0 + P1 + P2 (sidebar) + terminal design pass 1 DONE (validated 2026-08-25)
- LKG: commit after P1 (see git log) — plugin loads in Obsidian 1.13.4 (Brain vault), engine boots from plugin alone, terminal tabs work.

## Done (with evidence)
- P0: scaffold (`manifest.json`, esbuild, `src/{main,core,terminal,sessions}.ts`, `styles.css`, `scripts/{bundle-engine,sync}.mjs`), engine bundled (3,536,896 B), plugin-spawned engine wrote `~/.winmux/instance.json` (port 9922) with NO WinMux app running.
- P1: terminal tab over `/pty`, I/O + resize, folder honoured, reload-restore by sid (2/2 tabs reconnected, `meta.resumed`), keymap matrix 15/15 (Ctrl+W/P/C/L/D/E/K/F/Tab/Shift+Tab/V/Shift+C reach shell or are absorbed; Obsidian never acts), theme follows vault, cursor 15×8 px, header/tab title = folder · shell. Evidence: `evidence/p1/*.png`.

- Terminal design pass 1 (Edward: "focus on the design of the terminal itself"): vault-mapped ANSI palette (light+dark, live re-theme on css-change), Obsidian monospace font, 16 px inset, Obsidian-style scrollbar, 2 px bar cursor, refit on resize/active-leaf/post-open (48 rows in 954 px), tab-header status dot (working/needs-you/ended), ended strip with Restart button + Enter (verified: new sid, dot cleared), sidebar ended state. Claude Code renders correctly inside a tab (evidence/p1 + scratch d1/d2/d3 shots sent to Edward).
- P2 sidebar verified: 30 rows listed (2 live incl. one owned by another UI, 28 recoverable), "+ New" shell menu (5 shells), right-click menu (open / close tab / end), row 42 px, titles not clipped at 264 px.

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
- P3: split commands + hotkeys defaults, palette commands audit, local echo (instant typing), broadcast to group, tab context menu (rename/end), needs-you Notice. Then P4 tools installer + verbs.
- Design backlog: sidebar working dot for other-UI live sessions (no engine signal yet), `--font-monospace` on this machine starts with two garbled entries ('??') — harmless, fallbacks apply.
