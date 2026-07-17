---
"cyber-mux": minor
---

Address a pane by name or by id. Every pane-taking verb — `read`, `submit`, `exists`, `focus`,
`close`, `send text`, `send keys`, and `layout save --from` — now accepts a pane's label wherever it
took an id, so a caller holding a layout manifest's `(label, pane)` pairs can address "the `worker`
pane" without doing the lookup itself.

An id still wins. A string is taken as an id when a live pane carries that id, and resolved as a name
only otherwise — so every existing id-based call keeps working and cannot be made to mean something
else by someone renaming an unrelated pane. An id is recognized by matching a live pane rather than by
the shape of the string, so a pane labeled `%9` is still reachable by that name.

A label is a human name, not a key, and nothing requires one to be unique. So a name matching two or
more live panes **fails rather than guessing**, reporting each candidate's id, label and working
directory — every id directly usable as the retry — as a structured `ambiguous-pane` error on stdout,
honoring `--format`. A name matching nothing is the existing not-found path.

**`cyber-mux exists` gains a third exit code.** `0` still means one match and `1` still means none,
but `2` now means the locator matched two or more panes — there is no single pane the question is
about. Exit `2` means ambiguous on every pane verb. Nothing that exits `0` or `1` today changes: a
name could not be passed at all before this release, so exit `2` is only reachable through the new
capability.

**`cyber-mux list` replaces its `mux` column with `label`.** The label is what you now type instead of
an id, so it is the fact that row exists to carry; `mux` was constant on every row by construction —
one adapter is selected per session — so the column discriminated nothing. `cyber-mux doctor` is where
the backend is a live question, and it still reports it.
