import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import { refuseFloatingPane } from './floating.ts'
import type { LivePane, MuxAdapter, MuxReadOptions, OpenedPane } from './mux.ts'
import { assertRatioInRange } from './ratio.ts'
import { pollForOutput } from './wait-output.ts'

/**
 * otty backend — detected via `$OTTY_PANE_ID`. Drives otty's CLI through `otty pane <verb> …`
 * (https://docs.otty.sh/reference/cli), the same synchronous-CLI shape the other backends use.
 *
 * otty is a native terminal-centric workspace app with integrated multiplexing (Windows > Tabs >
 * Splits > Panes). Its hierarchy maps onto cyber-mux's placement tiers as:
 * - **Workspace** → Window (a new window, spawned via `otty open`)
 * - **Tab** → Tab (a new tab via `otty tab new`)
 * - **Pane** → Pane (a split via `otty pane split`)
 *
 * The env variable `$OTTY_PANE_ID` carries the caller's pane identity — analogous to `$TMUX_PANE`
 * or `$WEZTERM_PANE`. `$OTTY_SOCKET` is the IPC socket path (detection hint only).
 *
 * Probed from the otty docs only — otty is a GUI-only app not installed in this sandbox, so
 * nothing here carries the "verified against a live binary" claim `mux.tmux.ts`/`mux.herdr.ts`
 * make; it makes the same honest disclaimer the other GUI-based adapters do.
 *
 * Real capability shape from the docs:
 *
 * - **Pane is the terminal unit.** `OTTY_PANE_ID` is the self-identity env var and `LivePane.id`
 *   carries a pane id. `--at tab` maps to `otty tab new`; `--at pane:*` maps to `otty pane split`.
 * - **Window is the workspace tier.** `otty open` ALWAYS creates a genuinely separate window —
 *   there is no `--new-window` flag on it — reported as `OpenedPane.workspace`. It names the window
 *   at birth with the documented `--title`.
 * - **No `--env` on any route.** Like wezterm/zellij/cmux, env is native at no tier, so every open
 *   rides the `envFallback` compensation (an `env K=V` prefix on the launch command, or a stderr
 *   warning when there is no command to ride).
 * - **Split direction is a VALUE, not a flag.** `otty pane split --direction <right|left|up|down>`;
 *   `pane:right`/`pane:down` map to `right`/`down`. There is no `--bottom` in that vocabulary.
 * - **Splits CAN be sized** — `otty pane split --size` is documented as the NEW pane's share, so
 *   `ratio` (the fraction kept by the ORIGINAL) inverts to `1 - ratio`, the same inversion
 *   `mux.cmux.ts` and `mux.wezterm.ts` document. otty's units are a WHOLE PERCENT over a documented
 *   10-90 range, not cmux's 0-1 fraction. `canSizeSplits` is true.
 * - **Naming a tab happens at birth.** `otty tab new --title` is documented, so `--at tab` names the
 *   tab in the creating call instead of a follow-up `rename` — the same fix `open` at the window
 *   tier already makes with its own `--title`.
 * - **`send-keys` mixes text and key tokens.** `otty pane send-keys --pane <id> -- "text" key:Enter`
 *   can do both in one call. We implement `sendText` and `sendKeys` separately per the contract.
 * - **No pane-tier `rename`.** The reference scopes the shared verbs as "show, list, new, close,
 *   focus, rename (window/tab), move (tab)" and then enumerates what panes have *additionally* —
 *   "split, zoom, resize, send-keys, send-text, run, exec, wait, and capture". `rename` is in
 *   neither list for `pane`, so this adapter names a tab and REFUSES to name a pane, exactly as
 *   `mux.wezterm.ts` does for the same reason.
 * - **No pane geometry adapter.** `otty panes --json` does not report position, so `regions` is not
 *   implementable. `template save` refuses on otty by naming the backend.
 * - **No git-worktree concept in the CLI.** No `worktree` subcommand, so — like tmux, wezterm,
 *   zellij, and cmux — this backend never binds a worktree to a workspace; callers fall back to
 *   plain git plus `open()`.
 */
