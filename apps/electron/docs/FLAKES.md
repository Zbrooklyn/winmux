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
| `resume` | 1 of 3 runs of `3763175` | `{id}` template substitution and the cold-reopen auto-run both fail, plus a throw | unknown — not yet reproduced alone |

## Closed

| check | was | cause | fix |
|---|---|---|---|
| `orphan` | ~1 in 2, at both 3-way and 8-way | the tab close button is hover-revealed; a control mid-reveal satisfies Playwright's "visible and stable" while something else is still under the cursor, so the click missed and the shell count never moved — reported as *"closing it does not end the shell"* | `clickLive` waits until the target is genuinely the element at its own centre, and the check now asserts the tab actually closed before measuring anything downstream |
| `localecho` | 1 in 2 at 8-way | asserts a keystroke painted within 32ms; seven sibling Electron processes are not an unloaded machine, so the paint never landed in the window (`ms:-1`) | runs alone, last |
| `electron` | 2 of 3 at 8-way | same shape — a 100ms global-summon budget. Best-of-three lowers a flake rate; it does not make a latency claim true on a busy machine | runs alone, last |

## The rule that generalises

**Any check asserting a wall-clock budget runs in the solo lane.** That is the
rule, not the list — a new latency check joins it without anyone deciding to.

Everything else in the suite asserts behaviour, and behaviour does not care how
busy the machine is.
