import { relative, sep } from 'node:path'
import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxTarget, PaneRect, RegionPane, WorkspaceTab } from './mux.ts'
import type { PaneNode, SplitNode, TabNode, Template, TemplateNode } from './template.ts'

/**
 * A live region, run backwards into a template — `template save`. PURE, like `template.ts` and for the
 * same reason: the hard part here is geometry, not I/O, and keeping every seam out means the n-ary
 * lowering, the ratio arithmetic and the ambiguous-grid rule are all testable with plain numbers and
 * no multiplexer at all.
 *
 * This is `desugar`'s inverse, and the fact that both directions land on the same canonical tree —
 * the right-comb — is the evidence the schema is coherent rather than arbitrary. Exporting a region
 * that `arrange: even-horizontal` built gives back that comb, ratios and all.
 *
 * **What it recovers, and what it cannot.** Geometry, labels and dirs. NEVER commands — and the
 * reason is portability, not availability. A backend CAN often say what is running: herdr's
 * `pane process-info` hands back full argv for a pane's whole foreground tree, and `/proc` gets there
 * from a pid on any backend. What none of them can give back is a command worth writing into a
 * template, because what they report is the RESOLVED command line, not the one a human typed:
 * `nr web dev` comes back as `node /run/user/1000/fnm_multishells/4223_1784479278417/bin/nr web dev`,
 * a path carrying a uid, a pid and a timestamp that is dead on the next machine and often on the next
 * login. An idle pane reports its shell, and a `claude` pane reports exactly `claude` with the flags
 * that made it that session already gone.
 *
 * A template is a statement about how a project is worked on, meant to be checked in and run
 * elsewhere; a machine-local argv is the opposite of that, and `apply` SUBMITS whatever `command`
 * says, so a wrong one fails by executing something. Absent beats wrong here, exactly as it does for
 * a pane's `label`. A template out of this module is a DRAFT with `command` left for the author.
 */

/** A partition of the region — the same shape as `TemplateNode`, before panes become `PaneNode`s. */
type RegionTree = RegionLeaf | RegionSplit

interface RegionLeaf {
	type: 'pane'
	pane: RegionPane
}

interface RegionSplit {
	type: 'split'
	direction: 'right' | 'down'
	ratio?: number | undefined
	first: RegionTree
	second: RegionTree
}

