---
title: wait
description: Block until a pane's output matches, or the timeout elapses.
---

### `cyber-mux wait <pane> (--match <text> | --regex <pattern>) [--timeout <ms>] [--lines <n>]`

Block until the pane's output matches, then exit `0`. If the deadline passes first, exit `1` — the
verdict rides the exit code, so a shell caller branches on it without parsing anything.

Pass exactly one pattern. `--match <text>` is a **literal substring** and is the portable form: it
means the same on every backend. `--regex <pattern>` is matched by the backend's own engine (Rust's
`regex` on herdr, ECMAScript elsewhere), so the portable subset is what both accept — character
classes, quantifiers, alternation, anchors. Prefer `--match` whenever a literal will do.

`--timeout <ms>` defaults to `30000`. `--lines <n>` restricts the searched snapshot to the trailing
`n` lines, exactly as [`read --lines`](/cyber-mux/cli/read/) does.

The snapshot searched is the same one `read` returns, and it is searched **immediately** — output
already on screen when the command starts counts as a match, so a wait cannot lose a race to text
that arrived a moment early.

A timeout is a normal answer and still prints the pane's output, so a caller that guessed the wrong
pattern sees what the pane actually said. A pane that is **gone** is not a timeout: it fails with
`pane-not-found` rather than quietly waiting out the deadline. Neither is a wait that never ran — on
a herdr older than 0.7.5, which has no `pane wait-output`, the command fails loudly instead of
reporting an instant false timeout.

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

## Examples

```bash
# Wait for a harness to finish booting
cyber-mux wait %3 --match 'ready'
```

```bash
# Branch on the verdict
if cyber-mux wait logs --match 'listening on' --timeout 10000; then
  echo up
else
  echo still not up
fi
```

```bash
# A regex, scoped to the last 20 lines, as JSON
cyber-mux wait %3 --regex 'on [0-9]+' --lines 20 --format json
```
