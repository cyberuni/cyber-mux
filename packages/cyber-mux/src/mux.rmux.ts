import type { Exec } from './exec.ts'
import { withReason } from './exec.ts'
import { refuseFloatingPane } from './floating.ts'
import type { LivePane, MuxAdapter, MuxReadOptions, MuxTarget, OpenedPane, RegionPane, WorkspaceTab } from './mux.ts'
import { assertRatioInRange } from './ratio.ts'
import { isReadTruncated } from './read-window.ts'
import { pollForOutput } from './wait-output.ts'

/**
 * rmux backend — an async Rust reimplementation of the tmux command language (`Helvesec/rmux`),
 * detected via `$RMUX`.
 *
 * **A near-copy of `mux.tmux.ts`, on purpose.** rmux reimplements ~90 commands under tmux's own
 * names, flags, target syntax and `#{…}` format vocabulary, so the argv this adapter emits is
 * tmux's argv with a different binary in front of it. The alternative — one shared implementation
 * parameterized by binary name — was considered and REJECTED; the reasoning is in the ADR log
 * (`.agents/spec/design/decisions`, `136-rmux-adapter`). The short form: rmux is a separate project
 * that TRACKS tmux rather than a tmux version, so every future divergence would land as a
 * conditional inside the tmux adapter, which is the seam's own argument against emulation; and the
 * two already differ in the one member that matters most here (`canFloatPanes`), whose long
 * justification on each side is about a *different binary's* command set. A shared file could not
 * carry both verification claims honestly, and this repo's comments are verification claims.
 *
 * **Probed against a live binary — rmux 0.10.0, 2026-08-26**, on an isolated socket
 * (`rmux -L … new-session -d`), not read off documentation. Every claim below that says "verified"
 * names a command that was actually run. What was NOT covered: nothing was driven on Windows or
 * macOS (rmux runs natively on both, and that portability is the strategic reason this backend
 * exists), and no rmux version other than 0.10.0 was exercised.
 */

/**
 * The rmux window user option `MuxOpenOptions.workspaceGroup` is stored in — the same `@`-prefixed
 * user option tmux uses, because rmux implements tmux's user-option mechanism unchanged.
 *
 * Verified live on 0.10.0: `set-option -w -t @0 @cm_ws grp1` then `list-windows -F '#{@cm_ws}'`
 * read `grp1` back, and `list-windows -f '#{==:#{@cm_ws},grp1}'` filtered SERVER-SIDE to that
 * window. Both halves matter — the read alone would leave the filter a docs claim.
 *
 * Deliberately the SAME option name as tmux's (`TMUX_WORKSPACE_GROUP_OPTION`), not a namespaced
 * twin: the tag identifies a cyber-mux workspace group, and the two backends never share a server,
 * so a second spelling would buy nothing and cost a way for the two to drift. Named here rather
 * than spelled at each use so this adapter's write side and every read side cannot drift.
 * Server-lifetime, like every window: it dies with the rmux daemon, along with the windows it tags.
 */
export const RMUX_WORKSPACE_GROUP_OPTION = '@cm_ws'

/**
 * The rmux window user option a grouped window's OWN name is stored in — the name the caller gave
 * the tab, beside the group id, because rmux inherits tmux's single `window_name` field and so
 * inherits the problem it creates.
 *
 * See `TMUX_TAB_NAME_OPTION` in `mux.tmux.ts` for the full argument; it transfers intact, because
 * the constraint is tmux's data model and rmux reimplements that model. In brief: a caller that
 * composes a display name out of a tab's name (`pool - editor`) has destroyed `editor`, splitting
 * on the separator is ambiguous, and reading the display name verbatim re-prefixes it on every
 * round trip. So the original is stored here and read back from here.
 *
 * Verified live on 0.10.0 alongside the group tag: `set-option -w -t @0 @cm_tab editor` read back
 * through `display-message -p -t %1 '#{@cm_tab}'` as `editor`.
 */
