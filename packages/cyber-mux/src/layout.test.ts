import { describe, expect, it } from 'vitest'
import {
	type Arrange,
	collectPanes,
	desugar,
	type FlatPane,
	isValidLayoutName,
	type LayoutNode,
	type LayoutTemplate,
	parseLayout,
	resolveTree,
	type SplitNode,
	type TabNode,
	validateLayout,
} from './layout.ts'

/** A flat pool of `n` panes — the sugar's input, with labels that are irrelevant to the geometry. */
function pool(n: number): FlatPane[] {
	return Array.from({ length: n }, (_, i) => ({ label: `p${i + 1}`, command: 'zsh' }))
}

function asSplit(node: LayoutNode): SplitNode {
	if (node.type !== 'split') throw new Error(`expected a split node, got a ${node.type}`)
	return node
}

/**
 * Every leaf's rectangle in a unit region — the geometry a template actually MEANS, computed the way
 * a multiplexer would apply it. Asserting on rectangles rather than on ratios is what makes "all
 * three panes end equal width" and "a 2x2 grid" checkable claims rather than restatements of the
 * tree.
 */
interface Rect {
	x: number
	y: number
	w: number
	h: number
}

function rects(node: LayoutNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): Rect[] {
	if (node.type === 'pane') return [rect]
	// An omitted ratio is the backend's even split — the same default apply degrades to.
	const ratio = node.ratio ?? 0.5
	if (node.direction === 'right') {
		const first = rect.w * ratio
		return [
			...rects(node.first, { ...rect, w: first }),
			...rects(node.second, { ...rect, x: rect.x + first, w: rect.w - first }),
		]
	}
	const first = rect.h * ratio
	return [
		...rects(node.first, { ...rect, h: first }),
		...rects(node.second, { ...rect, y: rect.y + first, h: rect.h - first }),
	]
}

/** Every split node in the tree, for claims that quantify over all of them. */
function splits(node: LayoutNode, acc: SplitNode[] = []): SplitNode[] {
	if (node.type === 'split') {
		acc.push(node)
		splits(node.first, acc)
		splits(node.second, acc)
	}
	return acc
}

