---
"cyber-mux": minor
---

Add cmux backend adapter

cmux is a Ghostty-based macOS terminal built for AI coding agents. This adds detection (`$CMUX_WORKSPACE_ID`) and a full `MuxAdapter` implementation using cmux's CLI (`cmux new-pane`, `cmux send`, etc.).

- Detection via `$CMUX_WORKSPACE_ID` env variable
- Pane identity via `$CMUX_SURFACE_ID` (cmux's "surface" is the terminal unit)
- Supports workspace, tab (surface), and pane:right/pane:down placements
- Supports split sizing via `--size` flag
- No `--env` flag support (env compensation via command prefix)
- No geometry/regions support (cmux CLI doesn't report positions)
- macOS-only (cmux is a native Swift/AppKit app)
