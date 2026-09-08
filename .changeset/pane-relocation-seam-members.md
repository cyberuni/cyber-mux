---
'cyber-mux': minor
---

Add pane relocation to the `MuxAdapter` seam — `movePane(exec, target, destination, side)` and
`breakPane(exec, target, at)`. Until now every pane cyber-mux opened stayed where it was born: the
seam could create, read, name, resize, focus, zoom and close a pane, and never move one.

`movePane` puts a live pane beside another one — the destination is a PANE plus a side
(`'right' | 'down'`), never a tab or a workspace, because that is the only destination the capable
backends can all name exactly. `breakPane` promotes a pane into its own tab or its own workspace.
Both keep the pane's process and scrollback; neither opens or tears anything down.

Both return `OpenedPane` rather than `void`, and that is load-bearing: herdr pane ids are
workspace-scoped, so a relocation across that boundary rewrites the id and the old one drops out of
`pane list`. The return is the pane's new identity plus the tab and workspace it now lives in.

Real on tmux, rmux, herdr and wezterm, each driven live. Refused BY NAME elsewhere:
`PaneMoveUnsupportedError` / `PaneBreakUnsupportedError`, never an emulation. zellij and otty refuse
both; cmux refuses the move and declares the break-out. `canMovePanes` and `canBreakPanes` are how a
caller asks before relocating — two flags rather than one, because cmux has exactly one of the two
capabilities.

New exports on the `.` entry: `PaneMoveUnsupportedError`, `PaneBreakUnsupportedError`,
`refusePaneMove`, `refusePaneBreak`, `canMovePanes`, `canBreakPanes`, plus the `MuxMoveSide` and
`MuxBreakTier` types. `MuxAdapter` gains two required members, so an out-of-tree adapter must
implement them.
