# WinMux build loop — contract

The loop reads this each tick. Source of phases: `docs/BUILD-PLAN.md`. Deep per-feature
plans: `docs/superpowers/plans/` (write one per phase before building it).

## Objective
Build all 8 phases in `docs/BUILD-PLAN.md`, in order, on `feature/phase8-electron-shell`,
each to built-and-harness-green.

## Per tick
1. Identify the current phase (first unfinished in BUILD-PLAN.md).
2. If it has no plan yet, write a short per-phase plan first (superpowers).
3. Build the smallest next unit of that phase.
4. Run that unit's harness check; run full `npm run verify` at each phase boundary.
5. Commit + push (feature branch only).
6. Narrate progress; move to the next unit.

## Done-condition (loop STOPS here)
All 8 phases built AND full `npm run verify` green with each phase's new checks added.

## Hard stop-gates (STOP and surface to Edward — do not push past)
- **Any new on-screen UI**, before it ships. Build the backend/logic freely; when a
  visual is ready, capture a screenshot, show Edward, and PAUSE for his approval.
- The launch gate: never merge to master, make the repo public, or publish.
- Any genuine blocker, or a decision only Edward can make.

## Off-limits
Code signing, Android app, Rust v2 rebuild. Anything outside the winmux repo.

## Scope
In: `winmux` repo, feature branch, the 8 phases. Commit + push allowed (feature branch).
