# Flakes

The bounded maintenance queue. A check that gives two different answers for the
same commit is an instrument defect until proven otherwise, and it belongs here
rather than in the middle of whatever session found it.

**The rule:** a red from the background run is a report, not an order. Fix the
ones that invalidate the work in hand. Everything else lands on this list and
gets **one sitting** — never interleaved with product work. Chasing every
instrument defect the moment it appears is what turned two product fixes into
five instrument commits.

Run `node proof.cjs --flakes` for the live picture. It compares runs of the
*same commit*, because a check that fails on one commit and passes on the next
is a red that got fixed, which is what reds are for.

## Open

| check | seen | what it looks like | best guess |
|---|---|---|---|
| `writeloud` | 1 of 3 runs of `1b46e00` | — | unexamined |
| `recover` | 1 of 3 runs of `1b46e00` | — | unexamined |
| `resume` | 1 of 3 runs of `3763175` | `{id}` template substitution and the cold-reopen auto-run both fail, plus a throw | unknown — not yet reproduced alone |

## Closed — orphan, on the third explanation

**`orphan` — found, after three wrong answers.**

Sighting one read *"closing it does not end the shell"* and was diagnosed as the
click missing a hover-revealed control. `clickLive` was written for it.

Sighting two threw `page.waitForFunction: Timeout 10000ms exceeded` and nothing
else — `clickLive` waits 10s for the X to become hittable and the caller waits
10s for the tab to close, so the message could not say which had failed. Both
were made to throw in words.

Sighting three, on the very next run, said it plainly: *the X was clickable and
was clicked, but the tab did not close (2 before, 2 after)*. That rules out the
mouse. The app was asking.

**"Confirm before closing" ships ON.** `askCloseTerm` opens a dialog for a
terminal it still believes is open, and this check drops the websocket and clicks
the X immediately after — so it races the state flip. Sometimes the app has
noticed the socket is gone and closes at once; sometimes it has not, and asks
first. Load decides. That is why it only ever failed under concurrency, and why
running it alone kept "proving" it fixed.

Probed rather than reasoned about: clicking the X on a live terminal shows
`Close "PowerShell 7"?` with the count unmoved at 2, and clicking the dialog's
Close takes it to 1. The check now answers the dialog, which is what a person
who meant to close the tab does. Turning the setting off was easier and would
have proved a configuration nobody ships with.

**What this cost, and what actually fixed it:** three explanations, each
plausible against the evidence available at the time, and only the last was the
cause. What ended it was not thinking harder — it was making the failure say
which side it came from. **When a flake resists, improve the evidence, not the
guess.**

## Closed — and one wrong diagnosis worth keeping


**`port` — 3 of 3 runs of `1b46e00`, and it was never about the solo lane.**

This entry originally blamed `electron` moving to the solo lane, on the reasoning
that it shifted when `port` runs relative to the checks sharing the `PORT_BUSY`
server. That was a plausible story built from a diff, and it was wrong.

Running `port` alone said so immediately: `BLOCKED — port 9912 is already taken
by another process… held by node (pid 95084)`. Two `server.cjs` processes from
worktrees that had **already been deleted** were squatting 9911 and 9912. Killed
them by PID; `port` went 13/13, twice.

Why it looked deterministic: the auto-picking servers choose from `server.cjs`'s
**shipped** candidate list, which is not namespaced. So a leak from one run
collides with the next run on *any* `WINMUX_VERIFY_PORT_BASE`, and `server()`
hands back a `foreign` stub whose `get()` hits a bare socket — `ECONNRESET`,
reported as a product failure.

Fixed at the `proof.cjs` boundary: anything still executing out of a throwaway
tree is killed by PID before the tree goes, and stale trees are swept the same
way on the way in. Ownership there is not a judgement call — this process created
that directory. `verify.cjs` has its own reaper, but only one of its five spawn
sites registers with it, `.stop()` is a request rather than a guarantee, and a
run killed mid-flight never reaches the reaper at all. I killed one mid-flight
during this session.

**The lesson, and the reason this stays in the file:** a red that reproduces
every time still needs its cause *found*, not inferred from the most recent
diff. Three runs agreeing is evidence the fault is deterministic. It is not
evidence about what the fault is.

## Closed

| check | was | cause | fix |
|---|---|---|---|
| `localecho` | 1 in 2 at 8-way | asserts a keystroke painted within 32ms; seven sibling Electron processes are not an unloaded machine, so the paint never landed in the window (`ms:-1`) | runs alone, last |
| `electron` | 2 of 3 at 8-way | same shape — a 100ms global-summon budget. Best-of-three lowers a flake rate; it does not make a latency claim true on a busy machine | runs alone, last |

## Known residue — one empty directory per run

Each proof run leaves an empty `%TEMP%\winmux-proof-<sha>-<pid>pps\electron`
behind. Not a flake and not a port problem: the tree is empty, the worktree is
deregistered, and nothing squats a port.

The cause is measured, not guessed. A pwsh shell started through node-pty holds
its worktree as its working directory, and Windows will not delete a directory
someone is sitting in. Servers the sweep kills are killed with `/T`, so they take
their shells with them — but a server that exited *normally* first leaves its
shells orphaned with no parent left to kill. Killing the sixteen orphans found
holding five old trees released all five immediately, which is what confirms it.

The real fix is to stop the harness's servers gracefully (the product already has
a shutdown path that ends its shells) rather than with `proc.kill()`, which on
Windows terminates the parent and nothing under it. That is its own unit of work
and it is deliberately not being done inside another one.

Cost of leaving it: one empty directory per run. Cost of the thing already fixed:
runs failing on ports another run was squatting. Those are not the same size, and
the second one is closed.

## The rule that generalises

**Any check asserting a wall-clock budget runs in the solo lane.** That is the
rule, not the list — a new latency check joins it without anyone deciding to.

Everything else in the suite asserts behaviour, and behaviour does not care how
busy the machine is.