export function createOttyAdapter(deps: { window?: string | undefined }): MuxAdapter {
	const adapter: MuxAdapter = {
		name: 'otty',

		/**
		 * `true`. otty's `pane split` documents `--size`, and unlike its sibling `pane resize` (which
		 * counts CELLS, and is why `resizePane` stays refused) `--size` is a SHARE of the split region —
		 * a unit the seam's `ratio` can be converted into without knowing the region's extent, which is
		 * the one thing otty cannot report.
		 *
		 * The conversion is not the identity, and the direction of it is the whole risk here: `--size` is
		 * the NEW pane's share while `ratio` is the fraction kept by the ORIGINAL, so it inverts —
		 * see `toOttySize`.
		 *
		 * Read off otty's documented CLI, NOT verified against a live binary — no otty on the machine
		 * this was written on, matching the rest of this header.
		 */
		canSizeSplits: true,

		/**
		 * `false`, for cmux's two reasons exactly: no suppress-focus flag is documented on `pane split`,
		 * `tab new`, or `open`, and `from` is honored by focusing the target pane first (`open` below),
		 * so an open moves the user twice over.
		 *
		 * Read off otty's documented CLI, NOT verified against a live binary — no otty on the machine
		 * this was written on, matching the rest of this header.
		 */
		opensWithoutStealingFocus: false,

		open(exec, opts) {
			const at = opts.at ?? 'tab'

			if (at === 'workspace') {
				// `otty open [path]` ALWAYS opens a new window — the reference gives it `--command` and
				// `--title` and nothing else. `--new-window` is a flag of the DIFFERENT `otty view`/`otty edit`
				// family, where it selects between placements; passing it here fails at the argument parser.
				const args = ['open']
				// `--title` names the WINDOW, which is the space `at: 'workspace'` opens — so the label lands
				// at birth rather than as a follow-up rename of the wrong tier (the tab).
				if (opts.label) args.push('--title', opts.label)
				if (opts.cwd) args.push(opts.cwd)
				const out = exec('otty', args)
				if (!out) throw new Error(withReason(exec, 'otty open failed'))
				const parsed = parseOttyOutput(out)
				if (!parsed.window_id) throw new Error('otty open did not report the window id')
				const paneId = parsed.pane_id
				if (!paneId) throw new Error('otty open did not report the initial pane id')
				const opened = openedPane(paneId, parsed.tab_id, parsed.window_id)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}

			if (at === 'tab') {
				const args = ['tab', 'new']
				// `--title` names the TAB, which is the space `at: 'tab'` opens — so the label lands at birth
				// in the creating call rather than as a second round trip through `rename`, which left a
				// window where the tab carried otty's default name. Same fix the workspace arm above makes.
				if (opts.label) args.push('--title', opts.label)
				if (opts.cwd) args.push('--cwd', opts.cwd)
				const out = exec('otty', args)
				if (!out) throw new Error(withReason(exec, 'otty tab new failed'))
				const parsed = parseOttyOutput(out)
				const paneId = parsed.pane_id
				if (!paneId) throw new Error('otty tab new did not report the pane id')
				const opened = openedPane(paneId, parsed.tab_id, deps.window)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}

			// otty has no floating-pane concept: `pane split` always takes a share of the region and resizes
			// its neighbors, and nothing in the CLI opens a pane above the layout. So this REFUSES by name
			// rather than substituting a split — the substitute would satisfy the caller's pane id and
			// violate the one property they asked for. No `canFloatPanes` above is the declaration; this
			// is the enforcement, and both are needed for the same reason `agent wait` checks twice: the
			// CLI's pre-flight check is not on the path a library caller reaching `open()` directly takes.
			if (at === 'pane:float') refuseFloatingPane(adapter.name)

			// pane:right / pane:down — a split
			if (opts.from) adapter.focus(exec, opts.from)

			// `--direction <value>`, NOT a bare directional flag: the reference documents
			// `otty pane split --direction right …` over the vocabulary `right|left|up|down`. `--bottom` is
			// not a direction otty names at all — that spelling belongs to `otty view`/`otty edit`.
			const direction = at === 'pane:down' ? 'down' : 'right'
			const args = ['pane', 'split', '--direction', direction]
			if (opts.cwd) args.push('--cwd', opts.cwd)
			if (opts.ratio != null) {
				const { size, requested } = toOttySize(opts.ratio)
				// A clamp is a size the caller did NOT ask for, so it is announced rather than applied
				// quietly — the alternative is `--size 5`, which otty's own 10-90 range rejects, turning a
				// ratio the seam accepts into a failed split.
				if (size !== requested) {
					process.stderr.write(
						`otty sizes a split between 10% and 90% — ratio ${opts.ratio} asked for a ${requested}% ` +
							`new pane, so ${size}% was used instead\n`,
					)
				}
				args.push('--size', String(size))
			}
			const out = exec('otty', args)
			if (!out) throw new Error(withReason(exec, 'otty pane split failed'))
			const parsed = parseOttyOutput(out)
			const paneId = parsed.pane_id
			if (!paneId) throw new Error('otty pane split did not report the pane id')
			const opened = openedPane(paneId, parsed.tab_id, deps.window)
			// No pane-title primitive exists at birth or after (see `rename` below) — degrade with a warning
			// rather than silently dropping the label or failing the whole split over a name nobody NEEDS to
			// open the pane. Same trade `mux.wezterm.ts` makes for the same missing primitive.
			if (opts.label) {
				process.stderr.write(`otty cannot name a pane — "${opts.label}" was not set on pane ${opened.id}\n`)
			}
			runLaunch(adapter, exec, opened, opts.env, opts.launch)
			return opened
		},

		rename(exec, target, tier, name) {
			if (tier === 'tab') {
				exec('otty', ['tab', 'rename', '--tab', target.id, '--title', name])
				return
			}
			// otty scopes `rename` to window/tab. This is NOT an argument from the docs' silence (the #132
			// lesson): the reference states the scope twice over in one sentence — "rename (window/tab)"
			// for the shared verbs, then an explicit enumeration of what panes have *additionally* that
			// does not contain it. Throwing here (rather than issuing a command that fails at otty's
			// argument parser and is then discarded, which is what this did before) is what `open`'s
			// pane-tier degrade-with-warning is a deliberate alternative TO: a caller reaching this method
			// directly gets told, not a false success.
			//
			// Read off otty's documented CLI, NOT verified against a live binary — no otty on the machine
			// this was written on, matching the rest of this header. #128 tracks the missing live suite.
			throw new Error(`otty cannot name a pane (only a window or tab) — asked to rename ${target.id}`)
		},

		group() {
			// A complete no-op: otty has a real window tier that already groups every pane in it.
			// The grouping TAG exists for a backend with NO workspace tier (tmux) to hold one in.
			// otty has a real tier, so there is nothing for this to add.
		},

		sendText(exec, target, text) {
			// `otty pane send-keys` with just text types literal characters
			exec('otty', ['pane', 'send-keys', '--pane', target.id, '--', text])
		},

		sendKeys(exec, target, keys) {
			// `otty pane send-keys` with key:Name tokens presses named keys
			const keyTokens = keys.map((k) => `key:${toOttyKey(k)}`)
			exec('otty', ['pane', 'send-keys', '--pane', target.id, '--', ...keyTokens])
		},

		submit(exec, target, text) {
			// otty's send-keys can mix text and keys in one call
			if (!text) {
				adapter.sendKeys(exec, target, ['Enter'])
				return
			}
			// Combine text and key:Enter in one atomic call
			exec('otty', ['pane', 'send-keys', '--pane', target.id, '--', text, 'key:Enter'])
		},

		read(exec, target, opts?: MuxReadOptions | undefined) {
			// `otty pane capture` reads the terminal contents
			const args = ['pane', 'capture', '--pane', target.id]
			if (opts?.lines != null) args.push('--lines', String(opts.lines))
			const text = exec('otty', args) ?? ''
			// otty does not expose truncation info — report it unknown when asked.
			return { text }
		},

		waitForOutput(exec, target, opts) {
			return pollForOutput(adapter, exec, target, opts)
		},

		focus(exec, target) {
			exec('otty', ['pane', 'focus', '--pane', target.id])
		},

		teardown(exec, target) {
			exec('otty', ['pane', 'close', '--pane', target.id])
		},

		paneExists(exec, target) {
			return listOttyPanes(exec).some((p) => p.id === target.id)
		},

		isPaneFocused(exec, target) {
			const panes = listOttyPanes(exec)
			const found = panes.find((p) => p.id === target.id)
			if (!found) return undefined
			return found.is_focused === true
		},

		listPanes(exec): LivePane[] {
			return listOttyPanes(exec).map((p) => {
				// `floating` is `false` BY CONSTRUCTION, not a stub and not a refusal: otty has no floating-pane
				// concept at all, so every pane it can report really is tiled. The create side refuses a
				// `'pane:float'` open by NAME (`refuseFloatingPane` in `open` above) because there is no
				// truthful pane to hand back; the read side has a truthful answer, and this is it.
				const pane: LivePane = { id: p.id, mux: 'otty' as const, floating: false }
				if (p.cwd) pane.cwd = p.cwd
				if (p.title) pane.label = p.title
				return pane
			})
		},

		// No `regions`: geometry is not available from otty's CLI.
		// No `worktree`: otty has no worktree subcommand.
	}
	return adapter
}

