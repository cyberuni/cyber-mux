import { relative, sep } from 'node:path'
import type { LayoutNode, LayoutTemplate, PaneNode, SplitNode, TabNode } from './layout.ts'
import type { PaneRect, RegionPane, WorkspaceTab } from './session.ts'

/**
 * A live region, run backwards into a template — `layout save`. PURE, like `layout.ts` and for the
 * same reason: the hard part here is geometry, not I/O, and keeping every seam out means the n-ary
 * lowering, the ratio arithmetic and the ambiguous-grid rule are all testable with plain numbers and
 * no multiplexer at all.
 *
 * This is `desugar`'s inverse, and the fact that both directions land on the same canonical tree —
 * the right-comb — is the evidence the schema is coherent rather than arbitrary. Exporting a region
 * that `arrange: even-horizontal` built gives back that comb, ratios and all.
 *
 * **What it recovers, and what it cannot.** Geometry, labels and dirs. NEVER commands: no backend
 * can give a launch command back. cyber-mux types commands with `submit` rather than passing them to
 * the split (herdr's `pane split` takes no command at all), so tmux's `pane_start_command` is empty
 * for every pane cyber-mux ever created, and `pane_current_command` reports `zsh` or `node` — never
 * `claude --foo`. A template out of this module is a DRAFT with `command` left for the author.
 */

/** A partition of the region — the same shape as `LayoutNode`, before panes become `PaneNode`s. */
type RegionTree = RegionLeaf | RegionSplit

interface RegionLeaf {
	type: 'pane'
	pane: RegionPane
}

interface RegionSplit {
	type: 'split'
	direction: 'right' | 'down'
	ratio?: number
	first: RegionTree
	second: RegionTree
}

export interface LayoutCapture {
	template: LayoutTemplate
	/**
	 * What the capture could not express, for the caller to print. Returned rather than written to
	 * stderr so this module stays pure and the rules stay testable without capturing output.
	 */
	warnings: string[]
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
function partition(panes: RegionPane[]): RegionTree {
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
		first: partition(cut.first),
		second: partition(cut.second),
	}
	const ratio = roundRatio(cut.ratio)
	// An even split is the schema's DEFAULT, so an even cut emits no ratio at all rather than `0.5`.
	// Keeps an exported grid as clean as the hand-written one it should match.
	if (ratio !== 0.5) node.ratio = ratio
	return node
}

/**
 * Two decimals, and clamped strictly inside `(0, 1)`.
 *
 * Two because the emitted template is meant to be READ and edited: a 3-pane row wants `0.33`, not
 * `0.33167`, and the cell it costs is invisible. The clamp is the guard on a degenerate capture — a
 * pane one cell wide in a wide region rounds to `0`, which `validateLayout` rejects outright, so an
 * export of a real screen would emit a template that fails its own validator.
 */
function roundRatio(ratio: number): number {
	const rounded = Math.round(ratio * 100) / 100
	return Math.min(0.99, Math.max(0.01, rounded))
}

/**
 * The `dir` a pane's cwd becomes: relative to the root, or `undefined` when it IS the root or sits
 * outside it. Apply's injection run backwards — apply joins `cwd + dir`, so export subtracts.
 *
 * The schema forbids `cwd` outright, so a pane outside the root has nowhere to put its location and
 * genuinely loses it. That is reported as a warning rather than dropped in silence, and never
 * emitted as a `..` path: `dir` must stay under the apply-time target, so a template that escaped it
 * would fail validation on the way back in.
 */
function toDir(paneCwd: string | undefined, rootCwd: string | undefined): { dir?: string; outside: boolean } {
	if (!paneCwd || !rootCwd) return { outside: false }
	const rel = relative(rootCwd, paneCwd)
	if (rel === '') return { outside: false }
	if (rel.startsWith('..') || rel.split(sep).includes('..')) return { outside: true }
	return { dir: rel, outside: false }
}

/**
 * Every label carried by more than one pane in the region.
 *
 * A live region has no uniqueness rule — nothing stops a user labeling two panes `worker`, and on
 * tmux nothing stops two panes sharing a title by accident. A template has the opposite rule: a
 * duplicate label is a hard validation error, because `label` is the apply manifest's KEY. This is
 * the one place the live model and the schema genuinely disagree, so the capture has to resolve it.
 */
function duplicatedLabels(panes: RegionPane[]): Set<string> {
	const seen = new Set<string>()
	const duplicated = new Set<string>()
	for (const pane of panes) {
		if (!pane.label) continue
		if (seen.has(pane.label)) duplicated.add(pane.label)
		seen.add(pane.label)
	}
	return duplicated
}

/** The pane sitting on the region's own root — follow `first` down, exactly as `firstPane` does. */
function rootOf(tree: RegionTree): RegionPane {
	return tree.type === 'pane' ? tree.pane : rootOf(tree.first)
}

export interface CaptureLayoutOptions {
	/** The template's `name` — validated by the caller, since a name is also a lookup key. */
	name: string
	description?: string
}

/**
 * Capture a region into a template.
 *
 * The root pane's cwd becomes the template's implicit target — every other pane's `dir` is measured
 * from it — because that is precisely what apply injects `--cwd` as. A pane elsewhere on the disk
 * cannot be expressed and says so in `warnings`.
 */
