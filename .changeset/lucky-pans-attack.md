---
'cyber-mux': minor
---

herdr: `worktree.releaseWorkspace` closes the whole worktree group again

herdr 0.9.0 put the cascade behind `workspace close --group`: a bare close of a PRIMARY workspace
that still has worktree workspaces open no longer errors, it just releases the primary and leaves
the group up. The adapter sent the bare verb, so the group silently stayed open.

`releaseWorkspace` now takes `opts?: { group?: boolean }`, defaulting to `true` — cascading is what
the verb has always done, and defaulting it off would narrow it for callers who never asked for a
change. Pass `{ group: false }` to release only the workspace named.

Pre-0.9.0 herdr rejects `--group` client-side, at argument parsing, without contacting the server, so
the adapter retries the bare verb there — which already cascades on those releases. The retry keys on
`Exec`'s `null` failure sentinel, so it works against every runner rather than only ones that report
a diagnostic reason.
