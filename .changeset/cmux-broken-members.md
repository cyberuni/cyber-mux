---
'cyber-mux': patch
---

Drive cmux's real verbs for the six `MuxAdapter` members that could not work on it — fabricated flags,
a JSON shape that is never emitted, a route that never emits JSON at all, and two verbs that do not
exist.

- **`open()` at `pane:right`/`pane:down`** sent `--cwd` and `--size` to `new-pane`, which accepts
  neither and validates no unknown flag, so both were silently ignored: the split opened in the wrong
  directory and the ratio did nothing. Both flags are gone. **`canSizeSplits` is no longer declared** —
  cmux has no split-size flag and `resize-pane` is cell-based, so a `ratio` now degrades to cmux's own
  even split, zellij's answer exactly. The directory is carried instead as a `cd` on the command line
  (a shell-level cd, so it lands in that surface's shell history), the same last-resort shape env
  already takes.
- **`open()` at `workspace`** threw on every call: `new-workspace` hardcodes `honorJSONOutput: false`,
  so `cmux --json new-workspace` prints `OK workspace:3` and never JSON. It now runs the namespaced
  `cmux --json workspace create`, which does emit JSON — and takes `--name`, so a workspace is named at
  birth rather than renamed afterwards.
- **`listPanes`, `paneExists` and `isPaneFocused`** were all dead. They read `list-panes`, which
  reports PANES as `{"panes":[…]}`, while the parse required a top-level array of panes each holding
  surface objects — a shape cmux never emits, so the listing was empty for every real response and the
  three members answered "no panes", "does not exist" and "cannot tell" always. They now read
  `list-panels` (the surface tier) with its real keys: `ref` for the id, `focused` for focus.
  **`LivePane.cwd` is now absent on cmux**: the listing carries the directory a surface was *created*
  with and nothing that tracks where its shell is, so reporting it would go stale at the first `cd`.
- **`rename()`** ran `rename-surface`/`rename-pane`, neither of which exists in cmux at all. Both seam
  tiers now run `rename-tab --surface <id> --title <name>`; the `pane` tier retargets the surface the
  pane is showing, because cmux has no pane rename at any layer.
- **`teardown()`** sent `close-surface --surface <id>` with no workspace. It now names the workspace
  whenever the adapter is bound to one — cmux resolves an explicit `--surface` *within* a workspace,
  falling back to `$CMUX_WORKSPACE_ID`, so the old form worked from inside cmux, refused for a library
  caller with no cmux env, and resolved against the wrong workspace for a surface outside the caller's.

Also fixes a grouping bug this read uncovered: `workspace.create` reports no `pane_ref`, so a workspace
open's tab id is a SURFACE ref, and the `group` lookup — which sent only `pane_id` against a handle
registry keyed by ref string rather than by kind — silently resolved it to the caller's own workspace
and would have grouped the wrong one. Each attempt is now verified against its own result.

Read off cmux's own Swift source (`manaflow-ai/cmux` at `71eb616d`) — the CLI dispatch and parsers, the
socket payload builders, and `docs/cli-contract.md` — and **not** verified against a live binary: cmux
is macOS-GUI-only, and issue #128 tracks the missing real-boundary suite. `identify`-backed focus, a
`capabilities` pre-flight, and cmux's native workspace `--env` all replace working behavior on
source-only evidence and are deliberately left for someone with a Mac.
