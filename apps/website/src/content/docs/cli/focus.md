---
title: focus
description: Beam the attached client to a pane, or back to the pane it was jumped into from.
---

## `cyber-mux focus`

Beam the attached client to a pane, across workspace and tab. Every focus records where it came
from, so `cyber-mux focus --back` can return along it.

**Usage**

```bash
cyber-mux focus <pane>
cyber-mux focus --back
```

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

### Jump history

Each focus records **target ← source**: the target pane was entered from the pane the command ran
in. The library API records the same way, so a focus made through `MuxAdapter.focus` or
`resolveMux().focus` also counts.

The history maps each pane to the pane it was entered from. It is not a stack ordered by time, so
moving between panes by hand does not change what back does in any other pane.

`cyber-mux focus --back` follows the link for the pane it runs in:

- The latest jump into a pane replaces the one before it. After A→B and then C→B, back in B goes
  to C, and A is no longer reachable from B.
- Back records nothing. After A→B and back to A, back in A goes to A's own origin, not to B.
- A jump from a pane to itself records nothing.
- A closed pane is skipped: after A→B→C with B closed, back in C goes to A. Back fails when every
  pane up the chain is gone.
- Back in a pane with no jump into it fails with `no-jump`. The hint names the origin of the last
  jump.
- History is kept per backend and server. After the multiplexer restarts and reuses pane ids, links
  from the old server are ignored.
- Two terminals attached to one session share one history: the latest entry wins.

The history lives in `~/.agents/cyber-mux/jumps.json`, or in `$CYBER_MUX_STATE_DIR/jumps.json` when
that variable is set. It is written atomically, and links to panes that no longer exist are removed
when back reads it.

### Examples

```bash
cyber-mux focus %3
```

```bash
# Jump to a labeled pane
cyber-mux focus logs
```

```bash
# Return to the pane this one was jumped into from
cyber-mux focus --back
```
