---
'cyber-mux': minor
---

Implement `AgentLifecycle` on the otty backend, bound to `otty pane wait --pane <id>` — the second
backend with a native per-pane agent-state wait, after herdr. `cyber-mux agent wait` now drives otty
instead of refusing it, and `agentApi(env).supported()` is `true` there.

otty's wait ends on `idle` and nothing else, so an `--until` naming any other state is refused by
name with the new `AgentWaitStatesUnsupportedError` (exported from `cyber-mux/agent`) rather than
narrowed to what the backend happens to support. `timeoutMs` rounds up to otty's whole-second
`--timeout-secs` and never to `0`, which is otty's spelling for an unbounded wait.

`LivePane.agentStatus` on otty is unchanged and still `undefined`: otty exposes no documented CLI
read of per-pane agent state, so `supported()` and `status()` now answer differently on the same
backend.

Everything here is read off otty's published CLI documentation; otty is a GUI-only app with no
binary in CI, so nothing in this change was verified against a live otty.
