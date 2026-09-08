import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { canBreakPanes, canMovePanes, PaneBreakUnsupportedError, PaneMoveUnsupportedError } from './move.ts'
import { cmuxMuxAdapter } from './mux.cmux.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { ottyMuxAdapter } from './mux.otty.ts'
import { rmuxMuxAdapter } from './mux.rmux.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { zellijMuxAdapter } from './mux.zellij.ts'

const noExec: Exec = () => {
	throw new Error('the refusal must land before any exec')
}

/**
 * The capability matrix, asserted on the REAL adapters rather than on stubs — `zoom.test.ts`'s shape,
 * one member over, and for its reason: the point of a capability declaration is which backends carry
 * it, so a fake would test nothing.
 *
 * The two flags do not have the same answer set, which is the finding this whole module is shaped
 * around. Four backends move and were driven live; five break, because cmux has a break-out
 * (`pane.break`) and no way to place a pane beside a named one.
 */
describe('pane relocation capability', () => {
	it.each([
		['tmux', tmuxMuxAdapter],
		['rmux', rmuxMuxAdapter],
		['herdr', herdrMuxAdapter],
		['wezterm', weztermMuxAdapter],
	])('%s declares both capabilities', (_name, adapter) => {
		expect(canMovePanes(adapter)).toBe(true)
		expect(canBreakPanes(adapter)).toBe(true)
	})

	/**
	 * cmux is why there are two flags rather than one. It is the only adapter on the seam that splits
	 * them, and a single `canRelocatePanes` would have had to answer `false` here and discard the half
	 * it really has.
	 */
	it('cmux declares the break-out and refuses the move', () => {
		expect(canBreakPanes(cmuxMuxAdapter)).toBe(true)
		// The absence IS the declaration, the same pairing `canFloatPanes` uses — omitted, never a
		// literal `false`.
		expect(cmuxMuxAdapter.canMovePanes).toBeUndefined()
		expect(canMovePanes(cmuxMuxAdapter)).toBe(false)
		expect(() => cmuxMuxAdapter.movePane(noExec, { id: 'surface:1' }, { id: 'surface:2' }, 'right')).toThrow(
			PaneMoveUnsupportedError,
		)
	})

	it.each([
		['zellij', zellijMuxAdapter],
		['otty', ottyMuxAdapter],
	])('%s refuses BOTH by name, before any exec', (name, adapter) => {
		expect(adapter.canMovePanes).toBeUndefined()
		expect(adapter.canBreakPanes).toBeUndefined()
		expect(canMovePanes(adapter)).toBe(false)
		expect(canBreakPanes(adapter)).toBe(false)
		expect(() => adapter.movePane(noExec, { id: 'p1' }, { id: 'p2' }, 'right')).toThrow(PaneMoveUnsupportedError)
		expect(() => adapter.breakPane(noExec, { id: 'p1' }, 'tab')).toThrow(PaneBreakUnsupportedError)
		try {
			adapter.movePane(noExec, { id: 'p1' }, { id: 'p2' }, 'right')
		} catch (error) {
			expect((error as PaneMoveUnsupportedError).backend).toBe(name)
			expect((error as Error).message).toBe(`${name} cannot move a pane`)
		}
		try {
			adapter.breakPane(noExec, { id: 'p1' }, 'tab')
		} catch (error) {
			expect((error as PaneBreakUnsupportedError).backend).toBe(name)
			expect((error as Error).message).toBe(`${name} cannot break a pane out`)
		}
	})
})