export const ottyMuxAdapter: MuxAdapter = createOttyAdapter({})

interface OttyOutput {
	pane_id?: string
	tab_id?: string
	window_id?: string
}

function parseOttyOutput(out: string): OttyOutput {
	try {
		return JSON.parse(out) as OttyOutput
	} catch {
		return {}
	}
}

interface OttyPane {
	id: string
	title?: string
	cwd?: string
	is_focused?: boolean
}

function listOttyPanes(exec: Exec): OttyPane[] {
	// `otty panes --json` lists all panes
	const out = exec('otty', ['panes', '--json'])
	if (!out) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	const panes: OttyPane[] = []
	for (const p of parsed) {
		if (p?.pane_id) {
			panes.push({
				id: p.pane_id,
				title: p.title,
				cwd: p.cwd,
				is_focused: p.is_focused,
			})
		}
	}
	return panes
}

function openedPane(paneId: string, tabId: string | undefined, window: string | undefined): OpenedPane {
	const opened: OpenedPane = { id: paneId, tab: tabId ?? paneId }
	if (window) opened.workspace = window
	return opened
}

function runLaunch(
	adapter: MuxAdapter,
	exec: Exec,
	target: OpenedPane,
	env: Record<string, string> | undefined,
	launch: string | undefined,
) {
	const fallback = envFallback(env, launch)
	if (fallback.kind === 'dropped') {
		process.stderr.write(
			`env (${fallback.variables.join(', ')}) could not be set on this otty pane — ` +
				'otty has no --env flag on pane split/tab new/open\n',
		)
		return
	}
	if (fallback.command !== undefined) adapter.submit(exec, target, fallback.command)
}

