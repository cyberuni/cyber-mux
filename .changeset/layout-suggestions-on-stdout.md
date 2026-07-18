---
"cyber-mux": minor
---

The two contextual-disclosure suggestions (AXI #9) now ride on **stdout** inside the structured payload as a `help[N]:` block, not on stderr.

**What moved.** Two "here is your next move" notes were written to stderr, the stream AXI defines as the one an agent does not read — so scope information an agent must act on was landing where it never sees it:

- `layout save` in a multi-tab workspace, when a bare save captured only the caller's own region, noted the tabs it left out.
- `worktree add`/`open`, when the chosen placement cost the workspace grouping, named the flag (`--at workspace`) that would have grouped it.

Both now ride in the command's own stdout payload as a `help[N]:` block — a message line and the concrete command that acts on it (`{ message, command }`) — emitted only when there is a next move (AXI #9's omit-when-self-contained rule).

**Breaking: `layout save`'s stdout is now a structured payload, not a bare path.** Its text output is a `path` field (plus the help block when a bare save left tabs behind), and `layout save` gained `--format json`, which emits `{ "path": ..., "help": [...] }`. Programmatic composition that read the bare path from `$(cyber-mux layout save x)` must move to:

```
cyber-mux layout save x --format json | jq -r .path
```

`worktree add`/`open` gain a `help` field on their `--format json` object only when a grouping was lost; the bare, non-degraded shape is unchanged.
