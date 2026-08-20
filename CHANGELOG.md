# Changelog

All notable changes to WinMux are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.7] - 2026-08-20

### Fixed
- The window's minimize, maximize and close buttons could slide off the right edge of the
  screen. WinMux is frameless, so those three are the only window controls there are, and they
  were being placed inside whichever pane happened to be rightmost — a pane shrinks and clips
  its contents. At the enforced 720px minimum width, one split put the close button 121px past
  the window edge and two splits put it 189px past, leaving Alt+F4 as the only way out. The
  controls now belong to the cockpit itself, pinned top-right where no pane geometry can reach
  them, and the rightmost tab row reserves that corner so tabs never slide underneath.

### Added
- `winctl` harness check (12 assertions) walks 720x480 / 900x620 / 1440x900 across one to four
  panes and asserts each control is inside the viewport *and* is the element hit at its own
  centre — rendered is not the same as clickable.

## [0.2.6] - 2026-08-18

### Fixed
- Closing the last visible tab of a pane now collapses the split even when that pane still holds
  another group's hidden terminals; those terminals ride along to the surviving pane with their
  shells running, instead of the pane refusing to close and spawning a fresh shell. Same rule
  when dragging a pane's last tab away.
- The Projects dialog painted its Recent list over the "Recent & recoverable sessions" heading
  when several projects were saved. The lists keep their natural height and the body scrolls.

### Changed
- The Sessions and Projects panels speak one design language: project rows use the sessions-row
  anatomy (folder tile, name, status sub-line, full-bleed hairline), the open project carries the
  active-group highlight with "open now" in its sub-line, the Projects header shows a live count,
  and opening a project switches to the Sessions tab where it lands.

## [0.2.5] - 2026-08-17

### Added
- The left rail is a real sidebar: a slim icon strip switches between Sessions, Projects and
  Notifications panels instead of stacking everything in one column. Notifications live in the
  rail rather than floating over the terminal.
- The rail resizes by dragging its right edge (200–420px); double-click resets. Width and active
  tab survive restarts.

### Notes
- Desktop and half-width layouts only; the phone flow is untouched.

## [0.2.4] - 2026-08-16

### Changed
- Predictive local echo paints each keystroke on the frame it is pressed (0ms to DOM, was ~85ms),
  with guards that disable it in password prompts and TUIs and reconcile against the real shell.
  Settings → Terminal → Instant typing.
- Launch shows the window in ~100–130ms and a usable prompt in ~460ms warm; the engine resolves
  concurrently and a failure raises a real error dialog.
- Rendering holds at scale: 50 tabs with 10 live streams still paint every action in ≤100ms, a
  session status change repaints one row rather than the sidebar, and WebGL contexts are held only
  by visible terminals.

### Added
- Optional global summon hotkey (default off): Settings → Behaviour.
- Committed benchmark probes — `perf-echo`, `perf-actions --scale`, `perf-throughput`,
  `perf-corners`, `perf-installed`.

## [0.2.3] - 2026-08-16

### Changed
- The auto-saved workspace moved out of browser storage into the engine
  (`~/.winmux/workspace.<identity>.json`), so it survives a profile wipe.
- The engine's `config.json` is the single source of truth for settings; a window's cache can no
  longer silently override a setting changed on another face.

### Added
- The Projects overlay lists every saved scrollback the engine still holds, with age and expiry,
  and restores one into a live tab in a click. Dismissing asks first — that one deletes for good.
- Close project is a real verb: it unbinds the window from the named file and asks whether to keep
  sessions running, end them, or save first. It never deletes the file.
- F1 → "Where your stuff lives" shows the save model and the four real paths on the machine.

## [0.2.2] - 2026-08-16

### Changed
- The Phone settings pane explains what Tailscale is and links to the free download when it isn't
  running, instead of dead-ending.
- The welcome card's "Built for agents" point opens a real guide (also in the palette as
  "Agents guide").
- The first window close explains once that shells and agents keep running, with a
  "Quit completely" button in the dialog.

### Added
- A glossary in the keyboard-shortcuts panel defining tab, group, session, detached session and
  project.
- Job-supervision parity on the Node engine: jobs fail honestly when their worker session dies.

## [0.2.1] - 2026-08-16

### Fixed
- The v0.2.0 primary installer ran the app under the side-by-side "WinMux Rust" identity, giving a
  fresh profile instead of existing settings and hiding the app from the `winmux` CLI. The primary
  identity is restored while still shipping the Rust engine.
- `winmux` and the MCP server now find whichever installed WinMux is actually running — primary
  first, then the side-by-side Rust identity — and skip stale discovery files left by a crash.

## [0.2.0] - 2026-08-16

### Changed
- WinMux ships on its native Rust core. Same app, same UI; the engine underneath is a single
  native `winmux-core.exe`. Existing installs upgrade in place, and the Node engine stays
  available from source (`npm run dist:node`).

### Added
- Agent orchestration. One session can spawn another, run a task in it (a Claude prompt or any
  command), and block until it finishes, getting the result back as data. `winmux agent spawn`
  opens the session and returns a job id; `winmux agent wait --job <id>` waits for it and prints
  the result; `winmux agent result --job <id>` reads a finished job. The spawned session reports
  its own completion to the server, so nothing is screen-scraped, and the wait is bounded and
  resumable so it never hangs. Built into both the Node and Rust engines with identical behaviour.
- Per-worker model selection (`--model sonnet|haiku|opus|inherit`, Sonnet default).
- Supervision: a worker that crashes or loses its pane fails its job within seconds with the
  reason and exit code, so a wait never hangs. Nothing auto-restarts.
- Slash injection into a live session (`winmux slash "/model haiku"`).
- `winmux transcript` folds a Claude Code session's on-disk transcript into readable turns.
- "Save terminal history to disk" switch (Settings → Behaviour, on by default). Turning it off
  stops saving and wipes what is already on disk.

### Fixed
- Split panes no longer open with tiny, mis-fitted text (per-pane resize refit).

## [0.1.0] - 2026-08-13

First public release.

### Added
- Real Windows shells in tabs and splits: PowerShell 7, Windows PowerShell, and cmd, with
  ligatures, a GPU renderer, and Cascadia Code bundled into the installer.
- One session on three faces. The same live shell is reachable on the PC, in a browser, and on a
  phone over Tailscale, all as clients of one server.
- Tabs for everything. Terminals, an embedded browser, a markdown viewer, and git diff open as
  pane tabs you can split, zoom, and rearrange.
- Phone access over Tailscale, off by default. Devices pair by scanning a QR once, and forgetting
  a device rotates the key so an old link stops working.
- Fleet view for Claude Code sessions. See which session is working, done, or waiting on you, and
  approve or deny a blocked one inline from the desktop or your phone.
- Session survival. Shells outlive a dropped socket and the client reconnects instead of ending
  the session.
- Saveable projects. A workspace (group, tabs, each tab's folder and shell) writes to a portable
  `.winmux.json` you can back up or check into a repo.
- The `winmux` CLI drives the running app over a local RPC surface, so an agent can open tabs, run
  commands, read the screen, and control a browser panel.
- A native Rust core at full feature parity with the Node engine, bundled alongside it.

### Notes
- The installer is unsigned. Windows SmartScreen warns on first run; choose More info, then Run
  anyway.

[0.2.7]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.7
[0.2.6]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.6
[0.2.5]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.5
[0.2.4]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.4
[0.2.3]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.3
[0.2.2]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.2
[0.2.1]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.1
[0.2.0]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.0
[0.1.0]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.1.0
