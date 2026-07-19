---
"cyber-mux": minor
---

Add `--env KEY=VALUE` (repeatable) to every verb that opens a pane — `open`, `worktree add`, and `worktree open`. The seam and both adapters already set env natively at every tier; this gives it a CLI door, so a caller no longer has to reach for a template to set an environment variable in the pane they open.

- `--env` splits on the **first** `=`, so a value may contain `=` (`URL=k=v`); a trailing `=` sets an empty value (`ROLE=`); a pair with no `=` is rejected **before** anything opens, so a typo never leaves a half-created worktree behind.
- On `worktree add`, `--env` implies `--at workspace` for the same reason `--launch` does — asking for something in a pane is asking for the pane. It conflicts with `--template`, whose template owns its own panes' env.
- On the one route that cannot set env at birth — herdr's `worktree create`/`worktree open`, which take no env parameter — env rides in as an `env KEY=VALUE` prefix on the launch command, and when there is no command to carry it the drop is reported on stderr rather than passing in silence.
