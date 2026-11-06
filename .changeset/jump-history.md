---
"cyber-mux": minor
---

Record jump history and add `cyber-mux focus --back`. Every focus, through the CLI or the library (`MuxAdapter.focus`, `resolveMux().focus`), records the target pane as entered from the pane the focus ran in. `focus --back` follows that link for the pane it runs in: the latest jump into a pane wins, back records nothing, closed panes are skipped, and links from an earlier run of the multiplexer server are ignored. The history lives in `~/.agents/cyber-mux/jumps.json` (or `$CYBER_MUX_STATE_DIR/jumps.json`). The library exports `focusBack`, `focusAndRecord`, `recordJump`, `withJumpHistory`, and the `JumpStore` file seam.
