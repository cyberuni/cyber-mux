---
title: close
description: Close a pane.
---

### `cyber-mux close <pane>`

Close a pane.

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

## Examples

```bash
cyber-mux close %3
```

```bash
# Close a labeled pane once its job is done
cyber-mux close logs
```
