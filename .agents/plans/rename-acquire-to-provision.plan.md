---
cr: rename-acquire-to-provision
target: packages/cyber-mux/.agents/spec/mux/worktree
kind: revise
todos:
  - content: FF branch to main so the acquire work is present
    status: done
  - content: Rename acquire -> provision across code, spec, suite, ADR, changeset (7 files)
    status: done
  - content: pnpm verify (build + typecheck + lint + test + biome)
    status: done
  - content: Commit + open PR
    status: done
---

## NEXT

Execute the case-preserving rename `acquire`->`provision` / `Acquire`->`Provision`
across the 7 files carrying the surface, then `pnpm verify`, then commit + PR.

## CR

Rename the worktree `acquire` operation to `provision`.

**Why.** `acquire` is resource-protocol vocabulary (acquire/release, hold-then-return).
The operation has no `release`, records no hold, and holds nothing exclusively — the
"claim" emerges only when a host binds a live session via the injected availability
predicate, outside this seam. Its true twin is `prune` (remove-vs-recycle disposal),
not a lock. `provision` ("make a worktree ready — reuse or create") promises no
exclusivity, needs no `release` counterpart, and covers both the reuse and create paths.

**Behavior:** unchanged. Pure terminology. The frozen `worktree.feature` scenario text
is rewritten (narrows nothing); re-open is ratified in-session by the user's request.

**Unreleased:** the acquire changeset is still pending (Version Packages #81 open), so
`acquire` never shipped to npm — `provision` replaces it, no deprecation.

**Surface (7 files):**
- `src/worktree.ts` — acquireWorktree, WorktreeAcquireAction, WorktreeAcquireResult, WorktreeApi.acquire, docs
- `src/worktree.test.ts` — test names + calls
- `src/published-surface.dist.test.ts` — exported name entry
- `.agents/spec/mux/worktree/README.md` — acquire prose
- `.agents/spec/mux/worktree/worktree.feature` — scenario titles + steps (@frozen)
- `.agents/spec/design/decisions/README.md` — `worktree-acquire` ADR entry
- `.changeset/worktree-acquire-reuse.md` — content (+ rename file to `worktree-provision-reuse.md`)

Unchanged: `recycleWorktree`, action values `'reused'`/`'created'`, `WorktreeCreateSpec`.
No `cli.ts` change — acquire is a library API only.
