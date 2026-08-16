# WinMux State Contract (PT-2)

The single answer to "where is my stuff, and what happens to it?" Code is held to this
document; when they disagree, one of them is wrong and the fix starts here.

## The one-sentence model

**Your workspace is always saved automatically. A Project is a named snapshot you can
reopen anytime. Sessions keep running until you end them.**

## The three things that exist

### 1. Sessions — the running shells
- **What:** live shell processes plus their scrollback. Owned by the **engine**, never by a window.
- **Lifetime:** survive window close, reload, network drops. End on Quit completely, an explicit
  close with confirmation, or the shell exiting.
- **Where:** process + in-memory scrollback; a detached session's scrollback snapshots to
  `~/.winmux/backlog/<sid>.json` (throttled) so "come back to it" survives an engine restart.
- **Recovery:** reattach happens automatically when a window reconnects. Target state (PT-4): a
  visible **Recent & recoverable** list shows every detached session with age and expiry
  ("expires in N days"), one-click restore or dismiss. Backlog expiry is 7 days and must be
  visible before it happens — silent expiry is a contract violation.

### 2. Workspace — the always-saved current layout
- **What:** groups, tabs, splits, each tab's shell/folder/type, dock state. The thing you see.
- **Lifetime:** continuous. Every change auto-saves; there is no "unsaved workspace".
- **Where (today):** `ct-live` in per-window localStorage — invisible, per-app, wiped with the
  profile. **Target (PT-3):** the engine owns it at `~/.winmux/workspace.<identity>.json`;
  localStorage becomes a cache. One workspace per installed identity, by design.
- **Recovery:** reopening the app restores the workspace. Losing it should require deleting
  the file on purpose.

### 3. Projects — named snapshots on disk
- **What:** a portable `.winmux.json` file: the workspace frozen under a name. Layout only —
  never scrollback, never running processes.
- **Where:** `Documents\WinMux Projects` (override: `WINMUX_PROJECTS_DIR`).
- **Verbs (target, PT-5):**
  - **Save** — write/overwrite the named file from the current workspace.
  - **Open** — replace the current workspace with the file's layout (current workspace is
    auto-saved first; nothing is lost by opening).
  - **Close** — unbind from the name and return to the unnamed workspace. Asks exactly one
    question with three honest outcomes: *keep sessions running* / *end this project's
    sessions* / *save first*. Closing never deletes the file.
  - **Delete** — remove the file, confirmed, listed in a visible project manager.
- **Recovery:** files are plain JSON — copy them, sync them, check them in. The project
  manager (PT-5) lists them so they are never invisible in Documents.

## Settings and small state
- **Settings/keymap:** source of truth is the engine's `~/.winmux/config.json`; localStorage
  is a warm cache only (PT-6 closes today's dual-store drift).
- **One-time UI memories** (`ct-onboard`, `ct-close-notice`): deliberately local and
  disposable; losing them only replays a welcome card.
- **Trust/devices:** `~/.winmux/devices*.json`, engine-owned, atomic writes.

## Invariants (testable, harness-enforced)
1. Nothing the user made is ever lost silently; anything that expires says so beforehand.
2. Every stored thing is visible somewhere in the UI, with its recovery path next to it.
3. Closing a window never destroys state. Only explicit, confirmed verbs destroy state.
4. One source of truth per fact; caches may exist but never disagree for long.
5. All four installed identities implement this contract identically (parity-checked).

## Store index (implementation reference)

| Store | Path | Owner | Target state |
|---|---|---|---|
| Sessions | engine memory + `~/.winmux/backlog/` | engine | keep; add visible list + expiry notice |
| Workspace | `ct-live` (localStorage) | window (today) | move to `~/.winmux/workspace.<id>.json` (engine) |
| Project files | `Documents\WinMux Projects\*.winmux.json` | user | keep; add manager UI + Close verb |
| Settings/keymap | `~/.winmux/config.json` + `ct-settings`/`ct-keymap` | split (today) | engine file authoritative |
| Trust/devices | `~/.winmux/devices*.json` | engine | keep |
| UI one-timers | `ct-onboard`, `ct-close-notice` | window | keep (disposable by design) |
