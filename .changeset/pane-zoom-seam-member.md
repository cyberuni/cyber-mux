---
'cyber-mux': minor
---

Add pane zoom to the `MuxAdapter` seam — `setPaneZoom(exec, target, zoomed)` and
`isPaneZoomed(exec, target)`. A zoomed pane fills its region while its siblings stay open behind it,
which every backend but one can do and none of them could be asked to do before.

This is **not** `focus()`. Focus moves the client; zoom makes the pane big. A caller that has just
opened a worker pane and wants a human to actually read it needs the second, and only the first was
expressible.

- **Absolute, never a toggle**, for `resizePane`'s reason: a blind toggle can be asked for "big" and
  deliver "small", which is unusable by an agent. A caller that wants the toggle writes
  `setPaneZoom(e, t, !isPaneZoomed(e, t))`.
- **Asking for the state a pane is already in touches the backend at all.** That is contract, not an
  optimization: two backends spell zoom at the tab tier, where an unguarded write acts on a pane the
  caller never named — `herdr pane zoom <p3> --off` unzooms whichever sibling was zoomed, and tmux's
  `resize-pane -Z` on a window zoomed elsewhere just unzooms it.
- **Zooming moves focus to the pane** on every backend that has the verb. Declared rather than
  compensated: undoing it would be a second visible focus move. Unzooming moves nothing.
- **Real on five of seven backends**, each driven against a live binary: tmux 3.7c and rmux 0.10.0
  (`resize-pane -Z`), herdr 0.8.0/0.9.0 (`pane zoom --on|--off`), zellij 0.45.0 (`action
  toggle-fullscreen`), and wezterm 20240203 (`cli zoom-pane --zoom|--unzoom`, the only natively
  absolute one).
- **cmux and otty refuse BY NAME** with `PaneZoomUnsupportedError` rather than emulating: cmux has no
  pane-zoom verb at any programmable layer (its tmux-compat `resize-pane -Z` parses, does nothing and
  exits 0), and otty's documented `pane zoom` names no flags and reports no state, so an absolute set
  cannot be rendered. `canZoomPanes` is the pre-flight declaration, `canFloatPanes`'s exact shape.
- `isPaneZoomed` answers `undefined` — never `false` — on those two: cmux binds pane zoom to a GUI
  keystroke, so a `false` would be a lie about a pane the user zoomed by hand.

New exports on the `.` entry: `PaneZoomUnsupportedError`, `refusePaneZoom`, `canZoomPanes`.
`MuxAdapter` gains two required members, so an out-of-tree adapter must implement them.
