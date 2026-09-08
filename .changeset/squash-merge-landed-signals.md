---
'cyber-mux': minor
---

Detect squash-merged branches when deciding whether a worktree is disposable.

`git branch --merged` is structurally blind to a squash merge — the squash commit on the target is a
rewritten tip with no ancestry link back to the branch — so a squash-merging repo under-reported every
reusable worktree, and a pool built on `provision` never recycled: it only ever created.

The landed signal is now LAYERED, in cost order, with the ancestry answer kept exactly where it was:

- `ancestor` — `git branch --merged`, git's own proof, one call for the whole repo.
- `upstream-gone` — the branch's remote-tracking ref has disappeared (`[gone]`), i.e. the forge merged
  the pull request and deleted its head branch. One call for the whole repo, offline, and correct for
  squash, rebase, and merge-commit strategies alike. Read, never refreshed: nothing here runs
  `git fetch --prune` for you, so the signal is as fresh as your last fetch.
- `squash-patch` — the branch collapsed to one synthetic commit is already applied on the target
  (`commit-tree` + `git cherry`). Offline, and matches a clean squash or rebase merge.
- `forge` — the forge's own word on whether a merged PR exists for the head branch. OPT-IN: pass a
  `signals.forge` probe (`ghForgeMergedProbe` ships as one). Nothing reaches the network without it.

Entries carry a new `mergedSignal` field naming which layer established `merged: true`, absent for a
negative or undeterminable verdict — the layers do not carry equal authority, and a caller auditing a
reclaim needs to see which one spoke.

Every layer after the first is POSITIVE-ONLY, so the composite is a monotone OR: a squash that was
conflict-resolved or hand-edited does not match and degrades to "not reusable" rather than to a false
positive, and a landed signal never outranks a guard — a dirty, occupied, stale, or primary checkout
is refused however it was cleared. `isWorktreeRemovable`, `removeWorktreeSafely`, and the
primary/dirty/occupied gates are unchanged, as is behavior on merge-commit and fast-forward repos.
