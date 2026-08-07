# WinMux "Omni" Monorepo — Design Spec

**Date:** 2026-08-07
**Status:** Approved direction (symmetric monorepo, do-it-right-from-the-start)
**Repo:** `Zbrooklyn/winmux` (name unchanged — "omni" is the monorepo concept, not a rename)

## Goal

Restructure the existing `winmux` repository into a symmetric monorepo that holds
both WinMux implementations under one roof:

- **`apps/electron/`** — the current shipping Electron/JS app (unchanged behaviour).
- **`core/rust/`** — the planned v2 native Rust core (empty scaffold, ready for Stage 0).

…without breaking the live app's build or the installed-app deploy pipeline.

## Non-Goals

- Not renaming the GitHub repo (breaks in-app update check + release/clone links).
- Not building any Rust code — only the scaffold/home. Rust Stages 0–5 remain future work.
- Not adopting npm/JS workspaces — see "Workspace tooling" below.
- Not relocating the app in two phases — we do the clean symmetric layout in one pass.

## Target Structure

```
winmux/  (repo root)
├── apps/
│   └── electron/            # entire current app, moved as ONE subtree via `git mv`
│       ├── server.cjs
│       ├── public/          electron/  dist-electron/ (gitignored)
│       ├── bin/  agent/  scripts/  demos/  examples/  test/
│       ├── verify.cjs  perf.cjs  verify-coexist.cjs
│       ├── winmux.ps1  launch-winmux.cmd  winmux-autostart.vbs
│       ├── package.json  package-lock.json  tsconfig.electron.json
│       └── PLAN.md  PRODUCT.md  DESIGN.md   # app-specific docs travel with the app
├── core/
│   └── rust/                # v2 native core — fresh Cargo workspace scaffold
│       ├── Cargo.toml       # [workspace] members = ["crates/*"]
│       ├── crates/
│       │   └── winmux-core/
│       │       ├── Cargo.toml
│       │       └── src/main.rs   # placeholder that prints a banner; compiles, does nothing
│       └── README.md        # points at the v2 plan
├── docs/                    # monorepo-level docs (the v2 plan lives/links here)
├── README.md                # product-first (Download/Install stays) + monorepo-structure note
├── LICENSE                  # MIT, at root, covers the whole repo
└── .gitignore               # root: node_modules/, dist-electron/, target/, logs
```

## Why This Is Safe

The app moves as a **self-contained subtree**. Every path *internal* to the app is
relative and stays valid after the move:

- `electron/main.ts` → `server.cjs` (resolved relative to the app dir)
- `server.cjs` → `public/`, `bin/`, `node_modules/`
- `scripts/dist.cjs`, `verify.cjs`, `winmux.ps1` → all app-relative

The only references that break are **outside** the app and are enumerated as tasks:

1. **`build-asar.cjs`** (scratchpad deploy tool) — hard-codes repo-root paths
   (`winmux/server.cjs`, `winmux/public`, `winmux/node_modules`). Re-point to
   `winmux/apps/electron/…`. Not in the repo; updated as part of the deploy step.
2. **Root `README.md`** — download/install links and any path references.
3. **Any `.github/` workflow** — check for path assumptions (audit during migration).
4. **`launch-winmux.cmd` / autostart** — if they `cd` to a fixed path, update.

## Workspace Tooling — Deliberately None

Each stack is self-contained:

- `apps/electron/` — its own npm project, own `node_modules`, own lockfile. `npm install`
  and all scripts run **from that directory**.
- `core/rust/` — its own Cargo workspace.

No npm/JS workspace is added. Rationale: a JS workspace tool cannot manage a Rust
crate, and dependency hoisting is precisely what destabilises `node-pty` (native
module) and `electron-builder`. The monorepo is directory organisation + a root
README; nothing shares a package manager across the language boundary.

An optional root `package.json` with thin convenience scripts (e.g.
`"electron:verify": "npm --prefix apps/electron run verify"`) MAY be added for
ergonomics, but carries no dependencies and no workspace config.

## Migration Plan (executed on a branch)

Branch: `chore/omni-monorepo` off `feature/phase8-electron-shell`.

1. Confirm clean working tree (only untracked `docs/loop.md` present — stash or add).
2. `git mv` the app subtree into `apps/electron/` in one coherent commit (history
   preserved; `git log --follow` must still trace files).
3. Move monorepo-level docs to root `docs/`; keep app-specific docs in `apps/electron/`.
4. Scaffold `core/rust/` (Cargo workspace + `winmux-core` placeholder crate + README).
5. Author root `README.md` (product-first + structure note), root `.gitignore`.
6. Re-point external references (build-asar deploy tool, README links, `.github/`).
7. **Verification gate:**
   - `cd apps/electron && npm run verify` → Electron TS build + harness pass.
   - Updated deploy repacks the installed app.asar; relaunch → live check (env/color
     fix still present, app boots on 9912).
   - `git log --follow apps/electron/server.cjs` shows pre-move history.
8. Commit + push the branch.

## Success Criteria

- Repo has `apps/electron/` and `core/rust/` at the documented layout.
- `npm run verify` passes from `apps/electron/`.
- Installed-app deploy still produces a working, relaunchable app.
- Git history for moved files is intact (`--follow`).
- Rust scaffold compiles conceptually (real `cargo build` deferred to Stage 0 when the
  toolchain is installed — noted, not silently skipped).
- No change to the GitHub repo name, update-check, or release links.
