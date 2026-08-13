# Changelog

All notable changes to WinMux are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/Zbrooklyn/winmux/releases/tag/v0.1.0
