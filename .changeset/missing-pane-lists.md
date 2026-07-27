---
"cyber-mux": minor
---

A missing `<pane>` on a pane verb now lists the live panes as candidates. It stays a usage error
(exit 2), but instead of merely naming the missing argument it queries the backend and reports each
live pane's id, label, and cwd under the new `missing-pane` code — the same rendering and code family
as `ambiguous-pane` — so the caller's next move (`cyber-mux list`) is folded into the error. This
covers `read`, `focus`, `close`, `submit`, `send text`, `send keys`, `exists`, and `agent status`.
With no multiplexer the deeper `no-mux` failure (exit 1) still surfaces first, and `agent wait` on a
backend without the agent-lifecycle capability is still refused with `backend-unsupported` (exit 1)
ahead of any missing-pane check.

`cyber-mux list` also gains a herdr-only agent-status column, shown only when the backend feeds a
per-pane agent state (omitted entirely on tmux, wezterm, and zellij).
