import type { PaneRect, RegionPane } from './mux.ts'

/**
 * The region-geometry derivation: a flat list of `RegionPane` rectangles cut back into the binary
 * split tree the multiplexer built them by, plus the one lookup a WRITE needs — which split a given
 * pane sits directly inside.
 *
 * Its own module because two different capabilities now derive the SAME tree from the same rects, and
 * a second derivation is the way they come to disagree about the user's screen. `template save`
 * (`template-capture.ts`) reads the tree forwards into a template; `RegionInspector.resizePane`
 * (the tmux, rmux and herdr adapters) reads one node of it to turn a ratio into its backend's own resize
 * argument. Both are downstream of `RegionInspector.describeRegion`'s promise — rects, never a tree —
 * so the guillotine cut lives here, once, and neither imports the other.
 *
 * PURE: rectangles in, tree out, no `Exec` and no adapter. The tricky half — n-ary rows, ambiguous
 * grids, the divider a backend eats — stays testable with plain numbers and no multiplexer at all.
 */

/** A partition of the region — the same shape as `TemplateNode`, before panes become `PaneNode`s. */
export type RegionTree = RegionLeaf | RegionSplit

export interface RegionLeaf {
	type: 'pane'
	pane: RegionPane
}

export interface RegionSplit {
	type: 'split'
	direction: 'right' | 'down'
	/**
	 * The RAW fraction of the split region kept by `first` — full precision, never rounded and never
	 * dropped. `template save` rounds it to two decimals for a template a human reads; a resize needs
	 * every digit, because rounding first and differencing after is how a "restore this to 0.33" lands
	 * a cell off. Presentation is the consumer's, the fact is this module's.
	 */
	ratio: number
	first: RegionTree
	second: RegionTree
}

const right = (rect: PaneRect): number => rect.x + rect.width
const bottom = (rect: PaneRect): number => rect.y + rect.height

/**
 * The axis a cut runs along. `right` means a vertical divider with panes side by side — the schema's
 * vocabulary, where the name says where the NEW pane goes rather than which way the divider lies.
 */
interface Axis {
	direction: 'right' | 'down'
	/** Where a pane starts on this axis. */
	start: (rect: PaneRect) => number
	/** Where a pane ends on this axis. */
	end: (rect: PaneRect) => number
}

const HORIZONTAL: Axis = { direction: 'right', start: (r) => r.x, end: right }
const VERTICAL: Axis = { direction: 'down', start: (r) => r.y, end: bottom }

interface Cut {
	direction: 'right' | 'down'
	ratio: number
	first: RegionPane[]
	second: RegionPane[]
}

/**
 * The lowest cut on this axis that separates the panes cleanly, or `undefined` if none does.
 *
 * Taking the LOWEST rather than any is what produces a right-comb for an n-ary row: three panes side
 * by side cut first into `[a][b c]`, then `[b][c]` — the exact tree `desugar`'s `comb` emits for
 * `arrange: even-horizontal`, reached from the opposite direction.
 *
 * A candidate is any pane's start edge. It separates cleanly when every pane lies wholly before it
 * or wholly after it, and both sides have something in them.
 */
function findCut(panes: RegionPane[], axis: Axis): Cut | undefined {
	const candidates = [...new Set(panes.map((p) => axis.start(p.rect)))].sort((a, b) => a - b)
	for (const at of candidates) {
		const first = panes.filter((p) => axis.end(p.rect) <= at)
		const second = panes.filter((p) => axis.start(p.rect) >= at)
		if (first.length === 0 || second.length === 0) continue
		// Anything straddling the line lands in neither group, so the counts not adding up IS the
		// "this cut crosses a pane" test — no separate overlap check needed.
		if (first.length + second.length !== panes.length) continue
		return { direction: axis.direction, ratio: ratioOf(panes, second, axis), first, second }
	}
	return undefined
}

/**
 * The fraction of the split region kept by `first` — the schema's `ratio`.
 *
 * Measured as the COMPLEMENT of what `second` occupies, over the whole region: `1 - second/total`.
 * The obvious `first / (first + second)` is subtly wrong on any backend that draws a divider, and
 * the arithmetic says why — tmux splitting a 50-row region reports 34 + 15, with the 51st row eaten
 * by the divider. `first / (first + second)` reads 34/49 = 0.69; the true split was 0.7, and the
 * divider row belongs to neither pane's height while still costing the region a row.
 *
 * Taking the complement puts that row back where the backend's own arithmetic puts it: tmux's `-l`
 * sizes the NEW pane, so `second` is exactly the fraction asked for and `first` keeps the rest,
 * divider included. That reads 1 - 15/50 = 0.7 — the number the split was actually made with. On a
 * backend with no divider (herdr) the two formulas agree, so nothing is traded for the fix.
 *
 * Both checked against live binaries: this recovers tmux's `-l 40%`/`-l 30%` splits as 0.6/0.7
 * exactly, and reproduces herdr's to within the cell it rounds to.
 */
function ratioOf(all: RegionPane[], second: RegionPane[], axis: Axis): number {
	const total = extent(all, axis)
	if (total <= 0) return 0.5
	return 1 - extent(second, axis) / total
}

