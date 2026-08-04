---
title: read
description: Capture a pane's output.
---

### `cyber-mux read <pane> [--lines <n>] [--truncation]`

Capture a pane's output. `--lines <n>` scopes the capture to the trailing `n` lines; omit for the
backend's own default scrollback capture. A failed read captures nothing — the structured error is
the whole of stdout, never partial pane output followed by an error.

`--truncation` also reports whether **older rows above the captured window were dropped**, so a short
pane can be told from a capture that hit its bound. It is opt-in because the answer costs the backend
one extra query, and it is never guessed: without the flag nothing is reported at all, rather than a
`truncated: false` that would really mean "nobody checked". Every backend answers it — herdr, tmux,
WezTerm and Zellij each ask for one row more than the window and compare what comes back.

The capture stays the whole of stdout, so the annotation never lands in what you piped the output
into: in the default text format the answer goes to **stderr**, and with `--format json` it rides the
payload (`{"pane": "%3", "text": "…", "truncated": true}`) — the form to reach for from a script.

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

```bash
# Did that window drop anything above it?
cyber-mux read %3 --lines 20 --truncation --format json
```

Waiting for something to appear is [`wait`](/cyber-mux/cli/wait/), not a `read` loop — it uses the
backend's native wait where there is one, and it tells a pane that went away from a pane that stayed
quiet:

```bash
cyber-mux wait logs --match 'ready' --lines 5
```
