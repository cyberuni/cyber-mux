---
'cyber-mux': patch
---

`worktree list` shortens a `root` under your home directory to `~/…` in the table. The match is on a
path boundary, so `/home/annex` is untouched by a home of `/home/ann`. `--format json` is unchanged:
consumers still get the absolute path.
