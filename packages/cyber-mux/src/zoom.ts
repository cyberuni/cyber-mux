import type { MuxAdapter } from './mux.ts'

/**
 * The pane-zoom refusal — `setPaneZoom`'s answer on a backend that cannot render an absolute zoom
 * (cmux, otty).
 *
 * Its own module rather than a member of `mux.ts` for the reason every other seam refusal is:
 * `mux.ts` is the CONTRACT and carries no runtime value, so putting the one class the contract's
 * refusal needs there would make every consumer of the types import a value too. It rides the `.`
 * barrel beside `floating.ts` and `resize.ts` because the verb it refuses is core pane control, on
 * the surface everybody gets.
 */

/**
 * A zoom asked of a backend that cannot render one. A refusal, never a substitution: the nearest
 * thing an incapable backend could do is resize the pane to fill its region, which permanently
 * resizes the siblings and leaves no state to restore — so the caller would get back a pane that
 * satisfies "big" and violates everything else they assumed. There is no truthful degrade, so there
 * is no degrade.
 *
 * The two refusers do NOT refuse for the same reason, and the distinction is kept in each adapter's
 * own note rather than blurred here:
 *
 * - **cmux has no pane-zoom verb at all.** Read from cmux's Swift source at HEAD `ae18c88`, not from
 *   a live binary: no zoom/maximize verb in `CLI/cmux.swift` or `CMUXCLI+CommandSuggestions.swift`,
 *   and the control socket's nine pane methods (`pane.break` `pane.create` `pane.focus` `pane.join`
 *   `pane.last` `pane.list` `pane.resize` `pane.surfaces` `pane.swap`) carry no `pane.zoom`. The
 *   capability exists only as a GUI keybinding (`ShortcutAction.toggleSplitZoom`, ⌘⇧↩), which is
 *   exactly why `isPaneZoomed` answers `undefined` there rather than `false`. Its tmux-compat
 *   `resize-pane` shim is the trap this refusal exists to avoid: `-Z` is not in its `boolFlags`, an
 *   unrecognized short flag is pushed into `positional` rather than erroring, and the resize dispatch
 *   has no final `else` — so `cmux resize-pane -Z -t <pane>` resolves the pane, does nothing, and
 *   exits 0. Upstream PR #353 would add the verb and is still unmerged.
 * - **otty has the verb and does not document how to drive it.** `otty pane zoom` is named once on
 *   docs.otty.sh/reference/cli ("Panes additionally have `split`…, `zoom`, `resize`, …") with no flag
 *   list, no example, and no `--on`/`--off`/`--toggle` anywhere on the page; its sibling verbs
 *   `split` and `resize` DO get their flags spelled out in that same sentence. Nothing in the docs
 *   reports zoom state back either, so neither half of an absolute set can be rendered: not the
 *   write, whose vocabulary is unknown, and not the read the write would have to be guarded by. A
 *   blind toggle is precisely what `setPaneZoom` refuses to be. One `otty pane zoom --help` on a
 *   machine with otty settles it — see issue #128 for the missing real-boundary suite.
 *
 * PORTABLE and exit-code-free by design, the exact mirror of `FloatingPanesUnsupportedError` and
 * `PaneResizeUnsupportedError`. The DECISION to refuse is the library's, made inside each adapter's
 * `setPaneZoom` — the one place that sees the backend. How the refusal SURFACES (the exit code, the
 * fix hint, the exact sentence) is the caller's. `backend` names the backend so a caller composes the
 * message without re-deriving it; the terse `message` is a factual log line.
 */
export class PaneZoomUnsupportedError extends Error {
	constructor(readonly backend: string) {
		super(`${backend} cannot zoom a pane`)
		this.name = 'PaneZoomUnsupportedError'
	}
}

/**
 * Refuse a `setPaneZoom` on the backend named — the single spelling of the refusal, called by every
 * adapter that lacks the capability so the two cannot drift into two different messages.
 *
 * Takes the NAME rather than the adapter, for `refuseFloatingPane`'s reason: it is called from inside
 * an adapter method while the adapter object is still being constructed on some backends, and the
 * name is the only thing the error carries anyway.
 */
export function refusePaneZoom(backend: string): never {
	throw new PaneZoomUnsupportedError(backend)
}

/**
 * Whether `adapter` can zoom a pane — the declaration read, so a caller asking the question before
 * zooming spells it once rather than reaching into an optional member that may be `undefined`.
 *
 * The pre-flight check, not the enforcement: `setPaneZoom` re-checks as its own contract (the same
 * belt-and-braces `canFloatPanes` gets), so a caller that skips this is refused just as loudly.
 */
export function canZoomPanes(adapter: MuxAdapter): boolean {
	return adapter.canZoomPanes === true
}
