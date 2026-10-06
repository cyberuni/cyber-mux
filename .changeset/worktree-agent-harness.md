---
"cyber-mux": minor
---

`cyber-mux/worktree` now re-exports the leased worktree pool from `@cyberuni/agent-harness/worktrees` (`acquire`, `release`, `explain`, `primaryRoot`, `listWorktrees`, `slotPath`, and the rest) and adds `muxWorktreeCreator`, the library's injectable creator that binds a new worktree to a herdr workspace, plus `toHarnessExec` to drive the library with cyber-mux's `Exec`. The synchronous helpers the library replaces (`resolvePrimaryRoot`, `listWorktreesFromGit`, `isWorktreeRemovable`, `resolveWorktreePath`, `pruneWorktrees`, `provisionWorktree`, `ghForgeMergedProbe`, `normalizeWorktreePath`) are deprecated; they keep working unchanged.
