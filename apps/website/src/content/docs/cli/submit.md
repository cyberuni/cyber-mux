---
title: submit
description: Take a pane's turn.
---

### `cyber-mux submit <pane> [text]`

Take a pane's turn: given `text`, types it literally then always presses Enter. Given no text (or
empty text), sends a bare Enter only — flushing an already-staged buffer without re-typing it, so a
repeated flush cannot duplicate the message. [`open --launch`](/cyber-mux/cli/open/) uses this verb
internally.

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

## Examples

```bash
# Type text and press Enter in one step
cyber-mux submit %3 "git status"
```

```bash
# Stage text first, then flush it with a bare Enter — the same effect, in two steps
cyber-mux send text %3 "git status"
cyber-mux submit %3
```
