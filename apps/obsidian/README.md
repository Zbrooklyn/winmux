# WinMux for Obsidian

WinMux terminals inside Obsidian — a complete, standalone WinMux: the engine is bundled, so nothing else needs to be installed.

- **Sessions sidebar** — every shell the engine knows: open tabs, sessions live in another window, and recoverable scrollbacks. Click to open, right-click to end / forget / resume a Claude session.
- **One terminal per tab** — Obsidian's tabs, splits, stacking, command palette and hotkeys do the layout. Tab dot: orange = working, red = needs you.
- **Sessions survive** — close a tab and the shell lives 30 s; reload Obsidian and tabs reconnect; a shell that ends leaves its scrollback recoverable.
- **Instant typing, broadcast, projects, phone access, Claude resume**, plus every setting the WinMux app has.
- **Runs in the background** — close Obsidian and every shell keeps running; a tray icon by the clock shows how many, opens Obsidian, or stops the engine. Reopen Obsidian and the tabs reconnect.
- **Agents** — `winmux` CLI, the Claude Code MCP server and the orchestrate skill work against these tabs (`Install WinMux tools` in settings or the command palette).

## Install

1. Copy the release folder (`main.js`, `manifest.json`, `styles.css`, `binaries/`, `tools/`) to `<vault>/.obsidian/plugins/winmux/` — or install through BRAT with the release zip.
2. Enable **WinMux** in Settings → Community plugins. The engine starts on its own (or attaches to a running WinMux app — they share one engine).
3. Optional, Settings → WinMux → *Agent tools*: **Install** (CLI + MCP server on your PATH), **Register** the MCP server for Claude Code, **Install hooks** (tabs show working / needs you automatically).

Desktop only (Windows). Requires nothing else; Tailscale is only needed for phone access.

## Commands (Ctrl+P → "WinMux")

New terminal `Ctrl+Shift+T` · Split right `Ctrl+Shift+D` · Split down `Ctrl+Shift+Y` · Sessions sidebar `Ctrl+Shift+L` · Projects `Ctrl+Shift+O` · Broadcast `Ctrl+Alt+B` · Cheat sheet `Ctrl+Shift+/` · Next/previous terminal `Ctrl+Alt+→/←` · Rename · Restart shell · End session · Clear scrollback · Approve / Deny · Diagnostics · Phone access · Engine status / stop · Reclaim agent control.

While a terminal is focused these go to the shell, not Obsidian: `Ctrl+C/V/W/L/D/P/E/K/F/Tab` (configurable in settings).

## Not in the plugin (by design)

The quake drop-down window (global hotkey) and start-at-login for the *window* — Obsidian can't host either. The engine itself can start at login (Settings → WinMux → Behaviour).

## Development

```
cd apps/obsidian
npm install
npm run bundle-engine      # copies core/rust/target/release/winmux-core.exe → binaries/
npm run bundle-tools       # copies the CLI / MCP / skill / hooks → tools/
npm run build              # → main.js
npm run build-tray         # → binaries/winmux-tray.exe (uses Windows' built-in csc)
node scripts/sync.mjs "<vault path>"   # copy into a vault for testing
npm run release            # → release/winmux-obsidian-<version>.zip
```

Plan and status: `PLAN.md`, `STATUS.md`.
