---
title: Detection
description: How cyber-mux figures out which multiplexer it is running under.
---

Before it can drive a pane, `cyber-mux` has to know **which multiplexer it is inside**. Detection is
two-mode.

## 1. Fast-path / override

If `CYBER_MUX` is set to a known value (`tmux`, `herdr`, `screen`, or `none`), it is trusted
outright. `CYBER_MUX_PANE` carries the pane id alongside it.

This also acts as an **override**: `CYBER_MUX=none` forces no-mux behavior even inside a real
multiplexer.

```bash
export CYBER_MUX=tmux CYBER_MUX_PANE=%3
```

`cyber-mux doctor` prints exactly this line for your current pane, so you can pin it and skip
discovery.

## 2. Ancestry discovery

With no fast-path set, `cyber-mux` walks the process ancestry from its own PID (`ps -o ppid=,comm=`),
looking for a `tmux`, `herdr`, or `screen` ancestor. It walks *past* the tool's own shell — the
immediate parent is often not the human's pane.

If the walk is inconclusive (e.g. `ps` is unavailable), it falls back to the `$TMUX` / `$HERDR_ENV`
environment hints. These hints are **never trusted alone** — an ancestry-verified multiplexer always
wins over a stale env hint.

## Self pane

`cyber-mux` resolves *its own* pane from environment alone (no `ps` walk): the `CYBER_MUX_PANE`
fast-path, then `$TMUX_PANE` (tmux), then `$HERDR_PANE_ID` (herdr). This is the identity key a
session uses to address itself.
