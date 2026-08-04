---
title: read
description: Capture a pane's output.
---

### `cyber-mux read <pane> [--lines <n>]`

Capture a pane's output. `--lines <n>` scopes the capture to the trailing `n` lines; omit for the
backend's own default scrollback capture. A failed read captures nothing — the structured error is
the whole of stdout, never partial pane output followed by an error.

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

## Examples

```bash
cyber-mux read %3
```

```bash
# Just the trailing 20 lines
cyber-mux read %3 --lines 20
```

Waiting for something to appear is [`wait`](/cyber-mux/cli/wait/), not a `read` loop — it uses the
backend's native wait where there is one, and it tells a pane that went away from a pane that stayed
quiet:

```bash
cyber-mux wait logs --match 'ready' --lines 5
```
