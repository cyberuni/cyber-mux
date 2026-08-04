import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxTarget, MuxWaitOptions, MuxWaitResult } from './mux.ts'

/** How long a polling backend sleeps between reads when the caller names no cadence. */
export const DEFAULT_WAIT_POLL_MS = 150

/**
 * The seam's own precondition on a wait pattern: EXACTLY ONE of `match`/`regex`, and a `regex` that
 * compiles.
 *
 * Enforced here, at the seam, rather than per adapter, for `assertRatioInRange`'s reason — it is a
 * universal property of what a wait pattern IS, true on every backend, not a per-backend policy. Both
 * halves matter for portability in different ways: the one-of rule is refusable by herdr's CLI and by
 * nothing at all on a polling backend, so leaving it to the backend would make the same call fail on
 * one and silently pick a winner on another; and compiling the source turns a MALFORMED pattern into
 * the same loud failure everywhere, instead of a herdr refusal on one backend and a poll that throws
 * on its first read somewhere else.
 *
 * What it deliberately does NOT check is dialect: a pattern using ECMAScript-only syntax compiles here
 * and is then herdr's own to accept or refuse (see `MuxWaitOptions.regex`). Validating against the
 * intersection of two regex engines would mean shipping a third one.
 */
export function assertWaitPattern(opts: MuxWaitOptions): void {
	const hasMatch = opts.match != null
	const hasRegex = opts.regex != null
	if (hasMatch && hasRegex) {
		throw new Error('wait pattern must be one of match or regex — got both')
	}
	if (!hasMatch && !hasRegex) {
		throw new Error('wait pattern must be one of match or regex — got neither')
	}
	if (opts.match != null && opts.match === '') {
		// An empty needle matches every snapshot, including an empty one, so the wait would return
		// instantly no matter what the pane is doing — a spelling whose result carries no information.
		throw new Error('wait pattern match must not be empty')
	}
	if (opts.regex != null) {
		try {
			new RegExp(opts.regex)
		} catch (err) {
			throw new Error(`wait pattern regex is not a valid expression: ${opts.regex} — ${(err as Error).message}`)
		}
	}
}

/**
 * Whether `output` satisfies the pattern, and the single line to point at when it does.
 *
 * The match runs against the WHOLE snapshot, not line by line, so a regex that spans a newline still
 * hits — that is why `matchedLine` is derived separately and left absent when no single line carries
 * the match on its own. Pure, so the tricky half is testable with no multiplexer at all, exactly as
 * `template-capture`'s geometry derivation is.
 */
export function matchWaitPattern(output: string, opts: MuxWaitOptions): MuxWaitResult {
	assertWaitPattern(opts)
	const hit = (text: string): boolean =>
		opts.match != null ? text.includes(opts.match) : new RegExp(opts.regex as string).test(text)
	if (!hit(output)) return { matched: false, output }
	const line = output.split('\n').find(hit)
	return { matched: true, output, ...(line != null ? { matchedLine: line } : {}) }
}

/**
 * `waitForOutput` for a backend with NO native wait — poll its own `read` until the pattern matches or
 * the deadline passes. tmux, WezTerm and Zellij all route their seam method straight through here, so
 * the three share one cadence, one deadline rule and one liveness rule rather than three copies that
 * can drift; herdr overrides it with its native primitive.
 *
 * **Reads first, sleeps second.** The snapshot on screen when the call arrives is searched before any
 * sleeping, so a pattern already printed returns immediately — the seam's stated "existing output
 * counts" rule, and the same order herdr's native wait documents for itself.
 *
 * **A gone pane throws instead of timing out**, which is `nudge`'s rule for the same reason: a dead
 * pane and a quiet one both read back empty, so without the liveness probe every dead peer would be
 * reported as a timeout — a shape the caller reads as "still working" — and the real cause would be
 * buried. Probed BEFORE the first read (so a pane that was already gone fails at once rather than
 * after the full timeout) and again after the deadline (so a pane that died mid-wait is not reported as
 * one that merely stayed quiet). Never probed per poll: that would double every backend's query load
 * for a fact that only changes the verdict at the end.
 */
export async function pollForOutput(
	adapter: MuxAdapter,
	exec: Exec,
	target: MuxTarget,
	opts: MuxWaitOptions,
): Promise<MuxWaitResult> {
	assertWaitPattern(opts)
	const pollMs = opts.pollMs ?? DEFAULT_WAIT_POLL_MS
	const now = opts.now ?? (() => Date.now())
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const readOpts = opts.lines != null ? { lines: opts.lines } : undefined

	assertPaneLive(adapter, exec, target)

	const deadline = now() + opts.timeoutMs
	let output = ''
	for (;;) {
		// The TEXT alone: a poll never asks for `truncation`, which costs an extra backend query per read
		// and answers a question this loop does not ask — it searches the snapshot it was given.
		output = adapter.read(exec, target, readOpts).text
		const result = matchWaitPattern(output, opts)
		if (result.matched) return result
		// Checked AFTER a read, so a zero/elapsed timeout still gets its one look at the pane: the wait
		// promises a search of what is already there, and `timeoutMs: 0` means "look once", not "look never".
		if (now() >= deadline) break
		await sleep(pollMs)
	}
	assertPaneLive(adapter, exec, target)
	return { matched: false, output }
}

/** The liveness probe both ends of a poll share, throwing `nudge`'s named failure rather than letting a
 * dead pane be reported as a quiet one. */
function assertPaneLive(adapter: MuxAdapter, exec: Exec, target: MuxTarget): void {
	if (!adapter.paneExists(exec, target)) {
		throw new Error(`wait failed: pane ${target.id} no longer exists — the pane is gone, not quiet.`)
	}
}
