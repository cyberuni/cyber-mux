import type { MuxAdapter } from './mux.ts'

/**
 * The floating-pane refusal — the `'pane:float'` placement's answer on a backend that has no
 * floating-pane concept (wezterm, herdr).
 *
 * Its own module rather than a member of `mux.ts` for the reason every other seam type is not a
 * class: `mux.ts` is the CONTRACT and carries no runtime value, so putting the one class the
 * contract's refusal needs there would make every consumer of the types import a value too. It is
 * the core-surface parallel of `CaptureUnsupportedError` (`template-capture.ts`) and
 * `AgentLifecycleUnsupportedError` (`agent.ts`), and it rides the `.` barrel rather than a subpath
 * because the verb it refuses — `open` — is on the surface everybody gets.
 */

/**
 * A floating pane asked of a backend that cannot open one (`open` with `at: 'pane:float'` on wezterm
 * or herdr). A refusal, never a substitution: the nearest thing those backends could open is a tiled
 * split, which takes a share of the region and resizes its other panes — exactly the property a float
 * exists to avoid — so a caller would get back a pane whose id satisfies them and whose behavior does
 * not. There is no truthful degrade, so there is no degrade.
 *
 * PORTABLE and exit-code-free by design, the exact mirror of `AgentLifecycleUnsupportedError`. The
 * DECISION to refuse is the library's, made inside each adapter's `open` — the one place that sees
 * both the backend and the requested placement. How the refusal SURFACES (the exit code, the fix
 * hint, the exact sentence) is the CLI's, which catches this and re-raises its own
 * `backend-unsupported` error. `backend` names the backend so a caller composes the message without
 * re-deriving it; the terse `message` is a factual log line.
 */
export class FloatingPanesUnsupportedError extends Error {
	constructor(readonly backend: string) {
		super(`${backend} cannot open a floating pane`)
		this.name = 'FloatingPanesUnsupportedError'
	}
}

/**
 * Refuse a `'pane:float'` open on the backend named — the single spelling of the refusal, called by
 * every adapter that lacks the capability so the two cannot drift into two different messages.
 *
 * Takes the NAME rather than the adapter: it is called from inside `open`, where the adapter object is
 * still being constructed on some backends, and the name is the only thing the error carries anyway.
 */
export function refuseFloatingPane(backend: string): never {
	throw new FloatingPanesUnsupportedError(backend)
}

/**
 * Whether `adapter` can open a floating pane — the declaration read, so a caller asking the question
 * before opening spells it once rather than reaching into an optional member that may be `undefined`.
 *
 * The pre-flight check, not the enforcement: `open` re-checks as its own contract (the same
 * belt-and-braces `agent wait` runs against `agentLifecycle`), so a caller that skips this is refused
 * just as loudly — one exec later.
 */
export function canFloatPanes(adapter: MuxAdapter): boolean {
	return adapter.canFloatPanes === true
}
