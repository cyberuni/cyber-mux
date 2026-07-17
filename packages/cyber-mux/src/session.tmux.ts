import type { Exec } from './exec.ts'
import { withReason } from './exec.ts'
import type { LivePane, OpenedPane, RegionPane, SessionAdapter, SessionReadOptions, WorkspaceTab } from './session.ts'

/**
 * The tmux window user option `SessionOpenOptions.workspaceGroup` is stored in. A user option (the
 * `@` prefix) is tmux's own mechanism for a value it stores but never interprets, so tmux carries
 * the tag without cyber-mux teaching it anything: it survives a window rename, and `list-windows`
 * both reads it back (`#{@cm_ws}`) and filters on it server-side (`-f '#{==:#{@cm_ws},<id>}'`).
 *
 * Named here rather than spelled at each use so the write side and every read side cannot drift.
 * Server-lifetime, like every window: it dies with the tmux server, along with the windows it tags.
 */
export const TMUX_WORKSPACE_GROUP_OPTION = '@cm_ws'

/**
 * The tmux window user option a grouped window's OWN name is stored in — the name the caller gave the
 * tab, beside the group id, because tmux's single `window_name` field no longer holds it.
 *
 * tmux has ONE name field per space. A caller that composes a display name out of a tab's name
 * (`pool - editor`) has destroyed `editor`, and there is no sound way back: splitting on the separator
 * is ambiguous (`acme - beta - main` reads two legal ways), and reading the display name verbatim
 * re-prefixes it on every round trip (`pool - pool - editor`). So the original is stored here and read
 * back from here — the same rule the group id follows, one tier down. The display name is a human's to
 * read; this is what a machine reads.
 *
 * A user option (the `@` prefix) for `TMUX_WORKSPACE_GROUP_OPTION`'s reasons exactly: tmux stores it
 * without interpreting it, it survives a window rename, and `list-windows` reads it back
 * (`#{@cm_tab}`). Named here rather than spelled at each use so the write side and every read side
 * cannot drift.
 */
