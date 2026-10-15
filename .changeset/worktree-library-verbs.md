---
'cyber-mux': minor
---

**Breaking:** the `worktree` verbs and `cyber-mux/worktree` now run on `@cyberuni/agent-harness` 0.7.0's async worktree library, and the deprecated synchronous helpers are gone.

Removed from `cyber-mux/worktree`: `listWorktreesFromGit`, `isWorktreeRemovable`, `resolveWorktreePath`, `provisionWorktree`, the synchronous `pruneWorktrees` / `normalizeWorktreePath` / `ghForgeMergedProbe`, their types (`WorktreeMergedSignal`, `WorktreeSignalOptions`, `WorktreePruneSkip`, `WorktreePruneResult`, `WorktreeCreateSpec`, `WorktreeProvisionAction`, `WorktreeProvisionResult`), and the `list`, `prune`, `provision`, and `normalizePath` methods of `worktreeApi()`. `RemoveWorktreeOptions` (the `removeSafely` options) is renamed `RemoveWorktreeSafelyOptions`.

The library's own `pruneWorktrees`, `normalizeWorktreePath`, `ghForgeMergedProbe`, `removeWorktree`, `RemoveWorktreeOptions`, `WorktreeEntry`, `ForgeMergedProbe`, and `WorktreeCreatorUndo` are now re-exported under those names. Use `listWorktrees`, `pruneWorktrees`, `explain`, or `acquire` + `release` in place of the removed helpers, with `toHarnessExec(exec)` to drive them through a cyber-mux `Exec`. `resolvePrimaryRoot`, `gitWorktreeAdapter`, `removeWorktreeSafely`, and `assertDistinctFromPrimary` stay synchronous.

CLI changes:

- `worktree add` without `--path` checks out at the next free slot, `<repo>.worktrees/<repo>-<n>`, instead of `<repo>.worktrees/<branch>`.
- `worktree provision` runs the library's `acquire` and gives the lease straight back. It drops `--path`, and on reuse it reports the prior branch but no longer the workspace.
- `worktree remove` also refuses a worktree the library has leased, or one a live agent session works in, even with `--force`. A bound workspace now closes after git removes the checkout, so a refused removal keeps it open.
- `worktree prune` removes only the library's own slot worktrees that are unleased, idle, clean, and landed. Other worktrees, including ones at the older `<repo>.worktrees/<branch>` path, are skipped. A worktree open in a workspace is skipped too. `worktree list` marks `(removable)` on exactly the worktrees prune would remove.
- `worktree list --format json` entries carry the library's `head`, `detached`, and `locked` fields.
