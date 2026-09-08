import { agentWaitStatesSatisfiable, refuseAgentWaitStates } from './agent-states.ts'
import { launchFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import { refuseFloatingPane } from './floating.ts'
import { restoringFocus, soleFocusedPane } from './focus-on-open.ts'
import { refusePaneBreak, refusePaneMove } from './move.ts'
import type { AgentStatus, LivePane, MuxAdapter, MuxReadOptions, OpenedPane } from './mux.ts'
import { assertRatioInRange } from './ratio.ts'
import { pollForOutput } from './wait-output.ts'
import { refusePaneZoom } from './zoom.ts'

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
 * - **`--cwd` is REAL on `pane split` and unevidenced on `tab new`** (#163) — and the two halves rest
 *   on different ground, which is the whole point of splitting them.
 *   `/reference/cli` mentions `--cwd` nowhere, and #163 read that silence as a fabricated flag on
 *   both routes. It is not: `/agents/orchestration` gives
 *   `otty pane split --direction right --cwd "$PWD" --no-focus --json` as a hand-runnable command, so
 *   the split route's `--cwd` is documented by otty itself and STAYS. That page also settles what the
 *   reference is worth here — it demonstrates two flags (`--cwd`, `--no-focus`) the reference omits,
 *   and the reference's window/tab/pane section is prose plus examples with no flag table at all, so
 *   it enumerates nothing and its silence proves nothing. Measured 2026-09-08 over all 141 URLs in
 *   `docs.otty.sh/sitemap.xml`: `--cwd` and `--no-focus` each occur on exactly ONE page, that one.
 *   `tab new` gets no such rescue. Nothing on any of the 141 pages shows a working directory on it —
 *   the only `tab new` with flags is `--command`/`--title` — and otty publishes no source to settle
 *   it, so the flag is neither evidenced nor disproven. So this route takes the answer that is
 *   CORRECT UNDER BOTH READINGS instead of betting on either: `--cwd` is dropped and the directory
 *   rides a `cd` on the command line, which works whether or not the flag exists, where sending a
 *   flag otty does not take fails EVERY `--at tab` open outright. That is the shape `mux.cmux.ts`
 *   landed for the same wall (see `runLaunch`); it is a shell-level cd, so it lands in the tab's
 *   shell history and only means anything in a shell pane. If someone with a Mac runs
 *   `otty tab new --help` and finds `--cwd`, this route should go back to the native flag.
 *   The WORKSPACE tier is unaffected either way: `otty open [path]` takes the directory as a
 *   documented POSITIONAL and always did.
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
 * - **`otty pane zoom` exists and cannot be driven from the docs.** The reference names the verb once
 *   and gives it no flags, no example, and no read-back field, while spelling out the flags of its
 *   neighbours `split` and `resize`. An absolute zoom needs a write vocabulary and a state read and
 *   the docs supply neither, so `setPaneZoom` refuses BY NAME rather than guessing a flag otty may
 *   silently ignore. `otty pane zoom --help` on a real machine settles it; see `setPaneZoom`.
 * - **No pane geometry adapter.** `otty panes --json` does not report position, so `regions` is not
 *   implementable. `template save` refuses on otty by naming the backend.
 * - **A NATIVE agent-lifecycle wait exists, and it is `otty pane wait`** — not the `otty watch:<agent>`
 *   issue #134 proposed, whose positional is an agent session id no documented pane read can produce.
 *   `pane wait` is pane-selected, blocking, and on an agent pane blocks on what the agent itself
 *   reports, so `agentLifecycle` is PRESENT here — otty is the second backend with the capability
 *   after herdr. It ends on `idle` alone; see `agentLifecycle` below for the three named limits.
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
		 * `false`, and this is an ADAPTER-WIDE floor: the declaration is one bit covering every tier, so
		 * it can only be `true` when no tier steals focus. `tab new` and `open` document no
		 * suppress-focus flag, and `from` is honored by focusing the target pane first (`open` below),
		 * so an open moves the user twice over.
		 *
		 * The `pane split` half of that reason is now known to be WRONG and is left standing only
		 * because it does not move this bit: `--no-focus` IS real on `pane split` — otty's
		 * `/agents/orchestration` runs `otty pane split --direction right --cwd "$PWD" --no-focus
		 * --json` — and this adapter does not pass it. Found while settling #163's `--cwd`; acting on it
		 * is a behavior change on a different seam member and belongs to its own unit of work (#133 is
		 * where this declaration was set).
		 *
		 * Read off otty's documented CLI, NOT verified against a live binary — no otty on the machine
		 * this was written on, matching the rest of this header.
		 */
		/**
		 * `'restored'`. The old `false` gave two reasons and one of them is gone: `pane split` DOES take
		 * `--no-focus` — otty's own `/agents/orchestration` page runs `otty pane split --direction right
		 * --cwd "$PWD" --no-focus --json` (issue #172) — while `tab new` and `open` still document none,
		 * and `from` is still honored by FOCUSING the anchor pane first because otty's split has no
		 * target flag. That anchor move happens before the open runs, so no flag on the open can
		 * suppress it.
		 *
		 * Undoing it is what issue #152 asked for and what this declares. The restore is right whether
		 * or not the documented flag behaves as documented: if the new pane does not take focus,
		 * re-focusing the caller's own pane is a no-op; if it does, it is the fix.
		 *
		 * `--no-focus` itself is deliberately NOT passed here — that is #172's change, it needs a Mac to
		 * confirm, and an unverified flag would make the outcome depend on being right about a docs
		 * read that this behavior does not need.
		 *
		 * DOCS-READ, not live: otty is macOS/Windows-GUI-only and `live-backends` cannot exercise it
		 * (#128).
		 */
		focusOnOpen: 'restored',

		open(exec, opts) {
			const at = opts.at ?? 'tab'
			// The refusal is PRE-FLIGHT, above the focus read rather than inside the opened body: it must
			// cost no exec at all (`placement-float-refused-by-name` pins exactly that), and there is
			// nothing to restore when nothing is going to be opened.
			if (at === 'pane:float') refuseFloatingPane(adapter.name)
			// Argument validation is pre-flight for the same reason, and it did not used to be: an
			// out-of-range `ratio` threw from inside the split branch, which after the wrapper landed
			// meant one focus read had already been spent on an open that was never going to happen.
			// Rejecting bad input before touching the backend at all is the rule; the wrapper is where
			// forgetting it starts to cost something.
			if (opts.ratio != null) assertRatioInRange(opts.ratio)
			// EVERY route, not only the `pane:*` one: a new tab or workspace is selected when it is
			// created too, so those move the caller as well. The read runs before anything is created and
			// the restore runs even if the open throws — see `restoringFocus`.
			return restoringFocus(
				{
					read: () =>
						soleFocusedPane(
							listOttyPanes(exec),
							(r) => r.is_focused,
							(r) => r.id,
						),
					restore: (pane) => adapter.focus(exec, { id: pane }),
				},
				() => {
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
						// No `--cwd` here, unlike the split arm below: nothing otty publishes puts a working
						// directory on `tab new`, so the directory is compensated in `runLaunch` as a `cd`
						// instead — the answer that holds whether or not the flag exists (see the header).
						const out = exec('otty', args)
						if (!out) throw new Error(withReason(exec, 'otty tab new failed'))
						const parsed = parseOttyOutput(out)
						const paneId = parsed.pane_id
						if (!paneId) throw new Error('otty tab new did not report the pane id')
						const opened = openedPane(paneId, parsed.tab_id, deps.window)
						runLaunch(adapter, exec, opened, opts.env, opts.launch, opts.cwd)
						return opened
					}

					// pane:right / pane:down — a split
					if (opts.from) adapter.focus(exec, opts.from)

					// `--direction <value>`, NOT a bare directional flag: the reference documents
					// `otty pane split --direction right …` over the vocabulary `right|left|up|down`. `--bottom` is
					// not a direction otty names at all — that spelling belongs to `otty view`/`otty edit`.
					const direction = at === 'pane:down' ? 'down' : 'right'
					const args = ['pane', 'split', '--direction', direction]
					if (opts.cwd) args.push('--cwd', opts.cwd)
					// `--cwd` STAYS on this route, and on this route only: otty's own `/agents/orchestration`
					// runs `otty pane split --direction right --cwd "$PWD" --no-focus --json` by hand. #163 read
					// `/reference/cli`'s silence as proof the flag was fabricated; that page documents no flags
					// for this command family at all. See the header for the measurement.
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
					// No `cwd` argument: this route set it natively with `--cwd` above.
					runLaunch(adapter, exec, opened, opts.env, opts.launch)
					return opened
				},
			)
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
			// `is_focused` off the `panes --json` listing — and the FIELD is presence-checked, not only the
			// pane. `otty panes --json` is documented as a command; its row FIELDS never are (see the
			// header), so `is_focused` being absent from a real row is the likeliest shape of being wrong
			// about this backend. `undefined === true` is `false`, which would turn that silence into a
			// confident "not focused" — the plausible wrong answer. `isPaneZoomed` right below refuses on
			// the same ground; this member now matches it instead of contradicting it.
			const found = listOttyPanes(exec).find((p) => p.id === target.id)
			if (!found) return undefined
			return typeof found.is_focused === 'boolean' ? found.is_focused : undefined
		},

		/**
		 * REFUSED BY NAME — and for a DIFFERENT reason from cmux's, which is why the two are not
		 * collapsed into one note. otty HAS the verb; what it does not have is any documented way to
		 * drive it absolutely. No `canZoomPanes` above is the declaration; this is the enforcement.
		 *
		 * **And the reference is not the whole corpus, which is the first thing #163 established here** —
		 * `/agents/orchestration` demonstrates `--cwd` and `--no-focus` on `pane split`, two flags
		 * `/reference/cli` omits entirely. So that page was checked for this member too, and it does not
		 * mention zoom at ALL: the word appears nowhere on it, and the `otty pane …` commands it runs by
		 * hand are `list`, `split`, `run`, `exec`, `capture`, `wait` and `close`. The one page that has
		 * been shown to carry flags the reference drops carries nothing for `zoom`.
		 *
		 * `zoom` is named exactly once on the whole CLI reference — "Panes additionally have `split`
		 * (`--direction right|left|up|down`), `zoom`, `resize`, `send-keys`, `send-text`, `run`, `exec`,
		 * `wait`, and `capture`" — with no flag list, no example, and no `--on`/`--off`/`--toggle`
		 * anywhere on the page. Its neighbors `split` and `resize` get their flags spelled out in that
		 * same sentence, so the omission is the docs' own, not a reading failure. Nothing in the docs
		 * reports zoom state back either: `otty panes --json` is documented but its row fields never
		 * are, and `/reference/keybindings` gives one binding, "Zoom / unzoom split ⌘⇧↩", doing both
		 * directions — which HINTS a toggle and settles nothing about the CLI.
		 *
		 * Both halves of an absolute set are therefore missing: the write, whose vocabulary is unknown,
		 * and the read that write would have to be guarded by. Guessing a spelling would ship a flag
		 * otty may silently ignore — the exact silent-success failure `mux.cmux.ts` documents on its
		 * `resize-pane -Z` shim — and a bare `otty pane zoom` fired blind is the toggle
		 * `MuxAdapter.setPaneZoom` exists to refuse to be: it could be asked for "big" and deliver
		 * "small". This is `resizePane`'s refusal shape exactly: a backend with the neighbouring
		 * primitive but not the fact the seam's verb needs does not get the verb.
		 *
		 * **One command settles it** on a machine with otty: `otty pane zoom --help`. If it takes an
		 * absolute on/off, this becomes a two-line implementation and the declaration flips; if it is a
		 * bare toggle, the refusal stands until `otty panes --json` is shown to carry a zoom field. See
		 * issue #128 for the missing real-boundary suite that would run it.
		 */
		setPaneZoom() {
			refusePaneZoom('otty')
		},

		/**
		 * `undefined` — no documented zoom field on any otty listing, so the backend cannot be asked.
		 * Never `false`: otty's own keybinding reference shows a user can zoom a split with ⌘⇧↩, so a
		 * `false` here would be a confident lie about a pane they just zoomed. `isPaneFocused`'s wezterm
		 * shape, and the same distinction `mux.cmux.ts` draws.
		 *
		 * This is a docs-read answer like the rest of this file, and it is the half that would change
		 * first: if `otty panes --json` turns out to carry a zoom column, this member can answer for
		 * real even while `setPaneZoom` stays refused, because a read needs no flag vocabulary.
		 */
		isPaneZoomed() {
			return undefined
		},

		/**
		 * Refused BY NAME, and this is `setPaneZoom`'s refusal one member over rather than a claim that
		 * otty cannot relocate panes. It plainly can — the docs publish it as a MOUSE GESTURE ("drag a
		 * pane onto the tab strip to move it out into its own new tab", "drag it outside the window to
		 * tear it off") and as a right-click menu item ("Move Tab to New Window"). What they do not
		 * publish is a way for a program to ask.
		 *
		 * The CLI reference names `move` for the TAB tier only — "Common subcommands across the three:
		 * `show`, `list`, `new`, `close`, `focus`, `rename` (window/tab), `move` (tab)" — with no flag
		 * list, no example, and no destination grammar anywhere in the corpus; `/agents/orchestration`,
		 * the one page that carries flags the reference drops (`--cwd`, `--no-focus`), names neither
		 * verb. So the write vocabulary is unknown and there is no read to verify a guess landed
		 * against. A blind guess at a destination flag is exactly what a refusal is for: otty's parser
		 * would either fail or, worse, ignore it.
		 *
		 * RECHECK TRIGGER: `otty tab move --help` and `otty pane --help` on a machine with otty — see
		 * issue #128 for the missing real-boundary suite. Absence from a docs page is not evidence a
		 * verb does not exist, and this refusal claims only that nothing publishes how to drive one.
		 */
		movePane() {
			refusePaneMove('otty')
		},

		/** Refused BY NAME, for `movePane`'s reason: the break-out is a GUI gesture with no CLI spelling. */
		breakPane() {
			refusePaneBreak('otty')
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

		/**
		 * The native agent-lifecycle wait — otty is the SECOND backend to have one, after herdr, and it
		 * is a different primitive from the one issue #134 named.
		 *
		 * **Not `otty watch:<agent> <id>`, which is what #134 proposed and what the earlier verdict on it
		 * measured.** That command's positional is an AGENT SESSION id ("the one from Agent History" —
		 * `/workflows/cli-usage`), not a pane id; its whole flag table is `--interval-ms`,
		 * `--timeout-secs`, `--unknown-timeout-secs`, `-v` with no pane selector; the agent KIND is baked
		 * into the verb (`watch:claude` / `watch:codex` / `watch:opencode`); and no documented CLI read
		 * maps a pane id to either fact — otty binds them the other way, internally, by process tree
		 * (`/agents/supported-agents`). All of that still holds, and it is why `watch:` is not used here.
		 *
		 * **`otty pane wait` is the one that fits, and it was missed the first time round.** It is
		 * pane-selected with the same `--pane <id|index>` every other pane verb takes, it blocks, and on
		 * an agent pane the state it blocks on is the AGENT's own:
		 *
		 * > It exits 0 as soon as the pane is idle. For a pane running a coding agent, idle is what the
		 * > agent reports — an agent owns its terminal for its whole life, so "back at a shell prompt"
		 * > never happens there. […] A pane that can report neither exits 6 and says so; a timeout exits
		 * > 9 naming the panes still busy. — `/workflows/cli-usage`
		 *
		 * `/agents/orchestration` lists it beside `watch:` for the same job ("Block until a build, a
		 * pane, a tab or another agent is idle — `otty pane wait` / `otty watch:<agent>`") and
		 * `/agents/skills` says the same in prose. That is `AgentLifecycle`'s contract exactly: native,
		 * blocking, per-pane, on a state the backend derives itself — so this capability is PRESENT
		 * rather than absent, and no `read()`-polling lookalike is involved.
		 *
		 * **Three things this cannot do, each named rather than papered over:**
		 *
		 * 1. **It ends on `idle` and nothing else**, so any `until` naming another state is refused BY
		 *    NAME (`refuseAgentWaitStates`). Narrowing it silently would end the wait on a state the
		 *    caller did not ask for.
		 * 2. **Exit codes are invisible through the `Exec` seam.** otty distinguishes satisfied (0) from
		 *    no-reportable-state (6), no-such-pane (4) and timeout (9) by exit code alone, and `Exec`
		 *    returns `string | null` with no code. So this tells satisfied from not-satisfied — the
		 *    distinction the seam needs — and folds the three failures into one throw whose message
		 *    carries otty's own words via `withReason`. It does NOT branch on `exec.lastError`: that is
		 *    documented diagnostic-only and a runner is free never to set it, so a guard keyed on it
		 *    would be a live no-op.
		 * 3. **A pane with NO agent answers `idle` when its shell is at a prompt.** That is a real
		 *    divergence from herdr, which throws `agent_not_found`, and it cannot be guarded here: the
		 *    "which agent sits in which" read `/agents/orchestration` credits to `otty pane list` has no
		 *    documented output schema anywhere in the 141 pages, so there is no field to check. A caller
		 *    that waits on a pane it did not start an agent in gets shell-idle under an agent name.
		 *
		 * Read off otty's documented CLI over all 141 URLs in `docs.otty.sh/sitemap.xml`, measured
		 * 2026-09-08 — NOT verified against a live binary, matching this file's header. #128 tracks the
		 * missing real-boundary suite; one `otty pane wait --help` on a Mac settles the flag table.
		 */
		agentLifecycle: {
			waitForState(exec, target, opts) {
				// Refused BEFORE any exec, so a set otty cannot express never turns into a wait that ends
				// somewhere else. An omitted (or empty) `until` passes: the seam defines that as the
				// backend's own default, and otty's default is the only state it has.
				if (!agentWaitStatesSatisfiable(opts.until, OTTY_WAIT_STATES)) {
					refuseAgentWaitStates(adapter.name, opts.until ?? [], OTTY_WAIT_STATES)
				}
				const args = ['pane', 'wait', '--pane', target.id]
				if (opts.timeoutMs != null) args.push('--timeout-secs', String(toOttyTimeoutSecs(opts.timeoutMs)))
				const out = exec('otty', args)
				// `out === null`, never `!out`: a satisfied wait prints nothing documented, so success is
				// an EMPTY STRING here, and `!out` would turn every successful wait into a throw.
				if (out === null) {
					throw new Error(withReason(exec, `otty pane wait did not reach idle for pane ${target.id}`))
				}
				// Truthful rather than assumed: otty's wait has exactly one end state, so exit 0 IS idle.
				return 'idle'
			},
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

/**
 * Run the caller's launch command in the freshly opened space, carrying whatever the route could not
 * set natively.
 *
 * `cwd` is passed by the `tab` route ALONE — the one route with no working-directory flag to send
 * (the header says why). The other two routes pass none, and for the same reason: they already set
 * the directory natively — `pane split --cwd`, and `otty open [path]`'s positional — so a `cd` there
 * would push into shell history a directory the pane is already in.
 *
 * Both compensations — the env prefix and the `cd` — and the order they compose in are
 * `launchFallback`'s (`env-fallback.ts`); this route hands it what it lost and submits what comes
 * back. `mux.cmux.ts` calls the same function for the same reason, which is why the rule lives there
 * and not here.
 */
function runLaunch(
	adapter: MuxAdapter,
	exec: Exec,
	target: OpenedPane,
	env: Record<string, string> | undefined,
	launch: string | undefined,
	cwd?: string | undefined,
) {
	const fallback = launchFallback(env, launch, cwd)
	if (fallback.kind === 'dropped') {
		process.stderr.write(
			`env (${fallback.variables.join(', ')}) could not be set on this otty pane — ` +
				'otty has no --env flag on pane split/tab new/open\n',
		)
		// env is lost, the directory need not be: the `cd` still comes back and is still submitted.
	}
	if (fallback.command !== undefined) adapter.submit(exec, target, fallback.command)
}

/**
 * The `AgentStatus` values `otty pane wait` can end a wait on — exactly one.
 *
 * otty's own state vocabulary is wider than this (its hooks report `processing | idle | awaiting`, per
 * `/reference/cli`; `/vt/osc/osc-26` spells the same report a second way as
 * `running | awaiting-approval | finished`, an inconsistency inside otty's own docs that nothing here
 * has to resolve). None of that is reachable: `pane wait` takes no `--until`, and the only end
 * condition any page states for it is idle. So this is what the WAIT can promise, not what otty knows.
 */
const OTTY_WAIT_STATES: readonly AgentStatus[] = ['idle']

/**
 * The seam's `timeoutMs` as otty's `--timeout-secs`, rounded UP and floored at one second.
 *
 * Both halves guard the same failure, and it is the one that matters: `--timeout-secs 0` is otty's
 * spelling for *wait forever*, which is what OMITTING `timeoutMs` already means at the seam. So a
 * sub-second bound must never round to 0 — that would silently convert a caller's bounded wait into an
 * unbounded one, in a command that blocks. Rounding up costs at most 999ms of extra patience;
 * rounding down costs the timeout entirely.
 *
 * The granularity loss is otty's, not this adapter's: herdr's `--timeout` takes milliseconds and is
 * passed through verbatim.
 */
function toOttyTimeoutSecs(timeoutMs: number): number {
	return Math.max(1, Math.ceil(timeoutMs / 1000))
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
