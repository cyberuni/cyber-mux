---
title: exists
description: Probe whether a single pane is still live.
---

## `cyber-mux exists`

Probe whether a single pane is still live. Prints `live` or `gone`. Exits `0` when live, `1` when
gone — resolution runs before any output, so an ambiguous locator throws instead of printing either
word for a question that has no single pane to be about.

**Usage**

```bash
cyber-mux exists <pane>
```

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

### Examples

```bash
cyber-mux exists %3
# live
```

```bash
# Wait for a pane to close
while cyber-mux exists %3 > /dev/null; do sleep 1; done
```
