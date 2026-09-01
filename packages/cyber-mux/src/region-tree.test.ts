import { describe, expect, it } from 'vitest'
import type { RegionPane } from './mux.ts'
import { enclosingSplit } from './region-tree.ts'

/**
 * A real capture from tmux 3.7c (`list-panes -F '#{pane_left} #{pane_top} #{pane_width}x#{pane_height}'`
 * on a 200x50 window): one full-height pane on the left, two stacked on the right. Real rather than
 * hand-rounded because the divider tmux eats is the whole reason `extent` and the two side extents do
 * not add up, and a tidied fixture would hide it — 120 + 79 is 199, not 200.
 */
const NESTED: RegionPane[] = [
	{ id: '%0', rect: { x: 0, y: 0, width: 120, height: 50 } },
	{ id: '%1', rect: { x: 121, y: 0, width: 79, height: 35 } },
	{ id: '%2', rect: { x: 121, y: 36, width: 79, height: 14 } },
]

/** A herdr 0.8.2 capture of a plain two-pane split — no divider, so the extents add up exactly. */
const PAIR: RegionPane[] = [
	{ id: 'w1:p1', rect: { x: 36, y: 1, width: 128, height: 56 } },
	{ id: 'w1:p2', rect: { x: 164, y: 1, width: 128, height: 56 } },
]

describe('enclosingSplit', () => {
	it('reports the region root when the target is one whole side of it', () => {
		expect(enclosingSplit(NESTED, '%0')).toEqual({
			direction: 'right',
			targetIsFirst: true,
			// The complement definition `ratioOf` reads a live split back with: 1 - 79/200.
			firstRatio: 0.605,
			extent: 200,
			targetExtent: 120,
			otherExtent: 79,
		})
	})

	it('descends past a split whose side is a GROUP to the one the target sits directly in', () => {
		expect(enclosingSplit(NESTED, '%1')).toEqual({
			direction: 'down',
			targetIsFirst: true,
			firstRatio: 0.72,
			extent: 50,
			targetExtent: 35,
			otherExtent: 14,
		})
	})

	it('reports targetIsFirst false for the second side, with the sides’ extents swapped', () => {
		expect(enclosingSplit(NESTED, '%2')).toEqual({
			direction: 'down',
			targetIsFirst: false,
			firstRatio: 0.72,
			extent: 50,
			targetExtent: 14,
			otherExtent: 35,
		})
	})

	it('reports a divider-free backend’s sides adding up to the whole extent', () => {
		const split = enclosingSplit(PAIR, 'w1:p2')
		expect(split).toEqual({
			direction: 'right',
			targetIsFirst: false,
			firstRatio: 0.5,
			extent: 256,
			targetExtent: 128,
			otherExtent: 128,
		})
		expect(split!.targetExtent + split!.otherExtent).toBe(split!.extent)
	})

	it('returns undefined for a lone pane — there is no split to take a fraction of', () => {
		expect(enclosingSplit([{ id: '%0', rect: { x: 0, y: 0, width: 200, height: 50 } }], '%0')).toBeUndefined()
	})

	it('throws when the target is not in the region described', () => {
		expect(() => enclosingSplit(NESTED, '%9')).toThrow(/pane %9 is not in the region described/)
	})
})
