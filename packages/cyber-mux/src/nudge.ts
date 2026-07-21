import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxTarget } from './mux.ts'

/** Max flush re-submits after the initial submit, before nudge fails loud. */
const DEFAULT_ATTEMPTS = 10
/** Wait after a submit before reading the pane back, in ms. */
const DEFAULT_SETTLE_MS = 400
/** How many trailing non-empty lines of `visible` count as the "input box" tail scanned for staged text. */
const TAIL_LINES = 5
/** Length of the message prefix used as the staged-text needle. */
const NEEDLE_LEN = 40

export interface NudgeOptions {
	/** Max flush re-submits after the initial send; default 10. */
	attempts?: number | undefined
	/** Wait after a submit before reading back, in ms; default 400. */
	settleMs?: number | undefined
	sleep?: ((ms: number) => Promise<void>) | undefined
}

export interface NudgeResult {
	taken: boolean
	resubmits: number
}

/**
 * Whether `message` is still sitting staged in `visible`'s input box (not yet submitted). A real
 * submit scrolls the message into the transcript, leaving the bottom input box empty, so the
 * needle is absent from the tail; while staged it sits in the bottom input box, so the needle is
 * present. `visible` being null/empty means the turn can't be confirmed — treated as still staged
 * so callers keep retrying rather than falsely reporting success.
 */
export function isStaged(visible: string | null | undefined, message: string): boolean {
	if (!visible) return true
	const collapsedMessage = message.replace(/\s+/g, ' ').trim()
	const needle = collapsedMessage.slice(0, NEEDLE_LEN)
	if (needle === '') return true
	const tailLines = visible
		.split('\n')
		.filter((l) => l.trim() !== '')
		.slice(-TAIL_LINES)
	const tail = tailLines.join(' ').replace(/\s+/g, ' ').trim()
	return tail.includes(needle)
}

/**
 * Submit `message` to `target` and verify the peer actually took the turn — a booting harness can
 * swallow the Enter of the initial `submit`, leaving the text staged unsent while nudge would
 * otherwise report false success. Types the message exactly once; a swallowed Enter is recovered by
 * flushing the staged buffer (`adapter.submit` with no text, a bare Enter) — never re-typing the
 * message — up to a bounded number of attempts. Throws if the turn is never taken within the cap.
 *
 * A pane that no longer exists is rejected up front rather than retried: a gone pane and a booting
 * one both read back empty, so without the liveness probe the retry loop reports a dead peer as
 * "never took the turn" — a boot-race shape — and buries the real cause.
 */
export async function nudge(
	adapter: MuxAdapter,
	exec: Exec,
	target: MuxTarget,
	message: string,
	opts: NudgeOptions = {},
): Promise<NudgeResult> {
	const attempts = opts.attempts ?? DEFAULT_ATTEMPTS
	const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

	if (!adapter.paneExists(exec, target)) {
		throw new Error(`nudge failed: pane ${target.id} no longer exists — the peer's session is gone, not busy.`)
	}

	adapter.submit(exec, target, message)
	await sleep(settleMs)
	if (!isStaged(adapter.read(exec, target), message)) return { taken: true, resubmits: 0 }

	for (let attempt = 1; attempt <= attempts; attempt++) {
		adapter.submit(exec, target)
		await sleep(settleMs)
		if (!isStaged(adapter.read(exec, target), message)) return { taken: true, resubmits: attempt }
	}

	throw new Error(
		`nudge failed: peer at pane ${target.id} never took the turn — input still staged after ${attempts} re-submit attempts`,
	)
}
