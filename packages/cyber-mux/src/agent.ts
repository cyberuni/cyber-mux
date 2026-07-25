import type { Exec } from './exec.ts'
import type { AgentStatus, AgentWaitOptions, MuxAdapter, MuxTarget } from './mux.ts'

/**
 * The `cyber-mux/agent` subpath — the agent-lifecycle capability's orchestrator and its refusal.
 *
 * The `AgentStatus` type rides out on the `.` barrel (it is part of `LivePane`, and `mux.ts` is
 * re-exported there); the WAIT capability — the `AgentLifecycle` seam plus the emulate-or-refuse
 * decision below — is this subpath alone, kept off the core barrel exactly as `template`'s apply
 * engine is: a capability nobody has to import to drive a pane is not on the surface everybody gets.
 */

export type { AgentLifecycle, AgentStatus, AgentWaitOptions } from './mux.ts'

/**
 * An agent-lifecycle wait asked of a backend that has no native agent-state primitive (`agent wait`
 * on tmux, wezterm or zellij). An absent `agentLifecycle` seam member is a REFUSAL, never a guess: a
 * wait built from `read()` polling would silently disagree with herdr's own state derivation on the
 * same question, and a wait has no truthful degrade the way a snapshot does — so a backend that cannot
 * answer is refused rather than emulated.
 *
 * PORTABLE and exit-code-free by design, the exact mirror of `CaptureUnsupportedError`. The DECISION
 * to refuse is the library's and lives in `deriveAgentWait`, the one place that sees the adapter — how
 * the refusal SURFACES (the exit code, the fix hint, the exact sentence) is the CLI's, which catches
 * this and re-raises its own `backend-unsupported` error. `backend` names the backend so the caller
 * composes the message without re-deriving it; the terse `message` is a factual log line.
 */
export class AgentLifecycleUnsupportedError extends Error {
	constructor(readonly backend: string) {
		super(`${backend} cannot report agent-lifecycle state`)
		this.name = 'AgentLifecycleUnsupportedError'
	}
}

/**
 * Wait for the target pane's agent to reach one of `opts.until` (or the backend's default set) through
 * the adapter — the surface-independent orchestrator `agent wait` drives, and the single home of the
 * agent-wait refusal. The optional `agentLifecycle` seam is where a backend says whether it has a
 * native wait at all; a backend without it is refused HERE (`AgentLifecycleUnsupportedError`), BEFORE
 * any exec, because `waitForState` never sees the adapter and so cannot make that call. A backend that
 * HAS the capability delegates to it unchanged.
 *
 * Mirrors `deriveRegionCapture` (`template-capture.ts`) exactly: the orchestrator is the one place that
 * sees the adapter, so it is the one place the emulate-or-refuse decision can be made.
 */
export function deriveAgentWait(
	adapter: MuxAdapter,
	exec: Exec,
	target: MuxTarget,
	opts: AgentWaitOptions,
): AgentStatus {
	const agentLifecycle = adapter.agentLifecycle
	if (!agentLifecycle) throw new AgentLifecycleUnsupportedError(adapter.name)
	return agentLifecycle.waitForState(exec, target, opts)
}
