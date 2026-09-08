---
title: Agent
description: The agent-lifecycle capability — waiting on a pane's agent state, and the two refusals.
---

```ts
import { deriveAgentWait, AgentLifecycleUnsupportedError } from 'cyber-mux/agent'
```

The agent-lifecycle **wait**, kept off the core barrel for the same reason the template apply engine
is: a capability nobody needs in order to drive a pane does not belong on the surface everybody gets.

The `AgentStatus` type itself does ride out on the core barrel — it is a field of `LivePane`, so a
plain `listPanes` already carries a pane's agent status where the backend has a feed. This subpath is
the part that blocks.

## `deriveAgentWait(adapter, exec, target, opts)`

Wait until the target pane's agent reaches one of `opts.until` (or the backend's own default set) and
return the state that ended the wait.

```ts
import { resolveMuxAdapter } from 'cyber-mux'
import { nodeExec } from 'cyber-mux'
import { deriveAgentWait } from 'cyber-mux/agent'

const adapter = resolveMuxAdapter(process.env)
const reached = deriveAgentWait(adapter, nodeExec, { id: 'w3A:p1' }, {
  until: ['idle', 'blocked'],
  timeoutMs: 300_000,
})
```

`opts.until` omitted means the backend's default set; `opts.timeoutMs` omitted means no deadline.

This is the one place that sees both the adapter and the request, so it is the one place the
emulate-or-refuse decision can be made — the same shape `deriveRegionCapture` takes for captures. A
backend without the optional `agentLifecycle` seam member is refused **before any exec**, rather than
having a wait synthesized from `read()` polling that would disagree with the backend's own state
derivation on the same question.

## The two refusals

Both are portable and carry no exit code; the CLI decides how they surface.

| Error | Means | Fix |
| --- | --- | --- |
| `AgentLifecycleUnsupportedError` | this backend has no agent wait at all (tmux, rmux, wezterm, zellij, cmux) | run the wait on herdr or otty |
| `AgentWaitStatesUnsupportedError` | it has one, and its vocabulary is narrower than the `until` you asked for | drop a state |

Keeping them apart is the point. Collapsing them would tell a caller on otty to "run it on herdr"
when the real fix is to drop one state from `until` — otty's native wait ends on `idle` alone.

`AgentLifecycleUnsupportedError` carries `backend`. `AgentWaitStatesUnsupportedError` carries
`backend`, `requested`, and `supported`, so a caller composes the fix without re-deriving any of it.

## Building your own refusal

Two helpers back a backend whose native wait is narrower than the seam:

- `agentWaitStatesSatisfiable(until, supported)` — whether a set can be ended on. An omitted or empty
  `until` is satisfiable by definition: the seam defines that as the backend's own default.
- `refuseAgentWaitStates(backend, requested, supported)` — throws
  `AgentWaitStatesUnsupportedError`. The single spelling of the refusal, so a second narrow backend
  cannot drift into a second message.

## The seam member

A backend declares the capability by carrying `agentLifecycle` on its adapter:

```ts
agentLifecycle?: {
  waitForState(exec: Exec, target: MuxTarget, opts: AgentWaitOptions): AgentStatus
}
```

Present on **herdr** (`herdr agent wait`) and **otty** (`otty pane wait`); absent everywhere else,
which is what `deriveAgentWait` reads to refuse.

## Types

`AgentStatus` is `'idle' | 'working' | 'blocked' | 'done' | 'unknown'`. `AgentWaitOptions` carries
`until?: readonly AgentStatus[]` and `timeoutMs?: number`. `AgentLifecycle` is the seam member above.
All three are re-exported from this subpath.