export const TMUX_TAB_NAME_OPTION = '@cm_tab'

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
		// `-e` is on BOTH `split-window` and `new-window` (tmux(1): `new-window [-abdkPS] [-c
		// start-directory] [-e environment] ...`), so env is native at EVERY tier — which it must be:
		// a layout's root pane is the region's own pane, born by the window open rather than by any
		// split, so scoping this to the split path would silently drop that pane's env.
		const env = opts.env ? Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]) : []
		// A group id tags the WINDOW this open created. It no longer drives the FORMAT — `#{window_id}`
		// is now asked for unconditionally, because `OpenedPane.tab` is required and tmux's Tab is its
		// Window, so every open owes the window it landed in. This deliberately gives up the property
		// that an ungrouped open emitted byte-identical argv to before: tmux only reports what `-F`
		// asks for, and deriving the window from the pane afterwards would be the extra call the field
		// is specified to cost nothing. An honest, uniformly-present field beats identical argv.
		//
		// `group` still gates the tagging itself: a caller that did not ask is not grouped, and a split
		// creates no window of its own to tag (tagging the caller's would group a space the caller
		// never opened).
		const group = window && opts.workspaceGroup != null
		// A tab and a real \t: the pane id and window id are both `%`/`@`-prefixed and contain no
		// whitespace, so a tab separates them unambiguously.
		const format = '#{pane_id}\t#{window_id}'
		// `from` and `size` are declared INSIDE the split branch, and that placement is the whole
		// defense — not a guard. Both are pane concepts: `-t` targets the pane to split, `-l` sizes the
		// split against it, and a window is neither placed nor sized relative to a pane. Scoping them
		// here is what makes the leak unwritable: the window branch cannot spread a value that is not
		// in its scope, so wiring one in is a compile error rather than a wrong flag. A `!window` guard
		// at function scope would be strictly weaker — it leaves the value reachable and merely empties
		// it, so the same mistake compiles and goes quiet. herdr scopes these identically; this is the
		// one adapter that had not caught up.
		let args: string[]
		if (window) {
			// `-d` keeps focus on the caller (opens the window in the background) — without it tmux
			// switches the attached client to the new window, stealing the caller's focus. The returned
			// pane id and subsequent `send-keys -t` still target the new pane.
			args = ['new-window', '-d', ...env, '-c', opts.cwd, '-P', '-F', format]
		} else {
			// `-t` whenever the caller names a pane. Without it tmux does NOT split the calling pane — it
			// splits the session's ACTIVE pane, ignoring `$TMUX_PANE` outright (verified on tmux 3.6b: a
			// `split-window` run inside pane %1, with `$TMUX_PANE` correctly reading %1, split the active
			// %0 instead). The two coincide while a human types, which is why the default reads as
			// harmless and is not; a program driving a pane it is not focused on gets the wrong one.
			const from = opts.from ? ['-t', opts.from.id] : []
			// Empty unless the caller asks, so a split that names no ratio emits no `-l` and tmux applies
			// its own even default.
			const size = opts.ratio != null ? ['-l', toTmuxSize(opts.ratio)] : []
			const direction = at === 'pane:down' ? '-v' : '-h'
			args = ['split-window', direction, ...from, ...size, ...env, '-c', opts.cwd, '-P', '-F', format]
		}
		// A window takes its name at birth — `-n` also turns tmux's `automatic-rename` off for it, so
		// the name survives whatever the pane goes on to run. A pane has no such flag; its title is
		// set after the split.
		if (window && opts.label) args.splice(1, 0, '-n', opts.label)
		const out = exec('tmux', args)
		if (!out) throw new Error(withReason(exec, `tmux ${args[0]} failed`))
		const [pane, windowId] = splitOpenReport(out, args[0]!)
		// The window this pane landed in IS its tab — tmux's Tab is its Window. For a new window that
		// is the window just opened; for a split it is the caller's own window, which the split landed
		// in without opening a tab of its own. Both are exactly what tmux reports here.
		//
		// No `workspace`: tmux has no workspace tier — `workspace` and `tab` both collapse to a Window —
		// so it has nothing to report, which is not the same as reporting that nothing is there. Absent
		// is the seam's own convention for a fact a backend cannot answer (`OpenedPane.workspace`,
		// `isPaneFocused`'s `undefined`); reporting a null here would assert a "none" tmux never said.
		// `tab` is the opposite case and is never absent: every multiplexer has the Tab level.
		const target: OpenedPane = { id: pane, tab: windowId }
		// Through `group`, not a second `set-option` spelled here: grouping a space this open just
		// created and grouping one that was already open are the same act, so one spelling per backend
		// is the only way the two cannot drift. It costs no call — tmux has no `new-window` flag to set
		// an option at birth, so this was ALREADY a second call after the window exists — and it still
		// runs before any `--launch` submit, so the window is grouped before anything runs in it.
		//
		// No name: `open` knows only the DISPLAY name it just wrote with `-n`, which is exactly the
		// composed name that must never be stored as the space's own. A caller that composed one knows
		// the original and calls `group` itself with it; one that did not compose has nothing to store,
		// its display name already being its own name.
		if (group && windowId) tmuxSessionAdapter.group(exec, { id: windowId }, opts.workspaceGroup!)
		// Through `rename`, not a second `select-pane -T` spelled here: post-birth pane naming and the
		// seam's rename are the same act, so one spelling per backend is the only way the two cannot
		// drift. A window took its name at birth via `-n` above and needs nothing here.
		if (!window && opts.label) tmuxSessionAdapter.rename(exec, target, 'pane', opts.label)
		// `submit`, not `sendText` — a launch command has to actually run, and `submit` is the only
		// verb that supplies the Enter.
		if (opts.launch) tmuxSessionAdapter.submit(exec, target, opts.launch)
		return target
	},

	rename(exec, target, tier, name) {
		// tmux's two tiers are two different verbs, and the pane one is not `rename-pane` (no such
		// command exists) — a pane's name IS its title, set through `select-pane -T`.
		if (tier === 'tab') {
			// `rename-window`, because a tab is a Window on tmux — the same collapse `open` makes, where
			// both 'workspace' and 'tab' become a window. This also pins the name against tmux's
			// `automatic-rename`, exactly as `new-window -n` does at birth.
			exec('tmux', ['rename-window', '-t', target.id, name])
			return
		}
		// `-T` makes `select-pane` a pure title write: tmux returns as soon as it has set the title and
		// never reaches the code that would make the pane active (verified on 3.6b), so this moves no
		// focus despite the verb's name. That is what lets it serve a rename's read-only side effects.
		exec('tmux', ['select-pane', '-t', target.id, '-T', name])
	},

	group(exec, target, group, name) {
		// A window user option — tmux's own mechanism for a value it stores but never interprets. It
		// survives a window rename (unlike a name-encoded grouping), and tmux filters on it server-side
		// (`list-windows -f '#{==:#{@cm_ws},<id>}'`). Set verbatim: opaque means this adapter never
		// parses, splits, or derives the value, and never reads it off the label.
		exec('tmux', ['set-option', '-w', '-t', target.id, TMUX_WORKSPACE_GROUP_OPTION, group])
		// The space's own name, beside the group, because tmux's single `window_name` may now hold a
		// display name composed out of it — see TMUX_TAB_NAME_OPTION. Only when the caller has one:
		// nothing to store is not the same as an empty name, and no adapter invents one.
		if (name !== undefined) exec('tmux', ['set-option', '-w', '-t', target.id, TMUX_TAB_NAME_OPTION, name])
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

	/**
	 * Tab-separated, not space — the same rule `describeTmuxRegion` follows, and for the same reason:
	 * `pane_current_path` and `pane_title` can both contain spaces. The old space-separated format
	 * recovered the cwd by rejoining everything after the command, which works only while the cwd is
	 * the LAST field. A label is a human's and may hold anything, so appending one to that format would
	 * make both fields unrecoverable — `my worker` and `/repo/my dir` cannot be told apart by a space.
	 * A tab can appear in neither id nor command, and the two free-text fields are separated by one.
	 */
	listPanes(exec): LivePane[] {
		const out = exec('tmux', [
			'list-panes',
			'-a',
			'-F',
			'#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{host}',
		])
		if (!out) return []
		return out
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [id, , cwd, title, host] = line.split('\t')
				const pane: LivePane = { id: id ?? '', mux: 'tmux' as const }
				if (cwd) pane.cwd = cwd
				const label = paneLabel(title, host)
				if (label) pane.label = label
				return pane
			})
			.filter((p) => p.id !== '')
	},

	describeRegion(exec, target) {
		return describeTmuxRegion(exec, target.id)
	},

	/**
	 * tmux has NO workspace tier — `workspace` and `tab` both collapse onto a Window — so a workspace
	 * is not a fact this backend holds. What it holds is the grouping TAG the walk wrote
	 * (`SessionOpenOptions.workspaceGroup`, stored in a window user option), so the read here is
	 * literally *"which windows carry this group id"*.
	 *
	 * The tag, never the label. `list-windows -a` spans SESSIONS, so a bare name match would
	 * over-collect a same-named window from another session, and taking the workspace off a
	 * `<workspace> - <tab>` label is unsound in the first place (`acme - beta - main` splits two ways,
	 * both legal). `-f '#{==:#{@cm_ws},<id>}'` keys on what actually identifies the group, filtered
	 * server-side — the tag survives a window rename, which a name-encoded grouping does not.
	 *
	 * A window with NO tag is a workspace of ONE: the honest answer for a window nobody grouped, and
	 * it costs no further call — the caller's own window is the whole workspace.
	 */
	describeWorkspace(exec, target) {
		// One call for both facts: the caller's window and that window's tag. `display-message -p`
		// resolves the pane target and prints the format, so nothing has to be matched out of a
		// server-wide listing. Tab-separated — an id and a tag cannot contain one; a window NAME can,
		// but it is last, so a name with a tab in it cannot displace anything.
		const out = exec('tmux', [
			'display-message',
			'-p',
			'-t',
			target.id,
			`#{window_id}\t#{${TMUX_WORKSPACE_GROUP_OPTION}}\t#{${TMUX_TAB_NAME_OPTION}}\t#{window_name}`,
		])
		if (!out) throw new Error(withReason(exec, `tmux could not resolve the workspace around pane ${target.id}`))
		const [windowId, group, ownName, ...nameParts] = out.split('\n')[0]!.split('\t')
		if (!windowId) throw new Error(`tmux did not report the window around pane ${target.id}`)
		// Untagged: this window is a workspace of one. Not an error and not an empty list — nobody
		// grouped it, and one window is exactly what that means.
		if (!group) return [tmuxTab(exec, windowId, ownName, nameParts.join('\t'))]
		const listed = exec('tmux', [
			'list-windows',
			'-a',
			'-F',
			`#{window_id}\t#{${TMUX_TAB_NAME_OPTION}}\t#{window_name}`,
			'-f',
			`#{==:#{${TMUX_WORKSPACE_GROUP_OPTION}},${group}}`,
		])
		if (!listed) throw new Error(withReason(exec, `tmux could not enumerate the windows grouped as ${group}`))
		const tabs = listed
			.split('\n')
			.filter(Boolean)
			.map((line) => line.split('\t'))
			.filter(([id]) => Boolean(id))
			// `window_name` is LAST and absorbs any tab it contains, which is why it is rejoined rather
			// than destructured: a window name is a human's and may hold anything.
			.map(([id, own, ...rest]) => tmuxTab(exec, id!, own, rest.join('\t')))
		if (tabs.length === 0) throw new Error(`tmux reported no windows grouped as ${group}`)
		return tabs
	},
}

