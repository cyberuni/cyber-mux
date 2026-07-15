---
"cyber-mux": minor
---

Add `cyber-mux worktree add` and `cyber-mux worktree remove` — plain `git worktree` helpers ported from cyberlegion. `add` defaults the checkout path to a sibling of the primary checkout (`<parent>/<repo>.worktrees/<branch>`), never nested inside the primary's own working tree; `--path` overrides it. `remove` refuses the primary checkout (even with `--force`), tolerates a worktree already gone from disk, and refuses to discard uncommitted changes unless `--force` is passed.
