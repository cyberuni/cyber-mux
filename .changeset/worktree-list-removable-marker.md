---
'cyber-mux': minor
---

`worktree list` now answers whether a worktree is still **needed**, not only whether it is occupied.

Entries carry two new booleans — `merged` (the branch's tip is an ancestor of the repo's default
branch) and `dirty` (the checkout has uncommitted changes) — read from git on every backend, exactly
as `linked` and `prunable` are. The default branch is resolved from `origin/HEAD`, falling back to the
primary checkout's branch; `main` is never hardcoded.

The table compresses those two, plus the workspace binding, into a single `(removable)` marker on `BRANCH`
— merged **and** clean **and** unoccupied, i.e. safe to remove. It rides on `BRANCH` because the
branch is what carries the work that landed, and it is mutually exclusive with `(*)`, so no row ever
shows two markers. `--format json` is unmarked as always: consumers read the raw `merged` and `dirty`
booleans and compose their own policy.

A squash or rebase merge rewrites the commits, so such a branch reads `merged: false` and goes
unmarked — the signal errs toward "still needed" deliberately. Any signal git cannot determine (a
detached HEAD, a `prunable` entry, no default branch) is an **absent** field and an unmarked row, never
a guess and never a failure.

This reports only. Removal gating and pruning are unchanged: nothing consults `(removable)` before deleting
anything.
