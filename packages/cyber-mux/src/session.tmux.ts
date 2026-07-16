import type { LivePane, RegionPane, SessionAdapter, SessionReadOptions, SessionTarget } from './session.ts'

/** tmux backend — detected via `$TMUX`. */
export const tmuxSessionAdapter: SessionAdapter = {
	name: 'tmux',

	// `split-window -l N%` sizes a split; see `toTmuxSize` for the inversion it needs.
	canSizeSplits: true,

	open(exec, opts) {
		// tmux has fewer tiers than herdr: no Workspace level, and "window" is its name for the Tab
		// concept. So both 'workspace' (own visible space) and 'tab' collapse to a new WINDOW — the
		// finest "own visible space" unit tmux offers, visible in the status bar and reachable by
		// `select-window` (which cross-window beaming/focus relies on). `-d` opens it in the
		// background without stealing the caller's focus. A pane is never placed in a detached
		// (`new-session -d`) session — that is invisible to the attached client and unreachable by
		// beaming; a truly-detached session would be a separate explicit intent.
		const at = opts.at ?? 'tab'
		const window = at === 'workspace' || at === 'tab'
		// `-t` whenever the caller names a pane. Without it tmux does NOT split the calling pane — it
		// splits the session's ACTIVE pane, ignoring `$TMUX_PANE` outright (verified on tmux 3.6b: a
		// `split-window` run inside pane %1, with `$TMUX_PANE` correctly reading %1, split the active
		// %0 instead). The two coincide while a human types, which is why the default reads as
		// harmless and is not; a program driving a pane it is not focused on gets the wrong one.
		const from = !window && opts.from ? ['-t', opts.from.id] : []
		// A window is not sized against a pane, so `-l` only reaches a split. Empty unless the caller
		// asks, so every existing call site emits byte-identical argv.
		const size = !window && opts.ratio != null ? ['-l', toTmuxSize(opts.ratio)] : []
		// `-e` is on BOTH `split-window` and `new-window` (tmux(1): `new-window [-abdkPS] [-c
		// start-directory] [-e environment] ...`), so env is native at EVERY tier — which it must be:
		// a layout's root pane is the region's own pane, born by the window open rather than by any
		// split, so scoping this to the split path would silently drop that pane's env.
		const env = opts.env ? Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]) : []
		const args = window
			? // `-d` keeps focus on the caller (opens the window in the background) — without it tmux
				// switches the attached client to the new window, stealing the caller's focus. The
				// returned pane id and subsequent `send-keys -t` still target the new pane.
				['new-window', '-d', ...env, '-c', opts.cwd, '-P', '-F', '#{pane_id}']
			: at === 'pane:down'
				? ['split-window', '-v', ...from, ...size, ...env, '-c', opts.cwd, '-P', '-F', '#{pane_id}']
				: ['split-window', '-h', ...from, ...size, ...env, '-c', opts.cwd, '-P', '-F', '#{pane_id}']
		// A window takes its name at birth — `-n` also turns tmux's `automatic-rename` off for it, so
		// the name survives whatever the pane goes on to run. A pane has no such flag; its title is
		// set after the split.
		if (window && opts.label) args.splice(1, 0, '-n', opts.label)
		const pane = exec('tmux', args)
		if (!pane) throw new Error(`tmux ${args[0]} failed`)
		const target: SessionTarget = { id: pane }
		if (!window && opts.label) exec('tmux', ['select-pane', '-t', pane, '-T', opts.label])
		// `submit`, not `sendText` — a launch command has to actually run, and `submit` is the only
		// verb that supplies the Enter.
		if (opts.launch) tmuxSessionAdapter.submit(exec, target, opts.launch)
		return target
	},

	sendText(exec, target, text) {
		// `-l` is mandatory, not a nicety: without it tmux resolves each argument as a key name first
		// and only falls back to characters ("if the string is not recognised as a key, it is sent as
		// a series of characters"), so a bare `send-keys -t <p> Up` would press the arrow instead of
		// typing the word. `-l` disables that lookup outright.
		exec('tmux', ['send-keys', '-t', target.id, '-l', text])
	},

	sendKeys(exec, target, keys) {
		exec('tmux', ['send-keys', '-t', target.id, ...keys.map(toTmuxKey)])
	},

	submit(exec, target, text) {
		// No `-l` here: a bare Enter must resolve as the KEY, which is exactly what the key lookup is
		// for. `''` is the bare-flush case too — `send-keys -l ''` would be a no-op typing nothing,
		// leaving the staged buffer unsent.
		if (!text) {
			exec('tmux', ['send-keys', '-t', target.id, 'Enter'])
			return
		}
		// Two calls, unavoidably: tmux has no atomic literal-text-plus-Enter primitive. `-l` applies to
		// the whole argument list, so `send-keys -l <text> Enter` would type a literal "Enter" after the
		// text rather than pressing it. The composed path is what `submit`'s outcome-not-command
		// contract exists to permit.
		tmuxSessionAdapter.sendText(exec, target, text)
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

	describeRegion(exec, target) {
		// `-t <pane-id>` scopes `list-panes` to that pane's OWN window — the region tier, which is what
		// export captures. Without `-a`, so this never reaches the panes of some other window.
		//
		// `#{pane_left}`/`#{pane_top}` are window-relative, and the widths exclude the divider column
		// tmux draws between panes (a 200-wide window split side by side reports 119 + 80, not 200) —
		// both are exactly what `RegionPane.rect` documents, so nothing is adjusted here.
		//
		// Tab-separated, not space: `pane_current_path` and `pane_title` can both contain spaces, and
		// splitting a path on spaces is how a directory with one in it silently becomes the wrong pane.
		const out = exec('tmux', [
			'list-panes',
			'-t',
			target.id,
			'-F',
			'#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_title}\t#{host}',
		])
		if (!out) throw new Error(`tmux could not describe the region around pane ${target.id}`)
		const panes: RegionPane[] = []
		for (const line of out.split('\n').filter(Boolean)) {
			const [id, left, top, width, height, cwd, title, host] = line.split('\t')
			if (!id) continue
			const pane: RegionPane = {
				id,
				rect: { x: Number(left), y: Number(top), width: Number(width), height: Number(height) },
			}
			if (cwd) pane.cwd = cwd
			// tmux has no "unset title" — it defaults `pane_title` to the hostname, so every pane in an
			// untouched window reports the same name. Exporting that would put `label: "zeta"` on all of
			// them, which is not a label anyone chose. A title that differs from the host is one someone
			// set (cyber-mux's own `select-pane -T` among them), so it is the author's and survives.
			if (title && title !== host) pane.label = title
			panes.push(pane)
		}
		if (panes.length === 0) throw new Error(`tmux reported no panes in the region around pane ${target.id}`)
		return panes
	},
}

