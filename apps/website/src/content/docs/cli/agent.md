---
title: agent
description: Inspect and wait on a pane's agent-lifecycle state.
---

## `cyber-mux agent`

Reach the agent-lifecycle capability: what the agent in a pane is doing, and blocking until it
reaches a state you name.

The two halves have deliberately different failure behavior. `agent status` is a **snapshot that
degrades** — it answers on every backend, reporting no status where there is no feed. `agent wait`
is a **drive that refuses** — a wait has no truthful degrade, so a backend with no native
agent-state wait is named and rejected rather than emulated by polling.

| Subcommand | Backends that answer | Everywhere else |
| --- | --- | --- |
| `agent status` | herdr | resolves the pane, reports no status |
| `agent wait` | herdr, otty | `backend-unsupported`, exit 1 |

The states are `idle`, `working`, `blocked`, `done`, and `unknown`.

## `agent status`

**Usage**

```bash
cyber-mux agent status [<pane>] [--format <text|json|agent>]
```

Print the pane's agent-lifecycle status. herdr is the one backend with a per-pane agent-state feed;
elsewhere the status is absent, and the command still resolves the pane and answers rather than
failing. A backend that cannot say what the agent is doing can still say which pane this is, and
withholding the second fact because of the first would be the wrong trade.

`--format json` always carries the key, `null` when there is no feed:

```json
{ "pane": "w3A:p1", "agentStatus": "working" }
```

## `agent wait`

**Usage**

```bash
cyber-mux agent wait [<pane>] [--until <status...>] [--timeout <ms>] \
  [--format <text|json|agent>]
```

Block until the pane's agent reaches one of `--until`, then print the state that ended the wait.

`--until` takes one or more states. Omit it and the **backend's own default set** applies — herdr's
is `idle|done|blocked` — rather than cyber-mux restating a default that could drift from it.
`--timeout <ms>` is likewise omitted by default: the wait runs indefinitely.

This drives the backend's native wait (`herdr agent wait`, `otty pane wait`). Two refusals, kept
separate because they have different fixes:

- **No wait at all.** tmux, rmux, wezterm, zellij, and cmux have no per-pane agent-state primitive.
  They fail with `backend-unsupported` (exit 1), and the fix is to run the wait on herdr or otty.
- **A wait, but not those states.** otty's wait ends on `idle` alone, so any other `--until` is
  refused there by name, reporting what it asked for beside what the backend can end on. The fix is
  to drop a state, not to change backend.

Use `agent status` when you want an answer everywhere.

`<pane>` takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution
rules.

### Examples

```bash
# What is this pane's agent doing?
cyber-mux agent status %3
```

```bash
# Block until the agent is idle or has asked a question
cyber-mux agent wait w3A:p1 --until idle --until blocked --timeout 300000
```

```bash
# The state that ended the wait, as JSON
cyber-mux agent wait w3A:p1 --format json
```
