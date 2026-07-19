---
title: list
description: Enumerate every live pane the current backend can see.
---

### `cyber-mux list`

Enumerate every live pane the current backend can see. Table columns: `pane` (id), `label`,
`harness` (e.g. the tool running in it, when the backend reports one), `cwd`.

## Examples

```bash
cyber-mux list
```

```bash
# Pane ids only, for piping into another command
cyber-mux list --format json | jq -r '.panes[].id'
```