export const RMUX_TAB_NAME_OPTION = '@cm_tab'

/** rmux backend — detected via `$RMUX`. */
export const rmuxMuxAdapter: MuxAdapter = {
	name: 'rmux',

	// `split-window -l N%` sizes a split; see `toRmuxSize` for the inversion it needs. Verified live
	// on 0.10.0 that `-l` sizes the NEW pane exactly as tmux's does — `split-window -h -l 30%` in an
	// 80-column window left the original at 55 and gave the new pane 24, so the inversion below is
	// the right direction rather than an inherited assumption.
	canSizeSplits: true,

	// No `canFloatPanes`: rmux has NO floating-pane concept. `new-pane` — tmux 3.7's command, the one
	// `--at pane:float` drives — is simply not in rmux's command table (verified live on 0.10.0:
	// `rmux new-pane -t probe` answers `unknown command: new-pane`, and `list-commands` does not list
	// it). Omitted rather than declared `false`, the same way wezterm, cmux and otty omit it; the
	// absence IS the declaration, and `open` below carries the enforcement.

	open(exec, opts) {
		// rmux has tmux's tiers, so it has tmux's collapse: no Workspace level, and "window" is its
		// name for the Tab concept. Both 'workspace' (own visible space) and 'tab' become a new WINDOW
		// — the finest "own visible space" available, visible in the status bar and reachable by
		// `select-window` (which cross-window beaming/focus relies on). `-d` opens it in the background
		// without stealing the caller's focus.
		const at = opts.at ?? 'tab'
		const window = at === 'workspace' || at === 'tab'
		// rmux has NO floating-pane concept: `new-pane` does not exist, and nothing else in its ~90
		// commands opens a pane above the tiled layout. So this REFUSES by name rather than
		// substituting a split — the substitute would take a share of the region and resize its
		// neighbors, which is exactly the property a float exists to avoid, so the caller would get
		// back a pane whose id satisfies them and whose behavior does not. The omitted `canFloatPanes`
		// above is the declaration; this is the enforcement, and both are needed for the same reason
		// `agent wait` checks twice.
		//
		// Refused BEFORE any argv is built, so a float never reaches the split branch and degrades
		// silently into `split-window`.
		if (at === 'pane:float') refuseFloatingPane(rmuxMuxAdapter.name)
		// `-e` is on BOTH `split-window` and `new-window` in rmux's own `list-commands` synopsis, and
		// both were driven live: a `split-window -e CM_PROBE=yes -c /etc` pane echoed back
		// `ENV=yes PWD=/etc`. Native env means no `envFallback` command-prefix compensation, the way
		// wezterm and zellij need. It must be native at EVERY tier: a template's root pane is the
		// region's own pane, born by the window open rather than by any split, so scoping this to the
		// split path would silently drop that pane's env.
		const env = opts.env ? Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]) : []
		// A group id tags the WINDOW this open created. It does not drive the FORMAT — `#{window_id}`
		// is asked for unconditionally, because `OpenedPane.tab` is required and rmux's Tab is its
		// Window, so every open owes the window it landed in.
		//
		// `group` still gates the tagging itself: a caller that did not ask is not grouped, and a split
		// creates no window of its own to tag (tagging the caller's would group a space the caller
		// never opened).
		const group = window && opts.workspaceGroup != null
		// A tab and a real \t: the pane id and window id are both `%`/`@`-prefixed and contain no
		// whitespace, so a tab separates them unambiguously. Verified live — `split-window -P -F
		// '#{pane_id}\t#{window_id}'` printed `%1\t@0`, and `new-window` the same shape.
		const format = '#{pane_id}\t#{window_id}'
		// `from` and `size` are declared INSIDE the split branch, and that placement is the whole
		// defense — not a guard. Both are pane concepts: `-t` targets the pane to split, `-l` sizes the
		// split against it, and a window is neither placed nor sized relative to a pane. Scoping them
		// here is what makes the leak unwritable: the window branch cannot spread a value that is not
		// in its scope, so wiring one in is a compile error rather than a wrong flag.
		let args: string[]
		if (window) {
			// `-d` keeps focus on the caller (opens the window in the background) — without it rmux
			// switches the attached client to the new window, stealing the caller's focus. Both halves
			// verified live on 0.10.0 against a really-attached pty client: a bare `new-window` moved
			// `display-message -p '#{window_id}'` to the new window, and `new-window -d` left it where it
			// was. The returned pane id and subsequent `send-keys -t` still target the new pane.
			args = ['new-window', '-d', ...env, '-c', opts.cwd, '-P', '-F', format]
		} else {
			// `-t` whenever the caller names a pane — and this is one of the few places rmux measurably
			// DIVERGES from tmux, so the flag is passed for a different reason than it is on tmux.
			//
			// Probed on 0.10.0, both sides: a target-less `split-window` run INSIDE pane %1 (window @0)
			// landed its new pane in @0 beside %1, while the session's active pane was %2 in a different
			// window entirely — so rmux resolves the CALLING pane from `$RMUX_PANE`/`$TMUX_PANE`. tmux
			// does the opposite: the same experiment on 3.7c split the active %0 and ignored
			// `$TMUX_PANE` outright (see `mux.tmux.ts`). rmux's behavior is the friendlier one, and it is
			// exactly why this adapter must not lean on it: `from` names WHICH pane to split, which is
			// not always the caller's, and a caller that passes one would silently get its own pane split
			// instead. `-t` makes the choice explicit on both backends; an omitted `from` still takes
			// whatever default the backend documents for itself, never a pane this adapter guessed.
			//
			// Recorded rather than exploited: relying on the divergence would be an rmux-only code path
			// whose whole benefit is saving one flag.
			const from = opts.from ? ['-t', opts.from.id] : []
			// Empty unless the caller asks, so a split that names no ratio emits no `-l` and rmux applies
			// its own even default.
			const size = opts.ratio != null ? ['-l', toRmuxSize(opts.ratio)] : []
			const direction = at === 'pane:down' ? '-v' : '-h'
			args = ['split-window', direction, ...from, ...size, ...env, '-c', opts.cwd, '-P', '-F', format]
		}
		// A window takes its name at birth — `-n` also turns rmux's `automatic-rename` off for it, so
		// the name survives whatever the pane goes on to run. Verified live on 0.10.0:
		// `show-window-options -t <w> automatic-rename` reported `off` on a window opened with `-n`
		// (and nothing at all on one opened without it), and the name held while a command ran in the
		// pane. A pane has no such flag; its title is set after the split.
		if (window && opts.label) args.splice(1, 0, '-n', opts.label)
		const out = exec('rmux', args)
		if (!out) throw new Error(withReason(exec, `rmux ${args[0]} failed`))
		const [pane, windowId] = splitOpenReport(out, args[0]!)
		// The window this pane landed in IS its tab — rmux's Tab is its Window. For a new window that
		// is the window just opened; for a split it is the caller's own window, which the split landed
		// in without opening a tab of its own. Both are exactly what rmux reports here.
		//
		// No `workspace`: rmux has no workspace tier — `workspace` and `tab` both collapse to a Window
		// — so it has nothing to report, which is not the same as reporting that nothing is there.
		// Absent is the seam's own convention for a fact a backend cannot answer.
		const target: OpenedPane = { id: pane, tab: windowId }
		// Through `group`, not a second `set-option` spelled here: grouping a space this open just
		// created and grouping one that was already open are the same act, so one spelling per backend
		// is the only way the two cannot drift. It costs no call — rmux has no `new-window` flag to set
		// an option at birth, so this was ALREADY a second call after the window exists — and it still
		// runs before any `--launch` submit, so the window is grouped before anything runs in it.
		if (group && windowId) rmuxMuxAdapter.group(exec, { id: windowId }, opts.workspaceGroup!)
		// Through `rename`, not a second `select-pane -T` spelled here: post-birth pane naming and the
		// seam's rename are the same act, so one spelling per backend is the only way the two cannot
		// drift. A window took its name at birth via `-n` above and needs nothing here.
		if (!window && opts.label) rmuxMuxAdapter.rename(exec, target, 'pane', opts.label)
		// `submit`, not `sendText` — a launch command has to actually run, and `submit` is the only
		// verb that supplies the Enter.
		if (opts.launch) rmuxMuxAdapter.submit(exec, target, opts.launch)
		return target
	},

	rename(exec, target, tier, name) {
		// rmux's two tiers are two different verbs, and the pane one is not `rename-pane` (no such
		// command is in `list-commands`) — a pane's name IS its title, set through `select-pane -T`.
		// Verified live on 0.10.0: `select-pane -t %1 -T 'my worker'` read back through
		// `list-panes -F '#{pane_title}'` as `my worker`.
		if (tier === 'tab') {
			// `rename-window`, because a tab is a Window on rmux — the same collapse `open` makes, where
			// both 'workspace' and 'tab' become a window.
			exec('rmux', ['rename-window', '-t', target.id, name])
			return
		}
		// `-T` makes `select-pane` a pure title write on rmux too: verified live on 0.10.0 by aiming it
		// at the NON-active pane of a window with an attached client — the title changed and
		// `display-message -p '#{pane_id}'` still reported the pane that was active before. That is what
		// lets it serve a rename's read-only side effects despite the verb's name.
		exec('rmux', ['select-pane', '-t', target.id, '-T', name])
	},

	group(exec, target, group, name) {
		// A window user option — tmux's mechanism for a value the server stores but never interprets,
		// reimplemented by rmux and verified live (see `RMUX_WORKSPACE_GROUP_OPTION`). It survives a
		// window rename (unlike a name-encoded grouping), and rmux filters on it server-side
		// (`list-windows -f '#{==:#{@cm_ws},<id>}'`). Set verbatim: opaque means this adapter never
		// parses, splits, or derives the value, and never reads it off the label.
		exec('rmux', ['set-option', '-w', '-t', target.id, RMUX_WORKSPACE_GROUP_OPTION, group])
		// The space's own name, beside the group, because rmux's single `window_name` may now hold a
		// display name composed out of it — see RMUX_TAB_NAME_OPTION. Only when the caller has one:
		// nothing to store is not the same as an empty name, and no adapter invents one.
		if (name !== undefined) exec('rmux', ['set-option', '-w', '-t', target.id, RMUX_TAB_NAME_OPTION, name])
	},

	sendText(exec, target, text) {
		// `-l` is mandatory, not a nicety: rmux inherits tmux's key-name-first resolution, so a bare
		// `send-keys -t <p> Up` would press the arrow instead of typing the word. `-l` disables that
		// lookup outright. Verified live on 0.10.0 — see `toRmuxKey` for the probe that pins the
		// distinction.
		exec('rmux', ['send-keys', '-t', target.id, '-l', text])
	},

	sendKeys(exec, target, keys) {
		exec('rmux', ['send-keys', '-t', target.id, ...keys.map(toRmuxKey)])
	},

	submit(exec, target, text) {
		// No `-l` here: a bare Enter must resolve as the KEY, which is exactly what the key lookup is
		// for. `''` is the bare-flush case too — `send-keys -l ''` would be a no-op typing nothing,
		// leaving the staged buffer unsent.
		if (!text) {
			exec('rmux', ['send-keys', '-t', target.id, 'Enter'])
			return
		}
		// Two calls, unavoidably: rmux has no atomic literal-text-plus-Enter primitive either. `-l`
		// applies to the whole argument list, so `send-keys -l <text> Enter` would type a literal
		// "Enter" after the text rather than pressing it. The composed path is what `submit`'s
		// outcome-not-command contract exists to permit.
		rmuxMuxAdapter.sendText(exec, target, text)
		exec('rmux', ['send-keys', '-t', target.id, 'Enter'])
	},

	read(exec, target, opts?: MuxReadOptions | undefined) {
		const text = capturePane(exec, target, opts?.lines)
		if (!opts?.truncation) return { text }
		// An unbounded window omitted nothing by construction — the answer costs no probe at the one end
		// where it is already known.
		if (opts.lines === 'all') return { text, truncated: false }
		// One row deeper, in rmux's own units: `-S -N` starts the capture N rows INTO the history above
		// the visible screen, so `-S -(N+1)` is exactly this window plus one older row — and a bare read
		// (no `lines`) is the screen alone, whose one-deeper form is `-S -1`. rmux clamps a start line
		// past the top of the history rather than failing, so on a pane with nothing above the window
		// the deeper capture comes back the same length and the answer is `false` without a special
		// case. Verified live on 0.10.0: one pane read back 24 rows with no `-S`, 34 with `-S -10`, and
		// 72 with `-S -` — tmux's own offset arithmetic, clamped at the top.
		const deeper = capturePane(exec, target, (opts.lines ?? 0) + 1)
		return { text, truncated: isReadTruncated(text, deeper) }
	},

	// rmux inherits tmux's `wait-for`, which synchronizes on a channel some other rmux command signals
	// and says nothing about what a pane PRINTED. rmux DOES ship its own `wait-pane` extension outside
	// the tmux-compatible surface, but this adapter deliberately does not reach for it: the seam's
	// `waitForOutput` is a match against text the caller supplies, the shared poll already answers it
	// on every backend, and buying a second wait implementation would be an rmux-only code path to keep
	// honest for no behavior the caller can observe. Recorded so the option is not re-discovered as an
	// oversight. See `pollForOutput` for the cadence and liveness rules.
	waitForOutput(exec, target, opts) {
		return pollForOutput(rmuxMuxAdapter, exec, target, opts)
	},

	focus(exec, target) {
		// A bare `select-pane` only moves focus within the caller's OWN attached session/window — a
		// peer's pane can live in a different rmux session and window entirely, so that alone would
		// silently no-op on the attached client. Resolve the pane's session + window from
		// `list-panes -a` first and drive the beam in order: switch-client (session), then
		// select-window, then select-pane. Resolution happens BEFORE any switch is issued, so an
		// unresolvable pane throws instead of a partial or false-success beam.
		//
		// All three verbs verified live on 0.10.0 against a REALLY ATTACHED client (a pty attach), not
		// merely against argument parsing: with a client on session `probe`, `select-window -t @2` moved
		// `display-message -p '#{window_id}'` from `@0` to `@2`, `switch-client -t probe` succeeded, and
		// `select-pane -t %0` left `#{pane_id}` reading `%0`. Detached, `switch-client` fails with
		// rmux's own `no current client`, which is the honest answer and surfaces as a failed exec.
		const out = exec('rmux', ['list-panes', '-a', '-F', '#{pane_id} #{session_name} #{window_id}'])
		const { sessionName, windowId } = parsePaneLocation(out, target.id)
		exec('rmux', ['switch-client', '-t', sessionName])
		exec('rmux', ['select-window', '-t', windowId])
		exec('rmux', ['select-pane', '-t', target.id])
	},

	teardown(exec, target) {
		exec('rmux', ['kill-pane', '-t', target.id])
	},

	paneExists(exec, target) {
		// `has-session` hits when the id names a session — and on rmux it also resolves a PANE id
		// directly (verified live on 0.10.0: `has-session -t %1` exits 0 while `has-session -t %99`
		// fails with `can't find pane: %99`). Either way the fallback below is what makes the answer
		// sound rather than the first call's generosity: scan every pane server-wide for the id (pane
		// ids are globally unique across sessions).
		if (exec('rmux', ['has-session', '-t', target.id]) !== null) return true
		return (exec('rmux', ['list-panes', '-a', '-F', '#{pane_id}']) ?? '').split('\n').includes(target.id)
	},

	isPaneFocused(exec, target) {
		// `list-panes -a` server-wide, one line per pane: pane_id, whether it's the active pane of its
		// window, whether its window is the current one of its session, and the session's attached
		// client count. Focused iff all three hold; unresolvable (line missing) or no output → unknown,
		// never a false `false` — a caller can't tell "not focused" from "couldn't find the pane" here.
		//
		// Verified live on 0.10.0 that `#{session_attached}` is a real count rather than a stub: it read
		// `0` on a detached server and `1` once a pty client attached, with `#{window_active}`
		// distinguishing the client's window from the other one in the same session.
		const out = exec('rmux', [
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
	 * Tab-separated, not space — the same rule `describeRmuxRegion` follows, and for the same reason:
	 * `pane_current_path` and `pane_title` can both contain spaces, so a space-separated format makes
	 * both fields unrecoverable (`my worker` and `/repo/my dir` cannot be told apart by a space). A tab
	 * can appear in neither id nor command, and the two free-text fields are separated by one.
	 */
	listPanes(exec): LivePane[] {
		const out = exec('rmux', [
			'list-panes',
			'-a',
			'-F',
			// No `#{pane_floating_flag}` in this format, unlike tmux's: rmux has no floating panes, so
			// the variable names nothing and rmux expands it to the empty string (verified live on
			// 0.10.0). Asking for a field whose only possible value is "absent" would buy a column that
			// reads as `false` by accident rather than by construction — see the `floating` note below.
			'#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{host}',
		])
		if (!out) return []
		return out
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [id, , cwd, title, host] = line.split('\t')
				// `floating` is `false` BY CONSTRUCTION, not a stub and not a refusal: rmux has no
				// floating-pane concept at all, so every pane it can report really is tiled. The create
				// side refuses a `'pane:float'` open by NAME (`refuseFloatingPane` in `open` above) because
				// there is no truthful pane to hand back; the read side has a truthful answer, and this is
				// it.
				const pane: LivePane = { id: id ?? '', mux: 'rmux' as const, floating: false }
				if (cwd) pane.cwd = cwd
				const label = paneLabel(title, host)
				if (label) pane.label = label
				return pane
			})
			.filter((p) => p.id !== '')
	},

	regions: {
		describeRegion(exec, target) {
			return describeRmuxRegion(exec, target.id)
		},

		/**
		 * rmux has NO workspace tier — `workspace` and `tab` both collapse onto a Window — so a workspace
		 * is not a fact this backend holds. What it holds is the grouping TAG the walk wrote
		 * (`MuxOpenOptions.workspaceGroup`, stored in a window user option), so the read here is
		 * literally *"which windows carry this group id"*.
		 *
		 * The tag, never the label. `list-windows -a` spans SESSIONS, so a bare name match would
		 * over-collect a same-named window from another session, and taking the workspace off a
		 * `<workspace> - <tab>` label is unsound in the first place (`acme - beta - main` splits two ways,
		 * both legal). `-f '#{==:#{@cm_ws},<id>}'` keys on what actually identifies the group, filtered
		 * server-side — verified live on rmux 0.10.0, which is the half a docs read could not settle.
		 *
		 * A window with NO tag is a workspace of ONE: the honest answer for a window nobody grouped, and
		 * it costs no further call — the caller's own window is the whole workspace.
		 */
		describeWorkspace(exec, target) {
			// One call for both facts: the caller's window and that window's tag. `display-message -p`
			// resolves the pane target and prints the format, so nothing has to be matched out of a
			// server-wide listing. Tab-separated — an id and a tag cannot contain one; a window NAME can,
			// but it is last, so a name with a tab in it cannot displace anything.
			const out = exec('rmux', [
				'display-message',
				'-p',
				'-t',
				target.id,
				`#{window_id}\t#{${RMUX_WORKSPACE_GROUP_OPTION}}\t#{${RMUX_TAB_NAME_OPTION}}\t#{window_name}`,
			])
			if (!out) throw new Error(withReason(exec, `rmux could not resolve the workspace around pane ${target.id}`))
			const [windowId, group, ownName, ...nameParts] = out.split('\n')[0]!.split('\t')
			if (!windowId) throw new Error(`rmux did not report the window around pane ${target.id}`)
			// Untagged: this window is a workspace of one. Not an error and not an empty list — nobody
			// grouped it, and one window is exactly what that means.
			if (!group) return [rmuxTab(exec, windowId, ownName, nameParts.join('\t'))]
			const listed = exec('rmux', [
				'list-windows',
				'-a',
				'-F',
				`#{window_id}\t#{${RMUX_TAB_NAME_OPTION}}\t#{window_name}`,
				'-f',
				`#{==:#{${RMUX_WORKSPACE_GROUP_OPTION}},${group}}`,
			])
			if (!listed) throw new Error(withReason(exec, `rmux could not enumerate the windows grouped as ${group}`))
			const tabs = listed
				.split('\n')
				.filter(Boolean)
				.map((line) => line.split('\t'))
				.filter(([id]) => Boolean(id))
				// `window_name` is LAST and absorbs any tab it contains, which is why it is rejoined rather
				// than destructured: a window name is a human's and may hold anything.
				.map(([id, own, ...rest]) => rmuxTab(exec, id!, own, rest.join('\t')))
			if (tabs.length === 0) throw new Error(`rmux reported no windows grouped as ${group}`)
			return tabs
		},
	},
}

