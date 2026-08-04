/**
 * The READ WINDOW: how much of a pane a capture asks for, and whether rows sat above what came back.
 *
 * Both halves live here because they are one question. A capture is bounded — by the caller's `lines`,
 * or by the backend's own default (the viewport on all four) — and "was anything dropped" is a
 * property of that bound. Unbind the window (`lines: 'all'`) and the answer is `false` by
 * construction, with no probe to spend.
 *
 * The truncation rule itself is shared by every adapter so the four backends answer
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

/**
 * The row count that stands in for "the whole scrollback" on a backend whose read takes a NUMBER and
 * has no all-history token of its own (WezTerm's `--start-line`, herdr's `--lines`) — tmux (`-S -`)
 * and Zellij (`--full`) say it exactly and never reach for this.
 *
 * A million rows is past any real pane's history (tmux's own `history-limit` defaults to 2000) and
 * both backends CLAMP an over-deep window to what they hold rather than failing, so this reads as
 * "everything" without pretending to be a precise number. It stays under a u32, which is what herdr's
 * CLI parses `--lines` as.
 */
export const FULL_SCROLLBACK_LINES = 1_000_000
