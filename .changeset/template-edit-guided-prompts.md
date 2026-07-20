---
'cyber-mux': minor
---

`cyber-mux template edit [<name>]` fills a template in pane by pane, asking one prompt per pane —
the other half of `template save`, which captures geometry but lands with no `command` on any pane.
Panes are walked in apply order (the order the manifest reports and commands submit in), and a
`tabs` template is grouped by tab with the ordinal restarting in each.

The current value is pre-filled into the editable line, so a small change is an edit rather than a
retype. Enter keeps, `-` clears, `'-'` is a literal dash. `--field command|label` picks what to ask
about; `--dry-run` prints the result instead of writing it.

Nothing is written until every pane is answered and the result validates, so Ctrl-D abandons the
edit and leaves the file untouched. A walk where every pane was kept writes nothing at all, so a
no-op edit never dirties a checked-in template. A template's spelling survives: one written with the
flat `panes`/`arrange` sugar comes back out flat rather than re-spelled as a tree.

Refuses with `not-interactive` (exit 2) when stdin is not a tty, rather than blocking on a pipe.
