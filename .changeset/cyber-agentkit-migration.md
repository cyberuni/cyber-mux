---
'cyber-mux': patch
---

Move the worktree library from `@cyberuni/agent-harness` to `cyber-agentkit` 1.0.0. `cyber-mux/worktree` re-exports the same symbols from `cyber-agentkit/worktrees`. The lease marker is now `cyber-agentkit`; release cyber-mux together with cyberlegion.
