# WinMux Instant-Feel Arc — everything the hand touches responds now

Date: 2026-08-16 · Edward objective 2: "certain areas don't feel snappy enough — GPU rendering, actions — things I feel could be more instant."

## Doctrine

Feel is measured, not argued (Rule 21 sibling): every claim in this arc is a before/after number from the perf harness, plus Edward's hand on the real app for acceptance. Perceived speed counts as much as raw speed — response within ~100ms reads as instant; anything the UI can acknowledge optimistically, it should.

## What exists

- `perf.cjs` measures startup/first-paint/typing-tick/new-tab with baselines (Phase 0–4 arc, GPU renderer + font bundling + pre-warm + throttle all landed with measured gates).
- What it does NOT yet measure: interactive action latency — palette open, settings open (and per-toggle re-render), tab switch, sidebar toggle, group expand, peek open, diff open, welcome delay, menu opens. These are exactly where "doesn't feel snappy" lives.
- Known code smells to test (suspects, not verdicts): settings pane re-renders wholesale per toggle; sidebar re-renders on fleet ticks; artificial setTimeouts (400ms welcome, 60ms tab-click chains); synchronous /api calls before paint on some opens; xterm refit storms on layout changes.

## Units

- **IF-1** — this plan. ✅
- **IF-2 — Measure first.** Extend perf.cjs with an `actions` mode: click→next-paint latency for ~12 interactions (palette, settings open, each settings tab, one toggle flip, new tab, tab switch, sidebar toggle, group drill-in, peek, diff leaf, markdown leaf, close-tab). Run against the dev build AND the installed app for a real-machine baseline. Output a ranked table. No fixes in this unit.
- **IF-3 — Fix batch 1 (worst offenders).** Take the top of the ranked table; typical moves: render only the changed row/pane instead of whole-pane innerHTML; cache built DOM for overlays; remove/shrink artificial delays; move API reads off the open-path (open instantly, fill in); requestAnimationFrame-align paints. Surgical, per-offender commits.
- **IF-4 — Re-measure + prove.** Same probes, same machine; every fixed action shows its delta; nothing regressed (typing tick + startup re-run). Numbers to Edward.
- **IF-5 — Perceived-instant polish.** Optimistic acknowledgment where real work takes time (pressed states, immediate overlay shells); only where IF-2 shows the wait is irreducible.
- **IF-6 — Ship.** Harness green, release (0.2.3 or fold into next), Edward's hand-feel acceptance on his real machine is the exit gate — his "feels snappy" is the done-criterion, numbers are the evidence.

## Boundaries
- GPU renderer stays default-on; any renderer change re-proves the Phase-1 tick gate.
- No framework rewrite hiding inside a perf arc (omni-repo restructure is its own future arc).
- Rust engine untouched unless IF-2 proves engine latency (unlikely — prior measurements put it ahead of the Node engine).
