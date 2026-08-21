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

## G2 — `node verify.cjs --prove <check>`

Red-before, green-after, one command, no stashing. Costs about twice the check's
runtime — seconds. It refuses a no-op and treats a failed revert as fatal.

Not a gate. A thing to reach for when the question "did that actually do
anything" is worth ten seconds.

## G3 — The full run happens without me

`npm run verify` is twelve minutes at three checks in parallel on a twenty-four
core machine. Waiting on it four times was the single largest cost of the
experiment — larger than every other overhead combined.

The fix is not to run it less. It found five real defects that nothing else
could see. The fix is that **it never blocks anyone**:

- a `post-commit` hook launches `proof.cjs HEAD` detached
- single-flight: a new commit kills the in-flight run and starts on the new tip.
  Nobody needs a verdict on an intermediate state
- **green is silent.** Red writes `verify-out/RED.md` and nothing else
- concurrency comes off the floor of three

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

## Deleted

Tier names — no tier was ever chosen; a check was run, or everything was.
Failure-class taxonomy — generated after the fact, never consulted during.
"Batch by shared falsifier" — never fired. Replay as a standing step — worth
doing once, absurd as a habit. Post-hoc classification, checkpoint ceremony,
proof-step sequencing, and the four-property proof: all gone.
