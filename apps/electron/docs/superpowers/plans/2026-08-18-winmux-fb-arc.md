# FB arc — v0.2.5 feedback: split-close bug + panel coherence

Edward (2026-08-18): "there are quite a few large bugs like, when im in split
screen when i close the left tab it just opens a new one. also the main
sections tab and the projects tab feels disconnected and fragmented, does not
feel like a final product implementation."

Two deliverables, both proven fails-before / passes-after, shipped as v0.2.6.

## FB-1 — split-close respawns instead of collapsing

**Root cause.** `closeTerm`'s emptiness guard counted a pane's terminals across
ALL groups: a pane still homing another group's *hidden* terminals was "not
empty", so closing its last visible tab respawned a fresh shell instead of
collapsing the split. Same flawed guard duplicated in `moveTermToPane`.

**Fix.** New `collapsePane(p)` (app.js): re-homes any remaining hidden
other-group terminals to a surviving pane — shells keep running, exactly as if
the tabs were dragged there — then closes the pane. Used by `closeTerm` and
`moveTermToPane`. A pinned or last-remaining pane still survives with a fresh
shell.

**Proof.** New harness check `split-collapse` (:9984), 7 measured assertions on
the real user path (tab ×, confirm dialog): plain split collapses; cross-group
split collapses; the hidden terminal rides along (2 tabs in the survivor);
group B still reports its session alive. Fails-before was reproduced
mechanically before the fix (S2 BUG: panes stayed 2, shell respawned).

## FB-2 — Sessions/Projects panels feel fragmented

**Diagnosis (measured).** Sessions rows: 34px folder tile, 15px/600 name, 12px
muted sub, full-bleed hairline rows, accent fill on active. Projects rows: 9px
dot, 13px name, gray "0 tabs" pill, no tile, no sub, no current state — a
different design language in the same rail.

**Changes.**
- `pjrowHTML` (shared generator, additive): `.pjrow-folder` tile (FOLDER_SVG,
  folder-colour tinted), `.pjrow-sub` line ("open now · N tabs" for the bound
  project, "N tabs · 2h ago" otherwise, "file missing" when missing),
  `data-current` on the bound project. Overlay hides the new nodes — its look
  is unchanged.
- `.sx-plist` CSS: full sessions-row language (34px tile, 15px/600 name, sub
  line, hairline rows, `--accent-soft` fill + tinted tile on `data-current`);
  badge/dot/dir suppressed in the rail.
- Projects header gets a live count (`#sx-pcount`) like Groups.
- Continuity: opening a project from the rail switches to the Sessions tab.
- Harness: `sidebar-tabs` gained 3 measured coherence assertions (now 20).

## FB-3 — projects overlay row overlap (found during FB-2, pre-existing)

With ≥3 recents plus recoverables, `.proj-body`'s flex column shrank
`.proj-list` below its content (68px box, 333px rows, overflow visible) and the
rows painted over the "Recent & recoverable sessions" section. Fix:
`.proj-body .proj-list { flex-shrink: 0; }` — natural heights, `.proj-body`
scrolls. Verified by box metrics (rows 275–608 inside the list, recover section
starts at 652) and screenshot.

## Hygiene

Probe servers had been writing into the real `Documents\WinMux Projects` and
the shared recents index. Removed all 7 probe files (the dir held nothing
else) and dropped the 8 probe rows from recents (index now clean). Scratchpad
probes now set `WINMUX_PROJECTS_DIR` to an isolated dir. ~660 probe scrollbacks
in Recent & recoverable self-expire in 7 days.

## Status

- [x] FB-1 fix + split-collapse check green (7/7)
- [x] FB-2 coherence + sidebar-tabs check green (20/20)
- [x] FB-3 overlay fix, measured + screenshot
- [x] Affected checks green (51/51: sidebar-tabs, split-collapse, closeverb, recover, workspace)
- [ ] Full harness both engines
- [ ] Ship v0.2.6 + update installed identities