/** otty's documented `--size` range on `pane split`: a whole percent, 10 through 90. */
const OTTY_MIN_SIZE = 10
const OTTY_MAX_SIZE = 90

/**
 * The seam's `ratio` as otty's `--size`, plus what was asked for before the range clamp.
 *
 * Two conversions, both of which are silent wrong-sized panes when wrong:
 *
 * - **The inversion.** `ratio` is the fraction kept by the ORIGINAL pane; otty's `--size` is *"the
 *   NEW pane's share"*, so the value passed is `1 - ratio`. That is the same direction `mux.cmux.ts`
 *   (`--size`) and `mux.wezterm.ts` (`--percent`) already document, and the OPPOSITE of herdr's
 *   `--ratio`, which sizes the original and passes through verbatim.
 * - **The units.** cmux takes a 0-1 fraction; otty documents a whole percent over the range 10-90,
 *   so this scales and rounds like `toWeztermSize` and then clamps into otty's range. A ratio
 *   outside `0 < ratio < 1` is refused by the seam's own guard before either happens.
 *
 * The clamp is reported back so the caller can be told (see `open`): otty rejects a `--size` outside
 * 10-90, so a ratio like `0.95` has no faithful rendering — the choice is a near miss it is told
 * about, or a split that does not open at all.
 *
 * Read off otty's documented CLI, NOT verified against a live binary — no otty on the machine this
 * was written on, matching this file's header. #128 tracks the missing live suite.
 */
function toOttySize(ratio: number): { size: number; requested: number } {
	assertRatioInRange(ratio)
	const requested = Math.round((1 - ratio) * 100)
	return { requested, size: Math.min(OTTY_MAX_SIZE, Math.max(OTTY_MIN_SIZE, requested)) }
}

/**
 * The core key vocabulary's otty spelling. otty uses PascalCase key names: Enter, Tab, Escape, etc.
 */
const OTTY_KEY_RENAMES: Readonly<Record<string, string>> = {
	'C-c': 'Ctrl+c',
}

function toOttyKey(key: string): string {
	return OTTY_KEY_RENAMES[key] ?? key
}
