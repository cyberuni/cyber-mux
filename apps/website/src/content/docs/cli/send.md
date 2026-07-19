---
title: send
description: Drive a pane's input without taking its turn.
---

### `cyber-mux send text <pane> <text>`

Type literal text into a pane, pressing no Enter — a word that happens to name a key (`Enter`,
`Up`) is typed as characters, never interpreted as that key.

### `cyber-mux send keys <pane> <keys...>`

Press named keys in a pane, in order, typing nothing. Portable core vocabulary: `Up Down Left Right
Enter Escape Tab Space Backspace C-c F1`–`F12`; anything outside the core is forwarded verbatim to
the backend. `send keys <pane> Enter` does press Enter and does take the pane's turn — because the
caller asked for it.

Bare `cyber-mux send` (no `text`/`keys` subcommand) is incomplete input: help on stdout, exit `2`.

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules. See [`submit`](/cyber-mux/cli/submit/) to take a pane's turn instead of just driving its
input.

## Examples

```bash
# Stage text without pressing Enter — the pane's own turn is not taken
cyber-mux send text %3 "git status"
```

```bash
# Stage text into a labeled pane instead of an id
cyber-mux send text logs "tail -f app.log"
```

```bash
# Interrupt a running process, then dismiss a prompt
cyber-mux send keys %3 C-c
cyber-mux send keys %3 Escape
```
