---
"cyber-mux": patch
---

Fix two zellij `list-panes --json` field names, verified against a live 0.44.3 binary

The zellij adapter was built from a documentation probe, and two of the field names it read do not
exist in zellij's actual output. Driving the adapter against a real binary surfaced both.

- `pane_command` is really `terminal_command`. The adapter drops a pane's title when that title is
  just the running command zellij gave an unnamed pane — a guard that stops every shell pane from
  reporting the same manufactured `label`. Reading the wrong name meant the guard compared against
  `undefined` and never fired, so unnamed panes exported their own command line as an authored
  label. It now fires.
- `pane_cwd` does not exist; zellij's pane records carry no cwd field at all. `LivePane.cwd` was
  therefore never populated for zellij and the code that read it was dead. It is gone, so a zellij
  pane is honestly cwd-less rather than appearing to sometimes report one.
