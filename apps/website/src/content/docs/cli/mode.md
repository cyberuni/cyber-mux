---
title: mode
description: Print just the detected backend name.
---

## `cyber-mux mode`

Print just the detected backend name: `tmux`, `rmux`, `herdr`, `wezterm`, `zellij`, `cmux`, `otty`,
or `none`. The one-line version of [`doctor`](/cyber-mux/cli/doctor/) for scripts that only need the
backend name.

`mode` reports the **drivable backend**, so a mux that is recognized but cannot be driven answers
`none`. GNU screen is the one such mux today: inside it, `mode` prints `none` while
[`doctor`](/cyber-mux/cli/doctor/) still names `screen` as the multiplexer it detected. Ask `doctor`
when you want to know what you are inside; ask `mode` when you want to know what can be driven.

**Usage**

```bash
cyber-mux mode
```

### Examples

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
