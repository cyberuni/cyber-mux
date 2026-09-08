import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { cmuxMuxAdapter } from './mux.cmux.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { ottyMuxAdapter } from './mux.otty.ts'
import { rmuxMuxAdapter } from './mux.rmux.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { zellijMuxAdapter } from './mux.zellij.ts'
import { canZoomPanes, PaneZoomUnsupportedError } from './zoom.ts'

const noExec: Exec = () => {
	throw new Error('the refusal must land before any exec')
}

/**
 * The capability matrix, asserted on the REAL adapters rather than on stubs — the point of a
 * capability declaration is which backends carry it, so a fake would test nothing. This is
 * `resize.test.ts`'s shape for `resizePane`, one member over.
 *
 * Five of seven carry it and each was driven live (see each adapter's own note). The two that do not
 * are not the two the issue expected: wezterm turned out to have the best-shaped zoom on the seam,
 * and cmux — which has none at any programmable layer — took its place.
 */
describe('pane zoom capability', () => {
	it.each([
		['tmux', tmuxMuxAdapter],
		['rmux', rmuxMuxAdapter],
		['herdr', herdrMuxAdapter],
		['zellij', zellijMuxAdapter],
		['wezterm', weztermMuxAdapter],
	])('%s declares the capability', (_name, adapter) => {
		expect(canZoomPanes(adapter)).toBe(true)
		expect(adapter.canZoomPanes).toBe(true)
	})

	it.each([
		['cmux', cmuxMuxAdapter],
		['otty', ottyMuxAdapter],
	])('%s refuses BY NAME, before any exec', (name, adapter) => {
		// The absence IS the declaration, the same pairing `canFloatPanes` uses — omitted, never a
		// literal `false`.
		expect(adapter.canZoomPanes).toBeUndefined()
		expect(canZoomPanes(adapter)).toBe(false)
		expect(() => adapter.setPaneZoom(noExec, { id: 'p1' }, true)).toThrow(PaneZoomUnsupportedError)
		try {
			adapter.setPaneZoom(noExec, { id: 'p1' }, true)
		} catch (error) {
			expect((error as PaneZoomUnsupportedError).backend).toBe(name)
			expect((error as Error).message).toBe(`${name} cannot zoom a pane`)
		}
	})

	/**
	 * The read side does NOT refuse — it answers `undefined`, and never `false`. A backend with no zoom
	 * CLI is not a backend with no zoom: cmux binds pane zoom to ⌘⇧↩ in its own GUI, so `false` would
	 * be a confident lie about a pane the user zoomed by hand. This is the contrast with
	 * `LivePane.floating`, which IS `false` by construction on the backends that cannot float.
	 *
	 * `noExec` is the assertion, not scaffolding: neither backend may spend a command discovering it
	 * cannot answer.
	 */
	it.each([
		['cmux', cmuxMuxAdapter],
		['otty', ottyMuxAdapter],
	])('%s reports zoom state as undefined rather than false, and asks nothing', (_name, adapter) => {
		expect(adapter.isPaneZoomed(noExec, { id: 'p1' })).toBeUndefined()
	})
})
