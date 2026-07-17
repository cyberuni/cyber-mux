---
"cyber-mux": minor
---

`open` now reports the workspace the new pane landed in, so `open --layout --format json` stops emitting a manifest whose `workspace` is always `null` even on a backend that had just opened a real workspace.

The manifest is framed as the complete machine-readable answer to *"which panes exist and what are they for"*, but a consumer grouping panes by workspace had nothing to group on: `SessionAdapter.open` returned only a pane id, so nothing downstream had a workspace to report. Only the worktree capability surfaced one, which is why `worktree add --layout` got it right and `open --layout` did not.

`open` now returns an `OpenedPane` — the pane handle widened with an optional `workspace`. This is **additive**: the field is optional, so an implementor returning only a pane id still satisfies the seam. On herdr the answer costs no extra call, since every route (`workspace create`, `tab create`, `pane split`) already emits the pane's own `workspace_id` in the output the pane id is read from. A backend with no workspace tier reports it **absent** rather than a false "none" — the same convention `isPaneFocused`'s `undefined` follows — which is why it stays `null` on tmux, where `workspace` and `tab` both collapse to a Window.

**The reported workspace is occupancy, never a worktree binding.** It says which workspace a pane *lives in*; it does not say a worktree was *grouped* there. A worktree opened at a `pane:right` placement lives in the caller's workspace while bound to none, and the worktree report keeps answering that question separately and unchanged.
