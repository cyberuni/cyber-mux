import { resolveMuxAdapter } from './backend.ts'
import { type Exec, nodeExec } from './exec.ts'
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

/**
 * The `agent` subpath facade with its `Exec` and backend BOUND — the exec-bound parallel of
 * `worktreeApi`/`templateApi`. `agentApi(env, deps?)` resolves the backend adapter from `env` ONCE
 * (`resolveMuxAdapter`, defaulting `exec` to `nodeExec`) and exposes `supported`/`status`/`wait` with
 * the seams already threaded, so a caller never re-plumbs an adapter or a runner into them.
 *
 * It ADDS no logic of its own: `supported` reads the very capability presence `deriveAgentWait` gates
 * on, `status` reads the same `LivePane.agentStatus` the listing already carries (for one pane rather
 * than redefining it), and `wait` routes THROUGH `deriveAgentWait` — so the emulate-or-refuse decision
 * stays specified once and enforced once, with no second refusal path here that could drift from it.
 */
export interface AgentApi {
	/** Whether this backend reports agent-lifecycle state at all (herdr yes; tmux/wezterm/zellij no). */
	supported(): boolean
	/** A pane's current agent state, or `undefined` when the backend has no feed (absent-not-false). */
	status(target: MuxTarget): AgentStatus | undefined
	/**
	 * Block until the pane's agent reaches one of `opts.until` (or the backend's default set); throws
	 * `AgentLifecycleUnsupportedError` naming the backend on one without the capability, via
	 * `deriveAgentWait`. A bare `wait(target)` takes herdr's own defaults (`opts ?? {}`).
	 */
	wait(target: MuxTarget, opts?: AgentWaitOptions | undefined): AgentStatus
}

/**
 * Bind the agent-lifecycle capability to an environment and runner once, returning an `AgentApi` whose
 * methods no longer take an `Exec`. `deps.exec` defaults to `nodeExec`; `env` is bound like
 * `resolveMux(env)` because it is what the probe resolves the backend from.
 */
export function agentApi(env: NodeJS.ProcessEnv, deps?: { exec?: Exec | undefined } | undefined): AgentApi {
	const exec = deps?.exec ?? nodeExec
	const adapter = resolveMuxAdapter(env, exec)
	return {
		supported: () => adapter.agentLifecycle !== undefined,
		status: (target) => adapter.listPanes(exec).find((p) => p.id === target.id)?.agentStatus,
		wait: (target, opts) => deriveAgentWait(adapter, exec, target, opts ?? {}),
	}
}
