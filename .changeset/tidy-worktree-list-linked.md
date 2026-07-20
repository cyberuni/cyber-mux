---
'cyber-mux': patch
---

`worktree list` drops the LINKED column from the table. The primary checkout is marked `(*)` after
its branch instead, so the one bit that column carried costs no width. `--format json` is unchanged:
every entry still carries the `linked` boolean.
