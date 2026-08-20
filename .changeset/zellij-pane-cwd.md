---
"cyber-mux": patch
---

Report a zellij pane's working directory, verified against a live 0.44.3 binary

`LivePane.cwd` was never populated on zellij, so callers filtering a listing by directory got
nothing back from this backend. The adapter carried the claim that `list-panes --json` has no cwd
field at all on 0.44.3 — a probe conclusion drawn from a record that genuinely has none.

`pane_cwd` is real, and so is `pane_command` beside it. Both are present on a **terminal** pane's
record and omitted entirely on a **plugin** pane's, which is how a probe that sampled a plugin pane
read them as absent from the schema. A driven 0.44.3 session reports `pane_cwd` on every terminal
pane, and `listPanes` now fills `LivePane.cwd` from it — free, in the `list-panes --json` call the
listing already makes. A record with no directory to report still carries no `cwd`, rather than an
empty or invented one.

The label guard is unchanged: it reads `terminal_command`, which is null for a plain shell, and that
is the field it wants.
