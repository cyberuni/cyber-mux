---
'cyber-mux': patch
---

`worktree list` marks a prunable worktree — one whose checkout no longer exists on disk — with
`(gone)` after its `root` in the table. It rides on `root` because the path is the thing that
vanished, and `(gone)` is git's own word for it (`branch -vv` prints the same). `--format json` is
unchanged: entries still carry the `prunable` boolean.
