/**
 * The seam's own precondition on `MuxOpenOptions.ratio`: a fraction STRICTLY between 0 and 1.
 *
 * `ratio` is the fraction kept by the ORIGINAL pane. Outside `0 < ratio < 1` there is no split it can
 * name: `1 - ratio` goes negative above 1 (tmux `-l -50%` / wezterm `--percent -50`), and 0 or 1 hands
 * one side the whole region and the other nothing — a mistake, never an intent worth honoring. Left
 * unrendered these produce a silently broken split, not an error, which is the exact silent-wrong
 * output this seam's loud-over-quiet preference exists to refuse.
 *
 * Enforced HERE, at the seam, rather than left to each caller, because the invariant is a universal
 * property of what a ratio IS — true on every backend — not a per-caller policy. (The DEGRADE policy —
 * what a caller does when a backend cannot size a split at all — genuinely stays the caller's, unchanged;
 * range validity and degrade policy are different questions.) A caller cannot reach an adapter with an
 * out-of-range ratio and have it silently rendered; `template`'s schema still refuses one earlier, per
 * node, with a path-qualified message, so the two layers do different jobs and the seam is the backstop.
 *
 * The guard lives WITH the rendering: it is called by each backend's size render helper, so a backend
 * that cannot size a split (zellij) renders no ratio and so never reaches this guard — a dropped value
 * is never checked, valid or not, which is the same as the even-default degrade its callers already take.
 */
export function assertRatioInRange(ratio: number): void {
	if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
		throw new Error(`ratio must be strictly between 0 and 1 — got ${ratio}`)
	}
}
