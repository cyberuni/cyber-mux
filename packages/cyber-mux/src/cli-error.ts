import { isJsonOutput } from './output.ts'

/**
 * The error surface — AXI's #6, made concrete.
 *
 * Every failure is a STRUCTURED, CODED error on **stdout**, because stdout is the stream AXI reserves
 * for what the agent consumes — data, errors and suggestions alike — while stderr is defined as debug
 * the agent does not read. A report whose whole purpose is telling a caller what went wrong and how to
 * fix it is the last thing that belongs on the ignored stream. This does not muddy the payload: a verb
 * either succeeds and writes its result or fails and writes its error, never both, so the exit code
 * tells the two apart before anything is parsed.
 *
 * Three things every error carries, and they are not decoration:
 * - a **stable `code`** a script matches on, so one failure mode is told from another without parsing
 *   prose (`no-mux` is not `pane-not-found` is not `ambiguous-pane`);
 * - a **`help`** line naming THIS CLI's command that fixes it — never "see --help", and never a
 *   dependency's own name: an agent handed a raw tmux/herdr diagnostic cannot act on it through
 *   cyber-mux, so a backend's text is TRANSLATED here rather than forwarded;
 * - an **`exit`** code that separates a usage error (2 — a missing or malformed argument, whose fix is
 *   a different invocation) from a genuine operation failure (1).
 */
export class CliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly help: string,
		readonly exit: 1 | 2,
		/** Extra structured fields the JSON form carries beside code/message/help — e.g. an ambiguity's
		 * candidates. Never free-text; a machine reads these. */
		readonly extra?: Record<string, unknown> | undefined,
	) {
		super(message)
		this.name = 'CliError'
	}
}

/** The stable code the ambiguity error carries, in both formats — what a caller matches on. */
export const AMBIGUOUS_CODE = 'ambiguous-pane'

/** One candidate of an ambiguous locator: what tells it apart, and what retries it. */
export interface PaneCandidate {
	id: string
	label: string | null
	cwd: string | null
}

/**
 * An ambiguous locator — a `CliError` like any other, so the one renderer and the one verb-boundary
 * catch handle it with no special case, and so a caller sees the same `{ code, help, exit }` shape it
 * sees for every other failure.
 *
 * It is THROWN rather than reported where it is found: reporting in place would mean exiting from
 * inside `resolveTarget`, and a verb's own catch-all could then flatten an exit-2 ambiguity into an
 * exit-1 generic failure behind its back. A typed error is what makes the ambiguity visible to every
 * catch it passes through, so each one rethrows it deliberately instead of swallowing it by accident.
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
		super(
			AMBIGUOUS_CODE,
			`"${locator}" matches ${candidates.length} panes — an id resolves it`,
			`retry with one of the ids: ${candidates.map((c) => c.id).join(' ')}`,
			2,
			{ candidates },
		)
		this.name = 'AmbiguousPaneError'
	}
}

/**
 * The ONE renderer — every coded failure reaches stdout through here, and exits.
 *
 * `--format json` emits the machine form: a single `{ error: { code, message, help, ...extra } }`
 * object, the stable code first, no free-text prose beside it. The readable form leads its human line
 * with the same `code` token a script branches on — so a person scanning the terminal sees exactly
 * what a `--format json` consumer matches on — then the `help` line, then (for an ambiguity) one line
 * per candidate: `<id>  <label>  <cwd>`, the id-first shape whose first column is the retry.
 */
export function reportError(e: CliError): never {
	if (isJsonOutput()) {
		console.log(JSON.stringify({ error: { code: e.code, message: e.message, help: e.help, ...e.extra } }, null, 2))
	} else {
		// The code leads the human line too: the stable token is the point of the whole surface, so it
		// belongs where a person reads as much as where a script matches — not hidden in the JSON alone.
		console.log(`error: ${e.code}: ${e.message}`)
		console.log(`help: ${e.help}`)
		const candidates = e.extra?.['candidates'] as PaneCandidate[] | undefined
		if (candidates) {
			for (const c of candidates) console.log(`  ${c.id}  ${c.label ?? ''}  ${c.cwd ?? ''}`)
		}
	}
	process.exit(e.exit)
}
