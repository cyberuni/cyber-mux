import { type Exec, nodeExec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { MuxAdapter, MuxTarget } from './mux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { currentPane, probeMultiplexer } from './mux-probe.ts'

/**
 * Backend selection via the two-mode mux probe (`$CYBER_MUX` fast-path/override, else ancestry
 * discovery from `$$` falling back to the `$TMUX`/`$HERDR_ENV`/`$WEZTERM_PANE` hint when the walk is
 * inconclusive) — tmux/herdr/wezterm map to their existing adapters; anything else is a clear error.
 */
export function selectMuxAdapter(env: NodeJS.ProcessEnv, exec: Exec = nodeExec): MuxAdapter {
	const probe = probeMultiplexer(exec, env)
	if (probe.mux === 'tmux') return tmuxMuxAdapter
	if (probe.mux === 'herdr') return herdrMuxAdapter
	if (probe.mux === 'wezterm') return weztermMuxAdapter
	throw new Error(
		'cyber-mux requires a session backend — run inside tmux ($TMUX), herdr ($HERDR_ENV=1), or wezterm ($WEZTERM_PANE set)',
	)
}

/**
 * This process's own pane, as something `adapter` can address — `MuxOpenOptions.from`'s intended
 * argument for a `pane:*` open, so a split lands on the caller rather than on whichever pane the
 * user is looking at (see `from`'s note for why each backend's default gets that wrong).
 *
 * `undefined` when this session is in no pane, or in a pane belonging to a *different* multiplexer
 * than `adapter` drives — that mismatch is reachable (a `$TMUX_PANE` inherited into a herdr pane,
 * `$CYBER_MUX` overridden to the other backend), and handing one backend the other's pane id would
 * turn a self-identity mixup into a split of some unrelated pane. Falling back to the backend's own
 * default is the conservative answer: still possibly the wrong pane, but never a foreign id.
 */
export function callerPane(adapter: MuxAdapter, env: NodeJS.ProcessEnv): MuxTarget | undefined {
	const self = currentPane(env)
	return self && self.mux === adapter.name ? { id: self.pane } : undefined
}
