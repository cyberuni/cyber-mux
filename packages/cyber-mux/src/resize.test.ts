import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { cmuxMuxAdapter } from './mux.cmux.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { ottyMuxAdapter } from './mux.otty.ts'
import { rmuxMuxAdapter } from './mux.rmux.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { zellijMuxAdapter } from './mux.zellij.ts'
import { derivePaneResize, PaneResizeUnsupportedError } from './resize.ts'

const noExec: Exec = () => {
	throw new Error('the refusal must land before any exec')
}

/**
 * The capability matrix, asserted on the REAL adapters rather than on stubs — the point of the member
 * is which backends can carry it, so a fake would test nothing. tmux, rmux and herdr report pane
 * rects and so can turn a ratio into their own resize argument; the other four cannot, and the two of those that
 * do own a relative resize verb (zellij `action resize`, otty `pane resize --right N`) are refused
 * anyway, because a nudge of an unstated size and a count of cells are not the fraction this verb takes.
 */
describe('derivePaneResize', () => {
	it.each([
		['tmux', tmuxMuxAdapter],
		['rmux', rmuxMuxAdapter],
		['herdr', herdrMuxAdapter],
	])('%s carries the capability', (_name, adapter) => {
		expect(adapter.regions?.resizePane).toBeTypeOf('function')
	})

	it.each([
		['wezterm', weztermMuxAdapter],
		['zellij', zellijMuxAdapter],
		['cmux', cmuxMuxAdapter],
		['otty', ottyMuxAdapter],
	])('%s refuses BY NAME, before any exec', (name, adapter) => {
		expect(adapter.regions?.resizePane).toBeUndefined()
		expect(() => derivePaneResize(adapter, noExec, { id: 'p1' }, 0.5)).toThrow(PaneResizeUnsupportedError)
		try {
			derivePaneResize(adapter, noExec, { id: 'p1' }, 0.5)
		} catch (error) {
			expect((error as PaneResizeUnsupportedError).backend).toBe(name)
			expect((error as Error).message).toBe(`${name} cannot resize a pane`)
		}
	})

	it('delegates to the capability unchanged when the backend has one', () => {
		const seen: unknown[] = []
		const adapter = {
			name: 'fake',
			regions: { resizePane: (_e: Exec, target: unknown, ratio: number) => seen.push(target, ratio) },
		} as never
		derivePaneResize(adapter, noExec, { id: '%3' }, 0.42)
		expect(seen).toEqual([{ id: '%3' }, 0.42])
	})
})
