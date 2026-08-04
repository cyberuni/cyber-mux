---
title: read
description: Capture a pane's output.
---

### `cyber-mux read <pane> [--lines <n>] [--omitted-rows]`

Capture a pane's output. `--lines <n>` scopes the capture to the trailing `n` lines; omit for the
backend's own default scrollback capture. A failed read captures nothing — the structured error is
the whole of stdout, never partial pane output followed by an error.

`--omitted-rows` also reports whether **the backend dropped older rows above the captured window**, so
a short pane can be told from a capture that hit its bound. It is opt-in because the answer costs the
backend one extra query, and it is never guessed: without the flag nothing is reported at all, rather
than a `false` that would really mean "nobody checked". Every backend answers it — herdr, tmux,
WezTerm and Zellij each ask for one row more than the window and compare what comes back.

It is **not** `--truncation`, and the distinction is worth keeping straight: `--full` suppresses the
truncation *this CLI* applies to a large body, and can restore every row it elided. `--omitted-rows`
reports rows the *multiplexer* never handed over — no flag brings those back, only a wider `--lines`
window (and only as far as the backend's own scrollback goes).

The answer is on **stdout in every format**, the stream an agent reads: a trailing `omitted-rows`
field after the capture in the default and `agent` formats, and a payload field under `--format json`
(`{"pane": "%3", "text": "…", "omittedRows": true}`) — easier to parse, never the only way to get it.
The capture itself is byte-identical either way.

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
cyber-mux read %3 --lines 20 --omitted-rows --format json
```

Waiting for something to appear is [`wait`](/cyber-mux/cli/wait/), not a `read` loop — it uses the
backend's native wait where there is one, and it tells a pane that went away from a pane that stayed
quiet:

```bash
cyber-mux wait logs --match 'ready' --lines 5
```
