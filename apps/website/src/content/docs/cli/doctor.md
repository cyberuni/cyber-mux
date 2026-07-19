---
title: doctor
description: Probe the multiplexer, self pane, and resolved backend.
---

### `cyber-mux doctor`

Probe the multiplexer, your self pane, and the resolved backend. Prints the detected multiplexer,
how it was detected (`via`), the current pane id, the resolved backend name, and — when a self pane
was found — a ready-to-export `CYBER_MUX` / `CYBER_MUX_PANE` pair that pins the fast-path and skips
detection on the next run:

```
multiplexer: tmux
detected via: env
pane: %3
backend: tmux

Pin the fast-path to skip detection:
  export CYBER_MUX=tmux CYBER_MUX_PANE=%3
```

Never fails on "no multiplexer" — outside one, `backend` reads `none` rather than erroring.

Accepts `--format text|json|agent`. See [`mode`](/cyber-mux/cli/mode/) for the one-line version.

## Examples

```bash
cyber-mux doctor
```

```bash
# Pin the fast-path in your shell profile, skipping detection on every future run
eval "$(cyber-mux doctor | grep '^  export')"
```

```bash
# Machine-readable form
cyber-mux doctor --format json
# {"mux":"tmux","via":"env","pane":"%3","backend":"tmux"}
```
