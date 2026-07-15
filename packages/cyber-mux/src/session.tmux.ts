import type { LivePane, SessionAdapter, SessionReadOptions, SessionTarget } from './session.ts'

/** tmux backend — detected via `$TMUX`. */
export const tmuxSessionAdapter: SessionAdapter = {
	name: 'tmux',

	open(exec, opts) {
		// tmux has fewer tiers than herdr: no Workspace level, and "window" is its name for the Tab
		// concept. So both 'workspace' (own visible space) and 'tab' collapse to a new WINDOW — the
		// finest "own visible space" unit tmux offers, visible in the status bar and reachable by
		// `select-window` (which cross-window beaming/focus relies on). `-d` opens it in the
		// background without stealing the caller's focus. A pane is never placed in a detached
		// (`new-session -d`) session — that is invisible to the attached client and unreachable by
		// beaming; a truly-detached session would be a separate explicit intent.
		const at = opts.at ?? 'tab'
		const args =
			at === 'workspace' || at === 'tab'
				? // `-d` keeps focus on the caller (opens the window in the background) — without it tmux
					// switches the attached client to the new window, stealing the caller's focus. The
					// returned pane id and subsequent `send-keys -t` still target the new pane.
					['new-window', '-d', '-c', opts.cwd, '-P', '-F', '#{pane_id}']
				: at === 'pane:down'
					? ['split-window', '-v', '-c', opts.cwd, '-P', '-F', '#{pane_id}']
					: ['split-window', '-h', '-c', opts.cwd, '-P', '-F', '#{pane_id}']
		const pane = exec('tmux', args)
		if (!pane) throw new Error(`tmux ${args[0]} failed`)
		const target: SessionTarget = { id: pane }
		tmuxSessionAdapter.send(exec, target, opts.launch)
		return target
	},

	send(exec, target, text) {
		exec('tmux', ['send-keys', '-t', target.id, text, 'Enter'])
	},

	submit(exec, target) {
		// Bare Enter — flushes an already-staged buffer without re-typing it.
		exec('tmux', ['send-keys', '-t', target.id, 'Enter'])
	},

	read(exec, target, opts?: SessionReadOptions) {
		const args = ['capture-pane', '-p', '-t', target.id]
		if (opts?.lines != null) args.push('-S', `-${opts.lines}`)
		return exec('tmux', args) ?? ''
	},

	focus(exec, target) {
		// A bare `select-pane` only moves focus within the caller's OWN attached session/window — a
		// peer's pane can live in a different tmux session and window entirely, so that alone would
		// silently no-op on the attached client. Resolve the pane's session + window from
		// `list-panes -a` first and drive the beam in order: switch-client (session), then
		// select-window, then select-pane. Resolution happens BEFORE any switch is issued, so an
		// unresolvable pane throws instead of a partial or false-success beam.
		const out = exec('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{session_name} #{window_id}'])
		const { sessionName, windowId } = parsePaneLocation(out, target.id)
		exec('tmux', ['switch-client', '-t', sessionName])
		exec('tmux', ['select-window', '-t', windowId])
		exec('tmux', ['select-pane', '-t', target.id])
	},

	teardown(exec, target) {
		exec('tmux', ['kill-pane', '-t', target.id])
	},

	paneExists(exec, target) {
		// `has-session` hits when the pane id happens to name a session; otherwise scan every pane
		// server-wide for the id (pane ids are globally unique across sessions).
		if (exec('tmux', ['has-session', '-t', target.id]) !== null) return true
		return (exec('tmux', ['list-panes', '-a', '-F', '#{pane_id}']) ?? '').split('\n').includes(target.id)
	},

	isPaneFocused(exec, target) {
		// `list-panes -a` server-wide, one line per pane: pane_id, whether it's the active pane of its
		// window, whether its window is the current one of its session, and the session's attached
		// client count. Focused iff all three hold; unresolvable (line missing) or no output → unknown,
		// never a false `false` — a caller can't tell "not focused" from "couldn't find the pane" here.
		const out = exec('tmux', [
			'list-panes',
			'-a',
			'-F',
			'#{pane_id} #{pane_active} #{window_active} #{session_attached}',
		])
		if (!out) return undefined
		const line = out.split('\n').find((l) => l.split(' ')[0] === target.id)
		if (!line) return undefined
		const [, paneActive, windowActive, sessionAttached] = line.split(' ')
		return paneActive === '1' && windowActive === '1' && sessionAttached !== '0' && sessionAttached !== undefined
	},

	listPanes(exec): LivePane[] {
		const out = exec('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command} #{pane_current_path}'])
		if (!out) return []
		return out
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [id, , ...cwdParts] = line.split(' ')
				return { id: id ?? '', mux: 'tmux' as const, cwd: cwdParts.length ? cwdParts.join(' ') : undefined }
			})
			.filter((p) => p.id !== '')
	},
}

/**
 * `tmux list-panes -a -F '#{pane_id} #{session_name} #{window_id}'` lists every pane server-wide.
 * Resolving fails — no line's pane id matches `id` — when the pane no longer exists in the backend,
 * and that must throw so `focus` never issues a switch-client/select-window against a pane it
 * couldn't actually resolve.
 */
function parsePaneLocation(out: string | null, id: string): { sessionName: string; windowId: string } {
	const line = (out ?? '').split('\n').find((l) => l.split(' ')[0] === id)
	if (!line) throw new Error(`peer's pane ${id} could not be resolved to beam to`)
	const [, sessionName, windowId] = line.split(' ')
	return { sessionName: sessionName!, windowId: windowId! }
}