/**
 * One window, read as a tab: its id, the tab's OWN name, and its region's geometry.
 *
 * `ownName` is what `group` stored (`RMUX_TAB_NAME_OPTION`) and it WINS, because `windowName` is the
 * display name — on a grouped window that is the composed `pool - editor`, whose `editor` rmux's
 * single name field no longer holds. Reporting the display name instead would compound the prefix on
 * every capture/apply round trip (`pool - pool - editor`), and splitting it back apart is the unsound
 * parse the option exists to refuse.
 *
 * The window name is the FALLBACK, not a second guess: a window carrying no stored name is one nobody
 * composed a display name for, so its name already IS its own name.
 */
function rmuxTab(
	exec: Exec,
	windowId: string,
	ownName: string | undefined,
	windowName: string | undefined,
): WorkspaceTab {
	const tab: WorkspaceTab = { id: windowId, panes: describeRmuxRegion(exec, windowId) }
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
 * `#{pane_left}`/`#{pane_top}` are window-relative, and the widths exclude the divider column rmux
 * draws between panes — both verified live on 0.10.0, where an 80x24 window split side by side
 * reported `%0 0 0 39 24` and `%1 40 0 40 24` (39 + 40 = 79, not 80). That is exactly what
 * `RegionPane.rect` documents, so nothing is adjusted here. The check is not a formality: a backend
 * that INCLUDED the divider would silently shift every rect a captured template stores.
 *
 * Tab-separated, not space: `pane_current_path` and `pane_title` can both contain spaces, and
 * splitting a path on spaces is how a directory with one in it silently becomes the wrong pane.
 */
function describeRmuxRegion(exec: Exec, id: string): RegionPane[] {
	const out = exec('rmux', [
		'list-panes',
		'-t',
		id,
		'-F',
		'#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_title}\t#{host}',
	])
	if (!out) throw new Error(withReason(exec, `rmux could not describe the region around pane ${id}`))
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
	if (panes.length === 0) throw new Error(`rmux reported no panes in the region around pane ${id}`)
	return panes
}

/**
 * An rmux pane's label — its title, unless that title is the hostname rmux handed it.
 *
 * **rmux has no "unset title"**, exactly as tmux has none: it defaults `pane_title` to the hostname
 * (verified live on 0.10.0 — every pane of a fresh session reported the machine's hostname, and
 * `#{host}` reported the same string). Exporting that would label them all alike, and that label
 * would then resolve to every pane in the session — ambiguity manufactured out of nothing. A title
 * that differs from the host is one someone set (cyber-mux's own `select-pane -T` among them), so it
 * is the author's and survives.
 *
 * One home for the rule, called by BOTH reads — `listPanes` (which a name resolves against) and
 * `describeRmuxRegion` (which a capture exports). Two spellings of a heuristic this load-bearing is
 * how the listing and the capture come to disagree about which panes are named.
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
	if (!pane || !windowId) throw new Error(`rmux ${command} did not report the new pane's id and window id`)
	return [pane, windowId]
}

/**
 * `ratio` is the fraction kept by the ORIGINAL pane; rmux's `-l` sizes the NEW one, exactly as tmux's
 * does. So this INVERTS — `1 - ratio`. The direction was PROBED rather than inherited from the tmux
 * adapter: on rmux 0.10.0, `split-window -h -l 30%` in an 80-column window left the original at 55
 * columns and gave the new pane 24, which is the new pane taking the 30%. Reading the inversion off
 * the sibling adapter is how a shared-by-assumption number comes out silently backwards — a 0.333
 * template would size the original pane at 67%.
 *
 * Percent rather than cells: rmux takes `-l` as either, and a percentage is the only form that means
 * the same thing without first querying the region's size.
 */
function toRmuxSize(ratio: number): string {
	assertRatioInRange(ratio)
	return `${Math.round((1 - ratio) * 100)}%`
}

/**
 * The core vocabulary's rmux spelling. Exactly one member differs, and it was PROBED against the live
 * binary rather than inherited from `TMUX_KEY_RENAMES`: rmux has no `Backspace` key name, so it falls
 * through to tmux's unrecognized-token behavior and TYPES the word. Verified on 0.10.0 —
 * `send-keys 'echo DEFX'` then `send-keys Backspace` produced the line `echo DEFXBackspace`, while
 * the same sequence with `BSpace` produced `echo DEF`. So rmux's name for that key is `BSpace`, and
 * the rename is real behavior on this binary rather than a claim carried over from tmux(1).
 *
 * Deliberately a rename table, NOT a validation table: a token outside the core is forwarded
 * verbatim (the contract), so this must not reject what it does not recognize. Keeping a full rmux
 * key list here would make the passthrough a second vocabulary to maintain.
 */
const RMUX_KEY_RENAMES: Readonly<Record<string, string>> = { Backspace: 'BSpace' }

/**
 * One spelling of the capture, taken by `read` for the snapshot AND for the one-row-deeper truncation
 * probe — so the two differ in exactly the number they disagree about and nothing else. `lines`
 * omitted is rmux's own default window: the visible screen, with no `-S` at all.
 */
function capturePane(exec: Exec, target: MuxTarget, lines: number | 'all' | undefined): string {
	const args = ['capture-pane', '-p', '-t', target.id]
	// `-S -` is tmux's own spelling for "the start of the history", reimplemented by rmux — exact, no
	// stand-in number needed. Verified live on 0.10.0: a 24-row viewport read back 72 rows with it.
	if (lines === 'all') args.push('-S', '-')
	else if (lines != null) args.push('-S', `-${lines}`)
	return exec('rmux', args) ?? ''
}

function toRmuxKey(key: string): string {
	return RMUX_KEY_RENAMES[key] ?? key
}

/**
 * `rmux list-panes -a -F '#{pane_id} #{session_name} #{window_id}'` lists every pane server-wide.
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
