# WinMux Projects — Design Spec

**Date:** 2026-08-11
**Status:** Approved direction (Edward: "I need a clean implementation"; fork = *replace* the old layouts, delegated to recommendation)

## Goal

Replace WinMux's browser-storage "layouts" with real, file-backed **Projects**. A
project is a `.json` file on disk that holds a full workspace — the group, its tabs,
and each tab's folder + shell + auto-resume command. Users save the current setup to a
file, reopen a past project from a **recents** list in one click, and are prompted to
save on close. Projects are portable, backup-able, and shareable, because they are just
files.

This is the *clean* version: one model for "save my setup," not two overlapping ones.
The existing localStorage `ct-layouts` feature is retired and its saved layouts are
migrated into project files on first run — nothing is lost.

## Why this is a small, clean build

Everything a project needs already exists in the app:

- `snapshot()` (app.js:3202) already serializes the full workspace: per-tab `type`,
  `group` (by name), `shell`, `cwd`, `sid`, `resume`, `resumeId` — versioned at
  `SCHEMA_VERSION = 4` with a `migrateLayout()` upgrade path.
- `restoreLayout(desc)` (app.js:3284) already rebuilds a workspace from that blob,
  crash-safe, spawning fresh shells.
- `server.cjs` already has a clean `/api/...` route table and already reads+writes
  files on disk (`/api/config` at server.cjs:783 is the pattern to copy).
- `winmux open <file.json>` (bin/winmux.cjs:93) already reads a project file and pushes
  its layout into the running app over RPC.

So Projects is: **a server-side file store + a panel that reuses `snapshot()` /
`restoreLayout()`**, plus retiring the old popover and migrating old layouts.

## Architecture

The **server owns the filesystem**; the client is UI. This is the only design that
works across all three faces (Electron, browser, phone) and both engines (Node now,
Rust in the Stage-2 port), because none of the browser faces can write arbitrary disk
paths. The client calls `/api/...`; whichever engine is serving answers.

### Project file (`*.winmux.json`)

```json
{
  "winmuxProject": 1,
  "name": "WinMux Rust",
  "created": 1723420800000,
  "modified": 1723430900000,
  "layout": { "v": 4, "cols": [ ... ], "group": "WinMux Rust" }
}
```

`layout` is exactly the object `snapshot()` returns (minus live `sid`s — a project is a
template, so saved tabs always spawn fresh shells, same rule as the old layouts at
app.js:3395). `winmuxProject` is a format marker so a stray `.json` is not mistaken for
a project.

### Recents index (`recents.json`)

A small index the server keeps so the recents list is instant and survives even if the
user never opens the panel. It points at the real files; it is a cache, not the source
of truth.

```json
{ "recents": [
  { "path": "C:/Users/EDWAR/Documents/WinMux Projects/winmux-rust.winmux.json",
    "name": "WinMux Rust", "tabs": 3, "opened": 1723430900000 }
] }
```

Entries whose file is gone are shown greyed as **missing** (never a crash); opening one
offers to remove it from recents.

### Storage location

- Projects default folder: **`Documents\WinMux Projects\`** (Windows-native,
  discoverable, and synced if the user keeps Documents in OneDrive/Dropbox). Save
  Anywhere is allowed via the CLI / an explicit path.
- Recents index + "current project" pointer: `~/.winmux/` (alongside the existing
  instance/trust/config files), not in the projects folder — machine state, not a
  shareable artifact.

### Endpoints (server.cjs, mirrored later in the Rust core)

| Method + path | Body / query | Returns |
|---|---|---|
| `GET /api/projects` | — | `{ recents: [...], dir }` — recents (with `missing` flags) + default dir |
| `GET /api/project?path=` | path | `{ name, layout, modified }` — one project's contents |
| `POST /api/project` | `{ name, path?, layout }` | writes file (default dir if no path), updates recents → `{ path }` |
| `DELETE /api/project` | `{ path, trash? }` | removes from recents; deletes the file only if `trash:true` (default keeps it) |

All writes are atomic (temp + rename), matching the trust-file hardening already in the
codebase (#194). Paths are validated to stay files with a `.json`/`.winmux.json`
extension; no directory traversal into system paths.

## Client — the Projects panel

Replaces the `#sessmenu` layout popover. Same anchor points, richer content — the mock
Edward approved:

- **Recent** — each project: folder-color dot, name, tab count, the folders/shells
  running in it (chips), last-opened, filename. One click restores it (via
  `restoreLayout`, with the existing confirm-if-live guard at app.js:3421).
- **New project** — start clean (fresh single terminal), clears current-project pointer.
- **Open project file…** — path input / picker → `GET /api/project` → restore.
- **Save** — `POST /api/project`; a new project prompts for a name (→ default folder),
  an existing one overwrites its file.

### Current project + save-on-close

- A `ct-current` pointer (project path + a dirty flag) tracks the open project.
- Closing the app (or "New project" / opening another) while the current project has
  unsaved structural changes shows the **Save "X" before closing?** prompt from the
  mock. Dirty = the workspace structure changed since last save (tabs added/removed/
  moved/renamed, folder or resume changed) — not on every keystroke in a shell.

### Entry points

1. **Sidebar** — a **Projects** row near the brand header (primary door).
2. **On launch** — if there is no live workspace to restore (`ct-live` empty), the
   panel greets the user with recents instead of a blank terminal. Once inside a
   project, launch just restores it; the panel is not forced.
3. **Keyboard** — `Ctrl+Alt+O` opens it (today's "open" shortcut).
4. **Command palette** — "Open project" / "Save project".

## Migration (old layouts → project files, once)

On first load of the new build: if `ct-layouts` has entries and no migration marker is
set, write each saved layout as a project file in the default folder, seed recents, set
the marker, and drop the old `#sessmenu` UI. Idempotent and non-destructive — the
localStorage blob is left untouched as a safety copy, just no longer surfaced.

## Out of scope (v1)

- Rust-core endpoints — the design is engine-agnostic and the Rust port is tracked
  separately (Stage 2); v1 ships on the Node engine that the app runs on today.
- Cloud sync, sharing links, project templates, per-project settings. Files on disk
  already make manual backup/share/versioning work; anything richer is a later call.

## Testing / proof

- `verify.cjs` gains a **projects** check: save the current workspace → assert the file
  exists on disk with the right shape → mutate the workspace → open the saved project →
  assert the workspace matches the file (fresh shells, right folders). Round-trip
  through real disk + the real server, same style as the existing harness checks.
- Migration check: seed a `ct-layouts` blob, load, assert a project file appears and the
  popover is gone.
- Frontend proof: screenshots of the panel (recents populated, save-on-close prompt) at
  desktop + phone widths, shipped to Edward.

## Owner-gated (unchanged)

Promotion of this branch to `main` / publishing a release stays Edward's gate. Building,
committing, and pushing on the feature branch is reversible and proceeds.
