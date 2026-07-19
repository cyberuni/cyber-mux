---
title: mode
description: Print just the detected backend name.
---

### `cyber-mux mode`

Print just the detected backend name: `tmux`, `herdr`, `wezterm` (alpha), or `none`. The one-line
version of [`doctor`](/cyber-mux/cli/doctor/) for scripts that only need the backend name.

## Examples

```bash
cyber-mux mode
# tmux
```

```bash
# Branch a script on the backend
if [ "$(cyber-mux mode)" = "none" ]; then
  echo "not inside a multiplexer"
fi
```