/**
 * One window, read as a tab: its id, the tab's OWN name, and its region's geometry.
 *
 * `ownName` is what `group` stored (`TMUX_TAB_NAME_OPTION`) and it WINS, because `windowName` is the
 * display name — on a grouped window that is the composed `pool - editor`, whose `editor` tmux's
 * single name field no longer holds. Reporting the display name instead would compound the prefix on
 * every capture/apply round trip (`pool - pool - editor`), and splitting it back apart is the unsound
 * parse the option exists to refuse.
 *
 * The window name is the FALLBACK, not a second guess: a window carrying no stored name is one nobody
 * composed a display name for, so its name already IS its own name. That covers the untagged window —
 * a workspace of one — and any window a caller grouped without naming.
 */
function tmuxTab(
	exec: Exec,
	windowId: string,
	ownName: string | undefined,
	windowName: string | undefined,
): WorkspaceTab {
	const tab: WorkspaceTab = { id: windowId, panes: describeTmuxRegion(exec, windowId) }
	const label = ownName || windowName
	if (label) tab.label = label
	return tab
}

/**
 * Every pane of the region `id` names, with its rectangle. `id` is a pane id (that pane's own window)
 * or a window id (that window) — `list-panes -t` resolves both, which is what lets the region read and
 * the workspace read share one query instead of two that could drift apart.
 *
 * `-t` scopes `list-panes` to ONE window — the region tier, which is what capture captures. Without
 * `-a`, so this never reaches the panes of some other window.
 *
 * `#{pane_left}`/`#{pane_top}` are window-relative, and the widths exclude the divider column tmux
 * draws between panes (a 200-wide window split side by side reports 119 + 80, not 200) — both are
 * exactly what `RegionPane.rect` documents, so nothing is adjusted here.
 *
 * Tab-separated, not space: `pane_current_path` and `pane_title` can both contain spaces, and
 * splitting a path on spaces is how a directory with one in it silently becomes the wrong pane.
 */
