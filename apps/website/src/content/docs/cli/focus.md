---
title: focus
description: Beam the attached client to a pane.
---

## `cyber-mux focus`

Beam the attached client to a pane, across workspace and tab.

**Usage**

```bash
cyber-mux focus <pane>
```

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

### Examples

```bash
cyber-mux focus %3
```

```bash
# Jump to a labeled pane
cyber-mux focus logs
```
