# Product

## Register

product

## Users

Edward — the operator of a fleet of AI coding agents — and, secondarily, anyone who runs many
terminals at once on Windows. The context is not "sitting down to write code"; it is **checking on
work in flight**. Two postures matter, and they are the whole design problem:

- **At the desk**, on a 1440px-wide window: many shells open across a few panes, grouped by what
  they belong to. The job is to see which of them is working, which is stuck waiting on a human,
  and which is idle — and to get into the one that matters in one click.
- **On the phone**, at 384px: away from the machine, wanting to know whether the thing that was
  running finished, and to type one command if it didn't. There is no room for two levels at once,
  so the phone is a stack of screens — groups → sessions → terminal — and the back arrow is the
  spine.

The job to be done is **triage before interaction**. The user arrives with a question ("did it
finish?", "what's blocked?"), not a task. The interface answers before they touch anything.

## Product Purpose

WinMux is a real terminal multiplexer for Windows that wears the wmux cockpit design. Real shells
(PowerShell, Command Prompt, Git Bash, WSL) run behind xterm.js inside the mockup's chrome, served
over a local HTTP server the user opens in a browser — desk at `127.0.0.1`, phone over Tailscale
behind a key.

Success is: every visible control does something, the same app is usable at 1440px and at 384px,
and the shell survives the browser tab closing. Failure is a beautiful mockup with dead buttons —
the exact thing this project exists to replace.

## Brand Personality

**Quiet, dense, honest.**

- *Quiet* — the chrome never competes with the terminal. The terminal is the content; everything
  around it is instrumentation. Anything that isn't reporting real state should recede.
- *Dense* — this is a cockpit, not a dashboard. Many things visible at once is correct. Whitespace
  for elegance at the cost of a lost session is wrong.
- *Honest* — the status dots, counters, and sub-lines are the product's core claim. A counter that
  shows a number it can't back, or a control that looks live and isn't, is the worst possible bug
  here — worse than an ugly one.

Emotionally it should feel like a well-worn instrument panel: unremarkable when everything is fine,
and immediately legible the moment something needs you.

## Anti-references

- **`public/cockpit.css` is the frozen design contract** — lines 8–399 of
  `wmux-amirlehmam/design-spec/cockpit.html`, verbatim, never edited. Every app-side style lives in
  the `<style>` block of `public/index.html`. Any "improvement" that requires editing cockpit.css is
  out of scope by definition.
- **Not a dashboard.** No hero metrics, no big-number cards, no chart-first layout. The stats deck
  is three small counters in a corner, and that is the ceiling.
- **Not a consumer app.** No onboarding carousel, no gradients, no glass, no illustration, no
  decorative motion. A terminal multiplexer that greets you is broken.
- **Not the wmux Electron app.** WinMux is the browser-served build; it does not inherit that app's
  chrome, its window controls, or its scope.
- **Not "cleaned up" by removing capability.** Trimming controls to look tidier is a regression.
  Cleanup means quieting what isn't signal, never deleting what is.

## Design Principles

1. **The terminal is the content.** Chrome earns its pixels by reporting state. Anything that isn't
   reporting state gets quieter, smaller, or removed.
2. **Loudness must track signal.** Visual weight is a scarce budget spent on what is actually
   happening. A counter at zero, an inactive tab, and a version chip must not read as loud as a
   session that needs you.
3. **Two levels, never one.** The side is groups; the top is that group's sessions. Any surface
   that flattens the two is wrong even if it looks fine.
4. **The phone is the same product, not a cut-down one.** Every group and every session reachable
   at 1440px is reachable at 384px, through the same model, one screen at a time.
5. **Nothing renders that isn't wired.** A control that exists but does nothing fails this product
   harder than a control that is missing.

## Accessibility & Inclusion

- **WCAG AA** for all chrome text and controls: body ≥ 4.5:1, large/bold ≥ 3:1, against the actual
  surface it sits on. The deliberately-dimmed states (an idle counter at zero, an inactive tab) are
  *de-emphasis of non-signal*, not body copy, and are held to the ≥3:1 non-text/large bar.
- **Status is never color alone.** Every status dot is paired with a word — "working", "needs you",
  "idle" — in the sub-line or the card, so the red/amber/green ramp is redundant, not load-bearing.
  This is what makes the deck usable with any form of color blindness.
- **Keyboard** reaches every core flow (new tab, switch tab, close, palette). Keyboard shortcuts
  enhance; they never become the only path to a control.
- **Touch targets ≥ 44px** on the narrow layout, where the primary input is a thumb.
- **`prefers-reduced-motion: reduce`** removes transitions rather than shortening them. There is no
  motion in this product that carries meaning on its own.
- **Both themes are first-class.** Dark is the default because the terminal is; light is not a
  degraded afterthought and is held to the same contrast bar.
