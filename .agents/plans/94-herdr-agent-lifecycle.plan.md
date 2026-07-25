---
cr: 94-herdr-agent-lifecycle
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/94
status: implemented
todos:
  - content: "Intake: CR opened from #94; design ref + plan + leash written; nodes placed provisionally"
    status: completed
  - content: "Explore: authored agent/ + cli/agent/ nodes + additive mux/lookup scenarios; Fable producer; cold spec-judge NOT-ALIGNED then 5 findings remediated + reverified"
    status: completed
  - content: "Spec gate: bars pass; @frozen intact (mux/lookup addOnly self-clears); judge-iteration correction logged; gate line written; self-asserted (auto-spec); status approved"
    status: completed
  - content: "Deliver: AgentStatus+LivePane.agentStatus in mux.ts; new cyber-mux/agent subpath (AgentLifecycle + deriveAgentWait refusal); herdr waitForState + listPanes agentStatus; tmux/wezterm/zellij no member; CLI agent status/wait; backend bind; index+exports+package.json+tsdown; tests; changeset"
    status: in_progress
  - content: "Impl gate: verify per frozen scenario; pnpm verify green; rebase onto main; status: implemented"
    status: pending
  - content: "Handoff: Warden placement pass; 1 PR (Closes #94) decomposed by unit-of-work; changeset; combat log in PR"
    status: pending
---

# CR 94 — drive herdr's agent-lifecycle state feed, normalized across the seam

Add herdr's agent-lifecycle capability (`agent_status` + `agent wait`) to cyber-mux, normalized
across tmux/wezterm/zellij by **truthful refusal** (not emulation). Full settled design (locked by
the user): [`94-herdr-agent-lifecycle.design.md`](./94-herdr-agent-lifecycle.design.md).

## Decisions locked (do not relitigate)

- Snapshot `agentStatus` on `LivePane` in `mux.ts` (beside `harness?`), absent-where-unsupported.
- `agent wait` as its own `AgentLifecycle` capability on a **new `cyber-mux/agent` subpath** (not the
  core barrel) — `worktree`/`template` subpath precedent.
- tmux/wezterm/zellij **REFUSE** with a named `backend-unsupported` error via a library orchestrator
  (reuse #88/#90 + screen pattern). No emulation.
- CLI `agent status <pane>` / `agent wait <pane> --until --timeout`. Published surface → changeset.
- `pane wait-output` (portable `waitForOutput`) is OUT of scope — separate follow-up.

## Nodes (provisional; Warden finalizes at handoff)

- REVISE `mux/lookup` — `agentStatus` on `LivePane` (additive, self-clears freeze).
- ADD `agent/` (library top-level) — `AgentLifecycle.waitForState` + the refusal error.
- ADD `cli/agent/` — `agent status` + `agent wait`, agent-first.
- REVISE root `spec.md` — capability map + routing table (`agent/` row, `cli/agent/` mirror).

## Leash

`packages/cyber-mux/.agents/spec/ledger/94-herdr-agent-lifecycle.1f3364.jsonl` — `auto-spec`
(self-assert spec gate within leash; stop at impl gate for the in-session user to ratify, given the
published-surface blast + high novelty). Hash `1f3364`.

## NEXT

Explore. Read `mux/lookup/README.md` + `template/` node shape + `cli/README.md` for node skeletons.
Scaffold `agent/README.md` + `agent/agent.feature`, `cli/agent/README.md` + `cli/agent/agent.feature`,
add the snapshot scenario to `mux/lookup/lookup.feature`. Grill spec + suite; run build-to-learn spike
for the refusal orchestrator shape; dispatch cold spec-judge; converge → spec gate.
