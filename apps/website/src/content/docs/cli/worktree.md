---
title: worktree
description: Git worktree helpers for spawning/tearing down a session.
---

A multiplexer may bind a git worktree to a workspace as a first-class record — the binding its UI
groups a repo's checkouts by. herdr does; tmux has no workspace tier and does not. These verbs route
through that binding where it exists and fall back to plain git plus a normal
[`open`](/cyber-mux/cli/open/) where it does not, so the same command works on both. See
[adapters](/cyber-mux/concepts/adapters/) and [worktrees](/cyber-mux/concepts/worktrees/).

### `cyber-mux worktree add --branch <branch> [--path <path>] [--base <ref>] [--launch <cmd>] [--layout <name>] [--at <placement>] [--env <KEY=VALUE>...] [--label <name>]`

Create a git worktree, and open it when given a placement.

- `--branch <branch>` — required; the branch the new worktree checks out.
- `--path <path>` — defaults to `<parent>/<repo>.worktrees/<branch>`, a sibling of the primary
  checkout, never nested inside it, on **every** backend — so a path means the same thing
  everywhere.
- `--base <ref>` — start point for the new branch; defaults to the current `HEAD`.
- `--launch <cmd>` / `--env` — each **implies** `--at workspace`, the only placement a backend can
  bind a worktree to (asking for something *in* a pane is asking for the pane).
- `--layout <name>` — same rules as [`open --layout`](/cyber-mux/cli/open/): resolved and validated
  before the worktree is created, and conflicts with `--launch`/`--env`.
- `--label <name>` — names the opened workspace (see `open`'s label table). Worth knowing what you
  get without it: because `worktree add` always passes `--path`, herdr labels the workspace after
  the checkout path's **basename** — it would use the branch only if it chose the location itself.
  So `--branch feat/deep/name` gives you a workspace named `name` unless you pass `--label`.

With **none of `--at`, `--launch`, or `--env`** this is plain git: it creates the checkout, opens
nothing, and needs no multiplexer. Nothing was opened, so nothing is grouped — use `worktree open`
to group it later.

```bash
# Grouped with the repo on herdr; a working, ungrouped worktree on tmux.
cyber-mux worktree add --branch feat/x --at workspace --launch "claude"
```

Prints `root`, `branch`, `pane`, and `workspace`. A `workspace` of `null` means the worktree opened
**ungrouped** — either the backend binds nothing (tmux), or the placement could not carry a binding
(herdr's native call always makes a workspace, so a pane or tab placement falls back to plain git).
That is a complete outcome, not a failure: it succeeds, and — where a placement could have grouped
but didn't — names `--at workspace` as the fix in a `help[N]:` block on **stdout**, inside the
structured payload (not stderr).

`--env` on herdr's worktree-bind route is the one route that cannot carry env natively: it degrades
to an `env KEY=VALUE` prefix on `--launch`'s command line, or a stderr warning when there is no
command to ride.

**Examples**

```bash
# Plain git: create the checkout, open nothing
cyber-mux worktree add --branch feat/x
```

```bash
# Create and open, grouped with the repo where the backend supports it
cyber-mux worktree add --branch feat/x --at workspace --launch "claude"
```

```bash
# Explicit path and start point
cyber-mux worktree add --branch feat/x --path ~/code/my-app.worktrees/feat-x --base origin/main
```

### `cyber-mux worktree open <path> [--launch <cmd>] [--layout <name>] [--at <placement>] [--env <KEY=VALUE>...] [--label <name>]`

Open an existing worktree, grouping it with its repo where the backend can bind. This is the remedy
for a checkout made by a bare `worktree add` — add now, group later. Same flags as `worktree add`
minus `--branch`/`--path`/`--base` (the worktree already exists); prints the same `root`, `branch`,
`pane`, `workspace` shape.

**Example**

```bash
cyber-mux worktree open ~/code/my-app.worktrees/feat-x --at workspace
```

### `cyber-mux worktree list`

Every worktree of the repo, and the workspace each is currently open in. Table columns: `branch`
(`(detached)` when none), `root`, `linked`, `workspace`.

Path, branch, linked, and prunable always come from **git**, on every backend — only the workspace
binding comes from the multiplexer, so backends can never disagree about a worktree. Works outside a
multiplexer, where every `workspace` is simply blank.

**Example**

```bash
cyber-mux worktree list
```

### `cyber-mux worktree remove <path> [--force]`

Remove a worktree, releasing its workspace if one is bound.

The gates are identical on every backend: it refuses the primary checkout (absolute — `--force` never
overrides it), tolerates a checkout already gone from disk, and refuses to discard uncommitted
changes unless `--force`. A refused removal has no side effect: the workspace stays open. When the
gates pass, the workspace is closed *before* git removes the checkout, so none is ever left pointing
at a directory that no longer exists.

**Examples**

```bash
cyber-mux worktree remove ~/code/my-app.worktrees/feat-x
```

```bash
# Discard uncommitted changes in the checkout too
cyber-mux worktree remove ~/code/my-app.worktrees/feat-x --force
```