/** How far a group of panes reaches along an axis — its bounding box on that axis. */
function extent(panes: RegionPane[], axis: Axis): number {
	const starts = panes.map((p) => axis.start(p.rect))
	const ends = panes.map((p) => axis.end(p.rect))
	return Math.max(...ends) - Math.min(...starts)
}

/**
 * Cut the region into a binary tree, recursively.
 *
 * **`right` is tried before `down`, and the order is load-bearing on a grid.** A 2x2 is genuinely
 * ambiguous — cutting it vertically first and horizontally first both describe the same screen, and
 * neither is more true. Columns-then-rows is the tie-break because that is what `desugar`'s `tiled`
 * emits, so a tiled pool exports back as the tree it was built from rather than its transpose.
 *
 * A region no cut separates cannot come out of a multiplexer: both backends build regions BY
 * splitting, so every region they can report is guillotine-cuttable by construction. Reaching the
 * throw means the geometry did not come from where we think it did — which is worth saying loudly
 * rather than papering over with a tree that misplaces the user's panes.
 */
export function partition(panes: RegionPane[]): RegionTree {
	if (panes.length === 1) return { type: 'pane', pane: panes[0]! }
	const cut = findCut(panes, HORIZONTAL) ?? findCut(panes, VERTICAL)
	if (!cut) {
		throw new Error(
			`this region's panes do not form a splittable tree (${panes.length} panes: ${panes.map((p) => p.id).join(', ')}) — ` +
				'export can only capture a region built by splitting',
		)
	}
	const node: RegionSplit = {
		type: 'split',
		direction: cut.direction,
		ratio: cut.ratio,
		first: partition(cut.first),
		second: partition(cut.second),
	}
	return node
}

/**
 * The split a pane sits DIRECTLY inside, with the numbers a resize needs — or `undefined` when the
 * region has no split at all (a single-pane region: nothing to take a fraction of).
 *
 * **The target is always one WHOLE side of the split it encloses.** That falls out of the guillotine
 * derivation rather than being asserted: a leaf's parent is the last cut before it, so whichever side
 * of that cut the target lands on holds the target and nothing else. The OTHER side may be a group of
 * panes, which is why it is reported as an extent rather than a pane — a backend sizes the target, and
 * the group on the far side takes what is left.
 *
 * **Extents, not ratios alone, because the backends need different arithmetic.** tmux's
 * `resize-pane -x/-y` takes CELLS, so it needs the split region's extent to turn a fraction into one;
 * herdr's `pane resize --amount` takes a ratio DELTA, so it needs the fraction the split is at now.
 * Reporting both raw facts keeps the per-backend conversion in the adapter that owns it — the same
 * split `MuxOpenOptions.ratio` already makes, where the seam's number is one thing and each backend's
 * rendering of it is another.
 *
 * **`extent` includes the divider a backend draws.** It is the split region's own span, so on tmux
 * `targetExtent + otherExtent` falls one short of it and on herdr the two add up exactly. Neither
 * adapter hard-codes which: the divider is `extent - targetExtent - otherExtent`, measured from the
 * rects the backend just reported.
 */
export function enclosingSplit(panes: RegionPane[], paneId: string): EnclosingSplit | undefined {
	if (!panes.some((p) => p.id === paneId)) {
		throw new Error(`pane ${paneId} is not in the region described (${panes.map((p) => p.id).join(', ')})`)
	}
	let node: RegionTree = partition(panes)
	while (node.type === 'split') {
		const split: RegionSplit = node
		const targetIsFirst = holds(split.first, paneId)
		const side = targetIsFirst ? split.first : split.second
		const other = targetIsFirst ? split.second : split.first
		if (side.type !== 'pane') {
			node = side
			continue
		}
		const axis = split.direction === 'right' ? HORIZONTAL : VERTICAL
		return {
			direction: split.direction,
			targetIsFirst,
			firstRatio: split.ratio,
			extent: extent(leaves(split), axis),
			targetExtent: extent([side.pane], axis),
			otherExtent: extent(leaves(other), axis),
		}
	}
	return undefined
}

/** The facts a resize needs about the split a pane sits directly inside. See `enclosingSplit`. */
export interface EnclosingSplit {
	/** The split's axis: `right` = the two sides sit side by side, `down` = one above the other. */
	direction: 'right' | 'down'
	/** Whether the target is the split's FIRST side — the left one on `right`, the top one on `down`. */
	targetIsFirst: boolean
	/** The fraction of the split region currently kept by the FIRST side — the seam's `ratio` convention. */
	firstRatio: number
	/** The split region's own span along the axis, INCLUDING any divider the backend draws. */
	extent: number
	/** The target pane's span along the axis. */
	targetExtent: number
	/** The far side's span along the axis — one pane, or the bounding box of the group there. */
	otherExtent: number
}

/** Whether `paneId` is somewhere under `node`. */
function holds(node: RegionTree, paneId: string): boolean {
	return leaves(node).some((p) => p.id === paneId)
}

/** Every pane under `node`, in order. */
function leaves(node: RegionTree): RegionPane[] {
	return node.type === 'pane' ? [node.pane] : [...leaves(node.first), ...leaves(node.second)]
}
