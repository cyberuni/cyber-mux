import { describe, expect, it } from 'vitest'
import { selectSessionAdapter } from './backend.ts'
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
})