/**
 * `ratio` is the fraction kept by the ORIGINAL pane; tmux's `-l` sizes the NEW one. So this INVERTS
 * — `1 - ratio` — where herdr's `--ratio` passes the same number through untouched. The two backends
 * genuinely convert in opposite directions, and applying the inversion to both (or to neither) is
 * the way this gets silently backwards: a 0.333 template would size the original pane at 67%.
 *
 * Percent rather than cells: tmux takes `-l` as either, and a percentage is the only form that means
 * the same thing without first querying the region's size.
 */
function toTmuxSize(ratio: number): string {
	return `${Math.round((1 - ratio) * 100)}%`
}

/**
 * The core vocabulary's tmux spelling. Exactly one member differs — probed, not read off tmux(1):
 * tmux has no `Backspace` key name, so it would *type* the word (its unrecognized-token fallback);
 * its name for that key is `BSpace` (tmux(1): "the following special key names are accepted: Up,
 * Down, Left, Right, BSpace, BTab, DC ..."). Every other core key — `Up` `Down` `Left` `Right`
 * `Enter` `Escape` `Tab` `Space` `C-c` `F1`-`F12` — is already tmux's own name for it.
 *
 * Deliberately a rename table, NOT a validation table: a token outside the core is forwarded
 * verbatim (the contract), so this must not reject what it does not recognize. Keeping a full tmux
 * key list here would make the passthrough a second vocabulary to maintain.
 */
const TMUX_KEY_RENAMES: Readonly<Record<string, string>> = { Backspace: 'BSpace' }

function toTmuxKey(key: string): string {
	return TMUX_KEY_RENAMES[key] ?? key
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
