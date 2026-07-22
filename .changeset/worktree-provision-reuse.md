---
"cyber-mux": minor
---

Add `worktree provision` — reuse a free worktree instead of always creating a fresh one. The twin of
`prune`: prune removes disposable worktrees, `provisionWorktree` / `WorktreeApi.provision` recycles one
through the same default gate (`isWorktreeRemovable`), else creates. Availability is an injected
predicate so a host can add its own "no live session bound" check without leaking that concept into
the worktree seam. A reused worktree is reset to a pristine tree on a fresh branch (`switch -c` →
`reset --hard` → `clean -fdx`). The result reports whether it reused or created, and carries the
recycled worktree in full.
