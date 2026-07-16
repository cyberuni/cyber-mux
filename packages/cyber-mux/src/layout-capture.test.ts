import { describe, expect, it } from 'vitest'
import { collectPanes, type LayoutNode, resolveTree, type SplitNode, validateLayout } from './layout.ts'
import { captureLayout } from './layout-capture.ts'
import { herdrSessionAdapter } from './session.herdr.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'
import type { PaneRect, RegionPane } from './session.ts'

/**
 * Rects are written the way a multiplexer reports them — `x, y, width, height` in cells — so a fixture
 * is a screen someone could point at rather than an abstraction over one. The tmux fixtures are LIVE
 * CAPTURES from tmux 3.6b and the herdr ones from herdr 0.7.4, both noted where they appear: a made-up
 * rect can't tell you the divider eats a column, and that column is what the ratio math turns on.
 */
function pane(
	id: string,
	x: number,
	y: number,
	width: number,
	height: number,
	extra: Partial<RegionPane> = {},
): RegionPane {
	return { id, rect: { x, y, width, height }, ...extra }
}

function asSplit(node: LayoutNode): SplitNode {
	if (node.type !== 'split') throw new Error(`expected a split node, got a ${node.type}`)
	return node
}

function treeOf(panes: RegionPane[]): LayoutNode {
	return resolveTree(captureLayout(panes, { name: 'captured' }).template)
}

/**
 * Lay a tree out over a region the way a backend sizes a split — `first` keeps `ratio` of the
 * region, `second` takes the remainder — and return every leaf's rectangle in tree order.
 *
 * This models a backend that draws NO divider (herdr), which is what makes the round-trip check
 * exact rather than approximate. An omitted ratio means an even split, per the schema.
 */
function applyToRects(node: LayoutNode, region: PaneRect, acc: PaneRect[] = []): PaneRect[] {
	if (node.type === 'pane') {
		acc.push(region)
		return acc
	}
	const ratio = node.ratio ?? 0.5
	if (node.direction === 'right') {
		const width = Math.round(region.width * ratio)
		applyToRects(node.first, { ...region, width }, acc)
		applyToRects(node.second, { ...region, x: region.x + width, width: region.width - width }, acc)
	} else {
		const height = Math.round(region.height * ratio)
		applyToRects(node.first, { ...region, height }, acc)
		applyToRects(node.second, { ...region, y: region.y + height, height: region.height - height }, acc)
	}
	return acc
}

