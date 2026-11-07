import { CliError, exitCodes } from 'clibuilder'

/**
 * The error surface is clibuilder's own (`output: 'axi'`, AXI's #6): a thrown `CliError` is reported
 * once, on stdout, in the caller's `--format`, as `error`, `code`, the `details` fields, then `help`,
 * and the CLI exits with its `exitCode`. cyber-mux supplies only what core cannot know:
 *
 * - a **stable `code`** a script matches on (`no-mux` is not `pane-not-found` is not `ambiguous-pane`);
 * - a **`help`** line naming THIS CLI's command that fixes it, never a dependency's own text: an agent
 *   handed a raw tmux/herdr diagnostic cannot act on it through cyber-mux, so a backend's text is
 *   TRANSLATED into a `CliError` rather than forwarded;
 * - an **`exitCode`** that separates a usage error (2, the fix is a different invocation) from an
 *   operation failure (1).
 */
export { CliError }

/** The stable code the ambiguity error carries, in every format — what a caller matches on. */
export const AMBIGUOUS_CODE = 'ambiguous-pane'

/** One candidate of an ambiguous locator: what tells it apart, and what retries it. */
export interface PaneCandidate {
	id: string
	label: string | null
	cwd: string | null
}

/**
 * The candidates as `details` fields. Core keeps `details` flat (scalars, or lists of scalars), so the
 * candidates are three index-aligned lists rather than a list of records: `candidates[i]` is the id —
 * the retry — and `labels[i]` and `cwds[i]` are what tell that pane apart from the others.
 */
function candidateDetails(candidates: PaneCandidate[]): CliError.Details {
	return {
		candidates: candidates.map((c) => c.id),
		labels: candidates.map((c) => c.label),
		cwds: candidates.map((c) => c.cwd),
	}
}

/**
 * An ambiguous locator — a `CliError` like any other, so core reports it with no special case, and a
 * caller sees the same `{ error, code, help }` shape it sees for every other failure.
 *
 * It is THROWN rather than reported where it is found: a verb's own catch-all could otherwise flatten
 * an exit-2 ambiguity into an exit-1 generic failure behind its back. A typed error is what makes the
 * ambiguity visible to every catch it passes through, so each one rethrows it deliberately instead of
 * swallowing it by accident.
 *
 * Each candidate carries its id, its label and its cwd: the id is the RETRY — paste it back and the
 * ambiguity is gone, since an id outranks every name — and the cwd is what actually tells three panes
 * all labeled `worker` apart.
 */
export class AmbiguousPaneError extends CliError {
	constructor(
		readonly locator: string,
		readonly candidates: PaneCandidate[],
	) {
		super({
			code: AMBIGUOUS_CODE,
			message: `"${locator}" matches ${candidates.length} panes — an id resolves it`,
			details: { locator, ...candidateDetails(candidates) },
			help: `retry with one of the ids: ${candidates.map((c) => c.id).join(' ')}`,
			exitCode: exitCodes.usage,
		})
	}
}

/** The stable code a missing-pane usage error carries — the same code FAMILY as the ambiguity: both
 * are exit-2 usage errors whose fix is a different pane argument, and both hand the caller the live
 * panes to retry with rather than sending them on a second round trip. */
export const MISSING_PANE_CODE = 'missing-pane'

/**
 * A pane verb invoked with no `<pane>` at all — a usage error (exit 2), the same shape the ambiguity
 * uses. The backend IS queried so the live panes can be listed as candidates (CR 95), since the
 * caller's deterministic next move after "missing pane" is `cyber-mux list`. Folding that answer into
 * the error collapses a two-turn correction into one, exactly as the ambiguity report already does.
 *
 * Carries its candidates under the same `details` keys `AmbiguousPaneError` uses. When the backend
 * could NOT be enumerated the lists are empty and the help points at `cyber-mux list` instead.
 */
export class MissingPaneError extends CliError {
	constructor(readonly candidates: PaneCandidate[]) {
		super({
			code: MISSING_PANE_CODE,
			message: 'no pane given — this command needs a target pane',
			details: candidateDetails(candidates),
			help:
				candidates.length > 0
					? `pass one of the ids: ${candidates.map((c) => c.id).join(' ')}`
					: 'list the live panes with: cyber-mux list',
			exitCode: exitCodes.usage,
		})
	}
}
