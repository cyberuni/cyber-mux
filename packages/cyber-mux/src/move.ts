import type { MuxAdapter } from './mux.ts'

/**
 * The pane-relocation refusals — `movePane`'s and `breakPane`'s answer on a backend that cannot
 * render them (zellij and otty for both, cmux for the move alone).
 *
 * Its own module rather than a member of `mux.ts` for the reason every other seam refusal is:
 * `mux.ts` is the CONTRACT and carries no runtime value, so putting the classes the contract's
 * refusals need there would make every consumer of the types import a value too. It rides the `.`
 * barrel beside `floating.ts`, `resize.ts` and `zoom.ts` because the verbs it refuses are core pane
 * control, on the surface everybody gets.
 *
 * TWO errors and two capability reads rather than one of each, because these are two capabilities
 * and one backend has exactly one of them: cmux can promote a surface into a space of its own
 * (`break-pane`) and has nothing that puts one beside a NAMED pane on a NAMED side. A single
 * `canRelocatePanes` would have to answer `false` there and lose the half cmux really has.
 */

/**
 * A move asked of a backend that cannot put a pane beside another one. A refusal, never a
 * substitution, for `PaneZoomUnsupportedError`'s reason: the nearest thing an incapable backend
 * could do is open a NEW pane at the destination and tear the old one down, which loses the
 * scrollback, the running process and the pane's identity — everything the caller was moving.
 *
 * The three refusers do NOT refuse for the same reason, and the distinction is kept in each
 * adapter's own note rather than blurred here:
 *
 * - **zellij has no cross-container move at all.** Read off the pinned 0.45.0 binary's own command
 *   inventory, not a docs page: `zellij action move-pane [-p <id>] [DIRECTION]` rotates a pane
 *   WITHIN its tab, and no verb in `zellij action --help` names a destination tab or session.
 * - **cmux has two container moves and neither is this one.** `move-surface --surface <s> --pane <p>`
 *   moves a surface into another PANE CONTAINER, where it lands as a tab ordered by
 *   `--before`/`--after`/`--index` — never beside a named pane on a named side; `split-off` /
 *   `drag-surface-to-split --surface <s> <left|right|up|down>` splits a surface off inside its OWN
 *   pane and takes no destination at all. cmux HAS moves; it has no destination this member can
 *   render. (Source-read at `ae18c88`, never driven — see #128.)
 * - **otty documents no move verb a program can drive.** Its CLI reference names `move` for the TAB
 *   tier only, with no flag list anywhere in the 141-page corpus, and its pane relocation is
 *   published as a mouse gesture ("drag a pane to the tab strip") and a right-click menu item. That
 *   is `setPaneZoom`'s trap exactly.
 *
 * PORTABLE and exit-code-free by design, the exact mirror of `PaneZoomUnsupportedError`. The
 * DECISION to refuse is the library's, made inside each adapter's `movePane` — the one place that
 * sees the backend. How the refusal SURFACES (the exit code, the fix hint, the exact sentence) is
 * the caller's.
 */
export class PaneMoveUnsupportedError extends Error {
	constructor(readonly backend: string) {
		super(`${backend} cannot move a pane`)
		this.name = 'PaneMoveUnsupportedError'
	}
}

/**
 * A break-out asked of a backend that cannot promote a pane into a space of its own. Separate from
 * `PaneMoveUnsupportedError` because the capabilities are separate — see the module note.
 *
 * Its two refusers, again for different reasons:
 *
 * - **zellij**, whose 0.45.0 command inventory carries no break verb under any spelling.
 * - **otty**, whose only documented break-out is the GUI ("Move Tab to New Window" in the right-click
 *   menu, and tearing a pane off by dragging it outside the window).
 */
export class PaneBreakUnsupportedError extends Error {
	constructor(readonly backend: string) {
		super(`${backend} cannot break a pane out`)
		this.name = 'PaneBreakUnsupportedError'
	}
}

/**
 * Refuse a `movePane` on the backend named — the single spelling of the refusal, called by every
 * adapter that lacks the capability so they cannot drift into three different messages.
 *
 * Takes the NAME rather than the adapter, for `refusePaneZoom`'s reason: it is called from inside an
 * adapter method while the adapter object is still being constructed on some backends, and the name
 * is the only thing the error carries anyway.
 */
export function refusePaneMove(backend: string): never {
	throw new PaneMoveUnsupportedError(backend)
}

/** Refuse a `breakPane` on the backend named — `refusePaneMove`'s twin, one member over. */
export function refusePaneBreak(backend: string): never {
	throw new PaneBreakUnsupportedError(backend)
}

/**
 * Whether `adapter` can move a pane beside another one — the declaration read, so a caller asking
 * the question before moving spells it once rather than reaching into an optional member that may be
 * `undefined`.
 *
 * The pre-flight check, not the enforcement: `movePane` re-checks as its own contract (the same
 * belt-and-braces `canZoomPanes` gets), so a caller that skips this is refused just as loudly.
 */
export function canMovePanes(adapter: MuxAdapter): boolean {
	return adapter.canMovePanes === true
}

/** Whether `adapter` can break a pane out into a space of its own — `canMovePanes`'s twin. */
export function canBreakPanes(adapter: MuxAdapter): boolean {
	return adapter.canBreakPanes === true
}
