import { isAbsolute, normalize } from 'node:path'

/**
 * The layout schema, its parser, its validator, and the flat-N desugarer — PURE. No `Exec`, no
 * filesystem, no multiplexer, by design: keeping this module free of every seam is what makes the
 * schema, the desugaring, and every validation rule testable with no mock at all.
 *
 * The rule the whole capability exists to enforce lives here: `cwd` is not in the schema. It is not
 * an optional field a template may set and apply ignores — a template carrying one FAILS VALIDATION,
 * because an ignored key would quietly make a template non-reusable, which is the one thing a
 * template must be.
 */

/** A leaf: one pane, and what it starts as. Nothing about the target directory is in here. */
export interface PaneNode {
	type: 'pane'
	/**
	 * Names the pane. A NAME, never a key: the manifest's unique handle is the pane id, and nothing
	 * keys on this, so two panes may share one. A pool of workers all named `worker` is a legitimate
	 * thing to mean, and neither backend requires otherwise.
	 */
	label?: string
	/** Submitted after the geometry is built; omit for a blank shell. */
	command?: string
	/** Set in the pane's environment at birth. Valid with or without `command`. */
	env?: Record<string, string>
	/** A RELATIVE subdirectory joined onto the apply-time cwd. Absolute or `..`-escaping is invalid. */
	dir?: string
}

/**
 * A binary split. `direction` is deliberately `SessionPlacement`'s vocabulary rather than
 * horizontal/vertical: tmux's `-h` means "side by side" while most readers take "horizontal" to mean
 * "a horizontal divider", and that ambiguity has burned every tool that shipped it. `right`/`down`
 * say where the new pane goes and cannot be misread.
 */
export interface SplitNode {
	type: 'split'
	direction: 'right' | 'down'
	/** Fraction kept by `first` — the ORIGINAL pane. `0 < ratio < 1`; omitted means an even split. */
	ratio?: number
	/** Keeps the region's existing pane. */
	first: LayoutNode
	/** Gets the newly split-off pane. */
	second: LayoutNode
}

export type LayoutNode = PaneNode | SplitNode

/** Names borrowed from tmux's built-ins, because they are the names people already know. */
export type Arrange = 'tiled' | 'even-horizontal' | 'even-vertical'

const ARRANGES: readonly string[] = ['tiled', 'even-horizontal', 'even-vertical']

/** A pane in the flat (`panes` + `arrange`) sugar — a `PaneNode` with the discriminant implied. */
export type FlatPane = Omit<PaneNode, 'type'>

/**
 * ONE tab's worth of structure, in either spelling — the explicit tree or the flat sugar. This is the
 * shape a top-level template has always had, named so a tab can reuse it WHOLESALE rather than
 * introducing a second vocabulary: a tab is a tree plus a name. `resolveTree` takes this, so the tab
 * tier and the template tier resolve through the very same desugarer and cannot drift apart.
 */
export interface LayoutTree {
	/** The split tree. Exactly one of `root` / `panes`. */
	root?: LayoutNode
	/** The flat sugar's pane pool. Exactly one of `root` / `panes`. */
	panes?: FlatPane[]
	/** How `panes` is arranged; defaults to `tiled`. Ignored (and invalid) alongside `root`. */
	arrange?: Arrange
}

/**
 * One tab of a workspace: a `LayoutTree` plus a name. `cwd` is no more permitted here than on a pane —
 * the rule the whole capability exists to enforce does not weaken because a level was added.
 */
export interface TabNode extends LayoutTree {
	/**
	 * Names the tab. A name rather than a key, exactly as a pane's label is: a tab is addressed by its
	 * own id at the seam and the manifest reports a pane's tab by INDEX, so two tabs may share a label.
	 * Omit to leave the tab's name to the backend's own default.
	 */
	label?: string
}

export interface LayoutTemplate extends LayoutTree {
	name: string
	description?: string
	/**
	 * The two-level form: a workspace of N tabs, each its own tree. Exactly one of `root` / `panes` /
	 * `tabs` — `root` and `panes` are the one-tab spelling.
	 */
	tabs?: TabNode[]
}

/**
 * A template name is `[a-z0-9][a-z0-9-]*` and must equal its file's stem, so a name can never
 * traverse out of the layouts directory. Checked BEFORE any file is read — a name is a lookup key,
 * not a path, and treating it as one is how `../../../etc/pwd` becomes a read.
 */
const LAYOUT_NAME = /^[a-z0-9][a-z0-9-]*$/

export function isValidLayoutName(name: string): boolean {
	return LAYOUT_NAME.test(name)
}

