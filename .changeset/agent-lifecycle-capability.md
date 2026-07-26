---
"cyber-mux": minor
---

Add the agent-lifecycle capability, normalized by truthful refusal rather than emulation.

- **`cyber-mux/agent` subpath** — the new `AgentLifecycle` capability seam, its `deriveAgentWait`
  orchestrator, and the `AgentLifecycleUnsupportedError` refusal. The `AgentStatus` type
  (`idle | working | blocked | done | unknown`) rides out on the core `.` barrel via `LivePane`.
- **`LivePane.agentStatus`** — herdr 0.7.5's per-pane `agent_status` feed, reported on the live pane
  listing exactly like the herdr-only `harness` field: filled where the backend can answer, OMITTED
  (never a false `unknown`) where it cannot.
- **`agent status <pane>`** — a snapshot that degrades truthfully: it prints the resolved pane's
  `agentStatus` on herdr and, on a backend with no agent-state feed, still prints the pane with no
  status and exits 0 rather than refusing.
- **`agent wait <pane> [--until <s...>] [--timeout <ms>]`** — a blocking drive of herdr's native
  `agent wait`, reporting the reached state. On tmux, wezterm and zellij — which have no native
  per-pane agent-state primitive — it is refused with `backend-unsupported` (exit 1) naming the
  herdr-only constraint, the exact mirror of how `template save` refuses a geometry-incapable backend.
- **`agentApi(env, deps?)`** — the exec-bound `cyber-mux/agent` facade paralleling
  `worktreeApi`/`templateApi`: it resolves the backend from `env` once and exposes
  `supported()` / `status(target)` / `wait(target, opts?)` with the seams bound. It adds no logic of
  its own — `supported` reads the same capability presence, `status` the same `LivePane.agentStatus`,
  and `wait` routes through `deriveAgentWait`, so the refusal stays specified and enforced once.

The refuse-not-emulate normalization is deliberate: a lookalike wait built from output polling would
silently disagree with herdr's own state derivation, so a backend without the primitive is refused
rather than guessed.
