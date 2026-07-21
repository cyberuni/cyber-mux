import { randomUUID } from 'node:crypto'
import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import type { LivePane, MuxAdapter, MuxReadOptions, OpenedPane } from './mux.ts'

/**
 * WezTerm backend — detected via `$WEZTERM_PANE`. Drives WezTerm's built-in multiplexer through
 * `wezterm cli …` (https://wezterm.org/cli/general.html), the same synchronous-CLI shape tmux and
 * herdr already give `Exec`.
 *
 * Probed from `wezterm cli --help`/the CLI reference docs only — there is no live WezTerm GUI in
 * this sandbox, so nothing here carries the "verified against a live binary" claim `session.tmux.ts`
 * and `session.herdr.ts` make. Several real capability gaps fell out of that probe, not just missing
 * polish:
 *
 * - **No `--env` on `spawn`/`split-pane` at all.** Unlike herdr (native everywhere except one
 *   worktree route), WezTerm's CLI has no env flag on ANY space-creating command — every route is
 *   the exception, so `open`'s env always rides the `envFallback` compensation (a `env K=V` prefix
 *   on the launch command, or a stderr warning with none to ride), never a native flag.
 * - **No way to title a PANE**, at birth or after — `set-tab-title`/`set-window-title` exist, there
 *   is no pane equivalent. `rename(..., 'pane', …)` throws; `open`'s pane-tier `label` degrades to a
 *   stderr warning rather than silently dropping it or failing the whole open.
 * - **No focus-query primitive** — `list --format json`'s documented fields carry no active/focused
 *   indicator for a pane, tab, or window. `isPaneFocused` always answers `undefined`, which is the
 *   seam's own honest answer for "no primitive to report focus", not a workaround.
 * - **No per-key press primitive** — there is no `send-keys`-shaped verb, only `send-text`. The core
 *   vocabulary is instead realized by encoding each key as its raw terminal byte sequence and typing
 *   it via `send-text --no-paste`; see `WEZTERM_KEY_BYTES`.
 * - **No pane geometry** — `list --format json` reports a pane's `size` (rows/cols) but no position,
 *   so there is nothing to build a `PaneRect` from. `describeRegion`/`describeWorkspace` are omitted
 *   entirely, the same optional-omission `template save` already handles for a backend that cannot.
 * - **No git-worktree concept in the CLI at all** — no `worktree` subcommand, so like tmux this
 *   backend never binds one to a workspace; `worktree` is omitted.
 *
 * `spawn`/`split-pane` report only the new pane's bare id — unlike tmux/herdr, which embed the tab
 * (and workspace) in the same `-F`/JSON envelope the pane id rides out on. So `OpenedPane.tab` costs
 * a follow-up `wezterm cli list --format json` lookup here, not a free read of output already held.
 */
