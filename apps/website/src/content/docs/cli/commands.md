---
title: Commands
description: The cyber-mux verb surface.
---

:::note
The verb surface below is **provisional** — the behavior spec is the next milestone and may rename
verbs or adjust flags.
:::

Every command runs against the multiplexer the current process is inside (resolved by
[detection](/cyber-mux/concepts/detection/)). Commands that produce data accept `--format
text|json|agent`.

## Diagnostics

### `cyber-mux doctor`

Probe the multiplexer, your self pane, and the resolved backend; print a `CYBER_MUX` /
`CYBER_MUX_PANE` fast-path pin.

### `cyber-mux mode`

Print just the detected backend name: `tmux`, `herdr`, or `none`.

## Driving panes

### `cyber-mux open --launch <cmd> [--cwd <path>] [--at <placement>]`

Open a new pane and launch a command in it. `--at` is one of `pane:right`, `pane:down`, `tab`
(default), or `workspace`. Prints the new pane id.

### `cyber-mux send <pane> <text>`

Type text into a pane and submit it.

### `cyber-mux submit <pane>`

Flush a pane's already-staged buffer with a bare Enter — never re-types.

### `cyber-mux read <pane> [--lines <n>]`

Capture a pane's output, optionally scoped to the last `n` lines.

### `cyber-mux focus <pane>`

Beam the attached client to a pane, across workspace and tab.

### `cyber-mux close <pane>`

Close a pane.

## Inspecting panes

### `cyber-mux list`

Enumerate every live pane the current backend can see.

### `cyber-mux exists <pane>`

Probe whether a single pane is still live. Exits `0` when live, `1` when gone.

## Worktrees

A multiplexer may bind a git worktree to a workspace as a first-class record — the binding its UI
groups a repo's checkouts by. herdr does; tmux has no workspace tier and does not. These verbs route
through that binding where it exists and fall back to plain git plus a normal `open` where it does
not, so the same command works on both. See [adapters](/cyber-mux/concepts/adapters/).

### `cyber-mux worktree add --branch <branch> [--path <path>] [--base <ref>] [--launch <cmd>] [--at <placement>]`

Create a git worktree, and open it when given a placement.

With **neither `--at` nor `--launch`** this is plain git: it creates the checkout, opens nothing, and
needs no multiplexer. Nothing was opened, so nothing is grouped — use `worktree open` to group it
later.

With a placement, it opens too. `--launch` implies `--at workspace`, the only placement a backend can
bind a worktree to:

```bash
# Grouped with the repo on herdr; a working, ungrouped worktree on tmux.
cyber-mux worktree add --branch feat/x --at workspace --launch "claude"
```

`--path` defaults to `<parent>/<repo>.worktrees/<branch>` — a sibling of the primary checkout, never
nested inside it — on **every** backend, so a path means the same thing everywhere. `--base` sets the
new branch's start-point.

Prints `root`, `branch`, `pane`, and `workspace`. A `workspace` of `null` means the worktree opened
**ungrouped** — either the backend binds nothing (tmux), or the placement could not carry a binding
(herdr's native call always makes a workspace, so a pane or tab placement falls back to plain git).
That is a complete outcome, not a failure: it succeeds, and says so on stderr.

### `cyber-mux worktree open <path> [--launch <cmd>] [--at <placement>]`

Open an existing worktree, grouping it with its repo where the backend can bind. This is the remedy
for a checkout made by a bare `worktree add` — add now, group later.

### `cyber-mux worktree list`

Every worktree of the repo, and the workspace each is currently open in.

Path, branch, linked, and prunable always come from **git**, on every backend — only the workspace
binding comes from the multiplexer, so two backends can never disagree about a worktree. Works
outside a multiplexer, where every `workspace` is simply blank.

### `cyber-mux worktree remove <path> [--force]`

Remove a worktree, releasing its workspace if one is bound.

The gates are identical on every backend: it refuses the primary checkout (absolute — `--force` never
overrides it), tolerates a checkout already gone from disk, and refuses to discard uncommitted
changes unless `--force`. A refused removal has no side effect: the workspace stays open. When the
gates pass, the workspace is closed *before* git removes the checkout, so none is ever left pointing
at a directory that no longer exists.
