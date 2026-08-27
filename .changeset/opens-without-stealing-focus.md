---
'cyber-mux': minor
---

Declare `MuxAdapter.opensWithoutStealingFocus`, and make it true on tmux, rmux, herdr, and Zellij.

Opening a pane is not supposed to drag the user somewhere. Nothing on the seam said so, and four
routes did not honor it. `open()` now leaves the caller's focus where it found it on tmux, rmux,
herdr, and Zellij 0.45+, and every adapter declares which answer it gives.

**Behavior changes**

- **tmux** passes `-d` on `split-window` and `new-pane` as well as `new-window`. Previously a
  `pane:right`, `pane:down`, or `pane:float` open moved the attached client onto the new pane;
  `new-window -d` was the only route that did not. Measured on 3.7c.
- **rmux** passes `-d` on `split-window` as well as `new-window`, the same hole tmux had and for the
  same reason — rmux reimplements tmux's command language. Verified live on 0.10.0, not inferred from
  the resemblance. It has no `new-pane`, so there is no float route to cover.
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

**Zellij users on 0.44.x must upgrade.** The adapter declared `≥ 0.44.1` and now declares `≥ 0.45.0`.
A `--no-focus` open on an older binary is an unknown-argument error, so it fails loudly and creates
nothing rather than mis-targeting a pane — the same way an old tmux answers `new-pane` with `unknown
command`. The adapter version-probes nothing, by design.

Zellij's `--no-focus` was written from the v0.45.0 source tree rather than a live binary, and is now
driven in CI against a real Zellij 0.45.0.
