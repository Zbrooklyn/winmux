# DESIGN.md — WinMux visual system

The single source of truth for how WinMux *looks*. PRODUCT.md says what it is and why;
this says how it's drawn. **Read this before touching any UI.** Every entry here is a
decision Edward made or confirmed — not a guess. When a new design question comes up, it
gets resolved the way the ones below were (see Method) and written here.

## Method — how we decide design (the step we were missing)

Edward decides instantly from **rendered options**, not from words. So:

1. **Show, don't describe.** Any design question becomes 2–4 real rendered screenshots
   (previews via injected CSS, nothing committed) presented as a labelled multiple-choice.
2. **He picks; it gets built and re-shown on the real build; then it's locked here.**
3. **Judge feel before mechanics.** Ask "does it belong to the rest?" first; measure
   spacing/contrast second. Measuring equal gaps is not the same as looking.
4. **Objective defect → fix and show.** Misalignment, failed contrast, or something that
   doesn't match the language: just fix it and ship the screenshot.
5. **Removing or merging a control → never on my own.** Show the visual, ask, he decides.
6. **Visual proof on every rendered change**, at real viewports. Mechanics are read from
   computed values; taste is judged by eye.
7. **Batch, don't thrash.** One full region-by-region pass, not tiny loops.

## The frozen contract vs. the principles

- `public/cockpit.css` is the **mockup, verbatim, and is never edited.** It is the
  structural contract. All app CSS lives in the `<style>` block of `public/index.html`;
  overriding a cockpit.css rule *from there* is allowed, editing cockpit.css is not.
- **Where the mockup didn't pin something down** — or only showed it in its phone view
  (e.g. the desktop KPI deck) — the **principles below govern.** (Whether principles or
  strict mockup-parity is the north star for the *whole* app is still under visual review
  with Edward — see Pending.)

## Visual language (confirmed so far)

- **Flat and borderless.** The sidebar surfaces are flat. No bordered boxes or cards.
  (The KPI deck used to be three bordered cards; flattened to counters — see Decisions.)
- **Left-aligned.** The "GROUPS" label, the group row, and the deck counters all align left.
- **One highlight only.** The single emphasised surface is the *active* group row (a soft
  rounded background + accent bar). Nothing else gets a fill.
- **Separation by hairline or space, never decorative borders.** Where two things need
  dividing, use a 1px `--border` hairline or spacing — not a boxed outline.
- **Quiet by default; colour only when it signals.** Idle/zero states step back down the
  grey ramp. Status colour (working = `--work` amber, needs-you = `--err` red) appears only
  when the count is non-zero. Loudness tracks signal.

## Decisions log

- **Control removal is Edward's call.** I always show a visual and ask; I never remove or
  merge a control on my own. (Confirmed after I wrongly stripped footer buttons.)
- **KPI deck = flat counters**, not bordered cards. Left-aligned, hairline-separated, on the
  sidebar surface. `index.html` override; cockpit.css frozen. (Live.)
- **Sidebar footer icon row = evenly distributed** across the full width — one balanced
  toolbar, no dead centre gap. (Live.)
- **Sidebar collapse/expand = one button, both directions.** No second toggle. The same
  control — the panel icon at the left of the tab bar — collapses when open and expands when
  closed. The header chevron and the edge reopen-strip are both gone. (Live.)
- **Header row = no version chip.** The `GROUPS n` label sits left; search + notifications
  sit right; nothing between. The old bordered `v1.0` pill is removed — it was the only boxed
  element in the flat sidebar and a second colour highlight. Version + diagnostics stay
  reachable via the footer diag button. (Live.)

## Pending visual review

- **North star:** principles-first vs. strict mockup-parity for the whole app — Edward wants
  to brainstorm this visually, region by region.
- **Header icon row** arrangement (the "GROUPS … controls" row).
- **Whole-sidebar side-by-side** to confirm the overall language in one look.
