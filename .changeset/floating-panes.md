---
'cyber-mux': minor
---

Add a `pane:float` placement — a pane that sits above the tiled layout instead of taking a share of
it, so nothing else is resized.

- `MuxPlacement` gains `'pane:float'`, and `--at pane:float` gains the matching CLI choice. A
  floating pane is an ordinary `OpenedPane` with a real id, so `read`/`sendText`/`submit`/
  `waitForOutput`/`teardown` drive it unchanged.
- **tmux** (≥ 3.7, `new-pane`) and **zellij** (`new-pane --floating`) open a real one.
- **wezterm** and **herdr** have no floating-pane concept and **refuse by name** — a new
  `FloatingPanesUnsupportedError` from `open`, surfaced by the CLI as `backend-unsupported` (exit 1)
  — rather than quietly substituting a tiled split, which would resize the region's other panes.
  `MuxAdapter.canFloatPanes` (with the `canFloatPanes(adapter)` helper) is how a caller asks before
  opening; the refusal is raised before any backend command, so a refused float opens nothing.
- `ratio` is dropped on a float on every backend, tmux included: a float takes no share of the
  region, so there is no original pane whose fraction it could be.
