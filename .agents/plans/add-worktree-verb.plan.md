---
todos:
  - content: Diff cyberlegion's worktree usage (paths.ts, decommission.ts) against cyber-mux/src/worktree.ts
    status: completed
  - content: Reconcile capability gaps into worktree.ts (default path convention, dirty-check safe remove)
    status: completed
  - content: Add `cyber-mux worktree add|remove` CLI verbs in cli.ts
    status: completed
  - content: Update mux/README.md + mux.feature to specify worktree as a real surface (drop non-goal note)
    status: completed
  - content: Tests + pnpm verify
    status: completed
  - content: Commit per AGENTS.md discipline
    status: pending
---

# add-worktree-verb

CR: expose `worktree.ts` (a provisional git-worktree adapter ported from cyberlegion) as a real,
specced `cyber-mux` CLI surface instead of a listed non-goal (`packages/cyber-mux/.agents/spec/mux/README.md:50-53`).

Target: `cyber-mux/mux` (`packages/cyber-mux`).

Source diff: cyberlegion's `src/console/worktree.ts` (add/remove/resolvePrimaryRoot/assertDistinctFromPrimary)
is already byte-for-byte what `cyber-mux/src/worktree.ts` carries — no gap at that file. The gap is in
what cyberlegion builds *around* it: `paths.ts`'s `resolveUnitWorktreePath` (default path convention —
sibling `<repo>.worktrees/legion-<id>`, never nested inside the primary tree) and `decommission.ts`'s
safe-removal flow (tolerate an already-gone worktree, refuse the primary checkout, dirty-check unless
`--force`, abort-and-leave-record-intact on a real removal failure).

Note: project spec is `status: draft`, no `@frozen` scenarios in `mux.feature` yet — plain additive
edit, no freeze re-open applies.

Plan: bring the default-path convention and the safe-remove (dirty-check + `--force`) behavior into
`cyber-mux/src/worktree.ts` (host-neutral — no legion/unit-registry concepts), add `worktree add
[--branch] [--path]` and `worktree remove [--force]` verbs to `cli.ts`, update `mux/README.md` +
`mux.feature` to document worktree as a specced use case, run `pnpm verify`.

## NEXT

Reconcile capability gaps into `packages/cyber-mux/src/worktree.ts`.
