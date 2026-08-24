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
| **`orphan`** | **1 of 2 runs of `655eea1`** | `page.waitForFunction: Timeout 10000ms exceeded`, thrown after both pre-click assertions passed | **reopened.** `clickLive` reduced the rate; it did not close it |
| `writeloud` | 1 of 3 runs of `1b46e00` | — | unexamined |
| `recover` | 1 of 3 runs of `1b46e00` | — | unexamined |
| `resume` | 1 of 3 runs of `3763175` | `{id}` template substitution and the cold-reopen auto-run both fail, plus a throw | unknown — not yet reproduced alone |

**`orphan` was moved to Closed too early, and this is the correction.** It went
5/5 alone, three times, which was read as fixed; it then threw inside the very
next full run at 8-way. Alone is not the condition it fails under, and never was
— both earlier sightings were under concurrency too.

Worse, the failure could not say which half of the check broke: `clickLive`
waits 10s for the X to become hittable, and the caller waits 10s for the tab to
actually close, and a bare Playwright timeout from either reads identically.
That is now fixed — each side throws in words, and the `clickLive` side reports
the element's measured width, height, opacity and what was covering it. The next
occurrence will say which side it came from, which is the whole reason to wait
for one rather than guess now.

Not raising the timeout until then. 10s is already enormous for a hover reveal;
if that is genuinely the cause the message will say so, and if it is not, a
larger number would only have hidden it for longer.

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

## The rule that generalises

**Any check asserting a wall-clock budget runs in the solo lane.** That is the
rule, not the list — a new latency check joins it without anyone deciding to.

Everything else in the suite asserts behaviour, and behaviour does not care how
busy the machine is.
