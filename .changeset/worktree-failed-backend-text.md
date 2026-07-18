---
"cyber-mux": patch
---

`cyber-mux worktree add`/`open`/`list`/`remove` no longer leak the multiplexer's raw diagnostic on the
`worktree-failed` error. Previously, when opening or binding a worktree's pane failed on the backend
(tmux or herdr), the generic catch-all forwarded that failure's message verbatim — including the
backend's own name and its raw stderr — the one path AXI's "never leak a dependency's name or text"
rule didn't yet reach. This CLI's own worktree refusals (a dirty-checkout guard, a primary-checkout
guard) are unaffected and still report their own text as before; a genuine backend failure now reports
a generic, coded `worktree-failed` message, with the raw diagnostic written to stderr as a
non-load-bearing detail instead.
