import { describe, expect, it } from 'vitest'
import { callerPane, selectSessionAdapter } from './backend.ts'
import type { Exec } from './exec.ts'
import { herdrSessionAdapter } from './session.herdr.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'

// selectSessionAdapter consults the ancestry-discovery mux probe by default (see mux-probe.ts).
// These tests pin `exec` to a stub that reports no ancestry (ps unavailable), so the outcome is
// deterministic — driven only by the $TMUX/$HERDR_ENV env hint — regardless of the real multiplexer
// the test runner itself happens to be running under.
const noAncestry: Exec = () => null

describe('spec:cyber-mux/mux', () => {
	describe('selectSessionAdapter', () => {
		it('the session backend is selected by environment', () => {
			expect(selectSessionAdapter({ TMUX: 't' }, noAncestry)).toBe(tmuxSessionAdapter)
		})

		it('the session backend is selected by environment', () => {
			expect(selectSessionAdapter({ HERDR_ENV: '1' }, noAncestry)).toBe(herdrSessionAdapter)
		})

		it('prefers tmux when both are set', () => {
			expect(selectSessionAdapter({ TMUX: 't', HERDR_ENV: '1' }, noAncestry)).toBe(tmuxSessionAdapter)
		})

		it('neither tmux nor herdr detected errors before opening anything', () => {
			expect(() => selectSessionAdapter({}, noAncestry)).toThrow(/tmux.*herdr|herdr.*tmux/)
		})

		it('an ancestry-verified mux wins over a stale env hint', () => {
			const psChain: Exec = (cmd, args) => {
				if (cmd !== 'ps') return null
				const pid = Number.parseInt(args[args.length - 1] ?? '', 10)
				return pid === process.pid ? '1 tmux: server' : null
			}
			// $HERDR_ENV hints herdr, but the ancestry walk conclusively finds tmux — tmux wins.
			expect(selectSessionAdapter({ HERDR_ENV: '1' }, psChain)).toBe(tmuxSessionAdapter)
		})
	})

	describe('callerPane', () => {
		it('reports this session’s own pane as a target the adapter can address', () => {
			expect(callerPane(tmuxSessionAdapter, { TMUX_PANE: '%7' })).toEqual({ id: '%7' })
			expect(callerPane(herdrSessionAdapter, { HERDR_ENV: '1', HERDR_PANE_ID: 'w3:p1' })).toEqual({ id: 'w3:p1' })
		})

		it('honors the $CYBER_MUX_PANE fast-path a spawn propagates', () => {
			// The documented override, and the reason this resolves through `currentPane` rather than
			// reading $HERDR_PANE_ID/$TMUX_PANE directly: a spawn propagates CYBER_MUX_PANE, and a
			// backend's own `--current`/active-pane default cannot see it.
			expect(callerPane(herdrSessionAdapter, { CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w9:p3' })).toEqual({
				id: 'w9:p3',
			})
			expect(callerPane(tmuxSessionAdapter, { CYBER_MUX_PANE: '%4' })).toEqual({ id: '%4' })
		})

		it('is undefined when this session is in no pane', () => {
			expect(callerPane(tmuxSessionAdapter, {})).toBeUndefined()
			expect(callerPane(herdrSessionAdapter, {})).toBeUndefined()
		})

		it('refuses a pane belonging to a DIFFERENT multiplexer than the adapter drives', () => {
			// Reachable: a $TMUX_PANE inherited into a herdr pane, or $CYBER_MUX pointed at the other
			// backend. Handing herdr a tmux pane id would not fail loudly — herdr would reject the id
			// and `Exec` reports a failed command as null, surfacing as "split failed" rather than as
			// the identity mixup it is. Falling back to the backend's own default keeps the blast
			// radius at "possibly the wrong pane" instead of "a foreign id".
			expect(callerPane(herdrSessionAdapter, { TMUX_PANE: '%7' })).toBeUndefined()
			expect(callerPane(tmuxSessionAdapter, { HERDR_ENV: '1', HERDR_PANE_ID: 'w3:p1' })).toBeUndefined()
			expect(callerPane(tmuxSessionAdapter, { CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w9:p3' })).toBeUndefined()
		})
	})
})