describe('spec:cyber-mux/layout', () => {
	describe('parseLayout', () => {
		it('parses a template’s bytes into an object', () => {
			expect(parseLayout('{"name":"render-farm","panes":[{"label":"gpu"}]}')).toEqual({
				name: 'render-farm',
				panes: [{ label: 'gpu' }],
			})
		})

		it('throws naming the JSON failure rather than yielding a half-read template', () => {
			expect(() => parseLayout('{"name": "render-farm",}')).toThrow(/not valid JSON/)
		})
	})

	describe('a name is a lookup key, never a path', () => {
		// The stem rule is the whole reason a name can never traverse out of the layouts directory.
		it.each([
			'../../../etc/pwd',
			'pool/../../out',
			'Pool-4',
			'-pool',
			'pool_4',
		])('refuses "%s" as a template name', (name) => {
			expect(isValidLayoutName(name)).toBe(false)
		})

		it('accepts a plain lower-case stem', () => {
			for (const name of ['render-farm', 'p3', 'build-trio-2']) expect(isValidLayoutName(name)).toBe(true)
		})
	})

	describe('validateLayout', () => {
		it('a name field that disagrees with the filename stem fails, naming both', () => {
			// The redundancy is the point: a copied file that kept its old name fails loudly rather than
			// resolving under one name while calling itself another.
			const errors = validateLayout({ name: 'pool-3', panes: [{ label: 'w' }] }, 'pool-4')
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('pool-4')
			expect(errors[0]).toContain('pool-3')
		})

		it('accepts a name field equal to the stem', () => {
			expect(validateLayout({ name: 'render-farm', panes: [{ label: 'gpu' }] }, 'render-farm')).toEqual([])
		})

		it('a template that sets cwd fails, naming its JSON path, --cwd and dir', () => {
			// A hard error rather than an ignored key is what keeps a template reusable: silently dropping
			// a cwd would let a template that pins a machine's path look like it worked.
			const errors = validateLayout(
				{
					name: 'render-farm',
					root: {
						type: 'split',
						direction: 'right',
						first: { type: 'pane', label: 'gpu', cwd: '/home/someone/render' },
						second: { type: 'pane', label: 'cpu' },
					},
				},
				'render-farm',
			)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('root.first.cwd')
			expect(errors[0]).toContain('--cwd')
			expect(errors[0]).toContain('dir')
		})

		// The Examples rows are the contract's own vectors: absolute, a bare escape, and an escape that
		// only shows up after normalization.
		it.each(['/etc', '../sibling', 'packages/../../outside'])('refuses dir "%s", naming that pane’s path', (dir) => {
			const errors = validateLayout(
				{ name: 'render-farm', panes: [{ label: 'gpu' }, { label: 'cpu', dir }] },
				'render-farm',
			)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('panes[1].dir')
		})

		it('accepts a relative dir under the target', () => {
			expect(
				validateLayout({ name: 'render-farm', panes: [{ label: 'gpu', dir: 'services/api/logs' }] }, 'render-farm'),
			).toEqual([])
		})

		// 0 and 1 hand one side the whole region and the other nothing — a mistake, not an intent.
		it.each([0, 1, -0.5, 1.5])('refuses ratio %s, naming that node’s path', (ratio) => {
			const errors = validateLayout(
				{
					name: 'render-farm',
					root: {
						type: 'split',
						direction: 'right',
						ratio,
						first: { type: 'pane', label: 'gpu' },
						second: { type: 'pane', label: 'cpu' },
					},
				},
				'render-farm',
			)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('root.ratio')
		})

		it('accepts a ratio strictly between 0 and 1', () => {
			const errors = validateLayout(
				{
					name: 'render-farm',
					root: {
						type: 'split',
						direction: 'right',
						ratio: 0.333,
						first: { type: 'pane', label: 'gpu' },
						second: { type: 'pane', label: 'cpu' },
					},
				},
				'render-farm',
			)
			expect(errors).toEqual([])
		})

		it('a duplicate label fails, because labels are manifest keys', () => {
			const errors = validateLayout(
				{ name: 'render-farm', panes: [{ label: 'worker' }, { label: 'worker' }] },
				'render-farm',
			)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('worker')
			expect(errors[0]).toContain('duplicated')
		})

		// The Examples rows are the contract's own vectors. Two of them is ambiguous about which geometry
		// wins; none of them describes no panes at all — either way nothing is applicable.
		it.each([
			{ declares: 'both root and panes', root: { type: 'pane', label: 'gpu' }, panes: [{ label: 'cpu' }] },
			{ declares: 'both root and tabs', root: { type: 'pane', label: 'gpu' }, tabs: [{ panes: [{ label: 'io' }] }] },
			{ declares: 'both panes and tabs', panes: [{ label: 'cpu' }], tabs: [{ panes: [{ label: 'io' }] }] },
			{ declares: 'none of root, panes or tabs' },
		])('exactly one of root, panes and tabs', ({ declares: _declares, ...shape }) => {
			const errors = validateLayout({ name: 'render-farm', ...shape }, 'render-farm')
			expect(errors.some((e) => e.startsWith('root/panes/tabs:'))).toBe(true)
		})

		it('accepts each of root, panes and tabs on its own', () => {
			for (const shape of [
				{ root: { type: 'pane', label: 'gpu' } },
				{ panes: [{ label: 'cpu' }] },
				{ tabs: [{ panes: [{ label: 'io' }] }] },
			]) {
				expect(validateLayout({ name: 'render-farm', ...shape }, 'render-farm')).toEqual([])
			}
		})

		it('reports every error at once, one per line, each naming its own JSON path', () => {
			// CI's whole reason to run this is being told everything wrong in one pass — a template with
			// three mistakes must not take three runs to fix.
			const errors = validateLayout(
				{
					name: 'render-farm',
					root: {
						type: 'split',
						direction: 'right',
						ratio: 0,
						first: { type: 'pane', label: 'gpu', cwd: '/home/someone/render' },
						second: { type: 'pane', label: 'gpu' },
					},
				},
				'render-farm',
			)
			expect(errors).toHaveLength(3)
			expect(errors.some((e) => e.includes('root.ratio'))).toBe(true)
			expect(errors.some((e) => e.includes('root.first.cwd'))).toBe(true)
			expect(errors.some((e) => e.includes('label "gpu"'))).toBe(true)
		})

		it('a cwd nested deep in the tree is named at its own path, not the root’s', () => {
			const errors = validateLayout(
				{
					name: 'render-farm',
					root: {
						type: 'split',
						direction: 'right',
						first: { type: 'pane', label: 'gpu' },
						second: {
							type: 'split',
							direction: 'down',
							first: { type: 'pane', label: 'cpu', cwd: '/tmp/x' },
							second: { type: 'pane', label: 'io' },
						},
					},
				},
				'render-farm',
			)
			expect(errors).toEqual([expect.stringContaining('root.second.first.cwd')])
		})
	})

	// A workspace is tabs of panes, not one pane tree. `root`/`panes` are the one-tab spelling; `tabs`
	// is the two-level form, each tab a tree in the very same shape.
	describe('tabs', () => {
		it('a tab carries its own tree, in the same shape a single-tab template uses', () => {
			const split: LayoutNode = {
				type: 'split',
				direction: 'right',
				ratio: 0.6,
				first: { type: 'pane', label: 'gpu', command: 'render' },
				second: { type: 'pane', label: 'cpu' },
			}
			const solo: LayoutNode = { type: 'pane', label: 'io', command: 'iostat' }
			const template: LayoutTemplate = {
				name: 'render-farm',
				tabs: [{ label: 'shots', root: split }, { root: solo }],
			}
			expect(validateLayout(template, 'render-farm')).toEqual([])

			// "the same node shape a top-level root accepts", proven rather than asserted: each tab's tree,
			// lifted verbatim to the top level, is a valid template and resolves to the identical tree.
			for (const tab of template.tabs!) {
				expect(validateLayout({ name: 'render-farm', root: tab.root }, 'render-farm')).toEqual([])
				expect(resolveTree(tab)).toEqual(resolveTree({ name: 'render-farm', root: tab.root }))
			}
			expect(resolveTree(template.tabs![0]!)).toBe(split)
			expect(resolveTree(template.tabs![1]!)).toBe(solo)
		})

		it('a tab may use the flat sugar, desugared exactly as a single-tab template is', () => {
			// Sugar is a property of a pane pool, not of where the pool sits — one desugarer, one answer.
			const tab: TabNode = { label: 'shots', panes: pool(3), arrange: 'even-horizontal' }
			const single: LayoutTemplate = { name: 'render-farm', panes: pool(3), arrange: 'even-horizontal' }
			expect(resolveTree(tab)).toEqual(resolveTree(single))
			expect(resolveTree(tab)).toEqual(desugar(pool(3), 'even-horizontal'))
			// The right-comb itself, so a desugarer that quietly stopped combing inside a tab is caught.
			const outer = asSplit(resolveTree(tab))
			expect(outer.direction).toBe('right')
			expect(outer.ratio).toBeCloseTo(1 / 3)
			expect(asSplit(outer.second).ratio).toBeCloseTo(1 / 2)
			// A tab's arrange defaults to tiled exactly as the template's does.
			expect(resolveTree({ panes: pool(4) })).toEqual(desugar(pool(4), 'tiled'))
		})

		it.each([
			{ declares: 'both root and panes', root: { type: 'pane', label: 'gpu' }, panes: [{ label: 'cpu' }] },
			{ declares: 'neither root nor panes', label: 'shots' },
		])('a tab declares exactly one of root and panes, the same as the template itself', ({ declares: _d, ...tab }) => {
			const errors = validateLayout({ name: 'render-farm', tabs: [{ panes: [{ label: 'io' }] }, tab] }, 'render-farm')
			// The error points at the offending TAB rather than at the template.
			expect(errors.some((e) => e.startsWith('tabs[1]:'))).toBe(true)
		})

		it('an empty tabs array is refused, because a workspace of no tabs is not a workspace', () => {
			const errors = validateLayout({ name: 'render-farm', tabs: [] }, 'render-farm')
			expect(errors.some((e) => e.startsWith('tabs:'))).toBe(true)
			// And it is refused as an empty workspace, not by falling through to "declares none of the three".
			expect(errors.some((e) => e.startsWith('root/panes/tabs:'))).toBe(false)
		})

		it("a pane label must be unique across every tab, because labels are the manifest's keys", () => {
			// The manifest is one flat pane list for the whole apply, so its keys are global — a label is
			// not scoped to the tab it sits in.
			const errors = validateLayout(
				{
					name: 'render-farm',
					tabs: [
						{ label: 'shots', panes: [{ label: 'gpu' }] },
						{ label: 'frames', root: { type: 'pane', label: 'gpu' } },
					],
				},
				'render-farm',
			)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('gpu')
			expect(errors[0]).toContain('duplicated')
		})

		it('two tabs sharing a label are refused', () => {
			const errors = validateLayout(
				{
					name: 'render-farm',
					tabs: [
						{ label: 'shots', panes: [{ label: 'gpu' }] },
						{ label: 'shots', panes: [{ label: 'cpu' }] },
					],
				},
				'render-farm',
			)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('shots')
			expect(errors[0]).toContain('duplicated')
		})

		it('a tab label is a separate namespace from a pane label, so a tab and a pane may share a name', () => {
			expect(
				validateLayout({ name: 'render-farm', tabs: [{ label: 'gpu', panes: [{ label: 'gpu' }] }] }, 'render-farm'),
			).toEqual([])
		})

		it('a tab may leave its label to the backend', () => {
			// Matching --label omitted everywhere else: the backend's own default stands.
			expect(
				validateLayout(
					{ name: 'render-farm', tabs: [{ panes: [{ label: 'gpu' }] }, { panes: [{ label: 'cpu' }] }] },
					'render-farm',
				),
			).toEqual([])
		})

		it('a tab cannot carry a cwd any more than a pane can', () => {
			// The rule the whole capability exists to enforce does not weaken because a level was added.
			const errors = validateLayout(
				{ name: 'render-farm', tabs: [{ label: 'shots', cwd: '/home/someone/render', panes: [{ label: 'gpu' }] }] },
				'render-farm',
			)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain('tabs[0].cwd')
			expect(errors[0]).toContain('--cwd')
			expect(errors[0]).toContain('dir')
		})

		it('every error across every tab is reported at once, each naming its own JSON path', () => {
			// The report-everything rule holds through the added level: a cwd in one tab does not hide a
			// bad ratio in another.
			const errors = validateLayout(
				{
					name: 'render-farm',
					tabs: [
						{ label: 'shots', panes: [{ label: 'gpu', cwd: '/tmp/x' }] },
						{
							label: 'frames',
							root: {
								type: 'split',
								direction: 'down',
								ratio: 0,
								first: { type: 'pane', label: 'cpu' },
								second: { type: 'pane', label: 'io', dir: '/etc' },
							},
						},
					],
				},
				'render-farm',
			)
			expect(errors).toHaveLength(3)
			expect(errors.some((e) => e.includes('tabs[0].panes[0].cwd'))).toBe(true)
			expect(errors.some((e) => e.includes('tabs[1].root.ratio'))).toBe(true)
			expect(errors.some((e) => e.includes('tabs[1].root.second.dir'))).toBe(true)
		})
	})

	describe('desugar', () => {
		it('even-horizontal splits at 1/n then 1/(n-1) so every pane ends the same width', () => {
			// Splitting evenly at 0.5 each time would yield 1/2, 1/4, 1/4 — a comb that looks like a row
			// and is not one. This is the assertion that tells the two apart.
			const tree = desugar(pool(3), 'even-horizontal')
			const outer = asSplit(tree)
			expect(outer.direction).toBe('right')
			expect(outer.ratio).toBeCloseTo(1 / 3)
			const inner = asSplit(outer.second)
			expect(inner.direction).toBe('right')
			expect(inner.ratio).toBeCloseTo(1 / 2)
			const widths = rects(tree).map((r) => r.w)
			expect(widths).toHaveLength(3)
			for (const w of widths) expect(w).toBeCloseTo(1 / 3)
		})

		it('even-vertical is the same comb, down', () => {
			const tree = desugar(pool(3), 'even-vertical')
			expect(splits(tree).every((s) => s.direction === 'down')).toBe(true)
			expect(splits(tree).map((s) => s.ratio)).toHaveLength(2)
			expect(splits(tree)[0]?.ratio).toBeCloseTo(1 / 3)
			expect(splits(tree)[1]?.ratio).toBeCloseTo(1 / 2)
			for (const h of rects(tree).map((r) => r.h)) expect(h).toBeCloseTo(1 / 3)
		})

		it('tiled balances columns and rows into a 2x2 grid at n=4', () => {
			const tree = desugar(pool(4), 'tiled')
			const outer = asSplit(tree)
			expect(outer.direction).toBe('right')
			expect(outer.ratio).toBeCloseTo(0.5)
			for (const half of [outer.first, outer.second]) {
				const column = asSplit(half)
				expect(column.direction).toBe('down')
				expect(column.ratio).toBeCloseTo(0.5)
			}
			// A grid, proven as geometry: four equal quarters at the four corners.
			const grid = rects(tree)
			expect(grid).toHaveLength(4)
			for (const cell of grid) {
				expect(cell.w).toBeCloseTo(0.5)
				expect(cell.h).toBeCloseTo(0.5)
			}
			expect(grid.map((c) => [c.x, c.y])).toEqual([
				[0, 0],
				[0, 0.5],
				[0.5, 0],
				[0.5, 0.5],
			])
		})

		it('arrange omitted defaults to tiled', () => {
			const template: LayoutTemplate = { name: 'render-farm', panes: pool(4) }
			expect(resolveTree(template)).toEqual(desugar(pool(4), 'tiled'))
		})

		it('n = 1 is legal and produces a single pane carrying no split', () => {
			for (const arrange of ['tiled', 'even-horizontal', 'even-vertical'] as const) {
				const tree = desugar([{ label: 'solo', command: 'zsh' }], arrange)
				expect(tree.type).toBe('pane')
				expect(splits(tree)).toEqual([])
				expect(tree).toEqual({ type: 'pane', label: 'solo', command: 'zsh' })
			}
		})

		it('carries each pane’s label, command, env and dir onto its leaf, in order', () => {
			const tree = desugar(
				[
					{ label: 'gpu', command: 'render', env: { TIER: 'gpu' }, dir: 'apps/render' },
					{ label: 'cpu', command: 'encode' },
				],
				'even-horizontal',
			)
			expect(collectPanes(tree)).toEqual([
				{ type: 'pane', label: 'gpu', command: 'render', env: { TIER: 'gpu' }, dir: 'apps/render' },
				{ type: 'pane', label: 'cpu', command: 'encode' },
			])
		})

		it('rejects a flat template with no panes at all', () => {
			expect(() => desugar([], 'tiled')).toThrow(/at least one pane/)
		})

		// The table test the design asks for: a pure, total function of n and arrange alone.
		const arranges: Arrange[] = ['tiled', 'even-horizontal', 'even-vertical']
		const sizes = [1, 2, 3, 4, 5, 6, 7, 8]
		for (const arrange of arranges) {
			it.each(sizes)(`${arrange} yields exactly n panes filling the region at n=%i`, (n) => {
				const tree = desugar(pool(n), arrange)
				expect(collectPanes(tree)).toHaveLength(n)
				// n panes means n-1 splits, always — a binary tree with no wasted node.
				expect(splits(tree)).toHaveLength(n - 1)
				// Every ratio is a legal one, so a desugared tree always passes the schema's own rules.
				for (const s of splits(tree)) expect(s.ratio!).toBeGreaterThan(0)
				for (const s of splits(tree)) expect(s.ratio!).toBeLessThan(1)
				// The panes tile the region exactly: areas sum to the whole, with no overlap or gap.
				const area = rects(tree).reduce((sum, r) => sum + r.w * r.h, 0)
				expect(area).toBeCloseTo(1)
			})

			it(`${arrange} is a pure function of n and arrange — same input, same tree`, () => {
				expect(desugar(pool(5), arrange)).toEqual(desugar(pool(5), arrange))
			})
		}

		it('even arranges give every pane an equal share at every n', () => {
			for (const n of sizes) {
				for (const [arrange, axis] of [
					['even-horizontal', 'w'],
					['even-vertical', 'h'],
				] as const) {
					for (const rect of rects(desugar(pool(n), arrange))) expect(rect[axis]).toBeCloseTo(1 / n)
				}
			}
		})
	})

	describe('resolveTree', () => {
		it('returns an explicit root untouched, desugaring nothing', () => {
			const root: LayoutNode = {
				type: 'split',
				direction: 'down',
				ratio: 0.7,
				first: { type: 'pane', label: 'editor' },
				second: { type: 'pane', label: 'tests' },
			}
			expect(resolveTree({ name: 'build-trio', root })).toBe(root)
		})

		it('is the one desugarer, so show --desugar and the walk cannot disagree', () => {
			// Both callers go through this function; that identity is the guarantee, so it is asserted
			// rather than left to two call sites that happen to match today.
			const template: LayoutTemplate = { name: 'render-farm', arrange: 'even-vertical', panes: pool(3) }
			expect(resolveTree(template)).toEqual(desugar(pool(3), 'even-vertical'))
		})
	})
})
