# CR 94 — herdr agent-lifecycle capability (settled design)

Source: https://github.com/cyberuni/cyber-mux/issues/94. This is the in-repo, repo-relative copy of
the design ratified before the mission (decisions locked by the user).

## Capability

herdr 0.7.5 (2026-07-21 agent-lifecycle release) reports a per-pane agent state feed:
`AgentStatus = idle | working | blocked | done | unknown`, plus server-owned
`herdr agent wait <target> --until <status>… --timeout <ms>` (default until = idle|done|blocked;
indefinite without timeout). Detection = lifecycle-authority hooks OR per-agent screen-manifest
matchers; `done` is herdr-derived, not reporter-settable. cyber-mux drives herdr panes but not this
feed (the adapter header says so). `LivePane` has no `agentStatus`; `nudge` fakes a crude version by
scraping the input box.

## Locked decisions

1. **Snapshot `agentStatus` → stays in `mux.ts` on `LivePane`**, beside the existing herdr-only
   `harness?` field. Absent-where-unsupported (herdr fills it; tmux/wezterm/zellij omit). No refusal
   — a field that simply isn't there. CLI `agent status <pane>` degrades truthfully on backends with
   no feed (prints the pane with no status), never refuses.
2. **`agent wait` → its own `AgentLifecycle` capability on a NEW `cyber-mux/agent` subpath**, not the
   core barrel — following the `cyber-mux/worktree` / `cyber-mux/template` distinct-domain-→-subpath
   precedent. Keeps `mux.ts` as pane control; gives the agent domain room to grow.
   ```ts
   type AgentStatus = 'idle'|'working'|'blocked'|'done'|'unknown'   // lives in mux.ts (LivePane uses it)
   interface AgentLifecycle {
     waitForState(exec, target, opts: { until?: AgentStatus[]; timeoutMs?: number }): AgentStatus
   }
   // MuxAdapter gains:  readonly agentLifecycle?: AgentLifecycle | undefined
   ```
3. **tmux / wezterm / zellij REFUSE, do NOT emulate.** `agentLifecycle` is absent on those three; the
   wait is refused with a named `backend-unsupported` error via a library orchestrator
   (`AgentLifecycleUnsupportedError(backend)`), reusing the #88/#90 capture-derive-orchestrator +
   screen recognized-but-not-drivable pattern. CLI catches → `backend-unsupported` coded error,
   exit 1, help naming the herdr-only constraint. Rationale: the contract chooses truthful refusal
   over a confident lie everywhere; agent-state detection is harness-specific and herdr earns it.

## CLI (agent-first)

- `cyber-mux agent status <pane>` — snapshot; bare form prints the state (JSON `{ pane, agentStatus }`).
- `cyber-mux agent wait <pane> [--until <s>…] [--timeout <ms>]` — block; non-herdr → `backend-unsupported`.
- New `agent` command group (parallels `send` / `worktree` / `template`).

## Public API

Export `AgentStatus`; add `agentStatus?` to `LivePane`; new subpath entry `cyber-mux/agent`
(package.json `exports` + tsdown multi-entry) exporting the `AgentLifecycle` types + herdr binding +
the refusal error. `MuxSession` gains bound `agentLifecycle?` (bound in `resolveMux` like
`worktree`/`regions`). Update `published-surface.dist.test.ts` freeze lists (new entry + names).

## Out of scope (separate follow-up)

`pane wait-output` → a portable cross-mux `waitForOutput` (herdr native; others poll `read`). Genuinely
normalizable on all four — a different, more primitive capability. Its own CR.

## Provisional node placement (finalized at handoff Warden pass)

- REVISE `mux/lookup` — `agentStatus` on `LivePane` (listing reports it). Additive → self-clears freeze.
- ADD `agent/` (library, top-level, `cyber-mux/agent` subpath) — `AgentLifecycle` wait + the refusal.
- ADD `cli/agent/` — `agent status` + `agent wait` verbs, agent-first, refusal surface.
- REVISE root `spec.md` capability map + routing table — new `agent/` capability row + `cli/agent/` mirror.
