# STATUS — WinMux for Obsidian

Plan: PLAN.md v0.3 (approved 2026-08-25, full standalone replacement). Branch `feature/obsidian-plugin` off 3ffff3f. Edward: "full takeover until complete" (2026-08-25).

## Checklist (parity inventory → done when Verified)

- [x] P0 Engine bundled, plugin boots it alone (no WinMux app) — Verified
- [x] P1 Terminal tab over /pty, resize, reload-restore by sid, keymap 15/15 — Verified
- [x] P2 Sessions sidebar (open + other-UI live + recoverable), + New shell menu, row menu — Verified
- [x] Terminal design: vault palette light/dark, Obsidian mono, inset, scrollbar, cursor, refit — Verified (Edward's eye pending)
- [x] Tab status dot, ended-session strip + Enter/Restart — Verified
- [x] P3 Split right/down + hotkeys, rename (modal, persisted), tab "…" menu, terminal right-click menu — Verified
- [x] P3 Instant typing (SP-1 predictor: confidence 8, overlay painted) — Verified mechanically
- [x] P3 Broadcast (Ctrl+Alt+B, status bar, 4/4 terminals received) — Verified
- [x] P3 Notifications: needs-you from bell / verbs, Obsidian Notice, OS notification when unfocused, Approve/Deny (commands + sidebar) — Verified
- [x] P3 OSC titles (folder · <shell title>), shell-key mapping fix — Verified
- [x] P4 /control client: list · read-screen · send · focus · close · split · new-tab · agent · browser(open) · markdown(vault) · notify · project — Verified via real `winmux` CLI
- [x] P4 Jobs: agent register / spawn --cmd / wait → result — Verified (job done, result "SPAWN-OK")
- [x] P4 MCP server over stdio: initialize, 15 tools, list/send/read-screen/agent — Verified
- [x] P4 Tools installer: ~/.winmux/bin (winmux.cjs, winmux-mcp.cjs, shims using node or Obsidian-as-node), user PATH, ~/.claude/skills/winmux-orchestrate — Verified on this machine
- [x] P4 Engine env for shells: WINMUX_CLI_DIR + WINMUX_APP_EXE (only for an engine this plugin spawns)
- [x] P5 Projects (app-compatible .winmux.json, save/open/remove/delete) — Verified (saved "Obsidian dev")
- [x] P5 Phone access pane (toggle, QR, URL, trust tailnet, devices) — Implemented; toggle NOT exercised (would open the tailnet door — Edward's call)
- [x] P5 Diagnostics, Cheat sheet, full settings (scrollback, cursor, copy-on-select, right-click paste, confirm close, OS notify, resume command, engine autostart + history) — Verified renders
- [x] P5 Claude session resume from sidebar (/api/claude-sessions) — Implemented; menu not exercised
- [x] P5 Workspace save/load — provided by Obsidian's own workspace (tabs restore with sid); WinMux workspace.json not used
- [x] P6 Release zip (`%LOCALAPPDATA%winmuxeleaseswinmux-obsidian-0.1.0.zip`, 1.49 MB) + README — Verified
- [ ] Edward: full workday with the WinMux app closed → Accepted
- [ ] Edward (one click each, Settings → WinMux → Agent tools): Register MCP server · Install Claude hooks
- [ ] Community submission — gated (D3c)

## Accepted gaps (G1)
Quake drop-down window; start-at-login for the Obsidian window. Agents overlay = replaced by sidebar needs-you rows + cheat sheet text. `browser` verb only supports open (web viewer); others need the desktop app.

## Corrections to PLAN
- Obsidian installed is 1.13.4 (plan said 1.12.7); `minAppVersion` 1.12.0.
- `/api/backlog` items carry `live:true` → sidebar lists sessions held by other UIs (B1 resolved; D6 not needed).
- Engine HTTP must use Obsidian `requestUrl` (CORS blocks fetch from app://obsidian.md); WebSocket is fine.

## Gotchas
- Bash tool turns `\x1b` / `\n` text into raw bytes inside heredocs — patch source via script files.
- Obsidian global CSS makes xterm's DOM cursor block+absolute → CSS override.
- A Scope handler returning false stops the key before xterm sees it → `handleKey` feeds the control code.
- `revealLeaf` does not activate a leaf; use `setActiveLeaf` before split/focus logic.
- Git Bash mangles `https://` and paths with spaces in CLI args — test verbs from PowerShell.
- Engine exe is locked while running; `sync.mjs` keeps the existing copy.
- Broadcast fans input into EVERY terminal including a running Claude Code prompt.

## Next
- Edward: workday acceptance with the WinMux app closed; click Register MCP / Install hooks in Settings → WinMux; decide BRAT publish (G3b).
