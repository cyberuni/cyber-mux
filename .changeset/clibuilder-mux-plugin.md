---
"cyber-mux": minor
---

The CLI now runs on clibuilder instead of commander, and ships as a clibuilder plugin: a host CLI that
lists `cyber-mux/plugin` in its `plugins` config gets every verb under `mux` (`<host> mux list`).

Usage errors behave differently in a few places:

- A malformed value (`--at bogus`, `--lines abc`, `--env NOEQUALS`) is now a coded `invalid-value`
  error on stdout with exit 2. It used to exit 1 with commander's own text on stderr.
- A missing `--branch` on `worktree add` or `worktree provision` is now a coded `missing-argument`
  error with exit 2.
- `--help` exits 0 as before. The help layout is clibuilder's.
- `--version` reports the package version instead of `0.0.0`.
- `wait --timeout 0` takes a single look at the pane, as documented.
