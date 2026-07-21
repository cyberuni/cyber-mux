---
title: Worktree
description: The cyber-mux/worktree entry — list, resolve, and remove git worktrees safely.
---

The `cyber-mux/worktree` subpath is the git-worktree adapter: the read helpers that enumerate
worktrees from git, the path resolution the whole capability keys on, and the gated removal. Worktree
*facts* (path, branch, merged, dirty) are always read from git on every backend — a multiplexer only
contributes the [workspace binding](#binding-a-worktree-to-a-workspace).

```ts
import {
  resolvePrimaryRoot,
  listWorktreesFromGit,
  removeWorktreeSafely,
  isWorktreeRemovable,
  realExec,
  type WorktreeEntry,
} from 'cyber-mux/worktree'
```

## Reading worktrees

### `resolvePrimaryRoot(exec)`

The primary checkout's root, whether the caller's cwd is the primary checkout or a linked worktree
(via `--git-common-dir`). This is the canonical anchor every other helper resolves against, so a
worktree branched from an old commit sees the same answer as the primary.

### `listWorktreesFromGit(exec, ...)` → `WorktreeEntry[]`

Every worktree git reports. Each `WorktreeEntry` carries what listing must represent that creation
cannot — a detached HEAD, the primary checkout itself, a stale entry:

- **`root`** — absolute, normalized checkout path.
- **`branch`** — absent for a detached HEAD or bare entry.
- **`linked`** — `false` for the primary checkout, `true` for a linked worktree.
- **`prunable`** — git considers the checkout gone from disk.
- **`merged`** — the branch's work has landed on the default branch. Absent when undeterminable;
  reads `false` after a squash/rebase merge (the tip was rewritten) — the error is deliberately
  one-directional, costing a manual check rather than lost work.
- **`dirty`** — the checkout has uncommitted changes. A merged-but-dirty worktree is **not**
  disposable.
- **`workspace`** — the multiplexer workspace it is open in, joined in by the caller from a backend
  [binding](#binding-a-worktree-to-a-workspace); absent otherwise.

### `isWorktreeRemovable(entry)`

Whether an entry is safe to dispose — the merged-and-clean predicate over the fields above.

## Path helpers

- **`normalizeWorktreePath(path, fs?)`** — symlink-resolved, native-cased path; the normalization
  every matched path goes through.
- **`resolveWorktreePath(primaryRoot, name)`** — where a worktree named `name` should be checked out.
- **`assertDistinctFromPrimary(worktreeRoot, primaryRoot)`** — throws if a worktree path is the
  primary checkout, the guard behind any removal.

The `fs` parameter is a `WorktreeFs` seam (`exists` / `realpath`); `realWorktreeFs` is the default.

## Removing a worktree

### `removeWorktreeSafely(exec, ...)`

Removal is always cyber-mux's own gates plus `git worktree remove` — never delegated to a backend,
so a destructive operation's safety never depends on whether a workspace happened to be open. A
refused removal throws a `WorktreeGitError`, whose message is this CLI's own prose (safe to surface
verbatim).

## Binding a worktree to a workspace

The `WorktreeWorkspaceCapability` — reached as [`adapter.worktree`](/cyber-mux/api/mux-adapter/#optional-capabilities),
present on herdr and `undefined` on tmux — is the one part a *multiplexer* owns: binding a worktree
to a workspace as a first-class record the UI groups a repo's checkouts by. Empirically, plain
`git worktree add` + `workspace create` yields **no** binding; only routing through herdr's own
`worktree create`/`open` produces it.

- **`createInWorkspace(exec, opts)`** — create a worktree *and* open it in a bound workspace.
- **`openInWorkspace(exec, opts)`** — open an existing worktree in a bound workspace (the remedy that
  groups a worktree plain git created earlier).
- **`bindings(exec, { primaryRoot })`** → `Map<path, workspace>` — which workspace each worktree is
  open in; the one fact git cannot answer.
- **`releaseWorkspace(exec, workspace)`** — close the workspace, releasing the binding **without**
  touching the checkout on disk.

Every member here *opens* a workspace; none is a route for a bare worktree add — that is always plain
git. On tmux (`adapter.worktree === undefined`) callers fall back to plain git plus a placement-
appropriate [`open`](/cyber-mux/api/mux-adapter/#opening-panes).
