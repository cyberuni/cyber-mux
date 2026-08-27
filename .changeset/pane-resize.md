---
'cyber-mux': minor
---

Add `RegionInspector.resizePane` — a pane's size can now be changed after birth, not only chosen at
it. `resizePane(exec, target, ratio)` takes the same fraction-of-the-split-region
`MuxOpenOptions.ratio` takes, so a caller that opened a split at a ratio restores it with the same
number.

Implemented on tmux, rmux and herdr, and verified against live binaries (tmux 3.7c, rmux 0.10.0,
herdr 0.8.2). It rides the existing optional `regions` capability rather than a new `canResizePanes`
declaration, because a ratio is not a primitive any backend has: every one of them needs the region's
current geometry to turn it into its own resize argument, which is exactly what `regions` reports —
so a backend that reports rects answers the member for free. wezterm, zellij, cmux and otty do not
report geometry and so refuse by name with the new `PaneResizeUnsupportedError`, raised by the new
`derivePaneResize` orchestrator.
