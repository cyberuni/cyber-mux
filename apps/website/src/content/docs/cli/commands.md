---
title: Commands
description: The cyber-mux verb surface.
---

:::note
The verb surface below is **provisional** — the behavior spec is the next milestone and may rename
verbs or adjust flags.
:::

Every command runs against the multiplexer the current process is inside (resolved by
[detection](/cyber-mux/concepts/detection/)). Commands that produce data accept `--format
text|json|agent`.

## Diagnostics

### `cyber-mux doctor`

Probe the multiplexer, your self pane, and the resolved backend; print a `CYBER_MUX` /
`CYBER_MUX_PANE` fast-path pin.

### `cyber-mux mode`

Print just the detected backend name: `tmux`, `herdr`, or `none`.

## Driving panes

### `cyber-mux open --launch <cmd> [--cwd <path>] [--at <placement>]`

Open a new pane and launch a command in it. `--at` is one of `pane:right`, `pane:down`, `tab`
(default), or `workspace`. Prints the new pane id.

### `cyber-mux send <pane> <text>`

Type text into a pane and submit it.

### `cyber-mux submit <pane>`

Flush a pane's already-staged buffer with a bare Enter — never re-types.

### `cyber-mux read <pane> [--lines <n>]`

Capture a pane's output, optionally scoped to the last `n` lines.

### `cyber-mux focus <pane>`

Beam the attached client to a pane, across workspace and tab.

### `cyber-mux close <pane>`

Close a pane.

## Inspecting panes

### `cyber-mux list`

Enumerate every live pane the current backend can see.

### `cyber-mux exists <pane>`

Probe whether a single pane is still live. Exits `0` when live, `1` when gone.
