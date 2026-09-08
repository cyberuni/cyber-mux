---
'cyber-mux': patch
---

zellij: complete a `zellij action` that its own pre-flight dropped, and confirm a focus landed before
anything is built on it

`zellij action` resolves the session list before it honors `--session`, probing every socket and
requiring a `ConnStatus` reply; against a busy server that probe loses a live session, and the command
exits 1 with `There is no active session!` — or exits 0 printing nothing — having done nothing at all.
Measured on a live 0.45.0 under CPU contention: 2 bad answers in 600 `list-clients` calls, both
correct on an immediate re-ask.

Three real consequences are fixed. `open({ from })` no longer skips its focus restore when the
`list-clients` read behind it came back empty — a lost answer used to read as "no client is attached",
which left the caller's client on the pane the open had just created. `setPaneZoom` now confirms the
client actually reached the pane before toggling fullscreen, because `toggle-fullscreen -p <id>` on a
pane the client is not on, in a tab that already has a fullscreen pane, leaves fullscreen and reports
success. And a `rename`, `focus`, `teardown`, `send` or `read` that never reached the server is
re-issued rather than silently lost.

`new-pane` and `new-tab` are deliberately unchanged: they create, so they keep failing loudly by name
rather than risking a stray pane.