function describeTmuxRegion(exec: Exec, id: string): RegionPane[] {
	const out = exec('tmux', [
		'list-panes',
		'-t',
		id,
		'-F',
		'#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_title}\t#{host}',
	])
	if (!out) throw new Error(withReason(exec, `tmux could not describe the region around pane ${id}`))
	const panes: RegionPane[] = []
	for (const line of out.split('\n').filter(Boolean)) {
		const [paneId, left, top, width, height, cwd, title, host] = line.split('\t')
		if (!paneId) continue
		const pane: RegionPane = {
			id: paneId,
			rect: { x: Number(left), y: Number(top), width: Number(width), height: Number(height) },
		}
		if (cwd) pane.cwd = cwd
		const label = paneLabel(title, host)
		if (label) pane.label = label
		panes.push(pane)
	}
	if (panes.length === 0) throw new Error(`tmux reported no panes in the region around pane ${id}`)
	return panes
}

/**
 * A tmux pane's label — its title, unless that title is the hostname tmux handed it.
 *
 * **tmux has no "unset title"**: it defaults `pane_title` to the hostname, so a pane nobody ever named
 * reports a name nobody chose, and every pane in an untouched session reports the SAME one. Exporting
 * that would label them all `zeta`, and `zeta` would then resolve to every pane in the session —
 * ambiguity manufactured out of nothing. A title that differs from the host is one someone set
 * (cyber-mux's own `select-pane -T` among them), so it is the author's and survives.
 *
 * One home for the rule, called by BOTH reads — `listPanes` (which a name resolves against) and
 * `describeTmuxRegion` (which a capture exports). Two spellings of a heuristic this load-bearing is
 * how the listing and the capture come to disagree about which panes are named.
 *
 * The comparison is the workaround, not the shape of the thing: herdr has the honest primitive and
 * omits the key outright until a pane is renamed, so it needs no rule at all.
 */
function paneLabel(title: string | undefined, host: string | undefined): string | undefined {
	return title && title !== host ? title : undefined
}

/**
 * The `-P -F '#{pane_id}\t#{window_id}'` report EVERY open asks for, split back into its two ids.
 * Tab-separated because neither id can contain a tab.
 *
 * A report that does not carry both throws rather than returning half an answer: the window is the
 * pane's tab, which `OpenedPane.tab` promises is always present, and it is also what a grouping open
 * tags. Guessing either would be worse than failing — a caller would name or group nothing and never
 * learn it.
 */
function splitOpenReport(out: string, command: string): [string, string] {
	const [pane, windowId] = out.split('\t')
	if (!pane || !windowId) throw new Error(`tmux ${command} did not report the new pane's id and window id`)
	return [pane, windowId]
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
	// No `withReason` here, deliberately: this is a pure parser, not a command runner. Its failure is
	// "no line matched", not "a command failed", so the runner's most recent reason belongs to some
	// other command entirely and attributing it here would be a confident lie.
	if (!line) throw new Error(`peer's pane ${id} could not be resolved to beam to`)
	const [, sessionName, windowId] = line.split(' ')
	return { sessionName: sessionName!, windowId: windowId! }
}
