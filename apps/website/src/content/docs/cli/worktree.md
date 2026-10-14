---
title: worktree
description: Git worktree helpers for spawning/tearing down a session.
---

A multiplexer may bind a git worktree to a workspace as a first-class record — the binding its UI
groups a repo's checkouts by. herdr does; tmux has no workspace tier and does not. These verbs route
through that binding where it exists and fall back to plain git plus a normal
[`open`](/cyber-mux/cli/open/) where it does not, so the same command works on both. See
[multiplexers](/cyber-mux/multiplexers/) and [worktrees](/cyber-mux/concepts/worktrees/).

## `cyber-mux worktree add`

Create a git worktree, and open it when given a placement.

**Usage**

```bash
cyber-mux worktree add --branch <branch> [--path <path>] [--base <ref>] \
  [--launch <cmd>] [--template <name>] [--at <placement>] \
  [--env <KEY=VALUE>...] [--label <name>]
```

- `--branch <branch>` — required; the branch the new worktree checks out.
- `--path <path>` — where to check out. Without it, the worktree goes to the next free library slot,
  `<parent>/<repo>.worktrees/<repo>-<n>` (the lowest `n` not used by a worktree and not on disk), a
  sibling of the primary checkout, never nested inside it, on **every** backend.
- `--base <ref>` — start point for the new branch; defaults to the current `HEAD`.
- `--launch <cmd>` / `--env` — each **implies** `--at workspace`, the only placement a backend can
  bind a worktree to (asking for something *in* a pane is asking for the pane).
- `--template <name>` — same rules as [`open --template`](/cyber-mux/cli/open/): resolved and validated
  before the worktree is created, and conflicts with `--launch`/`--env`.