export interface TemplateCapture {
	template: Template
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
 * pane one cell wide in a wide region rounds to `0`, which `validateTemplate` rejects outright, so an
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
function toDir(
	paneCwd: string | undefined,
	rootCwd: string | undefined,
): { dir?: string | undefined; outside: boolean } {
	if (!paneCwd || !rootCwd) return { outside: false }
	const rel = relative(rootCwd, paneCwd)
	if (rel === '') return { outside: false }
	if (rel.startsWith('..') || rel.split(sep).includes('..')) return { outside: true }
	return { dir: rel, outside: false }
}

/** The pane sitting on the region's own root — follow `first` down, exactly as `firstPane` does. */
function rootOf(tree: RegionTree): RegionPane {
	return tree.type === 'pane' ? tree.pane : rootOf(tree.first)
}

export interface CaptureTemplateOptions {
	/** The template's `name` — validated by the caller, since a name is also a lookup key. */
	name: string
	description?: string | undefined
}

/**
 * Capture a region into a template.
 *
 * The root pane's cwd becomes the template's implicit target — every other pane's `dir` is measured
 * from it — because that is precisely what apply injects `--cwd` as. A pane elsewhere on the disk
 * cannot be expressed and says so in `warnings`.
 */
export function captureTemplate(panes: RegionPane[], opts: CaptureTemplateOptions): TemplateCapture {
	if (panes.length === 0) throw new Error('a capture needs at least one pane — this region reported none')
	const tree = partition(panes)
	const ctx = context(rootOf(tree).cwd)
	const template = shell(opts)
	template.root = convert(tree, ctx)
	return { template, warnings: ctx.warnings }
}

/**
 * Capture a whole workspace into a `tabs` template — the exact inverse of the tabs walk, and
 * `captureTemplate` one level up rather than a second derivation: each tab's tree comes off the SAME
 * `partition`, because a tab is a region and the geometry rules cannot depend on how many of them
 * there are.
 *
 * One thing is workspace-WIDE rather than per-tab, and it follows from what the schema already says:
 * the target is the FIRST tab's root pane, because that is the pane apply's `--cwd` opens the
 * workspace at, so every tab's `dir` is measured from that one root.
 */
export function captureWorkspaceTemplate(tabs: WorkspaceTab[], opts: CaptureTemplateOptions): TemplateCapture {
	if (tabs.length === 0) throw new Error('a workspace capture needs at least one tab — this workspace reported none')
	const trees = tabs.map((tab) => {
		if (tab.panes.length === 0) {
			throw new Error(`a capture needs at least one pane — tab ${tab.id} reported none`)
		}
		return partition(tab.panes)
	})
	const ctx = context(rootOf(trees[0]!).cwd)
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
function shell(opts: CaptureTemplateOptions): Template {
	const template: Template = { name: opts.name }
	if (opts.description) template.description = opts.description
	return template
}

/**
 * What converting a tree needs to know that the tree itself does not carry: the target the `dir`s are
 * measured from, and somewhere to say what could not be expressed.
 *
 * Shared by both captures deliberately — a workspace's `dir`s are measured from ONE root, so threading
 * one context through every tab is what makes them so.
 */
interface CaptureContext {
	rootCwd: string | undefined
	warnings: string[]
}

function context(rootCwd: string | undefined): CaptureContext {
	return { rootCwd, warnings: [] }
}

function toPaneNode(pane: RegionPane, ctx: CaptureContext): PaneNode {
	const node: PaneNode = { type: 'pane' }
	// A label two panes share is captured onto BOTH, verbatim. It got there because a human renamed the
	// pane by hand, which is the exact fact this capture exists to preserve — dropping it would report
	// "no label" where there is one, against the absent-rather-than-false rule the rest of this node
	// follows. Nothing keys on a label, so a shared one is a name two panes have, not a collision.
	if (pane.label) node.label = pane.label
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
 * emit one: what a backend can report about a running pane is a resolved, machine-local command line
 * rather than a portable one (the module doc has the why), so a capture at any tier is a DRAFT with
 * `command` left for the author.
 */
function convert(node: RegionTree, ctx: CaptureContext): TemplateNode {
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

/**
 * A capture asked of a backend that lacks the optional geometry seam it needs — no `describeRegion`
 * for a region capture, no `describeWorkspace` for a `--workspace` one. An absent optional seam member
 * is a refusal, never a guess: a backend that cannot answer cannot be captured and there is nothing to
 * degrade to.
 *
 * PORTABLE and exit-code-free by design. The DECISION to refuse is the library's and lives here, at
 * the one place that sees the adapter — the pure `captureTemplate` above takes rectangles already read
 * and could never make it. How the refusal SURFACES — the exit code, the fix hint, the exact sentence
 * — is the CLI's, which catches this and re-raises its own `backend-unsupported` error. `capability`
 * names which seam was missing so the caller composes the right message without re-deriving it, and
 * the terse `message` is a factual log line, not the user-facing copy.
 */
export class CaptureUnsupportedError extends Error {
	constructor(
		readonly backend: string,
		readonly capability: 'region' | 'workspace',
	) {
		super(
			capability === 'region'
				? `${backend} cannot report a region's geometry`
				: `${backend} cannot enumerate a workspace's tabs`,
		)
		this.name = 'CaptureUnsupportedError'
	}
}

/**
 * Read the live region around `target` through the adapter and derive its template — the
 * surface-independent orchestrator `template save` drives, and the single home of the region-capture
 * refusal. The optional `regions` seam is where a backend says whether it can report geometry at all;
 * a backend without `describeRegion` is refused HERE (`CaptureUnsupportedError`), before any read,
 * because the pure `captureTemplate` it would feed cannot see the adapter and so cannot make that
 * call. A backend that CAN report reads its region and hands the rectangles to the pure capture
 * unchanged.
 */
export function deriveRegionCapture(
	adapter: MuxAdapter,
	exec: Exec,
	target: MuxTarget,
	opts: CaptureTemplateOptions,
): TemplateCapture {
	const describeRegion = adapter.regions?.describeRegion
	if (!describeRegion) throw new CaptureUnsupportedError(adapter.name, 'region')
	return captureTemplate(describeRegion(exec, target), opts)
}

/**
 * Read every tab of the workspace `target` sits in through the adapter and derive a `tabs` template —
 * the `--workspace` orchestrator, and the single home of the workspace-capture refusal. Same shape as
 * `deriveRegionCapture`, one member over: a backend without `describeWorkspace` cannot enumerate a
 * workspace's tabs and is refused HERE (`CaptureUnsupportedError`), before any read.
 */
export function deriveWorkspaceCapture(
	adapter: MuxAdapter,
	exec: Exec,
	target: MuxTarget,
	opts: CaptureTemplateOptions,
): TemplateCapture {
	const describeWorkspace = adapter.regions?.describeWorkspace
	if (!describeWorkspace) throw new CaptureUnsupportedError(adapter.name, 'workspace')
	return captureWorkspaceTemplate(describeWorkspace(exec, target), opts)
}