describe('spec:cyber-mux/layout', () => {
	describe('captureLayout', () => {
		it('captures a single pane as a bare leaf, with no split at all', () => {
			const tree = treeOf([pane('%0', 0, 0, 200, 50)])
			expect(tree).toEqual({ type: 'pane' })
		})

		it('a captured ratio is the one the split was made with, not the one the pane sizes imply', () => {
			// LIVE, tmux 3.6b: a 200x50 window, `split-window -h -l 40%` then `split-window -v -l 30%` on
			// the original. tmux reports 119 + 80 across (200 less the divider column) and 34 + 15 down.
			const tree = asSplit(treeOf([pane('%0', 0, 0, 119, 34), pane('%2', 0, 35, 119, 15), pane('%1', 120, 0, 80, 50)]))
			// The 40% went to the NEW pane, so the original kept 0.6 — which is what `ratio` means.
			expect(tree.direction).toBe('right')
			expect(tree.ratio).toBe(0.6)
			// 34/(34+15) would read 0.69 here. The divider row belongs to the region, not to either pane,
			// and tmux's own `-l 30%` says the split was 0.7. This is the case that formula gets wrong.
			const nested = asSplit(tree.first)
			expect(nested.direction).toBe('down')
			expect(nested.ratio).toBe(0.7)
			expect(tree.second).toEqual({ type: 'pane' })
		})

		it('recovers herdr ratios from screen-absolute rects, which do not start at the origin', () => {
			// LIVE, herdr 0.7.4: a workspace at x=36,y=1 (201x45), `pane split --direction right --ratio 0.6`
			// then `--direction down --ratio 0.7`. herdr draws no divider, so the widths sum to the region.
			const tree = asSplit(
				treeOf([pane('w3V:p1', 36, 1, 121, 32), pane('w3V:p3', 36, 33, 121, 13), pane('w3V:p2', 157, 1, 80, 45)]),
			)
			expect(tree.direction).toBe('right')
			expect(tree.ratio).toBe(0.6)
			// 32/45 = 0.711 — the cell herdr rounded 0.7 up to. Re-applying 0.71 lands on the same 32 rows,
			// so the capture reproduces the screen even though it cannot read the author's original number.
			expect(asSplit(tree.first).ratio).toBe(0.71)
		})

		it('an n-ary row captures as the right-comb the flat sugar desugars to', () => {
			// Three panes side by side is ONE node with three children in tmux's own tree. The schema has
			// only binary splits, so the capture has to comb it — and must comb it the same way
			// `arrange: even-horizontal` does, or a pool would not survive a round trip.
			const tree = asSplit(treeOf([pane('%0', 0, 0, 66, 50), pane('%1', 67, 0, 66, 50), pane('%2', 134, 0, 66, 50)]))
			expect(tree.direction).toBe('right')
			// Right-comb: one pane peeled off the front, the rest nested to the right — never left-leaning.
			expect(tree.first).toEqual({ type: 'pane' })
			const rest = asSplit(tree.second)
			expect(rest.direction).toBe('right')
			expect(rest.first).toEqual({ type: 'pane' })
			expect(rest.second).toEqual({ type: 'pane' })
			// ~1/3 off the front, then an even cut of what is left — the comb's ratios, recovered.
			expect(tree.ratio).toBeCloseTo(1 / 3, 1)
			// An even split is the schema's default, so it emits no ratio rather than a redundant 0.5.
			expect(rest.ratio).toBeUndefined()
		})

		it('an ambiguous grid captures columns-first, matching tiled rather than its transpose', () => {
			// A 2x2 is genuinely ambiguous — cutting vertically or horizontally first describes the same
			// screen. `desugar`'s `tiled` lays columns first, so the capture must break the tie the same way
			// or an exported grid would come back as the mirror of the template that built it.
			const tree = asSplit(
				treeOf([
					pane('%0', 0, 0, 99, 24),
					pane('%1', 0, 25, 99, 25),
					pane('%2', 100, 0, 100, 24),
					pane('%3', 100, 25, 100, 25),
				]),
			)
			expect(tree.direction).toBe('right')
			expect(asSplit(tree.first).direction).toBe('down')
			expect(asSplit(tree.second).direction).toBe('down')
		})

		it('no pane in a captured template carries a command, on either backend', () => {
			// The honest limit of the whole verb: geometry comes back, commands do not. cyber-mux types
			// commands with `submit`, so tmux's `pane_start_command` is empty for every pane it created
			// and `pane_current_command` reports the shell or interpreter instead.
			//
			// One test for both Examples rows, because the guarantee is STRUCTURAL rather than per-backend:
			// `RegionPane` has no command field at all, so there is no road by which a backend could report
			// one even if it wanted to. Driving each adapter's real describeRegion is what proves that —
			// both are fed a region whose panes are running commands, and neither can say so.
			const tmuxCalls: string[][] = []
			const tmuxPanes = tmuxSessionAdapter.describeRegion!(
				(_c, args) => {
					tmuxCalls.push(args)
					// Every pane is running `claude`, and tmux reports it — as pane_current_command, which the
					// format string below never asks for.
					return ['%0\t0\t0\t99\t50\t/repo\tzeta\tzeta', '%1\t100\t0\t100\t50\t/repo\tzeta\tzeta'].join('\n')
				},
				{ id: '%0' },
			)
			const herdrPanes = herdrSessionAdapter.describeRegion!(
				(_c, args) => {
					if (args[1] === 'layout') {
						return JSON.stringify({
							result: {
								layout: {
									panes: [
										{ pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 99, height: 50 } },
										{ pane_id: 'w1:p2', rect: { x: 100, y: 0, width: 100, height: 50 } },
									],
								},
							},
						})
					}
					// herdr can even name the harness running in a pane — which is still not a command line.
					return JSON.stringify({
						result: {
							panes: [
								{ pane_id: 'w1:p1', cwd: '/repo', agent: 'claude' },
								{ pane_id: 'w1:p2', cwd: '/repo', agent: 'claude' },
							],
						},
					})
				},
				{ id: 'w1:p1' },
			)

			for (const panes of [tmuxPanes, herdrPanes]) {
				const { template } = captureLayout(panes, { name: 'captured' })
				for (const node of collectPanes(resolveTree(template))) {
					expect(node.command).toBeUndefined()
				}
			}
			// And the seam never even asks tmux for a command — a field absent from the query cannot leak.
			expect(tmuxCalls.flat().join(' ')).not.toContain('pane_start_command')
			expect(tmuxCalls.flat().join(' ')).not.toContain('pane_current_command')
		})

		it("the geometry seam reports one rectangle per pane, not a backend's own tree", () => {
			// The design of the seam. Both backends CAN describe a region and both describe it in a
			// structure the other cannot speak, so neither structure is portable — rects are.
			const tmuxCalls: string[][] = []
			const tmuxPanes = tmuxSessionAdapter.describeRegion!(
				(_c, args) => {
					tmuxCalls.push(args)
					return '%0\t0\t0\t119\t50\t/repo\tzeta\tzeta\n%1\t120\t0\t80\t50\t/repo\tzeta\tzeta'
				},
				{ id: '%0' },
			)
			expect(tmuxPanes.map((p) => p.rect)).toEqual([
				{ x: 0, y: 0, width: 119, height: 50 },
				{ x: 120, y: 0, width: 80, height: 50 },
			])
			// tmux's tree lives in `#{window_layout}` — a bespoke string it does not promise to keep.
			// Never requested, so nothing downstream can be coupled to its format.
			expect(tmuxCalls.flat().join(' ')).not.toContain('window_layout')

			// herdr's `splits[]` reports direction and ratio OUTRIGHT — and is ignored, because it is flat:
			// its parent links exist only inside the `split_1_0` id convention, which herdr documents
			// nowhere. Here it is fed a splits[] that contradicts the rects outright; the rects win.
			const herdrPanes = herdrSessionAdapter.describeRegion!(
				(_c, args) => {
					if (args[1] === 'layout') {
						return JSON.stringify({
							result: {
								layout: {
									panes: [
										{ pane_id: 'w1:p1', rect: { x: 36, y: 1, width: 121, height: 45 } },
										{ pane_id: 'w1:p2', rect: { x: 157, y: 1, width: 80, height: 45 } },
									],
									splits: [
										{
											direction: 'down',
											id: 'split_0_root',
											ratio: 0.99,
											rect: { x: 36, y: 1, width: 201, height: 45 },
										},
									],
								},
							},
						})
					}
					return JSON.stringify({ result: { panes: [] } })
				},
				{ id: 'w1:p1' },
			)
			expect(herdrPanes.map((p) => p.rect)).toEqual([
				{ x: 36, y: 1, width: 121, height: 45 },
				{ x: 157, y: 1, width: 80, height: 45 },
			])
			// The rects say a `right` split at ~0.6; splits[] claimed `down` at 0.99. The capture follows
			// the rects, so the contradicting splits[] never reaches the tree.
			const tree = asSplit(treeOf(herdrPanes))
			expect(tree.direction).toBe('right')
			expect(tree.ratio).toBe(0.6)
		})

		it('re-applying a captured template reproduces the region it was captured from', () => {
			// The property the whole derivation exists to hold. These are the REAL rects of a live 4-pane
			// herdr region (0.7.4) — a 201x43 workspace split right, then down, then right again.
			const region = { x: 0, y: 0, width: 201, height: 43 }
			const original = [
				pane('w3X:p1', 0, 0, 121, 30),
				pane('w3X:p3', 0, 30, 61, 13),
				pane('w3X:p4', 61, 30, 60, 13),
				pane('w3X:p2', 121, 0, 80, 43),
			]
			const { template } = captureLayout(original, { name: 'captured' })
			// Lay the captured tree back out over a fresh region of the same size, the way a backend sizes
			// a split: the ratio is the fraction kept by `first`, and the remainder goes to `second`.
			const rebuilt = applyToRects(resolveTree(template), region)
			expect(rebuilt).toEqual(original.map((p) => p.rect))
			// Proven live too: this exact region captured, validated and re-applied through a real herdr
			// reproduced 121x30 / 61x13 / 60x13 / 80x43 cell-for-cell.
		})
	})

	describe('captureLayout cwd handling', () => {
		it('a pane under the captured root becomes a relative dir', () => {
			const { template, warnings } = captureLayout(
				[pane('%0', 0, 0, 99, 50, { cwd: '/repo' }), pane('%1', 100, 0, 100, 50, { cwd: '/repo/packages/api' })],
				{ name: 'captured' },
			)
			const tree = asSplit(template.root!)
			// The root pane IS the target, so it has no dir to record — `dir: "."` would be noise.
			expect(tree.first).toEqual({ type: 'pane' })
			expect(tree.second).toEqual({ type: 'pane', dir: 'packages/api' })
			expect(warnings).toEqual([])
			// The rule the schema exists to enforce: an absolute path never reaches a template.
			expect(JSON.stringify(template)).not.toContain('/repo')
		})

		it('captureLayout reports a pane outside the root as a warning, and emits no dir for it', () => {
			const { template, warnings } = captureLayout(
				[pane('%0', 0, 0, 99, 50, { cwd: '/repo' }), pane('%1', 100, 0, 100, 50, { cwd: '/elsewhere/other' })],
				{ name: 'captured' },
			)
			// `dir` must stay under the apply-time target, so there is nowhere to put this pane's location:
			// emitting `../elsewhere/other` would fail the validator this export has to satisfy.
			expect(asSplit(template.root!).second).toEqual({ type: 'pane' })
			expect(warnings).toHaveLength(1)
			expect(warnings[0]).toContain('/elsewhere/other')
			expect(warnings[0]).toContain('not under the captured root')
		})

		it("a label the author set is captured, and a backend's default pane title is not", () => {
			// tmux has no unset title — it defaults every pane's to the HOSTNAME. Capturing the title
			// verbatim would hang the host's name on every pane of every capture, which is not a label
			// anyone chose. A title equal to the host is that default; one that differs is a real label
			// (cyber-mux's own `select-pane -T` among them).
			//
			// EXACTLY ONE pane carries the host default here, and that is load-bearing rather than
			// incidental. With two, a broken host filter labels both `zeta` — which makes them DUPLICATES,
			// so `duplicatedLabels` drops them and the capture looks correct for entirely the wrong
			// reason. One host-titled pane leaves the duplicate path out of it, so this fails if and only
			// if the host filter itself breaks.
			const panes = tmuxSessionAdapter.describeRegion!(
				() =>
					[
						'%0\t0\t0\t119\t34\t/repo\tzeta\tzeta',
						'%2\t0\t35\t119\t15\t/repo\twatcher\tzeta',
						'%1\t120\t0\t80\t50\t/repo\treviewer\tzeta',
					].join('\n'),
				{ id: '%0' },
			)
			const { template } = captureLayout(panes, { name: 'captured' })
			// Tree order is `first` before `second`: the host-titled %0, then %2, then %1.
			const labels = collectPanes(resolveTree(template)).map((p) => p.label)
			expect(labels).toEqual([undefined, 'watcher', 'reviewer'])
			// The hostname reaches nothing — not as a label, not anywhere.
			expect(JSON.stringify(template)).not.toContain('zeta')
		})

		it('captureLayout drops a shared label from every pane carrying it, and reports it', () => {
			// A live region has no uniqueness rule; a template's labels are manifest KEYS and must be
			// unique. Keeping the duplicate would write a template that fails validateLayout — which the
			// scenario below forbids outright.
			const { template, warnings } = captureLayout(
				[
					pane('%0', 0, 0, 99, 50, { cwd: '/repo', label: 'worker' }),
					pane('%1', 100, 0, 100, 50, { cwd: '/repo', label: 'worker' }),
				],
				{ name: 'captured' },
			)
			for (const node of collectPanes(resolveTree(template))) {
				expect(node.label).toBeUndefined()
			}
			expect(warnings).toHaveLength(1)
			expect(warnings[0]).toContain('worker')
			// The whole point of dropping it: the result still validates.
			expect(validateLayout(template, 'captured')).toEqual([])
		})

		it('a captured template passes validate', () => {
			// The round trip that matters: a capture has to be loadable. Run the REAL validator over it —
			// asserting the name and description came back would pass for a template carrying a cwd, a
			// duplicate label or a degenerate ratio, which is exactly what this has to rule out.
			const { template } = captureLayout(
				[
					pane('%0', 0, 0, 119, 34, { cwd: '/repo', label: 'top' }),
					pane('%2', 0, 35, 119, 15, { cwd: '/repo/api' }),
					pane('%1', 120, 0, 80, 50, { cwd: '/repo/services/web', label: 'web' }),
				],
				{ name: 'captured', description: 'from a live region' },
			)
			expect(validateLayout(template, 'captured')).toEqual([])
			// The stem rule too: a name that disagrees with its filename fails validation, so a capture
			// saved as <name>.json has to carry that same name.
			expect(validateLayout(template, 'a-different-stem')).not.toEqual([])
		})
	})

	describe('captureLayout refusals', () => {
		it('refuses a region with no panes rather than emitting an empty template', () => {
			expect(() => captureLayout([], { name: 'captured' })).toThrow(/at least one pane/)
		})

		it('captureLayout throws on a region no straight cut separates', () => {
			// A true pinwheel: four panes wound around a fifth, tiling the region with no gap. No straight
			// line crosses it without cutting a pane in half, so there is no split that could have made it —
			// and both backends build regions only BY splitting. Reaching this means the geometry is not
			// what we think it is, which is worth failing on rather than guessing a tree that would misplace
			// the user's panes.
			expect(() =>
				captureLayout(
					[
						pane('%0', 0, 0, 150, 12), // top, stopping short of the right edge
						pane('%1', 150, 0, 50, 37), // right, stopping short of the bottom
						pane('%2', 50, 37, 150, 13), // bottom, stopping short of the left
						pane('%3', 0, 12, 50, 38), // left, stopping short of the top
						pane('%4', 50, 12, 100, 25), // the hub the other four wind around
					],
					{ name: 'captured' },
				),
			).toThrow(/do not form a splittable tree/)
		})
	})
})