export function captureLayout(panes: RegionPane[], opts: CaptureLayoutOptions): LayoutCapture {
	if (panes.length === 0) throw new Error('a capture needs at least one pane — this region reported none')
	const tree = partition(panes)
	const ctx = context(panes, rootOf(tree).cwd)
	const template = shell(opts)
	template.root = convert(tree, ctx)
	return { template, warnings: ctx.warnings }
}

/**
 * Capture a whole workspace into a `tabs` template — the exact inverse of the tabs walk, and
 * `captureLayout` one level up rather than a second derivation: each tab's tree comes off the SAME
 * `partition`, because a tab is a region and the geometry rules cannot depend on how many of them
 * there are.
 *
 * Two things are workspace-WIDE rather than per-tab, and both follow from what the schema already
 * says. The target is the FIRST tab's root pane, because that is the pane apply's `--cwd` opens the
 * workspace at, so every tab's `dir` is measured from that one root. And label collisions are
 * detected across every tab at once — the apply manifest is one flat list for the whole workspace, so
 * its keys are global, which is exactly why the schema demands pane labels unique across tabs rather
 * than within one.
 */
export function captureWorkspaceLayout(tabs: WorkspaceTab[], opts: CaptureLayoutOptions): LayoutCapture {
	if (tabs.length === 0) throw new Error('a workspace capture needs at least one tab — this workspace reported none')
	const trees = tabs.map((tab) => {
		if (tab.panes.length === 0) {
			throw new Error(`a capture needs at least one pane — tab ${tab.id} reported none`)
		}
		return partition(tab.panes)
	})
	const ctx = context(
		tabs.flatMap((tab) => tab.panes),
		rootOf(trees[0]!).cwd,
	)
	const template = shell(opts)
	template.tabs = tabs.map((tab, index) => {
		const node: TabNode = {}
		// The label the tab carries, verbatim — never a workspace parsed back out of it. On a backend
		// with no workspace tier this is the composed `<workspace> - <tab>` the walk wrote, and
		// `acme - beta - main` reads as two different groupings under every split rule, so recovering one
		// is guessing. The grouping came from the tag; this is a human's to read and to fix up by hand.
		if (tab.label) node.label = tab.label
		node.root = convert(trees[index]!, ctx)
		return node
	})
	return { template, warnings: ctx.warnings }
}

/** The template every capture starts from — the fields that owe nothing to the geometry. */
function shell(opts: CaptureLayoutOptions): LayoutTemplate {
	const template: LayoutTemplate = { name: opts.name }
	if (opts.description) template.description = opts.description
	return template
}

/**
 * What converting a tree needs to know that the tree itself does not carry: the target the `dir`s are
 * measured from, the labels no pane may keep, and somewhere to say what could not be expressed.
 *
 * Shared by both captures deliberately — a workspace's `dir`s and label collisions are global, so
 * threading one context through every tab is what makes them so.
 */
interface CaptureContext {
	rootCwd: string | undefined
	collisions: Set<string>
	warnings: string[]
}

function context(panes: RegionPane[], rootCwd: string | undefined): CaptureContext {
	const warnings: string[] = []
	const collisions = duplicatedLabels(panes)
	for (const label of collisions) {
		warnings.push(
			`two or more panes are labeled "${label}" — a label is the manifest's key, so it must be unique. ` +
				'Every pane carrying it is captured without a label; name them apart yourself',
		)
	}
	return { rootCwd, collisions, warnings }
}

function toPaneNode(pane: RegionPane, ctx: CaptureContext): PaneNode {
	const node: PaneNode = { type: 'pane' }
	// A label shared by two panes is dropped from BOTH rather than kept on the first. It is a real
	// case — a user labels two panes `worker` — and the schema rejects the duplicate outright, so
	// keeping it would emit a template that fails the very validator this capture has to satisfy.
	// Keeping the first instead would be worse than dropping: nothing in the region says which pane
	// the author meant by the name, so picking one invents an answer.
	if (pane.label && !ctx.collisions.has(pane.label)) node.label = pane.label
	const { dir, outside } = toDir(pane.cwd, ctx.rootCwd)
	if (dir) node.dir = dir
	if (outside) {
		ctx.warnings.push(
			`pane ${pane.id}${pane.label ? ` ("${pane.label}")` : ''} runs in ${pane.cwd}, which is not under the ` +
				`captured root ${ctx.rootCwd} — a template cannot pin a directory, so this pane is captured without one`,
		)
	}
	return node
}

/**
 * A partition into schema nodes. `command` is never emitted and there is no branch here that could
 * emit one: no multiplexer reports the command a pane was launched with, so a capture at any tier is
 * a DRAFT with `command` left for the author.
 */
function convert(node: RegionTree, ctx: CaptureContext): LayoutNode {
	if (node.type === 'pane') return toPaneNode(node.pane, ctx)
	const split: SplitNode = {
		type: 'split',
		direction: node.direction,
		first: convert(node.first, ctx),
		second: convert(node.second, ctx),
	}
	if (node.ratio !== undefined) split.ratio = node.ratio
	return split
}
