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

## Still deferred, deliberately

- Affected-state targeting. The expensive one: it needs a map that does not
  exist. Everything above was hours; this is a day.
- Reusable screenshot proof as a harness verb.
- A check that can attach to the app actually running on the machine.
- Coverage-gap number printed beside the pass count, with a ratchet.
