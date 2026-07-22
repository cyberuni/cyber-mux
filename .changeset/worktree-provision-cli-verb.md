---
"cyber-mux": minor
---

Add the `cyber-mux worktree provision` CLI verb — the command-line surface over the
`provisionWorktree` seam. It reuses a free worktree (the set `worktree list` marks `(removable)` and
`prune` removes) or creates a fresh checkout at the sibling path, and reports whether it `reused` or
`created`, the worktree, and on reuse the recycled entry. Flags: `--branch` (required), `--base`,
`--path`, `--format`.

The verb uses the **default availability gate only** and offers no flag to inject a host predicate —
that is the deliberate surface divergence from the library seam, which takes an injectable one. A
host that must exclude, say, a live-session worktree calls `WorktreeApi.provision` directly.

The worktree spec is now split by public surface to make that divergence first-class: the
`cyber-mux worktree <verb>` surface (verbs, flag defaults, table rendering, and this new verb) is
specified under `cli/worktree/`, while the surface-independent library contract (the seam, git-owns-
facts, removal ordering, and the injectable predicate) stays in `mux/worktree/`.