export const weztermMuxAdapter: MuxAdapter = {
	name: 'wezterm',

	// `split-pane --percent` sizes a split. Verified only against the issue's own probe note and the
	// CLI's own help text, not a live binary — see `toWeztermSize`.
	canSizeSplits: true,

	open(exec, opts) {
		const at = opts.at ?? 'tab'
		if (at === 'workspace') {
			// WezTerm's `--workspace` both selects AND creates: naming one that does not yet exist makes
			// it. Reusing "default" (the CLI's own default when `--workspace` is omitted) would NOT open
			// the pane's own space — it would join whatever the caller was already in — so a fresh name
			// is minted whenever the caller gave no `label`. When a label IS given it doubles as the
			// workspace's name: WezTerm has one string per workspace, not a separate opaque id plus a
			// display name the way tmux's window option split the two.
			const workspace = opts.label ?? `cyber-mux-${randomUUID().slice(0, 8)}`
			const out = exec('wezterm', ['cli', 'spawn', '--new-window', '--workspace', workspace, '--cwd', opts.cwd])
			if (!out) throw new Error(withReason(exec, 'wezterm cli spawn --new-window failed'))
			const pane = out.trim()
			if (!pane) throw new Error('wezterm cli spawn --new-window did not report the new pane id')
			const opened: OpenedPane = { id: pane, tab: resolveTab(exec, pane), workspace }
			runLaunch(exec, opened, opts.env, opts.launch)
			return opened
		}
		if (at === 'tab') {
			// A WezTerm workspace is a set of WINDOWS and a tab lives in a window, so the anchor is
			// resolved one level down: any window already in the named workspace will do — a tab spawned
			// into it lands in that workspace. Without it `spawn` targets the window the USER is looking
			// at, which is the whole reason `within` exists.
			const within = opts.within ? ['--window-id', resolveWorkspaceWindow(exec, opts.within)] : []
			const out = exec('wezterm', ['cli', 'spawn', ...within, '--cwd', opts.cwd])
			if (!out) throw new Error(withReason(exec, 'wezterm cli spawn failed'))
			const pane = out.trim()
			if (!pane) throw new Error('wezterm cli spawn did not report the new pane id')
			const opened = withTabAndWorkspace(exec, pane)
			// `spawn` has no title flag at all (unlike tmux `-n`/herdr `--label`), so a tab's own label
			// is always a post-birth rename — not just the one root-tab case herdr has. Addressed by
			// TAB id, not the pane id `opened` itself carries — `rename`'s 'tab' tier takes a tab id.
			if (opts.label) weztermMuxAdapter.rename(exec, { id: opened.tab }, 'tab', opts.label)
			runLaunch(exec, opened, opts.env, opts.launch)
			return opened
		}
		// pane:right / pane:down
		const direction = at === 'pane:down' ? ['--bottom'] : ['--right']
		const from = opts.from ? ['--pane-id', opts.from.id] : []
		// The issue's own probe note: `--percent` sizes the NEW pane, the same inversion tmux's `-l`
		// needs — not herdr's pass-through of the ORIGINAL pane's fraction.
		const size = opts.ratio != null ? ['--percent', toWeztermSize(opts.ratio)] : []
		const out = exec('wezterm', ['cli', 'split-pane', ...direction, ...from, ...size, '--cwd', opts.cwd])
		if (!out) throw new Error(withReason(exec, 'wezterm cli split-pane failed'))
		const pane = out.trim()
		if (!pane) throw new Error('wezterm cli split-pane did not report the new pane id')
		const opened = withTabAndWorkspace(exec, pane)
		// No pane-title primitive exists at all — degrade with a warning rather than silently dropping
		// the label or failing the whole split over a name nobody NEEDS to open the pane.
		if (opts.label) {
			process.stderr.write(`wezterm cannot name a pane — "${opts.label}" was not set on pane ${opened.id}\n`)
		}
		runLaunch(exec, opened, opts.env, opts.launch)
		return opened
	},

	rename(exec, target, tier, name) {
		if (tier === 'tab') {
			exec('wezterm', ['cli', 'set-tab-title', '--tab-id', target.id, name])
			return
		}
		// No CLI primitive names a pane, at birth or after — `set-tab-title`/`set-window-title` exist,
		// there is no pane equivalent. Throwing here (rather than a silent no-op) is what `open`'s own
		// pane-tier degrade-with-warning is a deliberate alternative TO: a caller reaching this method
		// directly gets told, not a false success.
		throw new Error(`wezterm cannot name a pane (only a tab or window) — asked to rename ${target.id}`)
	},

	group() {
		// Same complete answer as herdr's, and for the same reason: WezTerm's workspace IS a real tier
		// (every window belongs to one), so a caller opening several tabs and asking to group them has
		// nothing left for this to add — the grouping tag exists for a backend with no workspace tier
		// to hold one in (tmux). The granularity is coarser here (per-WINDOW, since every tab in a
		// window already shares its workspace, and there is no "move this tab to another workspace"
		// primitive to retrofit one), but the answer is the same: nothing to write.
	},

	sendText(exec, target, text) {
		// The default (no `--no-paste`) sends as a bracketed paste, which is what keeps the guarantee
		// send-keys asks for: text is never interpreted as a key name, only ever typed.
		exec('wezterm', ['cli', 'send-text', '--pane-id', target.id, text])
	},

	sendKeys(exec, target, keys) {
		// There is no send-keys-shaped verb in wezterm's CLI, so a named key is realized as its own raw
		// terminal byte sequence typed via `send-text --no-paste` — `--no-paste` because a key's bytes
		// (an escape sequence, a control byte) must reach the pty as-is, never wrapped in a bracketed
		// paste marker the way `sendText`'s literal text is. A token this adapter cannot encode is
		// forwarded as its own literal characters, the same "cannot refuse a key name" fallback tmux's
		// send-keys has — there is no backend to ask, so nothing here can refuse it either.
		const bytes = keys.map((k) => WEZTERM_KEY_BYTES[k] ?? k).join('')
		exec('wezterm', ['cli', 'send-text', '--pane-id', target.id, '--no-paste', bytes])
	},

	submit(exec, target, text) {
		// No atomic literal-text-plus-Enter primitive, so this composes exactly as tmux's does: the
		// bare-flush case presses Enter alone, typing nothing; otherwise the literal text first, then
		// Enter as its own key.
		if (!text) {
			weztermMuxAdapter.sendKeys(exec, target, ['Enter'])
			return
		}
		weztermMuxAdapter.sendText(exec, target, text)
		weztermMuxAdapter.sendKeys(exec, target, ['Enter'])
	},

	read(exec, target, opts?: MuxReadOptions) {
		const args = ['cli', 'get-text', '--pane-id', target.id]
		// `--start-line` counts backward into scrollback from 0 (the top of the visible screen); the
		// end defaults to the bottom of the screen. Negative-N approximates "last N lines" the way
		// tmux's `-S -N` does, though the two are not guaranteed to line up cell-for-cell.
		if (opts?.lines != null) args.push('--start-line', String(-opts.lines))
		return exec('wezterm', args) ?? ''
	},

	focus(exec, target) {
		// The one primitive whose name says what this method wants — "Activate (focus) a pane". Its
		// docs do not state whether it crosses a window or workspace boundary to get there (untestable
		// here, no live GUI); it is used as the whole implementation because there is nothing else in
		// the CLI surface that names this intent.
		exec('wezterm', ['cli', 'activate-pane', '--pane-id', target.id])
	},

	teardown(exec, target) {
		exec('wezterm', ['cli', 'kill-pane', '--pane-id', target.id])
	},

	paneExists(exec, target) {
		return listWeztermPanes(exec).some((p) => String(p.pane_id) === target.id)
	},

	isPaneFocused() {
		// `list --format json`'s documented fields carry no active/focused indicator for a pane, tab, or
		// window — there is no primitive to ask. `undefined` is the seam's own answer for exactly this
		// case, not a stand-in for `false`: callers fail OPEN on it.
		return undefined
	},

	listPanes(exec): LivePane[] {
		return listWeztermPanes(exec).map((p) => {
			const pane: LivePane = { id: String(p.pane_id), mux: 'wezterm' as const }
			const cwd = weztermCwd(p.cwd)
			if (cwd) pane.cwd = cwd
			// No `label`, ever — not a filtering rule like tmux's hostname guard, but the honest answer
			// to there being no way for a human OR cyber-mux to set a pane's title on this backend (see
			// `rename`). `title` is whatever program is running, ambient rather than chosen — reporting
			// it as a label would manufacture the exact collision (every shell pane named the same
			// thing) the hostname guard exists to prevent, except with no author ever able to override
			// it here.
			return pane
		})
	},

	// No `describeRegion`/`describeWorkspace`: `list --format json` reports a pane's size, never its
	// position, so there is no rect to build. Omitted entirely — the same optional-absence `template
	// save` already handles for a backend that cannot describe its own region, not a stub.

	// No `worktree`: no `worktree` subcommand exists in the CLI at all, so — like tmux — this backend
	// never binds a git worktree to a workspace; callers fall back to plain git plus `open()`.
}

