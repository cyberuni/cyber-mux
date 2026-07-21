import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { currentPane, probeMultiplexer } from './mux-probe.ts'

/** Builds a fake `ps -o ppid=,comm= -p <pid>` chain: pid -> [ppid, comm]. */
function psChain(chain: Record<number, [number, string]>): Exec {
	return (cmd, args) => {
		if (cmd !== 'ps') return null
		const pid = Number.parseInt(args[args.length - 1] ?? '', 10)
		const entry = chain[pid]
		if (!entry) return null
		return `${entry[0]} ${entry[1]}`
	}
}

describe('spec:cyber-mux/mux', () => {
	describe('probeMultiplexer — env fast-path', () => {
		it('$CYBER_MUX is trusted outright as a fast-path', () => {
			const noExec: Exec = () => null
			expect(probeMultiplexer(noExec, { CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%3' })).toEqual({
				mux: 'tmux',
				pane: '%3',
				via: 'env',
			})
		})

		it('$CYBER_MUX=none is an override even inside a real multiplexer', () => {
			const noExec: Exec = () => null
			expect(probeMultiplexer(noExec, { CYBER_MUX: 'none', TMUX: 't' })).toEqual({ mux: 'none', via: 'env' })
		})

		it('ignores an unrecognized $CYBER_MUX value and falls through to discovery', () => {
			const noExec: Exec = () => null
			const probe = probeMultiplexer(noExec, { CYBER_MUX: 'bogus' })
			expect(probe.mux).toBe('none')
			expect(probe.via).toBe('ancestry')
		})

		it('reads a host-provided envPrefix: <prefix> and <prefix>_PANE, not CYBER_MUX', () => {
			const noExec: Exec = () => null
			// A host embedding cyber-mux under its own namespace adopts the fast-path by passing its prefix.
			expect(probeMultiplexer(noExec, { ACME_MUX: 'herdr', ACME_MUX_PANE: 'p9' }, { envPrefix: 'ACME_MUX' })).toEqual({
				mux: 'herdr',
				pane: 'p9',
				via: 'env',
			})
			// And the default namespace is inert under a custom prefix — CYBER_MUX is not consulted.
			const probe = probeMultiplexer(noExec, { CYBER_MUX: 'tmux' }, { discover: false, envPrefix: 'ACME_MUX' })
			expect(probe).toEqual({ mux: 'none', via: 'ancestry' })
		})
	})

	describe('probeMultiplexer — ancestry discovery', () => {
		it('absent the env fast-path, the probe walks the process ancestry from $$', () => {
			const pid = process.pid
			const exec = psChain({
				[pid]: [pid + 1, 'node'],
				[pid + 1]: [pid + 2, 'bash'],
				[pid + 2]: [1, 'tmux: server'],
			})
			expect(probeMultiplexer(exec, { TMUX_PANE: '%7' })).toEqual({ mux: 'tmux', pane: '%7', via: 'ancestry' })
		})

		it('detects a herdr ancestor', () => {
			const pid = process.pid
			const exec = psChain({
				[pid]: [pid + 1, 'node'],
				[pid + 1]: [1, 'herdr'],
			})
			expect(probeMultiplexer(exec, { HERDR_PANE_ID: 'p1' })).toEqual({ mux: 'herdr', pane: 'p1', via: 'ancestry' })
		})

		it('detects a wezterm-gui ancestor', () => {
			const pid = process.pid
			const exec = psChain({
				[pid]: [pid + 1, 'node'],
				[pid + 1]: [1, 'wezterm-gui'],
			})
			expect(probeMultiplexer(exec, { WEZTERM_PANE: '9' })).toEqual({ mux: 'wezterm', pane: '9', via: 'ancestry' })
		})

		it('detects a wezterm-mux-server ancestor', () => {
			const pid = process.pid
			const exec = psChain({ [pid]: [1, 'wezterm-mux-server'] })
			expect(probeMultiplexer(exec, {}).mux).toBe('wezterm')
		})

		it('detects a screen ancestor', () => {
			const pid = process.pid
			const exec = psChain({ [pid]: [1, 'screen'] })
			expect(probeMultiplexer(exec, {})).toEqual({ mux: 'screen', via: 'ancestry' })
		})

		it('recognizes the $CYBER_MUX=screen override — recognition is not support', () => {
			// screen stays a KNOWN value so pinning it is HONORED-then-honestly-rejected (by
			// resolveMuxAdapter), never silently ignored and fallen through to discovery. The probe's
			// job ends at recognition; drivability is resolveMuxAdapter's call (issue #45).
			const exec = psChain({})
			expect(probeMultiplexer(exec, { CYBER_MUX: 'screen' })).toEqual({ mux: 'screen', via: 'env' })
		})

		it('does not stop at the immediate parent shell — walks past it to the real mux ancestor', () => {
			const pid = process.pid
			const exec = psChain({
				[pid]: [pid + 1, 'bash'], // the tool's own shell — not the human's pane
				[pid + 1]: [pid + 2, 'bash'],
				[pid + 2]: [1, 'tmux: server'],
			})
			expect(probeMultiplexer(exec, {}).mux).toBe('tmux')
		})

		it('$TMUX/$HERDR_ENV alone are not trusted — only a fast-positive hint the walk falls back to', () => {
			const noPs: Exec = () => null // ps unavailable
			expect(probeMultiplexer(noPs, { TMUX: 't', TMUX_PANE: '%2' })).toEqual({
				mux: 'tmux',
				pane: '%2',
				via: 'ancestry',
			})
		})

		it('$WEZTERM_PANE alone is a fast-positive hint the walk falls back to, same as $TMUX/$HERDR_ENV', () => {
			const noPs: Exec = () => null
			expect(probeMultiplexer(noPs, { WEZTERM_PANE: '9' })).toEqual({ mux: 'wezterm', pane: '9', via: 'ancestry' })
		})

		it('reports none when neither ancestry nor an env hint finds a multiplexer', () => {
			const noPs: Exec = () => null
			expect(probeMultiplexer(noPs, {})).toEqual({ mux: 'none', via: 'ancestry' })
		})
	})

	describe('currentPane — env-only self pane resolution', () => {
		it('reads $TMUX_PANE as a tmux pane', () => {
			expect(currentPane({ TMUX_PANE: '%3' })).toEqual({ mux: 'tmux', pane: '%3' })
		})

		it('reads $HERDR_PANE_ID as a herdr pane', () => {
			expect(currentPane({ HERDR_PANE_ID: 'w3:p4' })).toEqual({ mux: 'herdr', pane: 'w3:p4' })
		})

		it('prefers the $CYBER_MUX_PANE fast-path, tagging it herdr when $CYBER_MUX=herdr', () => {
			expect(currentPane({ CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w3:p4', TMUX_PANE: '%3' })).toEqual({
				mux: 'herdr',
				pane: 'w3:p4',
			})
		})

		it('defaults the fast-path mux to tmux when $CYBER_MUX is absent', () => {
			expect(currentPane({ CYBER_MUX_PANE: '%9' })).toEqual({ mux: 'tmux', pane: '%9' })
		})

		it('reads $WEZTERM_PANE as a wezterm pane', () => {
			expect(currentPane({ WEZTERM_PANE: '9' })).toEqual({ mux: 'wezterm', pane: '9' })
		})

		it('tags the $CYBER_MUX_PANE fast-path wezterm when $CYBER_MUX=wezterm', () => {
			expect(currentPane({ CYBER_MUX: 'wezterm', CYBER_MUX_PANE: '9', TMUX_PANE: '%3' })).toEqual({
				mux: 'wezterm',
				pane: '9',
			})
		})

		it('prefers $TMUX_PANE over $HERDR_PANE_ID when both are present', () => {
			expect(currentPane({ TMUX_PANE: '%3', HERDR_PANE_ID: 'w3:p4' })).toEqual({ mux: 'tmux', pane: '%3' })
		})

		it('returns undefined when the session is in no pane-carrying multiplexer', () => {
			expect(currentPane({})).toBeUndefined()
		})
	})
})
