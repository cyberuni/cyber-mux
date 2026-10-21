---
title: Worktree
description: The cyber-mux/worktree entry — the async worktree library, the mux binding, and the gated removal.
---

The `cyber-mux/worktree` subpath is the git-worktree adapter. The worktree logic lives in
[`cyber-agentkit/worktrees`](https://github.com/cyber-uni/cyber-agentkit) (v0.7.0 and later),
and this entry re-exports it, then adds the multiplexer binding and cyber-mux's own removal gates.
Worktree *facts* (path, branch, landed, dirty) are always read from git on every backend — a
multiplexer only contributes the [workspace binding](#binding-a-worktree-to-a-workspace).

```ts
import {
  acquire,
  release,
  listWorktrees,
  pruneWorktrees,
  muxWorktreeCreator,
  removeWorktreeSafely,
  toHarnessExec,
  nodeExec,
} from 'cyber-mux/worktree'
```

## The library — `cyber-agentkit/worktrees`

The library is async and takes its runner per call. Re-exported unchanged: `acquire` / `release` /
`explain` with a git-lock lease, `primaryRoot`, `listWorktrees`, `pruneWorktrees`, `removeWorktree`,
`readDirty`, `classifyOwner`, `probeProcesses` / `occupants`, `seedWorktree`, `normalizeWorktreePath`,
`ghForgeMergedProbe`, the slot naming (`slotPath`, `<repo>.worktrees/<repo>-<n>`), and the types
`WorktreeEntry`, `ForgeMergedProbe`, `RemoveWorktreeOptions`, and `WorktreeCreatorUndo`. The
`HarnessWorktreeEntry` and `HarnessForgeMergedProbe` aliases remain but are deprecated; use the
unprefixed names.

cyber-mux adds the one piece the library leaves to the caller, the multiplexer binding:

```ts
import { resolveMuxAdapter } from 'cyber-mux'
import { acquire, muxWorktreeCreator, release } from 'cyber-mux/worktree'

const adapter = resolveMuxAdapter(process.env)
const lease = await acquire({
  holder: 'my-agent',
  branch: 'feat/x',
  create: muxWorktreeCreator(adapter, { label: 'feat-x', onBound: (bound) => { /* bound.workspace */ } }),
})
// ... work in lease.worktree ...
await release(lease)
```

- **`muxWorktreeCreator(adapter, options?)`** → `WorktreeCreator` — creates the checkout with the
  library's `gitWorktreeCreator`, then, on a backend that binds worktrees (herdr), opens it through
  [`openInWorkspace`](#binding-a-worktree-to-a-workspace) so the binding is recorded. On any other
  backend it only creates the checkout. `options` takes `exec`, `launch`, `env`, `label`, and
  `onBound`.
- **`toHarnessExec(exec)`** — lifts cyber-mux's synchronous `Exec` onto the library's async one, so one
  runner (or one fake) drives both.

### Migrating from the removed helpers

The synchronous helpers that duplicated the library are gone. This is a breaking change.

| Removed | Use instead |
| --- | --- |
| `listWorktreesFromGit(exec, ...)` | `listWorktrees({ primaryRoot, exec })` |
| `pruneWorktrees` (sync) | `pruneWorktrees({ primaryRoot, apply, exec })` |
| `provisionWorktree` | `acquire({ primaryRoot, holder, branch, base, exec })`, then `release(lease)` |
| `isWorktreeRemovable` | `explain()`, or a `pruneWorktrees` dry run |
| `resolveWorktreePath` | the library's slot naming (`slotPath`) |
| sync `ghForgeMergedProbe` | the library's async `ghForgeMergedProbe(exec, primaryRoot)` |
| sync `normalizeWorktreePath` | the library's async `normalizeWorktreePath` |
| `WorktreeMergedSignal`, `WorktreeSignalOptions`, `WorktreePruneSkip`, `WorktreePruneResult`, `WorktreeCreateSpec`, `WorktreeProvisionAction`, `WorktreeProvisionResult` | the library's equivalent types |

`RemoveWorktreeOptions` for `worktreeApi().removeSafely` is now `RemoveWorktreeSafelyOptions`; the
name `RemoveWorktreeOptions` is the library's.

## Bound facade — `worktreeApi`

`worktreeApi(deps?)` binds `Exec` + `WorktreeFs` once (defaulting to `nodeExec` / `nodeWorktreeFs`),
returning a `WorktreeApi` whose methods drop the runner — mirroring how
[`resolveMux`](/cyber-mux/api/mux-adapter/) binds the mux adapter. It covers only the synchronous
helpers that stay.

```ts
import { worktreeApi } from 'cyber-mux/worktree'

const wt = worktreeApi()                       // or worktreeApi({ exec, fs }) to inject
wt.removeSafely(somePath, { primaryRoot: '/path/to/primary' })
```

| method | binds + wraps |
| --- | --- |
| `wt.primaryRoot()` | `resolvePrimaryRoot` (deprecated) |
| `wt.add(opts)` | `gitWorktreeAdapter.add` |
| `wt.removeSafely(path, opts)` | `removeWorktreeSafely` — its `fs` supplied |

`deps` is `WorktreeDeps { exec?, fs? }`. Listing, pruning, and reuse are the library's, not methods
here.

## Synchronous helpers

These have no library equivalent and stay synchronous.

- **`resolvePrimaryRoot(exec)`** — the primary checkout's root, from the primary checkout or a linked
  worktree (via `--git-common-dir`). Deprecated: use the library's async `primaryRoot`.
- **`gitWorktreeAdapter`** — `add` creates a worktree at a caller-chosen path.
- **`assertDistinctFromPrimary(worktreeRoot, primaryRoot)`** — throws if a worktree path is the
  primary checkout, the guard behind any removal.
- **`WorktreeFs` / `nodeWorktreeFs`** — the `exists` / `realpath` seam the remove gate reads the disk
  through.
- **`WorktreeGitError`** — thrown for a refused removal; its message is this CLI's own prose, safe to
  surface verbatim.

## Removing a worktree

### `removeWorktreeSafely(exec, ...)`

cyber-mux's own gates plus `git worktree remove`: it refuses the primary checkout (always) and
uncommitted changes unless `force`, and tolerates a path already gone. It is never delegated to a
backend, so a destructive operation's safety never depends on whether a workspace happened to be
open. The CLI's `worktree remove` goes through the library's `removeWorktree`, which also refuses a
leased worktree and one where a live agent session works.

## Binding a worktree to a workspace

The worktree-workspace capability — present on herdr and `undefined` on tmux, rmux, WezTerm, Zellij, cmux, and otty — is
the one part a *multiplexer* owns: binding a worktree to a workspace as a first-class record the UI
groups a repo's checkouts by. Empirically, plain `git worktree add` + `workspace create` yields **no**
binding; only routing through herdr's own `worktree create`/`open` produces it.

Reach it bound, off a resolved `MuxSession`, as `mux.worktree` (a `BoundWorktreeWorkspaceCapability`
— methods take `deps?` instead of a leading `exec`) — this is the preferred, ergonomic route:

```ts
const mux = resolveMux(process.env)
if (mux.worktree) {
  mux.worktree.createInWorkspace({ /* ... */ })
}
```

Or reach it raw, off the exec-first [`MuxAdapter`](/cyber-mux/api/mux-adapter/#the-raw-seam), as
`adapter.worktree` — the same capability, exec-first:

- **`createInWorkspace(opts, deps?)`** / **`createInWorkspace(exec, opts)`** — create a worktree *and*
  open it in a bound workspace.
- **`openInWorkspace(opts, deps?)`** / **`openInWorkspace(exec, opts)`** — open an existing worktree
  in a bound workspace (the remedy that groups a worktree plain git created earlier).
- **`bindings({ primaryRoot }, deps?)`** / **`bindings(exec, { primaryRoot })`** → `Map<path, workspace>`
  — which workspace each worktree is open in; the one fact git cannot answer.
- **`releaseWorkspace(workspace, opts?, deps?)`** / **`releaseWorkspace(exec, workspace, opts?)`** —
  close the workspace, releasing the binding **without** touching the checkout on disk. When the
  workspace is a *primary* one that still has worktree workspaces open on it, the close reaches the
  whole group: `opts.group` defaults to `true`, which herdr 0.9.0 spells `workspace close --group`
  (it cascaded implicitly through 0.8.2). Pass `{ group: false }` to release only the workspace named
  and leave its worktree workspaces up.

Every member here *opens* a workspace; none is a route for a bare worktree add — that is always plain
git. On tmux (`mux.worktree`/`adapter.worktree === undefined`) callers fall back to plain git plus a
placement-appropriate [`mux.open`](/cyber-mux/api/mux-adapter/#opening-panes).
