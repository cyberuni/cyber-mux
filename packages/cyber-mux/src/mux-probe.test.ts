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

describe('spec:cyber-mux/mux/detection', () => {
	describe('probeMultiplexer — env fast-path', () => {
		it('detection-cyber-mux-fast-path', () => {
			const noExec: Exec = () => null
			expect(probeMultiplexer(noExec, { CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%3' })).toEqual({
				mux: 'tmux',
				pane: '%3',
				via: 'env',
			})
		})

		it('detection-cyber-mux-none-override', () => {
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
		it('detection-ancestry-walk-fallback', () => {
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

		it('detects a zellij ancestor', () => {
			const pid = process.pid
			const exec = psChain({
				[pid]: [pid + 1, 'node'],
				[pid + 1]: [1, 'zellij'],
			})
			expect(probeMultiplexer(exec, { ZELLIJ_PANE_ID: 'terminal_3' })).toEqual({
				mux: 'zellij',
				pane: 'terminal_3',
				via: 'ancestry',
			})
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

		it('detection-hint-not-trusted-alone', () => {
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

		it('$ZELLIJ alone is a fast-positive hint the walk falls back to, attaching the separate $ZELLIJ_PANE_ID', () => {
			const noPs: Exec = () => null
			expect(probeMultiplexer(noPs, { ZELLIJ: '0', ZELLIJ_PANE_ID: 'terminal_3' })).toEqual({
				mux: 'zellij',
				pane: 'terminal_3',
				via: 'ancestry',
			})
		})

		it('$CMUX_WORKSPACE_ID alone is a fast-positive hint the walk falls back to, attaching the separate $CMUX_SURFACE_ID', () => {
			const noPs: Exec = () => null
			expect(probeMultiplexer(noPs, { CMUX_WORKSPACE_ID: 'workspace:1', CMUX_SURFACE_ID: 'surface:7' })).toEqual({
				mux: 'cmux',
				pane: 'surface:7',
				via: 'ancestry',
			})
		})

		// rmux's ancestry marker is `rmux-daemon`, not `rmux`: a pane's shell is parented by the
		// long-lived daemon, which is what a `ps -o ppid=,comm=` walk from inside a real rmux pane
		// actually climbs to (probed on 0.10.0).
		it('walks to rmux-daemon and reads $RMUX_PANE as the pane', () => {
			const pid = process.pid
			const exec = psChain({
				[pid]: [pid + 1, 'node'],
				[pid + 1]: [pid + 2, 'zsh'],
				[pid + 2]: [1, 'rmux-daemon'],
			})
			expect(probeMultiplexer(exec, { RMUX_PANE: '%7' })).toEqual({ mux: 'rmux', pane: '%7', via: 'ancestry' })
		})

		it('$RMUX alone is a fast-positive hint the walk falls back to, attaching the separate $RMUX_PANE', () => {
			const noPs: Exec = () => null
			expect(probeMultiplexer(noPs, { RMUX: '/tmp/rmux/default,123,0', RMUX_PANE: '%4' })).toEqual({
				mux: 'rmux',
				pane: '%4',
				via: 'ancestry',
			})
		})

		// THE ordering trap, and the single most load-bearing detection claim this backend adds. A real
		// rmux pane sets `$TMUX` and `$TMUX_PANE` alongside its own vars, to the SAME values, for tmux
		// compatibility (probed live on rmux 0.10.0 by dumping a pane's environment). So an env that
		// carries both is rmux, not tmux — and getting it backwards would resolve every rmux session to
		// the tmux adapter, where rmux's own PATH shim named `tmux` would keep the mistake silent
		// instead of loud.
		it('detection-rmux-wins-over-its-own-tmux-compat-vars', () => {
			const noPs: Exec = () => null
			const triple = '/tmp/rmux-1000/sock,46694,0'
			expect(probeMultiplexer(noPs, { RMUX: triple, RMUX_PANE: '%1', TMUX: triple, TMUX_PANE: '%1' })).toEqual({
				mux: 'rmux',
				pane: '%1',
				via: 'ancestry',
			})
		})

		// The reverse is unreachable in the wild — tmux does not set `$RMUX` — but the row pins that
		// tmux is still detected as tmux rather than being shadowed by the new branch.
		it('a tmux pane is still tmux: $TMUX without $RMUX is unaffected by the rmux branch', () => {
			const noPs: Exec = () => null
			expect(probeMultiplexer(noPs, { TMUX: 't', TMUX_PANE: '%2' })).toEqual({
				mux: 'tmux',
				pane: '%2',
				via: 'ancestry',
			})
		})

		it('recognizes the $CYBER_MUX=rmux override', () => {
			const noExec: Exec = () => null
			expect(probeMultiplexer(noExec, { CYBER_MUX: 'rmux', CYBER_MUX_PANE: '%5' })).toEqual({
				mux: 'rmux',
				pane: '%5',
				via: 'env',
			})
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

		it('reads $RMUX_PANE as an rmux pane', () => {
			expect(currentPane({ RMUX_PANE: '%3' })).toEqual({ mux: 'rmux', pane: '%3' })
		})

		// The same ordering trap one layer down. `currentPane` is the SELF-identity key, so reading an
		// rmux pane as tmux here hands `callerPane` a pane the tmux adapter would then drive with the
		// wrong binary — see the probe-level row above for why both vars are present at once.
		it('reads a pane carrying BOTH $RMUX_PANE and $TMUX_PANE as rmux, never tmux', () => {
			expect(currentPane({ RMUX_PANE: '%1', TMUX_PANE: '%1' })).toEqual({ mux: 'rmux', pane: '%1' })
		})

		it('tags the $CYBER_MUX_PANE fast-path rmux when $CYBER_MUX=rmux', () => {
			expect(currentPane({ CYBER_MUX: 'rmux', CYBER_MUX_PANE: '%5', TMUX_PANE: '%3' })).toEqual({
				mux: 'rmux',
				pane: '%5',
			})
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

		it('reads $ZELLIJ_PANE_ID as a zellij pane', () => {
			expect(currentPane({ ZELLIJ_PANE_ID: 'terminal_3' })).toEqual({ mux: 'zellij', pane: 'terminal_3' })
		})

		it('tags the $CYBER_MUX_PANE fast-path zellij when $CYBER_MUX=zellij', () => {
			expect(currentPane({ CYBER_MUX: 'zellij', CYBER_MUX_PANE: 'terminal_3', TMUX_PANE: '%3' })).toEqual({
				mux: 'zellij',
				pane: 'terminal_3',
			})
		})

		it('reads $CMUX_SURFACE_ID as a cmux pane', () => {
			expect(currentPane({ CMUX_SURFACE_ID: 'surface:7' })).toEqual({ mux: 'cmux', pane: 'surface:7' })
		})

		it('tags the $CYBER_MUX_PANE fast-path cmux when $CYBER_MUX=cmux', () => {
			expect(currentPane({ CYBER_MUX: 'cmux', CYBER_MUX_PANE: 'surface:7', TMUX_PANE: '%3' })).toEqual({
				mux: 'cmux',
				pane: 'surface:7',
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
