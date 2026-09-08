/**
 * The focus-on-open vocabulary — what `open()` does to the human's view, as `MuxAdapter.focusOnOpen`
 * reports it.
 *
 * Its own module rather than a member of `mux.ts` for the reason `zoom.ts` and `floating.ts` are:
 * `mux.ts` is the CONTRACT and carries no runtime value, so the one helper the declaration needs
 * would drag a value import into every consumer of the types. It rides the `.` barrel because the
 * verb it describes — `open` — is on the surface everybody gets.
 */

/**
 * What an `open()` does to the caller's focus. Replaces the boolean `opensWithoutStealingFocus`,
 * which could not say the thing issue #152 asked for: a backend that MOVES focus and then puts it
 * back is neither "opens without stealing focus" nor the same product as one that leaves the user
 * stranded, and the boolean had to call it one or the other.
 *
 * It called it `true`, which is how zellij came to declare the same value as tmux while doing
 * something visibly different. tmux passes `-d` and nothing moves at any instant; zellij's `from`
 * path FOCUSES the anchor pane (its `new-pane` has no target flag), opens, and then focuses the
 * caller back. Both end where they started; only one of them never left.
 *
 * - **`'preserved'`** — nothing moves, at any instant, on **every** route `open()` can take: tab,
 *   workspace, and each `pane:*` placement. The backend has a suppress-focus primitive and every
 *   route passes it, AND no route has to VISIT a pane to choose a split target.
 * - **`'restored'`** — a focus move happens and is deterministically undone before `open()` returns,
 *   so the caller ends on the pane they started on. A human watching may see a flicker; a human who
 *   looks after the call sees nothing moved. This is the honest answer for a backend whose
 *   `new-pane` has no split-target flag, which is most of them.
 * - **`'stolen'`** — focus moves and stays moved. The caller is somewhere new when `open()` returns
 *   and has to decide for itself whether to go back.
 *
 * **A three-valued declaration, not a `MuxOpenOptions` flag**, for the boolean's original reason: no
 * caller wants the stealing behavior, so an option would be a branch every caller writes and none
 * takes. And `'stolen'` is still not a refusal — an open that moves focus returns the pane the
 * caller asked for, so the honest answer is to say so rather than fail.
 *
 * **REQUIRED on `MuxAdapter`**, as the boolean was. An adapter that simply never considered focus
 * would read as `undefined`, indistinguishable from one that considered it and found no primitive,
 * and a caller cannot tell an unanswered question from a negative answer. The seam takes the adapter
 * author's debt over the caller's ambiguity.
 */
export type FocusOnOpen = 'preserved' | 'restored' | 'stolen'

/**
 * Run `open` with the caller's focus put back where it was — the one spelling of the `'restored'`
 * behavior, so the four adapters that need it cannot drift into four subtly different dances.
 *
 * `read` names the pane the caller is on and is called BEFORE anything moves, which is the only
 * moment it is the answer we want. `restore` is the backend's own focus verb. Both are the
 * adapter's, because "which pane is the client on" and "put the client there" are the two things no
 * two multiplexers spell alike.
 *
 * **`read` answering `undefined` means the restore is skipped, not guessed.** A session no client
 * has attached to reports exactly that: nothing was stolen, so nothing is put back, and inventing a
 * focus move to a pane picked by heuristic would be worse than the theft it exists to undo — it
 * would move a user who was never moved.
 *
 * **The restore runs even when `open` throws**, via `finally`. A half-finished open is exactly the
 * case where a caller is least equipped to notice their view has moved, and the alternative — a
 * focus move left standing only on the failure path — is the kind of state that gets found weeks
 * later. The throw still propagates; only the focus is cleaned up.
 *
 * Returns whatever `open` returned, so it wraps an existing route without changing its shape.
 */
export function restoringFocus<T>(
	io: { read: () => string | undefined; restore: (pane: string) => void },
	open: () => T,
): T {
	const restoreTo = io.read()
	try {
		return open()
	} finally {
		if (restoreTo !== undefined) io.restore(restoreTo)
	}
}

/**
 * The pane the sole attached client is on, read out of a listing — the `read` half of
 * `restoringFocus` for a backend whose focus authority is a per-row `focused` flag rather than a
 * client listing.
 *
 * Presence-checked field by field, for `isPaneFocused`'s reason: a row that carries no focus field
 * has said nothing, and folding that into "not focused" would let this pick the WRONG pane to
 * restore to. It answers `undefined` unless exactly one row claims focus — more than one claimant
 * means the listing is reporting focus per layer rather than per client (zellij's `is_focused` does
 * exactly that), and a restore aimed at a guess is a focus move the caller never asked for.
 */
export function soleFocusedPane<T>(
	rows: readonly T[],
	focused: (row: T) => boolean | undefined,
	id: (row: T) => string,
): string | undefined {
	const claimants = rows.filter((r) => focused(r) === true)
	return claimants.length === 1 ? id(claimants[0]!) : undefined
}