/**
 * `wezterm cli spawn`/`split-pane` report ONLY the new pane's bare id on stdout — unlike tmux/herdr,
 * neither embeds the tab (or workspace) in that same output. So the tab this pane landed in is a
 * follow-up `list --format json` lookup rather than a free read of an envelope already held.
 * `OpenedPane.tab` is still required — every multiplexer has the Tab level — it simply costs more
 * here than the "no extra call" property tmux/herdr get to claim.
 */
function resolveTab(exec: Exec, pane: string): string {
	const found = listWeztermPanes(exec).find((p) => String(p.pane_id) === pane)
	if (!found) throw new Error(`wezterm did not report a tab for the new pane ${pane}`)
	return String(found.tab_id)
}

/**
 * A window of the named workspace — what `spawn --window-id` needs to place a tab in a workspace
 * WezTerm's CLI cannot target directly (`--workspace` only names the space a `--new-window` spawn
 * creates, so it cannot place a tab in an existing one).
 *
 * Throws rather than falling back to an untargeted spawn: an unresolvable anchor means the workspace
 * is gone, and the untargeted spawn is exactly the wrong-space bug `within` was added to close.
 */
function resolveWorkspaceWindow(exec: Exec, workspace: string): string {
	const found = listWeztermPanes(exec).find((p) => p.workspace === workspace)
	if (!found) throw new Error(`wezterm reported no window in workspace ${workspace} to open a tab in`)
	return String(found.window_id)
}

