---
todos:
  - content: Map each of the 29 UNBOUND mux scenarios to the test that already verifies it
    status: completed
  - content: Add the spec node wrapper to worktree.test.ts (structural half)
    status: completed
  - content: Retitle bound-worthy tests onto their scenario names verbatim
    status: completed
  - content: Prove no rename-induced over-claim — mutate each retitled test's subject
    status: completed
  - content: Re-run the bridge; record what stays unbound and why
    status: completed
  - content: Commit and open the PR
    status: completed
  - content: Drain the 4 recorded follow-ups into issues (needs permission)
    status: pending
---

# Bind the pane node's unbound scenarios

CR: [#21](https://github.com/cyberuni/cyber-mux/issues/21) — bind `cyber-mux/mux`'s unbound
scenarios to the tests that already verify them.

Target: `cyber-mux/mux` (`packages/cyber-mux`), suite
`packages/cyber-mux/.agents/spec/mux/mux.feature`.

**No spec or suite content change.** Every bound scenario already existed verbatim and stays frozen;
the node is already `status: implemented`. Tests change, the contract does not. Follows the
`complete-mux-scenario-coverage` precedent: leash line, no spec gate, nothing to freeze.

## Result

**48/77 bound → 70/77**, 0 fail. Measured, with the `layout` node re-measured at 29/67 before and
after to prove no regression. 432 tests pass.

## Three things the issue got wrong

- **Stale counts.** It reports 45/72 bound and 27 unbound; the rebased tree measured 48/77 and 29.
  It was filed pre-merge. The premise still held.
- **Half-wrong cause.** It says every test already sits under the right node wrapper, so the cause is
  purely per-test title voice. In fact `worktree.test.ts` carried **no** `spec:` wrapper at all, so
  every test in it bound to nothing — the same structural shape as the layout node's sibling finding
  (CR 8), which the issue believed did not apply here. Both causes were in play.
- **"Needs no new assertions" was false.** Only 13 of 29 were verified fully enough to retitle
  as-is. The rest each had a clause their test did not check.

## The hazard, and what it caught

A retitle makes a test *claim* its scenario. A false bind is worse than an unbound scenario: unbound
gets hand-judged, a false bind gets trusted. So every retitle was proven by mutating the scenario's
subject and watching that test fail — not by reading.

That mutation pass earned its keep. The `worktree remove refuses the primary checkout` fixture used
a `/repo` path that does not exist on disk, so a removal guarded by `existsSync` never fired and the
"removes nothing" assertion was inert — a real primary checkout always exists, so the bug it was
meant to catch would have shipped. Repointed at a genuinely existing path; the mutation now fails.

One scenario was misdiagnosed entirely: unbound over a curly apostrophe against the suite's straight
one, not implementation voice at all.

## Left unbound (7), on purpose

Recorded as follow-ups in the CR's ledger shard. Two key-refusal scenarios are facts about a real
backend that a mocked exec cannot prove; three have Givens in env terms no test exercises; two are
half-covered. Each would need a new assertion or an integration tier — not a retitle. Binding them
would have been the exact lie this CR set out to avoid.

## NEXT

Landed as [PR #25](https://github.com/cyberuni/cyber-mux/pull/25), rebased onto `main` after it
advanced 7 commits mid-PR and re-verified on the merged tree (70/77, 0 fail, 444 tests).

Remaining: drain the 4 follow-ups in the ledger shard into issues. Deduped against the open set —
none is a duplicate; #17 is adjacent to the near-miss-diagnostic one but covers an unparseable
suite, not a title mismatch. Awaiting the requester's permission to file; the ledger records stand
either way, and a later drain re-derives what is outstanding by the same dedupe.
