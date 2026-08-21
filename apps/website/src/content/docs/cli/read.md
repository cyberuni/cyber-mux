---
title: read
description: Capture a pane's output.
---

## `cyber-mux read`

Capture a pane's output. A failed read captures nothing — the structured error is the whole of stdout,
never partial pane output followed by an error.

**Usage**

```bash
cyber-mux read <pane> [--lines <n> | --full]
```

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

### The read window

Every capture is bounded, so `read` has one knob for how much of the pane it takes and one escape
hatch for taking all of it:

| | what it captures |
| --- | --- |
| *(default)* | the backend's own window — the visible viewport |
| `--lines <n>` | the trailing `n` lines |
| `--full` | the pane's whole scrollback, however long |

`--lines` and `--full` are mutually exclusive; passing both is a usage error (exit 2) rather than one
silently winning.

**`read` always reports whether that window left rows behind.** When it did, the capture is followed
by a `truncated` field and a `help:` entry naming `--full` as the fix:

```
$ cyber-mux read %3 --lines 20
… the 20 rows …
truncated  true
help[0]: older rows sit above this capture
  -> cyber-mux read %3 --full
```

A complete capture is the pane's raw bytes and nothing else, so `read | grep` is unchanged in the
ordinary case. That silence is not a guess: the check runs on every read, so no hint means *asked, and
nothing was omitted*. `--format json` spells it either way —
`{"pane": "%3", "text": "…", "truncated": false}` — and never puts it on stderr, which agents do not
read.

`--full` costs nothing extra to report: an unbounded window omitted nothing by construction. What it
cannot recover is scrollback the multiplexer itself dropped long ago — "everything the backend holds"
is the ceiling of the honest answer.

### Examples

```bash
cyber-mux read %3
```

```bash
# Just the trailing 20 lines
cyber-mux read %3 --lines 20
```

```bash
# Everything the pane still holds
cyber-mux read %3 --full
```

Waiting for something to appear is [`wait`](/cyber-mux/cli/wait/), not a `read` loop — it uses the
backend's native wait where there is one, and it tells a pane that went away from a pane that stayed
quiet:

```bash
cyber-mux wait logs --match 'ready' --lines 5
```
