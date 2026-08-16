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

## Scorecard — the questions we hold ourselves to (baseline 2026-08-16, re-rate after every unit)

Strict ratings; "unmeasured" scores low on principle — we don't get credit for speed we can't prove.

1. Do we know, in numbers, our slowest user-facing actions? — Startup/typing measured; the ~12 daily actions never measured. **2/10** → IF-2.
2. Does every input acknowledge within ~100ms? — Unmeasured; code suspects say no. **3/10 (unproven)** → IF-2 then IF-3.
3. Is anything artificially delayed? — Yes: 400ms welcome, 60ms click chains, assorted throttles; some justified, none revisited since written. **4/10** → IF-3.
4. Is work done on the click path that could happen before or after? — Settings rebuilds its whole DOM on open; some opens fetch before paint. **4/10 (suspected)** → IF-3.
5. Does rendering cost scale with what changed, or with page size? — Whole-pane innerHTML re-renders (settings per toggle, sidebar on fleet ticks). **3/10** → IF-3.
6. Is the GPU used everywhere it helps? — Terminal yes (WebGL default, proven); ligatures toggle honestly documents its software-renderer cost. **7/10** → hold.
7. Does it stay snappy under load (streaming agents, many tabs)? — Throttle + refit fixes landed with measured gates; chrome actions under load unmeasured. **6/10** → IF-2 includes an under-load pass.
8. Is the second time instant even when the first isn't (warm caches)? — No overlay DOM caching; everything rebuilds every open. **3/10** → IF-3.
9. Do we re-measure on every release (regression guard)? — perf.cjs exists but is not a release gate. **5/10** → IF-4 makes the action table part of release proof.
10. Does Edward's hand say it feels instant? — He says no; that's this arc's trigger and its exit gate. **3/10** → IF-6.

**Baseline: 40/100.** Exit bar: every measured action <100ms to first acknowledgment (or optimistically acknowledged), no question below 8, and Edward's hand-feel sign-off.

## Boundaries
- GPU renderer stays default-on; any renderer change re-proves the Phase-1 tick gate.
- No framework rewrite hiding inside a perf arc (omni-repo restructure is its own future arc).
- Rust engine untouched unless IF-2 proves engine latency (unlikely — prior measurements put it ahead of the Node engine).
