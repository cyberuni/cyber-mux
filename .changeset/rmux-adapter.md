---
"cyber-mux": minor
---

Add an rmux backend

`cyber-mux` now drives [rmux](https://github.com/Helvesec/rmux), an async Rust reimplementation of
the tmux command language, alongside tmux, herdr, WezTerm, Zellij, cmux and otty. rmux runs natively
on Linux, macOS and Windows — it is the first backend that runs natively on Windows.

The adapter realizes the existing `MuxAdapter` contract plus `RegionInspector`, with no seam change:
placements, naming, workspace grouping, reads, waits, focus and region geometry all work, and
splits can be sized. Detection recognizes rmux through `$RMUX` and `$RMUX_PANE`, through an
`rmux-daemon` process ancestor, and through the explicit `CYBER_MUX=rmux` override.

One capability is genuinely absent: rmux has no floating panes. `new-pane` — the tmux 3.7 command
`--at pane:float` drives — is not part of rmux's command set, so a float is **refused by name**
(`FloatingPanesUnsupportedError`) rather than quietly substituted with a tiled split, exactly as
WezTerm, herdr, cmux and otty refuse it. Every other placement is available.

**If you use rmux and tmux on the same machine, detection order matters and is now handled.** An
rmux pane exports `$TMUX` and `$TMUX_PANE` as well as its own `$RMUX`/`$RMUX_PANE`, for tmux
compatibility, and rmux puts a `tmux` shim on `$PATH`. `cyber-mux` therefore asks the rmux question
first: a pane carrying both resolves to rmux. Nothing about tmux detection changes.

Verified against a live rmux 0.10.0 binary on Linux, including a real-boundary suite
(`pnpm --filter cyber-mux test:integration`) that drives the actual binary on a throwaway socket.
Not exercised on Windows or macOS — the native-Windows claim is about rmux's own portability, not
about a `cyber-mux` run anyone has observed there.