/** `resolveTab` plus the workspace the same lookup already answers — one call serves both facts. */
function withTabAndWorkspace(exec: Exec, pane: string): OpenedPane {
	const found = listWeztermPanes(exec).find((p) => String(p.pane_id) === pane)
	if (!found) throw new Error(`wezterm did not report a tab for the new pane ${pane}`)
	// Every WezTerm pane belongs to SOME workspace, even the implicit "default" one it starts in — so
	// unlike tmux (never reports; no tier at all) this is never absent, on every placement including
	// tab and pane:*, whether or not the caller ever asked for one.
	return { id: pane, tab: String(found.tab_id), workspace: found.workspace }
}

/**
 * Env is native at NO tier on this backend — `spawn`/`split-pane` take no `--env` at all, unlike
 * herdr (native everywhere but one worktree route). So every `open` funnels through the same
 * fallback herdr's worktree route uses: with a launch command, env rides in as an `env K=V` prefix;
 * with none, a warning names what did not land. `envFallback` is a no-op when there is no env to
 * carry, so this is safe to call unconditionally.
 */
function runLaunch(
	exec: Exec,
	target: OpenedPane,
	env: Record<string, string> | undefined,
	launch: string | undefined,
) {
	const fallback = envFallback(env, launch)
	if (fallback.kind === 'dropped') {
		process.stderr.write(
			`env (${fallback.variables.join(', ')}) could not be set on this wezterm pane — ` +
				'wezterm has no --env flag on any space-creating command\n',
		)
		return
	}
	if (fallback.command !== undefined) weztermMuxAdapter.submit(exec, target, fallback.command)
}

interface WeztermListEntry {
	window_id: number | string
	tab_id: number | string
	pane_id: number | string
	workspace: string
	title?: string
	cwd?: string
}

/** One `wezterm cli list --format json` call, parsed defensively — never throws on bad output. */
function listWeztermPanes(exec: Exec): WeztermListEntry[] {
	const out = exec('wezterm', ['cli', 'list', '--format', 'json'])
	if (!out) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	return parsed.filter(
		(p): p is WeztermListEntry => p != null && p.pane_id != null && p.tab_id != null && p.window_id != null,
	)
}

/** `cwd` is reported as a `file://` URI; strip the scheme and host down to the bare path. */
function weztermCwd(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined
	const match = /^file:\/\/[^/]*(\/.*)$/.exec(cwd)
	return match ? decodeURIComponent(match[1]!) : cwd
}

/**
 * `ratio` is the fraction kept by the ORIGINAL pane; `--percent` sizes the NEW one (the issue's own
 * probe note, #47) — the same inversion tmux's `-l` needs, unlike herdr's pass-through.
 */
function toWeztermSize(ratio: number): string {
	return String(Math.round((1 - ratio) * 100))
}

/**
 * The core vocabulary, realized as raw terminal bytes rather than a backend key NAME — there is no
 * send-keys-shaped verb to name a key TO, only `send-text`. Escape sequences are the ANSI/VT100
 * "cursor key mode" forms every common shell/program already parses; `Backspace` sends DEL (`\x7f`),
 * what most terminals emit for that key today (probed, not read off any wezterm spec — wezterm ships
 * no such table because it has no key-name CLI surface to spec).
 *
 * `Home`/`End`/`Delete`/`Insert`/`PageUp`/`PageDown` are extras beyond the core, included for the
 * same reason tmux "knows" `Home` even though the core vocabulary does not name it: these are
 * standard-enough ANSI keys that encoding them costs nothing extra and a caller reaching for one
 * should not silently get the literal word typed instead.
 */
const WEZTERM_KEY_BYTES: Readonly<Record<string, string>> = {
	Up: '\x1b[A',
	Down: '\x1b[B',
	Right: '\x1b[C',
	Left: '\x1b[D',
	Enter: '\r',
	Escape: '\x1b',
	Tab: '\t',
	Space: ' ',
	Backspace: '\x7f',
	'C-c': '\x03',
	F1: '\x1bOP',
	F2: '\x1bOQ',
	F3: '\x1bOR',
	F4: '\x1bOS',
	F5: '\x1b[15~',
	F6: '\x1b[17~',
	F7: '\x1b[18~',
	F8: '\x1b[19~',
	F9: '\x1b[20~',
	F10: '\x1b[21~',
	F11: '\x1b[23~',
	F12: '\x1b[24~',
	Home: '\x1b[H',
	End: '\x1b[F',
	Delete: '\x1b[3~',
	Insert: '\x1b[2~',
	PageUp: '\x1b[5~',
	PageDown: '\x1b[6~',
}