- `--label <name>` — names the opened workspace (see `open`'s label table). Without it, herdr labels the
  workspace after the checkout path's **basename**, such as `my-app-2`, not the branch.

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

## `cyber-mux worktree provision`

Get a worktree on the branch you name, reusing an idle one before creating another. It runs the
library's `acquire`, then releases the lease, so the worktree is handed back **unleased**.

**Usage**

```bash
cyber-mux worktree provision --branch <branch> [--base <ref>] [--format <format>]
```

`--branch` is required. `--base` is the start point for the branch; it defaults to the library's
resolved default branch (`origin/HEAD`, then the primary checkout's branch). There is no `--path`:
the library assigns paths.

`acquire` reuses a library slot worktree (`<repo>.worktrees/<repo>-<n>`) that is unleased, has no
live agent session, is clean, and has landed. Otherwise it creates one at the next free slot. The
output reports which happened, so a caller never has to infer it:

```
action        reused
root          ~/code/my-app.worktrees/my-app-2
branch        feat/next
reused-from   feat/search
```

`--format json` carries `action` (`reused` | `created`), `root`, `branch`, and, on reuse,
`reused: { root, branch }`, where `branch` is the prior branch.

**Example**

```bash
cyber-mux worktree provision --branch feat/next --base origin/main
```

## `cyber-mux worktree open`

Open an existing worktree, grouping it with its repo where the backend can bind. This is the remedy
for a checkout made by a bare `worktree add` — add now, group later. Same flags as `worktree add`
minus `--branch`/`--path`/`--base`/`--template` (the worktree already exists); prints the same `root`, `branch`,
`pane`, `workspace` shape.

**Usage**

```bash
cyber-mux worktree open <path> [--launch <cmd>] [--at <placement>] \
  [--env <KEY=VALUE>...] [--label <name>]
```

**Example**

```bash
cyber-mux worktree open ~/code/my-app.worktrees/feat-x --at workspace
```

## `cyber-mux worktree list`

Every worktree of the repo, whether each is still **needed**, and the workspace each is currently
open in. Table columns: `branch` (`(detached)` when none), `root`, `workspace`.

**Usage**

```bash
cyber-mux worktree list
```

Markers ride on the column they are about, so no one-bit fact spends a column of its own:

| Marker | Column | Meaning |
| --- | --- | --- |
| `(*)` | `branch` | the primary checkout — every other row is a linked worktree |
| `(removable)` | `branch` | the worktree looks **disposable** — see below |
| `(gone)` | `root` | the checkout no longer exists on disk; git can prune it |

A `root` under your home directory is also shortened to `~/…`. Every marker and the shortening are
**table-only**: `--format json` carries the library's `WorktreeEntry` fields, unmarked, plus
`workspace`: the absolute `root`, `branch`, `head`, `detached`, `locked` (when locked), and the raw
`linked`, `prunable`, `merged`, `mergedSignal`, and `dirty` values.

### `(removable)` — is this worktree still needed?

A worktree is marked `(removable)` exactly when `worktree prune` would remove it in a dry run, so
the two can never disagree. That means all of the following hold:

1. it is one of the library's own slot worktrees (`<repo>.worktrees/<repo>-<n>`); a worktree at any
   other path, including the older `<repo>.worktrees/<branch>` naming, is never marked;
2. it is **unleased** and **idle**: no live agent session works in it;
3. its branch has **landed** on the repo's default branch, so removing the checkout destroys nothing
   the trunk does not already have;
4. the checkout is **clean**: no uncommitted changes, tracked or untracked;
5. **nothing is open in it**: no multiplexer `workspace` holds it.

The default branch is resolved, never assumed: `origin/HEAD` when it resolves, otherwise the branch
checked out in the primary checkout. `main` is never hardcoded.

Two things worth knowing:

- Landing is established by four independent signals, any one of which is enough: **ancestry**, a
  **gone upstream** (the remote branch was deleted after its PR landed), a **squash patch** match, and
  an opt-in **forge** check. A squash or rebase merge rewrites the commits, so ancestry alone would
  miss it; the patch heuristic catches a clean squash, and one that was conflict-resolved or
  hand-edited still reads `false`. The signal errs toward "still needed" on purpose — a missed marker
  costs you one manual check, a wrong one costs you work.
- The marker is **advisory**. `worktree list` reports; it never removes, and nothing consults `(removable)`
  before a `worktree remove`. The removal gates are unchanged.

When a signal cannot be determined — a detached HEAD, a checkout already gone, no default branch to
compare against — the field is simply **absent** in `--format json` and the row is left unmarked.
Nothing is guessed and nothing fails.

Path, branch, linked, prunable, merged, and dirty always come from **git**, on every backend — only
the workspace binding comes from the multiplexer, so backends can never disagree about a worktree.
Works outside a multiplexer, where every `workspace` is simply blank.

**Example**

```bash
cyber-mux worktree list
```

```
BRANCH                   ROOT                              WORKSPACE
-----------------------  --------------------------------  ---------
main (*)                 ~/code/my-app                     w19
feat/search (removable)  ~/code/my-app.worktrees/search
feat/checkout            ~/code/my-app.worktrees/checkout  w6F
fix/flaky-test           ~/code/my-app.worktrees/flaky
old/spike (gone)         ~/code/my-app.worktrees/spike
```

`feat/search` is merged, clean, and unoccupied — safe to remove. `feat/checkout` is open in a
workspace, `fix/flaky-test` has unmerged work or local edits, and `old/spike`'s checkout is already
gone (`git worktree prune` clears it).

Scripted use reads the booleans rather than the markers:

```bash
cyber-mux worktree list --format json | jq -r '
  .worktrees[]
  | select(.linked and (.prunable | not) and .merged and .dirty == false and .workspace == null)
  | .root'
```

## `cyber-mux worktree remove`

Remove a worktree, closing its workspace if one is bound.

**Usage**

```bash
cyber-mux worktree remove <path> [--force]
```

Removal goes through the library's `removeWorktree`. The gates are identical on every backend: it
refuses the primary checkout (absolute — `--force` never overrides it), tolerates a checkout already
gone from disk, and refuses to discard uncommitted changes unless `--force`. It also refuses a
worktree leased by the library and one where a live agent session works, even with `--force`. A bound
herdr workspace is closed *after* git removes the checkout, so a refused removal has no side effect:
the workspace stays open.

**Examples**

```bash
cyber-mux worktree remove ~/code/my-app.worktrees/feat-x
```

```bash
# Discard uncommitted changes in the checkout too
cyber-mux worktree remove ~/code/my-app.worktrees/feat-x --force
```

## `cyber-mux worktree prune`

Remove every disposable worktree in one call, using the library's `pruneWorktrees`. It removes only
the library's own slot worktrees (`<repo>.worktrees/<repo>-<n>`) that are unleased, idle (no live
agent session), clean, and landed. It is the same set `worktree list` marks `(removable)`.

**Usage**

```bash
cyber-mux worktree prune [--force]
```

**The bare form previews and removes nothing.** It prints the candidates under a `would remove`
column and tells you the command that applies them; `--force` does the removal. Everything it
declines is listed with the reason, so a skip is never silent: open in a workspace (`open in
workspace <id>`), uncommitted changes, branch not landed, leased, live session, or checkout already
gone. Worktrees at other paths, including the older `<repo>.worktrees/<branch>` naming, are skipped
as foreign and left alone.

The primary checkout is not a candidate, not a skip, just absent.

`--format json` prints `{ applied, removed: [{ root, branch }], skipped: [{ root, branch, reason }] }`.

**Examples**

```bash
# Preview
cyber-mux worktree prune
```

```bash
# Apply
cyber-mux worktree prune --force
```
