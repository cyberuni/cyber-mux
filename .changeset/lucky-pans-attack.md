---
'cyber-mux': minor
---

herdr: `worktree.releaseWorkspace` closes the whole worktree group again

herdr 0.9.0 put the cascade behind `workspace close --group`: a bare close of a PRIMARY workspace
that still has worktree workspaces open no longer errors, it just releases the primary and leaves
the group up. The adapter sent the bare verb, so the group silently stayed open.

`releaseWorkspace` now takes `opts?: { group?: boolean }`, defaulting to `true` — cascading is what
the verb has always done, and defaulting it off would narrow it for callers who never asked for a
change. Pass `{ group: false }` to release only the workspace named. On pre-0.9.0 herdr, which
rejects `--group` client-side with its usage line, the adapter retries the bare verb, which already
cascades there.
