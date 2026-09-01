import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxTarget } from './mux.ts'

/**
 * The pane-resize refusal and its orchestrator — the `RegionInspector.resizePane` capability's
 * emulate-or-refuse decision, in the one place that sees the adapter.
 *
 * Its own module rather than a member of `mux.ts` for the reason every other seam refusal is:
 * `mux.ts` is the CONTRACT and carries no runtime value, so putting the one class the contract's
 * refusal needs there would make every consumer of the types import a value too. It rides the `.`
 * barrel beside `floating.ts` rather than a subpath because resizing a pane is core pane control,
 * not a tier of its own — contrast `template`'s capture, whose refusal ships with the template
 * engine that raises it.
 */

/**
 * A resize asked of a backend that cannot report pane geometry (wezterm, zellij, cmux, otty). An
 * absent `regions` seam is a REFUSAL, never a guess, and the refusal is structural rather than
 * declared: `resizePane` takes a fraction of a split region, and a backend that cannot measure that
 * region has nothing to take the fraction of. See `RegionInspector.resizePane` for why the capability
 * is not a `canResizePanes` boolean on `MuxAdapter`, and why a relative nudge — which zellij and otty
 * do have — is not the same verb.
 *
 * PORTABLE and exit-code-free by design, the exact mirror of `FloatingPanesUnsupportedError` and
 * `AgentLifecycleUnsupportedError`. The DECISION to refuse is the library's and lives in
 * `derivePaneResize` below; how the refusal SURFACES — the exit code, the fix hint, the exact
 * sentence — is the caller's. `backend` names the backend so a caller composes the message without
 * re-deriving it; the terse `message` is a factual log line.
 */
export class PaneResizeUnsupportedError extends Error {
	constructor(readonly backend: string) {
		super(`${backend} cannot resize a pane`)
		this.name = 'PaneResizeUnsupportedError'
	}
}

/**
 * Resize the target pane to `ratio` of the split it sits in, through the adapter — the
 * surface-independent orchestrator, and the single home of the pane-resize refusal. A backend without
 * `regions` is refused HERE, BEFORE any exec, because `resizePane` never sees the adapter and so
 * cannot make that call itself.
 *
 * Mirrors `deriveRegionCapture` (`template-capture.ts`) and `deriveAgentWait` (`agent.ts`) exactly:
 * the orchestrator is the one place that sees the adapter, so it is the one place the decision can be
 * made. It gates on `resizePane` rather than on `regions` as a whole so an adapter that grows the
 * reads before the write is refused truthfully rather than crashing on an absent method.
 */
export function derivePaneResize(adapter: MuxAdapter, exec: Exec, target: MuxTarget, ratio: number): void {
	const resizePane = adapter.regions?.resizePane
	if (!resizePane) throw new PaneResizeUnsupportedError(adapter.name)
	resizePane(exec, target, ratio)
}
