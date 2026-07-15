import { type Exec, realExec } from './exec.ts'
import { probeMultiplexer } from './mux-probe.ts'
import { herdrSessionAdapter } from './session.herdr.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'
import type { SessionAdapter } from './session.ts'

/**
 * Backend selection via the two-mode mux probe (`$CYBER_MUX` fast-path/override, else ancestry
 * discovery from `$$` falling back to the `$TMUX`/`$HERDR_ENV` hint when the walk is inconclusive)
 * — tmux/herdr map to their existing adapters; anything else is a clear error.
 */
export function selectSessionAdapter(env: NodeJS.ProcessEnv, exec: Exec = realExec): SessionAdapter {
	const probe = probeMultiplexer(exec, env)
	if (probe.mux === 'tmux') return tmuxSessionAdapter
	if (probe.mux === 'herdr') return herdrSessionAdapter
	throw new Error('cyber-mux requires a session backend — run inside tmux ($TMUX) or herdr ($HERDR_ENV=1)')
}
