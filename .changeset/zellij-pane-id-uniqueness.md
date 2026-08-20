---
"cyber-mux": patch
---

Give zellij's plugin and terminal panes distinct ids in the live listing

A zellij pane number is unique only within a kind: zellij numbers plugin panes and terminal panes in
separate spaces, so a live 0.44.3 session reports `id: 0` for both its suppressed `zellij:link`
plugin pane and its first terminal pane. The adapter stringified that number as-is, so two genuinely
different panes were reported under one `LivePane.id` — an identity hazard for everything that
resolves by id, including the guard that catches an `open()` reporting a pane it never created.

The listing now qualifies a bare number with the kind `is_plugin` names, so those two panes are
reported as `plugin_0` and `terminal_0`. Both prefixed forms are what `zellij action --pane-id`
itself accepts, and `terminal_N` is already what `new-pane` prints, so a qualified id is directly
drivable. An id zellij already spelled out is passed through untouched.

**A zellij `LivePane.id` therefore reads `terminal_3` where it used to read `3`.** A bare number
still resolves — it addresses the terminal pane, on the backend and in this adapter alike — so ids
already held by a caller keep working.