/** Parse a template's bytes. Throws on malformed JSON; SCHEMA validity is `validateLayout`'s job. */
export function parseLayout(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch (err) {
		throw new Error(`template is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/**
 * Every validation error, not the first — CI's whole reason to run this is to be told everything
 * wrong at once. Each error names its own JSON path (`root.second.first.cwd`), so an error points at
 * a place in the file rather than describing one. An empty array means valid.
 *
 * `stem` is the filename's stem when there is a file to compare against; the `name` field must equal
 * it. The redundancy is the point: a copied template that kept its old name fails loudly.
 */
export function validateLayout(template: unknown, stem?: string): string[] {
	const errors: string[] = []
	if (typeof template !== 'object' || template === null || Array.isArray(template)) {
		return ['template: must be a JSON object']
	}
	const t = template as Record<string, unknown>

	if (t.name === undefined) errors.push("name: required — it must equal the template filename's stem")
	else if (typeof t.name !== 'string') errors.push('name: must be a string')
	else if (stem !== undefined && t.name !== stem) {
		errors.push(`name: filename stem is "${stem}" but the name field is "${t.name}" — they must match`)
	}

	if (t.description !== undefined && typeof t.description !== 'string') errors.push('description: must be a string')

	// Exactly one of root/panes/tabs. Two of them is ambiguous about which geometry wins; none of them
	// describes no panes at all. Either way there is nothing to apply, so both are errors rather than a
	// default. `root` and `panes` are the one-tab spelling of what `tabs` says for N.
	const hasRoot = t.root !== undefined
	const hasPanes = t.panes !== undefined
	const hasTabs = t.tabs !== undefined
	const declared = [hasRoot && 'root', hasPanes && 'panes', hasTabs && 'tabs'].filter((d): d is string => Boolean(d))
	if (declared.length > 1) {
		errors.push(
			`root/panes/tabs: exactly one of "root", "panes" or "tabs" may be set — this template sets ${declared.map((d) => `"${d}"`).join(' and ')}`,
		)
	} else if (declared.length === 0) {
		errors.push('root/panes/tabs: exactly one of "root", "panes" or "tabs" must be set — this template sets none')
	}

	// No label — pane's or tab's — is checked against any other. A label is a NAME, not a key: the
	// manifest's unique handle is the pane id and it reports a pane's tab by index, so nothing here has
	// a collision to have. Neither backend requires uniqueness either, and herdr labels every new
	// workspace's root tab `1`, so a rule refusing duplicates would refuse what a backend manufactures
	// by default. Ambiguity belongs to whoever LOOKS a pane up, where the candidates are known.
	validateTree(t, '', errors)

	if (hasTabs) {
		if (!Array.isArray(t.tabs)) errors.push('tabs: must be an array of tab objects')
		// A workspace of no tabs is not a workspace — there is nothing to open.
		else if (t.tabs.length === 0) errors.push('tabs: must name at least one tab — a workspace of no tabs is not one')
		else {
			t.tabs.forEach((tab, i) => {
				validateTab(tab, `tabs[${i}]`, errors)
			})
		}
	}

	return errors
}

/**
 * One tab: the same `root`/`panes` tree a top-level template declares, plus its own label. Every rule
 * the template tier holds holds here for the identical reason — hence the shared `validateTree`
 * rather than a parallel set of checks that could drift.
 */
function validateTab(tab: unknown, path: string, errors: string[]): void {
	if (typeof tab !== 'object' || tab === null || Array.isArray(tab)) {
		errors.push(`${path}: must be an object`)
		return
	}
	const n = tab as Record<string, unknown>

	// The rule the whole capability exists to enforce does not weaken because a level was added.
	if (n.cwd !== undefined) {
		errors.push(
			`${path}.cwd: a template must never set cwd — pass --cwd at apply time, or use "dir" for a subdirectory under it`,
		)
	}

	if (n.label !== undefined && (typeof n.label !== 'string' || n.label === '')) {
		errors.push(`${path}.label: must be a non-empty string`)
	}

	// Exactly one of root/panes, the same as the template itself, and for the same reasons.
	const hasRoot = n.root !== undefined
	const hasPanes = n.panes !== undefined
	if (hasRoot && hasPanes) errors.push(`${path}: exactly one of "root" or "panes" may be set — this tab sets both`)
	else if (!hasRoot && !hasPanes)
		errors.push(`${path}: exactly one of "root" or "panes" must be set — this tab sets neither`)

	validateTree(n, path, errors)
}

/**
 * The `root` / `panes` / `arrange` triple, wherever it sits. `path` is `''` at the template tier and
 * `tabs[i]` inside a tab, so an error points at a place in the file either way. Whether exactly one of
 * the two spellings is present is the CALLER's check — the template tier weighs `tabs` in that choice
 * and a tab does not.
 */
function validateTree(t: Record<string, unknown>, path: string, errors: string[]): void {
	const at = (key: string) => (path === '' ? key : `${path}.${key}`)

	if (t.arrange !== undefined && (typeof t.arrange !== 'string' || !ARRANGES.includes(t.arrange))) {
		errors.push(`${at('arrange')}: must be one of ${ARRANGES.join(', ')}`)
	}

	if (t.root !== undefined) validateNode(t.root, at('root'), errors)
	if (t.panes !== undefined) {
		if (!Array.isArray(t.panes)) errors.push(`${at('panes')}: must be an array of pane objects`)
		else if (t.panes.length === 0) errors.push(`${at('panes')}: must name at least one pane`)
		else {
			t.panes.forEach((pane, i) => {
				validatePaneFields(pane, `${at('panes')}[${i}]`, errors)
			})
		}
	}
}

function validateNode(node: unknown, path: string, errors: string[]): void {
	if (typeof node !== 'object' || node === null || Array.isArray(node)) {
		errors.push(`${path}: must be an object with a "type" of "pane" or "split"`)
		return
	}
	const n = node as Record<string, unknown>
	// `type` is an explicit discriminant rather than inferred from which keys are present: an inferred
	// union produces terrible errors on a typo (a misspelled `frist` silently becomes a pane node).
	if (n.type === 'pane') {
		validatePaneFields(n, path, errors)
		return
	}
	if (n.type !== 'split') {
		errors.push(`${path}.type: must be "pane" or "split"`)
		return
	}
	if (n.direction !== 'right' && n.direction !== 'down') {
		errors.push(`${path}.direction: must be "right" or "down"`)
	}
	if (n.ratio !== undefined) {
		// 0 and 1 are degenerate — one side gets the whole region and the other gets nothing, which is a
		// mistake rather than an intent worth honoring.
		if (typeof n.ratio !== 'number' || !Number.isFinite(n.ratio) || n.ratio <= 0 || n.ratio >= 1) {
			errors.push(`${path}.ratio: must be a number strictly between 0 and 1 — got ${JSON.stringify(n.ratio)}`)
		}
	}
	if (n.first === undefined) errors.push(`${path}.first: required`)
	else validateNode(n.first, `${path}.first`, errors)
	if (n.second === undefined) errors.push(`${path}.second: required`)
	else validateNode(n.second, `${path}.second`, errors)
}

function validatePaneFields(pane: unknown, path: string, errors: string[]): void {
	if (typeof pane !== 'object' || pane === null || Array.isArray(pane)) {
		errors.push(`${path}: must be an object`)
		return
	}
	const p = pane as Record<string, unknown>

	// The single rule the whole capability exists to enforce. A hard error, not an ignored key: a
	// template that pins a target directory is not reusable, and silently dropping it would let one
	// look like it worked.
	if (p.cwd !== undefined) {
		errors.push(
			`${path}.cwd: a template must never set cwd — pass --cwd at apply time, or use "dir" for a subdirectory under it`,
		)
	}

	if (p.label !== undefined && (typeof p.label !== 'string' || p.label === '')) {
		errors.push(`${path}.label: must be a non-empty string`)
	}
	if (p.command !== undefined && typeof p.command !== 'string') errors.push(`${path}.command: must be a string`)

	if (p.env !== undefined) {
		if (typeof p.env !== 'object' || p.env === null || Array.isArray(p.env)) {
			errors.push(`${path}.env: must be an object of string values`)
		} else {
			for (const [key, value] of Object.entries(p.env)) {
				if (typeof value !== 'string') errors.push(`${path}.env.${key}: must be a string`)
			}
		}
	}

	if (p.dir !== undefined) {
		if (typeof p.dir !== 'string' || p.dir === '') errors.push(`${path}.dir: must be a non-empty string`)
		else if (dirEscapes(p.dir)) {
			errors.push(`${path}.dir: must be a relative subdirectory under the apply-time target — "${p.dir}" escapes it`)
		}
	}
}

/**
 * Whether a `dir` can reach outside the apply-time target. Absolute is rejected because a
 * machine-specific path must never reach a template by any road; `..` is rejected because it is the
 * other road to the same place. Checked on the RAW string as well as the normalized one — a `..` that
 * cancels out (`packages/../../outside` normalizes past the root, but `a/../b` does not) is still an
 * author saying something they did not mean.
 */
function dirEscapes(dir: string): boolean {
	if (isAbsolute(dir)) return true
	if (dir.split(/[/\\]+/).includes('..')) return true
	return normalize(dir).startsWith('..')
}

/**
 * The tree a `LayoutTree` describes, whichever form it was written in — the ONE place `panes`/`arrange`
 * becomes a tree, so `layout show --desugar` and the apply walk can never disagree about what a flat
 * template means.
 *
 * It takes either carrier of a `LayoutTree`, so a `TabNode` and a single-tab `LayoutTemplate` resolve
 * through THIS function rather than through two that happen to agree today: the sugar is a property of
 * a pane pool, not of where the pool sits, so a tab of 3 panes means what a top-level pool of 3 panes
 * means. One desugarer, one answer.
 */
export function resolveTree(tree: LayoutTemplate | TabNode): LayoutNode {
	if (tree.root) return tree.root
	return desugar(tree.panes ?? [], tree.arrange ?? 'tiled')
}

/**
 * Expand the flat sugar into the canonical tree. A pure function of `panes.length` and `arrange`
 * ALONE — no backend, no region size — which is exactly what lets `show --desugar` print the tree
 * apply will build, and what makes one template mean one geometry everywhere.
 *
 * tmux's native `select-layout tiled` is deliberately NOT used even though it exists and would be one
 * call: it implements tmux's own grid algorithm, herdr has no equivalent, and reaching for it would
 * mean the same template producing a visibly different geometry per backend — and a third on
 * whatever backend comes next. Owning the desugaring is what makes a backend-agnostic schema worth
 * having, and it costs exactly one saved call.
 */
export function desugar(panes: FlatPane[], arrange: Arrange): LayoutNode {
	if (panes.length === 0) throw new Error('a flat template must name at least one pane')
	const leaves = panes.map(toPaneNode)
	if (arrange === 'even-horizontal') return comb(leaves, 'right')
	if (arrange === 'even-vertical') return comb(leaves, 'down')
	return tiled(leaves)
}

function toPaneNode(pane: FlatPane): PaneNode {
	const node: PaneNode = { type: 'pane' }
	if (pane.label !== undefined) node.label = pane.label
	if (pane.command !== undefined) node.command = pane.command
	if (pane.env !== undefined) node.env = pane.env
	if (pane.dir !== undefined) node.dir = pane.dir
	return node
}

/**
 * The even comb: split at `1/n`, then `1/(n-1)`, … so all `n` regions end EQUAL.
 *
 * The ratios are the whole point and the easy thing to get wrong. Splitting evenly at `0.5` each time
 * would yield 1/2, 1/4, 1/4 — a comb that looks like a row and is not one. Peeling `1/n` off the
 * front leaves `(n-1)/n` for the rest, which the next `1/(n-1)` divides into another exact `1/n`.
 */
function comb(nodes: LayoutNode[], direction: 'right' | 'down'): LayoutNode {
	const [head, ...rest] = nodes
	if (rest.length === 0) return head!
	return { type: 'split', direction, ratio: 1 / nodes.length, first: head!, second: comb(rest, direction) }
}

/**
 * A balanced grid: `ceil(sqrt(n))` columns laid left-to-right, each column an even stack. Both axes
 * are the same even comb, so the geometry is exact rather than approximate at every `n`.
 *
 * For `n = 4` this is one `right` at `0.5` with a `down` at `0.5` in each half — a true 2x2. `n = 1`
 * falls out as the bare pane with no split at all, rather than being special-cased.
 */
function tiled(leaves: LayoutNode[]): LayoutNode {
	if (leaves.length === 1) return leaves[0]!
	const columns = distribute(leaves, Math.ceil(Math.sqrt(leaves.length)))
	return comb(
		columns.map((column) => comb(column, 'down')),
		'right',
	)
}

/** Split `items` into `groups` contiguous chunks as evenly as possible, remainder to the front. */
function distribute<T>(items: T[], groups: number): T[][] {
	const out: T[][] = []
	const base = Math.floor(items.length / groups)
	let remainder = items.length % groups
	let index = 0
	for (let g = 0; g < groups; g++) {
		const size = base + (remainder > 0 ? 1 : 0)
		if (remainder > 0) remainder--
		out.push(items.slice(index, index + size))
		index += size
	}
	return out
}

/** Every pane in the tree, in template order — a depth-first walk taking `first` before `second`. */
export function collectPanes(node: LayoutNode, acc: PaneNode[] = []): PaneNode[] {
	if (node.type === 'pane') acc.push(node)
	else {
		collectPanes(node.first, acc)
		collectPanes(node.second, acc)
	}
	return acc
}

/**
 * The pane that ends up on a subtree's EXISTING region pane — follow `first` down, since `first`
 * always inherits the pane a split was made from. This is what tells the walk whose `env` and `dir`
 * a split must carry: the new pane a split creates is the region for `second`, and the leaf that
 * ultimately sits on it is `firstPane(second)`.
 */
export function firstPane(node: LayoutNode): PaneNode {
	return node.type === 'pane' ? node : firstPane(node.first)
}
