/**
 * The seam's portable truncation rule, shared by every adapter so the four backends answer
 * `MuxReadResult.truncated` by one definition rather than four that can drift — the same reason
 * `pollForOutput` owns one poll cadence for the three polling backends.
 *
 * Pure, and deliberately so: the tricky half of the answer is a row count, testable with no
 * multiplexer at all (`template-capture`'s geometry derivation is the precedent). Each adapter owns
 * only the one thing that genuinely differs — how its backend spells "one row deeper".
 */

/**
 * How many terminal ROWS a capture carries.
 *
 * A trailing newline is a terminator, not an empty row: `capture-pane` and `dump-screen` both end
 * their output with one, so counting it would make every capture look one row longer than the screen
 * and — worse — would compare unequal against a probe that happened not to end with one. An empty
 * capture is zero rows, not one.
 */
export function capturedRows(text: string): number {
	if (text === '') return 0
	return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
}

/**
 * Whether `capture` omitted older rows, judged against `deeper` — the SAME read taken one row further
 * back.
 *
 * More rows in the deeper read means there was output above the captured window that the caller did
 * not receive. An equal (or smaller) count means the deeper read had nothing more to give: the
 * backend clamped at the top of what it holds, so the caller has everything there is.
 *
 * Row counts, not text equality, because the two reads are not required to render the shared rows
 * identically — herdr's deeper probe reads a different `--source`, and a backend may re-wrap. What
 * both reads DO agree on is how many rows they returned, and that is the whole question.
 */
export function isReadTruncated(capture: string, deeper: string): boolean {
	return capturedRows(deeper) > capturedRows(capture)
}
