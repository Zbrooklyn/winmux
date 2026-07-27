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
- **KPI deck = even thirds.** The three counters take equal thirds, each centred, divided
  by the existing hairlines — balanced across the full width, no dead space. (Live.)
- **Active group row = full fill, no bar, no idle dot.** The soft-purple fill IS the whole
  selection signal; the accent bar is dropped (a stripe is redundant once the row is tinted).
  The status dot's hollow ring is gone, so an idle group shows no dot — but a working (amber)
  or needs-you (red) group still fills its dot, and needs-you still shows red subtext. Loudness
  tracks signal: the dot appears only when a group wants attention. (Live.)
- **Command palette = no row chevrons.** The decorative `›` prefix on every palette row is
  gone; labels align left cleanly. (Live.)
- **Dock / browser address bar = flat, borderless.** The path pill lost its border and reads
  as a quiet line, not the one bordered box in a flat panel. Shared with the in-app browser's
  address bar (consistent). (Live.)
- **Notifications + Settings = reviewed, already on-language.** Flat rows, one purple highlight,
  purple toggles; no change made.
- **Diff panel = reviewed, already on-language.** File list and hunks divided by a single hairline
  (no boxes); the active file row reuses the active-row soft-purple fill; status is the only colour —
  `M`/`A` badges (amber/green), add lines green-tinted, del lines red-tinted, hunk headers in accent,
  quiet everywhere else. Header carries the same `± Changes` tab · panel-glyph · window frame. The
  browser address bar in this chrome was already flattened (shared `.burl`). No change made. (Live.)
- **Dock toggle = one button, like the sidebar.** The pane-header panel icon (`.pc-dock`)
  is the single dock toggle, both directions. The floating right-edge reopen-strip is gone —
  it was the same stray chrome we removed from the sidebar, and `.pc-dock` already reopens.
  (The in-panel control still hides the dock from inside — it uses the panel glyph, not an ×,
  so it reads as a panel toggle and never collides with the window-close × sitting beside it.) (Live.)
- **Control-placement model (top bar + tabs).** The tab toolbar carries ONLY global
  controls — new tab (`+`) and the dock toggle. Every action that acts on one session
  moved into that tab's **right-click menu**: Change tab color · Rename · Duplicate · Split ·
  Move to group · Export text · Find · — · Close · Close tabs to the right · Close others ·
  Close all. (The "to the right / others" items appear only when there's more than one tab.)
  The "connected" pill is hidden while connected — it appears (red/amber) only on a problem.
  Principle: nothing session-specific is in your face until you ask the tab for it; the bar
  stays global. cockpit.css frozen; bar hidden + menu built in index.html/app.js. (Live.)
- **Window-frame controls = present as design language.** Minimize · maximize · close (the
  `.wc` trio) live at the far right of the tab bar, behind a hairline, right of the global
  cluster (`+` / dock toggle). They are the desktop-app frame for the eventual Electron / app-mode
  target — added now so the design language is settled before the shell is wired. Forward-wired to
  a `window.winmux` bridge (Electron injects it); until then maximize falls back to fullscreen and
  close to `window.close()`, minimize is inert (no web API). `placeWinctl()` relocates the trio into
  the dock header when the dock opens so it always pins the window's right edge. Hidden on the phone
  (`data-mode="narrow"`) — mobile is a PWA, not a framed window. Close hover = red. (Live in markup.)
- **Header row = no version chip.** The `GROUPS n` label sits left; search + notifications
  sit right; nothing between. The old bordered `v1.0` pill is removed — it was the only boxed
  element in the flat sidebar and a second colour highlight. Version + diagnostics stay
  reachable via the footer diag button. (Live.)

- **Phone terminal header = two bars, not three.** The mobile Terminal view stacked three
  header rows — brand bar + a back header + the tab bar — and printed the session name twice
  (back header *and* its tab). Collapsed to two (Option A of three shown): the `‹` back-arrow
  moved into the tab bar (`.ptab-back`, back to the session list), and the separate npane back
  header is hidden in narrow focus. Brand bar (with the global "running" count) stays. Alternatives
  shown and not taken: drop the brand bar here (B), or fold back+name into the brand bar (C) — both
  left the name duplicated. cockpit.css frozen; done in index.html/app.js; harness back-nav test
  retargeted to `.ptab-back`. (Live.)
- **Phone tab bar = no phantom left gap.** The left rail toggle is hidden on the phone, but its
  `.pctrls` holder kept its `0 8px` padding — dead space before the first tab. The empty holder is
  now collapsed (`:has(.pc-rail)`), so tabs (and the back-arrow) sit flush left. (Live.)

- **Phone menus = bottom sheets.** Every menu (tab overflow, tab/session/group context menus)
  slides up from the bottom edge as a full-width sheet with a drag handle and a dimmed backdrop,
  instead of a desktop popover anchored to a cursor. One shared path: `placeMenu()` routes to the
  sheet whenever `currentMode === 'narrow'`, so all menus stay consistent. (Live.)
- **Phone controls stay flat on touch.** The mockup's icon-button hover is a 7px-rounded grey fill —
  a *desktop* affordance. Phones tap, not hover, so that fill flashed a rounded grey box on every
  touch and fought the flat language. On narrow, the `.pc` / `.tab-of` / tab-`×` controls drop the
  filled-box hover/active state; press feedback is a colour shift only. Controls read flat during
  interaction, consistently. (Live.)

## Pending visual review

- **North star:** principles-first vs. strict mockup-parity for the whole app — Edward wants
  to brainstorm this visually, region by region. (This is the last open framing question.)
- **Whole-sidebar language** — shown to Edward in one look (2026-07-27) with all four
  decisions applied; awaiting his confirm that it reads as one coherent thing.
