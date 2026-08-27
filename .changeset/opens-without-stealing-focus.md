---
'cyber-mux': minor
---

Declare `MuxAdapter.opensWithoutStealingFocus`, and make it true on tmux, herdr, and Zellij.

Opening a pane is not supposed to drag the user somewhere. Nothing on the seam said so, and three
routes did not honor it. `open()` now leaves the caller's focus where it found it on tmux, herdr, and
Zellij 0.45+, and every adapter declares which answer it gives.

**Behavior changes**

- **tmux** passes `-d` on `split-window` and `new-pane` as well as `new-window`. Previously a
  `pane:right`, `pane:down`, or `pane:float` open moved the attached client onto the new pane;
  `new-window -d` was the only route that did not. Measured on 3.7c.
- **herdr** passes `--no-focus` on `pane split` as well as `workspace create` and `tab create`. On
  0.8.2 the split already left focus alone, so this changes nothing observable — it is passed so the
  guarantee does not rest on a backend default.
- **Zellij** requires **0.45.0** (up from 0.44.1), the release that added `--no-focus`. A `tab` or
  `workspace` open, and a `pane:*` open naming no `from`, pass the flag. A `pane:*` open that names a
  `from` cannot: under `--no-focus` Zellij anchors the split on the pane the command was issued from
  rather than the focused one, so passing it would split the wrong pane. That path focuses the target,
  splits it, then focuses back to the pane that had focus. On an older Zellij the open fails loudly
  with Zellij's own unknown-argument error instead of silently stealing focus.

**New seam member**

`opensWithoutStealingFocus: boolean` is **required** on `MuxAdapter`, so a third-party adapter must
add it. It follows `canSizeSplits` — a declaration the caller reads, not a `MuxOpenOptions` flag —
but is required rather than optional because `undefined` here cannot be distinguished from an author
who never considered focus. `false` (WezTerm, cmux, otty) is a degrade, not a refusal: the open still
returns the pane you asked for, it just moves the user to it.

Zellij's `--no-focus` is **unverified against a running binary** — read out of the v0.45.0 source
tree, not driven, because no Zellij is available to this project's integration suite.
