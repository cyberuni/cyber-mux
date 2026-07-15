---
"cyber-mux": minor
---

Route worktree creation through the multiplexer that binds worktrees to workspaces, so a worktree is **grouped with its repo** where the backend supports it. herdr binds a worktree to a workspace as a first-class record — the binding its UI groups a repo's primary checkout and its worktrees by — and only its own `worktree create`/`worktree open` produce one: `git worktree add` followed by `workspace create --cwd <checkout>` yields a workspace herdr does not know is a worktree at all. tmux has no workspace tier and binds nothing, so callers fall back to plain git plus a normal `open` — same command, both backends.

`cyber-mux worktree add` takes `--at`, `--launch`, and `--base`. With neither `--at` nor `--launch` it is unchanged: plain git, no backend resolved, works outside any multiplexer (nothing is opened, so nothing can be grouped). `--launch` implies `--at workspace`, the only placement a binding can attach to. A placement that cannot carry a binding degrades rather than failing — a worktree in a split pane is a complete outcome — reported as `workspace: null` plus a note on stderr, so `--format json` stays clean.

New `cyber-mux worktree open <path>` groups a checkout that plain git created earlier, making "add now, group later" a real story. New `cyber-mux worktree list` reports every worktree of the repo and the workspace each is open in; its path/branch/linked/prunable always come from git on every backend, so two backends can never disagree about the same worktree. `worktree list` and `worktree remove` now answer outside a multiplexer.

`cyber-mux worktree remove` releases a bound workspace instead of orphaning it, with the gates unchanged and identical on every backend: the checks run *before* the workspace is released (a refused removal has no side effect) and the release runs *before* git removes the checkout (no workspace left on a dead directory).
