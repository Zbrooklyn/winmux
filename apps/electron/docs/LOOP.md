# The loop

Designed backwards from how the work actually goes fastest, not forwards from a
verification architecture. Three mechanisms. Everything else that was proposed or
built during the experiment is deleted; the reasoning is in LOOP-EXPERIMENT.md.

## The behaviour this is built around

At full speed the work looks like this, and the loop must not disturb any of it:

- one file family held in head for twenty to forty minutes at a stretch
- read a region once, write the whole change, wire it, move on
- ports, selectors, helper placement decided silently and instantly
- one targeted check when there is a specific question, answered in ten seconds
- commit when a thing is coherent, not when a step says to

The thing that breaks it is not ceremony. It is **waiting**, and **being pulled
out of the product into the instrument**. Both are addressed directly below.

## G1 — Guards, ~1ms, on every invocation

Already in `verify.cjs`, above everything else. They refuse to start and name the
problem:

- two checks may not claim one port unless the sharing is declared
- no raw port literal outside `P()` — anywhere, including inside strings
- no check on a port the browser refuses (`ERR_UNSAFE_PORT`)
- no run against a tree that was never compiled

These cost nothing and have caught, between them, one re-introduced collision,
one port chosen by eye while building the guard against choosing ports by eye,
one port baked into a filename, one unsafe port, and one uncompiled worktree.
This is the whole of the old "Tier 0" minus the word.

**Add a guard whenever a mistake is made twice, and only then.** A guard that
cannot be checked from the file's own text or the file system is not a guard, it
is a wish.

The worked example is `clickLive`. A hover-revealed control burned a thirty-
second timeout once; then `orphan` clicked a tab's close button, watched the
shell count not move, and reported *"closing it does not end the shell"* — at
3-way concurrency and again at 8-way. Both times the product was fine and the
mouse was what was actually being measured. Playwright's actionability check
means visible and stable, which a control halfway through a reveal transition can
satisfy while something else is still under the cursor. So on the second
occurrence it became a helper: hover the parent, wait until the target is
genuinely the element at its own centre, then click — and if it never becomes
hittable, say *harness* rather than letting the silence be scored against the
product.

That is the general shape of everything worth keeping: **a failure mode that
cannot tell you which side it came from is the expensive kind.**

## G2 — `node verify.cjs --prove <check>`

Red-before, green-after, one command, no stashing. Costs about twice the check's
runtime — seconds. It refuses a no-op and treats a failed revert as fatal.

Not a gate. A thing to reach for when the question "did that actually do
anything" is worth ten seconds.

## G3 — The full run, launched detached, never waited on

The full run found five real defects that nothing else could see. It was also the
single largest cost of the experiment — larger than every other overhead
combined — because it took twelve minutes and got waited on four times.

Both halves of that were fixed by one line. The concurrency cap was a flat 3, set
years ago against a flake that no longer reproduces, on a machine with 24 cores:

    3 at a time  →  ~12 min   637/637
    8 at a time  →  2m 26s    637/637
    8 at a time  →  2m 28s    636/637   ← the second run flaked

The flake is worth reading, because it is the whole reason the cap existed. It
was `localecho`, which asserts a *latency* — a keystroke painted within 32ms —
and under seven sibling Electron processes the paint never landed in its window.
One check with a timing budget was making the other eighty-five run at a fifth
speed. It now runs alone, last; everything else keeps the full width.

At two and a half minutes there is nothing left to engineer. No git hook, no
single-flight lock, no notification bus — those were all designed to work around
a cost that turned out to be a default nobody had re-measured. What remains is a
habit:

**Launch `node proof.cjs HEAD` in the background and keep working. Never wait on
it.** Read the result when it lands, in whatever you are doing next.

And the second-order effect, which was the real payoff: once the run is cheap it
gets repeated, and **repetition is the only thing that exposes a coin flip.**

Five runs of essentially the same commit gave 637/637, 636/637, 637/637,
636/637, 631/635. Four different checks flipped across them. `637/637` was never
a property of the code — it was a sample, and it was reported as proof twice.

Two of the four are fixed (`orphan`, `localecho`). One is a latency claim that
belongs in the solo lane (`electron`). One (`resume`) is unexplained and is
written down rather than chased, because chasing every instrument defect the
moment it appears is the runaway this whole document exists to stop.

**The number to trust is not the pass count. It is the pass count repeated.** A
single green full run means the suite did not fail this time.

The one thing worth remembering: it proves the *commit*, not the working tree. If
the answer matters, commit first.

## The rule that was missing

Every full run that came back red pointed at the instrument, so the instrument
got fixed, so the run was repeated. Locally correct, globally unbounded: an
instrument is never finished, and a loop that prioritises instrument correctness
will always find more instrument work. Five instrument commits, two product
commits.

So: **a red from the background run is a report, not an order.**

- a red that blocks the change in hand → fix now
- anything else → it goes on a list and is fixed in **one** sitting, at most once
  per session, never interleaved with product work

And when a run comes back red, read **every** root cause out of that one log
before touching anything. The first full run of the experiment contained both the
CLI-port defect and the missing-build defect. Only the first was acted on, so the
second cost an extra twelve-minute run to rediscover. That was not the loop's
fault; it was a batching failure with the log already open.

## The whole loop, as it is actually run

    write for twenty to forty minutes inside one file family
    node verify.cjs <check> <neighbour>     # only when there is a real question
    node verify.cjs --prove <check>         # when "did that do anything" is worth 10s
    git commit                              # on coherence, not on a step
    node proof.cjs HEAD &                   # detached, never waited on

The guards run inside every one of those invocations and cost nothing. That is
the entire mechanism. If a step ever needs a name, a tier, or a decision tree, it
is not part of this loop.

## Deleted

Tier names — no tier was ever chosen; a check was run, or everything was.
Failure-class taxonomy — generated after the fact, never consulted during.
"Batch by shared falsifier" — never fired. Replay as a standing step — worth
doing once, absurd as a habit. Post-hoc classification, checkpoint ceremony,
proof-step sequencing, and the four-property proof: all gone.
