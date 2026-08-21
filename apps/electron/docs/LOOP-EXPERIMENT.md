# The replay experiment

Re-running the work from the last checkpoint before the instrument started
lying, under a different loop, to find out which loop changes were worth their
build cost. Kept short on purpose: a log that costs more than it saves is one
more thing that will not be maintained.

Baseline (`evidence/original-path`) and replay (`replay/guarded-loop`) both
start from `8fa3b40`, the last commit at which no two checks shared a port.

## How the corruption was found — by measurement, not memory

A twenty-line script read every historical version of `verify.cjs`, resolved
each check's port expression, and printed collisions per commit. It contradicted
my own written account: I had told Edward that three collisions were mine and
the fourth was older. All four were mine, introduced in four consecutive
commits. Roughly one instrument-corrupting mistake per feature commit, in a file
where choosing a port by eye was the norm.

Cost: about two minutes. It replaced a recollection that was wrong.

## What each loop change actually bought

**Port uniqueness guard — kept.** Caught a re-introduced collision by name
before any check ran. Then caught *me*, a fifth time, choosing a colliding
number by eye while building the very thing meant to stop that. It has to be
mechanical because judgement demonstrably does not hold here.

**Port namespace — kept, and it is not optional.** Worktree isolation alone
does not let a full run and a targeted run coexist: the ports are machine-wide.
Proven by running both at once — pinned suite on :100xx from a frozen worktree,
live targeted run on :99xx from the working tree, both fully green, no
interference. Source pinning stops staleness; only the namespace stops
contention. The original plan named one of these two.

**The namespace was half-built, and only the full pinned run could see it.**
The paragraph above was written before the first full proof, and it was wrong in
the way that matters. Shifting the ports at the registration choke point moved
the servers; it did not move the fifteen checks that hand their raw port
constant to the `winmux` CLI as `WINMUX_PORT`. Under a base the server listened
on 10068 and the CLI dialled 9968. Thirty-five of eighty-five checks went red.

None of it is visible at base 0, where the raw and shifted numbers are the same
number — which is precisely why the targeted concurrency test passed. **A
half-applied namespace is green exactly where it is not being used.** The
targeted run answered "do these two runs interfere," which was the question I
asked; the question I meant was "is this suite correct under a shifted base,"
and only the whole suite could answer it. That is P10 again, committed by the
person who had just written P10 down.

The fix is not fifteen call sites. Ports are declared already-shifted —
`P(9914)`, not `9914` — so a raw number has nowhere to leak from, and a startup
self-scan refuses to run if a `99xx` literal appears outside `P()`. One
millisecond, and it sees what a twelve-minute run sees.

**`--prove` — kept, and it earned its place by failing correctly.** Its first
run reported NOT PROVEN. The fault was inside `--prove` itself: git resolves
pathspecs against the working directory, so the revert silently did nothing, the
"before" run kept the change, and it passed. A proof harness that quietly fails
to remove the fix is exactly how a false PROVEN gets manufactured — so a failed
revert is fatal now, not survivable. The important part is that the broken
version reported NOT PROVEN rather than a green tick.

**Ephemeral worktree per run — kept, learned the hard way twice.** "Isolated"
has to mean a throwaway tree at a pinned commit, deleted afterwards. A second
directory you keep editing is just another mutable tree. I launched a pinned run
into the replay worktree and was one edit away from invalidating it — the same
mistake that destroyed a run on the original path.

**`node --check` — demoted.** It passed a file that referenced an undefined
`spawnSync`. Syntax checking says nothing about references, and treating it as a
gate is false confidence.

## Loop-cost notes

- Both product units (`splitfloor`, `foldfit`) went red-before / green-after in
  one command each. On the original path the same evidence took hand-run
  `git stash` gymnastics, four times, each one a live risk to uncommitted work.
- Two instrument defects were caught by *reasoning about the instrument before
  running it* — a guard seeded with offset ports while comparing raw ones, and a
  dead `evaluate` block that computed nothing. Neither cost a run.
- One selector cost a 30-second Playwright timeout (`.pc-split` is hover-only).
  A liveness helper that fails with "exists but nothing can click it, X is on
  top" would have said so instantly — and that same class of measurement is what
  found the broadcast Stop button sitting under the window controls.

## What the tiers are actually for

Not "cheap first, expensive later." They answer different questions, and the
cheap one cannot be made to answer the expensive one's:

- **Tier 0** (milliseconds, no browser) — is the instrument self-consistent?
  Port uniqueness, no raw literal skipping `P()`. Catches by name, before
  anything runs. Both of its rules exist because judgement demonstrably failed
  at exactly that spot.
- **Tier 1** (targeted, seconds to a minute) — does *this* change do what I
  said? `--prove` red-before / green-after on the named checks.
- **Tier 2** (full, pinned, ~12 min) — is the suite still true *as a whole*?
  This is the only tier that can catch a defect in the harness's own
  cross-cutting machinery, because a targeted run is by definition a subset that
  may not contain the affected checks. Tier 2 is not a formality at the end of
  the work. It is the only instrument that can see a class of bug the other two
  are structurally blind to, and skipping it is how a wrong instrument ships.

## Still deferred, deliberately

- Affected-state targeting. The expensive one: it needs a map that does not
  exist. Everything above was hours; this is a day.
- Reusable screenshot proof as a harness verb.
- A check that can attach to the app actually running on the machine.
- Coverage-gap number printed beside the pass count, with a ratchet.
