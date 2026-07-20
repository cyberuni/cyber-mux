---
'cyber-mux': minor
---

`cyber-mux template edit [<name>]` shows a template's panes and fills them in — the other half of
`template save`, which captures geometry but lands with no `command` on any pane.

The bare form **lists and mutates nothing**: a table of every pane with its position, label, dir and
current value, plus `help[N]` suggestions for what to do next. Its `pane` column is verbatim what
`--set` takes, so acting on the listing is a paste rather than a derivation. Panes are addressed by
ordinal (`3`, or `2.3` for tab 2 pane 3) and never by label, since two panes may share a label by
design. A `position` (`top-left`, `right`) is shown because apply order is a tree walk rather than a
reading order — pane 2 of a 2x2 is the pane below pane 1, not the one beside it.

`--set <pane>=<value>` writes without a terminal, is repeatable, splits on the first `=` only so a
value may contain one, and clears the field when the value is empty. Re-running the same `--set` is a
no-op that exits 0 and leaves the file's mtime alone, so a checked-in template is never dirtied by an
edit that changes nothing. A batch naming one pane that does not exist writes none of them, and the
error lists every identifier that would have worked.

`--interactive` asks one question per pane instead, in apply order, with the current value pre-filled
into the editable line: Enter keeps, `-` clears, `'-'` is a literal dash, Ctrl-D abandons the edit and
leaves the file untouched. It refuses when stdin is not a tty or when `--format json|agent` was asked
for, and points at `--set` instead.

`--field command|label` picks what both modes write; `--dry-run` prints the result instead of writing
it. A template's spelling survives either way — one written with the flat `panes`/`arrange` sugar
comes back out flat rather than re-spelled as a tree.
