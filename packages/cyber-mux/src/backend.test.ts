import { describe, expect, it } from 'vitest'
import { callerPane, resolveMuxAdapter } from './backend.ts'
import type { Exec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'

// resolveMuxAdapter consults the ancestry-discovery mux probe by default (see mux-probe.ts).
// These tests pin `exec` to a stub that reports no ancestry (ps unavailable), so the outcome is
// deterministic — driven only by the $TMUX/$HERDR_ENV env hint — regardless of the real multiplexer
// the test runner itself happens to be running under.
const noAncestry: Exec = () => null

describe('spec:cyber-mux/mux', () => {
	describe('resolveMuxAdapter', () => {
		it('the session backend is selected by environment', () => {
			expect(resolveMuxAdapter({ TMUX: 't' }, noAncestry)).toBe(tmuxMuxAdapter)
		})

		it('the session backend is selected by environment', () => {
			expect(resolveMuxAdapter({ HERDR_ENV: '1' }, noAncestry)).toBe(herdrMuxAdapter)
		})

		it('prefers tmux when both are set', () => {
			expect(resolveMuxAdapter({ TMUX: 't', HERDR_ENV: '1' }, noAncestry)).toBe(tmuxMuxAdapter)
		})

		it('the session backend is selected by environment', () => {
			expect(resolveMuxAdapter({ WEZTERM_PANE: '9' }, noAncestry)).toBe(weztermMuxAdapter)
		})

		it('neither tmux, herdr, nor wezterm detected errors before opening anything', () => {
			expect(() => resolveMuxAdapter({}, noAncestry)).toThrow(/tmux.*herdr.*wezterm|wezterm.*herdr.*tmux/)
		})

		it('a detected screen is rejected by name, not with the generic no-multiplexer error', () => {
			// screen is a KNOWN mux the probe recognizes — via the fast-path override here, and via
			// ancestry for a real screen session — but not a drivable backend (issue #45). The rejection
			// must NAME screen and state the reason, so a caller who pinned CYBER_MUX=screen is told the
			// truth (a real multiplexer cyber-mux cannot drive) rather than the lie "run inside one".
			expect(() => resolveMuxAdapter({ CYBER_MUX: 'screen' }, noAncestry)).toThrow(/screen/i)
			expect(() => resolveMuxAdapter({ CYBER_MUX: 'screen' }, noAncestry)).toThrow(
				/cannot drive|no per-pane id|identity/i,
			)
		})

		it('rejects a screen ancestor by name too, not only the pinned override', () => {
			const psChain: Exec = (cmd, args) => {
				if (cmd !== 'ps') return null
				const pid = Number.parseInt(args[args.length - 1] ?? '', 10)
				return pid === process.pid ? '1 screen' : null
			}
			expect(() => resolveMuxAdapter({}, psChain)).toThrow(/screen/i)
		})

		it('an ancestry-verified mux wins over a stale env hint', () => {
			const psChain: Exec = (cmd, args) => {
				if (cmd !== 'ps') return null
				const pid = Number.parseInt(args[args.length - 1] ?? '', 10)
				return pid === process.pid ? '1 tmux: server' : null
			}
			// $HERDR_ENV hints herdr, but the ancestry walk conclusively finds tmux — tmux wins.
			expect(resolveMuxAdapter({ HERDR_ENV: '1' }, psChain)).toBe(tmuxMuxAdapter)
		})
	})

	describe('callerPane', () => {
		it('reports this session’s own pane as a target the adapter can address', () => {
			expect(callerPane(tmuxMuxAdapter, { TMUX_PANE: '%7' })).toEqual({ id: '%7' })
			expect(callerPane(herdrMuxAdapter, { HERDR_ENV: '1', HERDR_PANE_ID: 'w3:p1' })).toEqual({ id: 'w3:p1' })
			expect(callerPane(weztermMuxAdapter, { WEZTERM_PANE: '9' })).toEqual({ id: '9' })
		})

		it('honors the $CYBER_MUX_PANE fast-path a spawn propagates', () => {
			// The documented override, and the reason this resolves through `currentPane` rather than
			// reading $HERDR_PANE_ID/$TMUX_PANE directly: a spawn propagates CYBER_MUX_PANE, and a
			// backend's own `--current`/active-pane default cannot see it.
			expect(callerPane(herdrMuxAdapter, { CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w9:p3' })).toEqual({
				id: 'w9:p3',
			})
			expect(callerPane(tmuxMuxAdapter, { CYBER_MUX_PANE: '%4' })).toEqual({ id: '%4' })
		})

		it('is undefined when this session is in no pane', () => {
			expect(callerPane(tmuxMuxAdapter, {})).toBeUndefined()
			expect(callerPane(herdrMuxAdapter, {})).toBeUndefined()
		})

		it('refuses a pane belonging to a DIFFERENT multiplexer than the adapter drives', () => {
			// Reachable: a $TMUX_PANE inherited into a herdr pane, or $CYBER_MUX pointed at the other
			// backend. Handing herdr a tmux pane id would not fail loudly — herdr would reject the id
			// and `Exec` reports a failed command as null, surfacing as "split failed" rather than as
			// the identity mixup it is. Falling back to the backend's own default keeps the blast
			// radius at "possibly the wrong pane" instead of "a foreign id".
			expect(callerPane(herdrMuxAdapter, { TMUX_PANE: '%7' })).toBeUndefined()
			expect(callerPane(tmuxMuxAdapter, { HERDR_ENV: '1', HERDR_PANE_ID: 'w3:p1' })).toBeUndefined()
			expect(callerPane(tmuxMuxAdapter, { CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w9:p3' })).toBeUndefined()
		})
	})
})
