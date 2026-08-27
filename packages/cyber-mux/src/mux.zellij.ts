import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import type { LivePane, MuxAdapter, MuxReadOptions, OpenedPane } from './mux.ts'
import { isReadTruncated } from './read-window.ts'
import { pollForOutput } from './wait-output.ts'

/**
 * Zellij backend — detected via `$ZELLIJ`. Drives Zellij's built-in multiplexer through `zellij
 * action …` (https://zellij.dev/documentation/cli-actions), the same synchronous-CLI shape tmux,
 * herdr and wezterm already give `Exec`.
 *
 * Requires **Zellij ≥ 0.45.0**. The whole per-pane-addressable surface this adapter stands on landed
 * in 0.44.0 (2026-03-23): `--pane-id` across the action verbs, `list-panes --json`, ids returned from
 * `new-pane`/`new-tab`, and `focus-pane-id` (0.44.1). Before that release Zellij's CLI was almost
 * entirely FOCUS-relative — no stable per-pane handle — and no faithful adapter was possible. On an
 * older binary these commands fail and the adapter surfaces the failure rather than silently
 * mis-targeting the focused pane.
 *
 * The floor moved from 0.44.1 to **0.45.0** (2026-08-20) for `--no-focus`, which is what lets this
 * backend answer `opensWithoutStealingFocus` at all. Raising it rather than keeping the old
 * focus-stealing path as a fallback, for four reasons that compound:
 *
 * - The seam member is a **static declaration**, like `canSizeSplits` and `canFloatPanes` — there is
 *   no runtime probe behind any of them. An adapter cannot declare `true` and then quietly degrade on
 *   an old binary without lying in precisely the way the declaration exists to prevent, and a
 *   conditional value has nowhere to live.
 * - Version-probing to decide would be a NEW behavior for this file, which reads no version anywhere,
 *   and would cost an exec on every open to pre-empt a failure zellij already reports precisely.
 * - A fallback would be a second code path that nothing here can ever exercise: there is no zellij on
 *   the machine this was written on, and the integration suite skips its rows without one (issue
 *   #125). Untested code guarding an untestable condition is a liability, not a safety net.
 * - The 0.44 failure is LOUD and creates nothing. Zellij's CLI parses in clap's strict mode (the
 *   v0.45.0 tree sets no `ignore_errors`, `allow_hyphen_values`, `allow_external_subcommands`, or
 *   `trailing_var_arg` anywhere in `zellij-utils/src/cli.rs`), so an unknown `--no-focus` is a parse
 *   error on stderr and a nonzero exit — surfaced by the `withReason` throw in `open`, which names the
 *   command. There is no silent wrong-pane for it to become, which is the one failure mode worth
 *   engineering against. tmux sets this precedent exactly: `new-pane` is declared unconditionally and
 *   an older binary fails with tmux's own `unknown command`.
 *
 * **The 0.45.0 surface is UNVERIFIED against a running binary** — read out of the v0.45.0 source tree
 * (`zellij-utils/src/cli.rs`, `zellij-server/src/route.rs`), not driven. Everything below attributed
 * to 0.44.3 was driven, and stays driven; the two claims are kept apart on purpose.
 *
 * Originally probed from the Zellij docs + CHANGELOG alone; now **driven against a live 0.44.3
 * binary** by `mux.zellij.integration.test.ts`, so the command shapes below carry the same
 * verified-against-a-real-binary claim `session.tmux.ts`/`session.herdr.ts` make. What the live probe
 * changed, and what a doc probe could not have known:
 *
 * - The id forms are confirmed and asymmetric: `new-pane` prints the PREFIXED `terminal_N`, while
 *   `list-panes --json` reports `id` as a BARE integer. `samePane` is what makes those the same pane,
 *   so it is load-bearing rather than defensive.
 * - That bare integer is NOT unique: a live session reports `id: 0` for both its suppressed
 *   `zellij:link` PLUGIN pane and its first terminal pane. The number is unique only within a kind,
 *   and `is_plugin` is what says which kind — so `listZellijPanes` qualifies every bare id to
 *   `terminal_N`/`plugin_N` before anything compares or reports it. Both prefixed forms are what
 *   `--pane-id` itself accepts, and a bare `N` addresses the TERMINAL pane (verified: renaming
 *   `--pane-id 3` renames terminal 3 and leaves plugin 3 alone), which is exactly the fold
 *   `normalizePaneId` makes.
 * - Which `list-panes --json` field names are real, and what each one carries. The label guard reads
 *   `terminal_command`, not `pane_command` — a doc probe had that one backwards; see `ZellijPane`.
 *   `pane_cwd` and `pane_command` are real too, and both are present ONLY on a terminal pane: a
 *   plugin pane's record omits the keys entirely, which is how a probe that sampled one concluded
 *   the fields did not exist at all. That is the failure mode of a doc probe, and the reason this
 *   file now has a suite.
 * - `new-pane --direction` requires an attached client focused on a TERMINAL pane, and fails
 *   SILENTLY without one — it prints a plausible new pane id and exits 0 having created nothing.
 *   Re-probed against 0.44.3 with the client parked on zellij's own release-notes PLUGIN pane, which
 *   is where a fresh attach lands: the split printed `terminal_2`, exited 0, and the pane count did
 *   not move. `open()` does not propagate that phantom — see `openedForPane`, which now believes a
 *   reported id only where it names a pane that was NOT already standing.
 * - **A `zellij action` reply can be delivered to the WRONG command**, and **a session no client has
 *   ever attached to reports `list-panes --json` as an empty ARRAY** rather than as an error. Both
 *   are the reason this file retries a listing instead of reading one empty answer as the truth; see
 *   `LIST_PANES_ATTEMPTS` for the repro behind the first and `mux.zellij.integration.test.ts`'s
 *   readiness gate for the second. So the older claim that every verb but `--direction` works against
 *   a client-less session is wrong: the listing is silent there, and everything in this file that
 *   resolves an id reads the listing.
 *
 * Real capability shape that fell out of the probe:
 *
 * - **The session is the workspace tier, but a SEPARATE session's panes are un-addressable through
 *   this seam.** Zellij's native tiers are Session › Tab › Pane, so a `workspace` placement would
 *   naturally open a new session (`zellij attach --create-background`). But Zellij pane ids are
 *   SESSION-SCOPED — driving another session's pane requires `zellij --session <name> action …` — and
 *   `MuxTarget` carries only an opaque pane id, no session. A pane returned from a freshly-created
 *   session would therefore fail on the next `write`/`read`/`focus`, which is a trap, not a feature.
 *   So this adapter operates within the AMBIENT session: `workspace` collapses to a new **tab**, the
 *   same collapse tmux makes for a Window. Unlike tmux, the occupied workspace IS reported —
 *   `OpenedPane.workspace` carries the ambient session name (`deps.session`), because every pane
 *   genuinely lives in that session. (Lifting the collapse needs a seam change: a session qualifier
 *   on `MuxTarget`. Recorded in the ADR log.)
 * - **No `--env` on `new-pane`/`new-tab`.** Like wezterm, env is native at no tier, so every open
 *   rides the `envFallback` compensation (an `env K=V` prefix on the launch command, or a stderr
 *   warning when there is no command to ride).
 * - **Tiled splits cannot be sized.** `new-pane`'s `-x/-y/--width/--height` all require `--floating`;
 *   a tiled `pane:*` split is always even. So `canSizeSplits` is omitted and a `ratio` is dropped —
 *   callers degrade to the even default, the same path the flag's absence already documents.
 * - **`new-pane` has no split-TARGET flag.** It splits the focused pane (or the biggest space); the
 *   only flag is `--tab-id`. So `from` — which pane a `pane:*` split lands beside — is honored by
 *   FOCUSING that pane first, the sole way to choose the split target. That is still a real focus
 *   move; what changed in 0.45.0 is that it is now UNDONE, not that it stopped happening. See
 *   `opensWithoutStealingFocus`, and `open` for why `--no-focus` cannot be the answer on that path —
 *   it re-anchors the split on the ISSUING pane and would make the focus move pointless and the target
 *   wrong.
 * - **No pane geometry adapter.** `list-panes --json` does report `pane_x`/`pane_y`, so `regions`
 *   (`describeRegion`/`describeWorkspace`) is IMPLEMENTABLE here — unlike wezterm, which lacks
 *   position entirely — but the cell-vs-divider semantics of Zellij's rects need a live binary to pin,
 *   so it is deliberately left as a follow-up rather than guessed. `template save` refuses on zellij
 *   by naming the backend, the same optional-absence it already handles for wezterm.
 * - **No git-worktree concept in the CLI.** No `worktree` subcommand, so — like tmux and wezterm —
 *   this backend never binds one to a workspace; callers fall back to plain git plus `open()`.
 *
 * Wins Zellij has that wezterm does not: it CAN name a pane (`new-pane --name` / `rename-pane`), and
 * it CAN report which pane is focused (`list-panes --json`'s `is_focused`), so `isPaneFocused`
 * answers a real value rather than always `unknown`.
 */
/**
 * Build the Zellij adapter over its injected effects. The only effect it takes is `session` — the
 * ambient Zellij session name (`$ZELLIJ_SESSION_NAME`), reported as `OpenedPane.workspace` so a
 * caller learns which workspace a new pane landed in. Undefined when unknown (the exported singleton),
 * in which case `workspace` is simply omitted — the same absent-not-false convention the seam uses
 * elsewhere. Exported as a factory (with `zellijMuxAdapter` binding the effect-less one) so
 * `backend.ts` can bind the real session name off `env` at resolution, exactly the seam `Exec` and
 * wezterm's `newId` already are.
 */
export function createZellijAdapter(deps: { session?: string | undefined }): MuxAdapter {
	const adapter: MuxAdapter = {
		name: 'zellij',

		// No `canSizeSplits`: a tiled split is always even — `new-pane`'s size flags all require
		// `--floating`, so there is nothing to honor a `ratio` with. Its absence is what callers degrade
		// against.

		// `new-pane --floating` opens a pane above the tiled layout — Zellij's oldest and most native
		// floating-pane surface, and the reason the `-x/-y/--width/--height` flags exist at all (they
		// REQUIRE `--floating`, which is what leaves a tiled split unsizable here). Per-pane addressing
		// of the result is 0.44's, the same release this whole adapter already requires.
		canFloatPanes: true,

		/**
		 * Every route this adapter can take ends with the caller's focus where it started, which is the
		 * end-state the seam declares — NOT "focus never moves at any instant", which zellij cannot offer
		 * on the one route that has to choose a split target. Two different mechanisms get there, and
		 * which one applies is decided by whether `from` was named:
		 *
		 * - **No target to choose** (`new-tab`, and `new-pane` with no `from`): `--no-focus`, and nothing
		 *   moves at all. Zellij 0.45.0's flag, on the verbs this adapter uses.
		 * - **A named `from`**: focus it, split it, then focus back to the pane that was focused before —
		 *   a real, visible round trip. `--no-focus` is deliberately NOT passed here; see `open`, where
		 *   passing it would silently split the WRONG pane.
		 *
		 * **Unverified against a running zellij.** There is no zellij binary on the machine this was
		 * written on, and this repo's zellij integration suite SKIPS every row without one (issue #125),
		 * so a green suite is not evidence here. `--no-focus` was read out of the v0.45.0 source tree
		 * (`zellij-utils/src/cli.rs`, the `no_focus: bool` field on `CliAction::NewPane`/`NewTab`), not
		 * off a live `--help`. The restore half is on firmer ground: `focus-pane-id` and `list-panes
		 * --json`'s `is_focused` are both already driven against a live 0.44.3 by the integration suite.
		 * The same disclaimer `mux.wezterm.ts` and `mux.cmux.ts` carry applies to the flag itself.
		 */
		opensWithoutStealingFocus: true,

		open(exec, opts) {
			const at = opts.at ?? 'tab'
			// `workspace` and `tab` both open a new TAB in the ambient session — the collapse forced by
			// session-scoped pane ids plus a session-less `MuxTarget` (see the header). tmux makes the
			// same collapse onto a Window; the one difference is that `workspace` is still reported here.
			if (at === 'tab' || at === 'workspace') {
				// `--no-focus` (0.45.0) opens the tab without moving any client — tmux's `new-window -d` and
				// herdr's `tab create --no-focus`, finally spellable here. A new tab chooses no target, so
				// this route needs nothing else to leave focus alone.
				const args = ['action', 'new-tab', '--no-focus', '--cwd', opts.cwd]
				// `--name` names the tab at birth — native, unlike wezterm's post-birth `set-tab-title`.
				if (opts.label) args.push('--name', opts.label)
				// The pane ids standing BEFORE the command, which is what makes the id it reports checkable:
				// zellij's reply can arrive empty or carry the PREVIOUS command's payload (see
				// `openedForTab`), and only a pane that was not already there can be the one this open made.
				const before = paneIdSet(exec)
				const out = exec('zellij', args)
				if (out === null) throw new Error(withReason(exec, 'zellij action new-tab failed'))
				// `new-tab` reports the TAB id, not a pane id; the tab's own initial pane is the
				// `list-panes` record carrying that `tab_id` and absent from `before`.
				const opened = openedForTab(exec, out.trim(), before, deps.session)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}
			// pane:right / pane:down / pane:float — all three are `new-pane`, which has no target flag
			// beyond `--tab-id`. That single missing flag is what forks this whole branch in two, because
			// zellij 0.45.0's `--no-focus` does not merely suppress the new pane's activation: it also
			// REPLACES how the target is chosen. From the v0.45.0 source (`zellij-server/src/route.rs`,
			// `new_pane_routing`), a `--no-focus` open resolves its anchor as `--tab-id` if given, else the
			// pane named by `$ZELLIJ_PANE_ID` — the pane the command was ISSUED from, which the flag's own
			// help text says out loud — and only failing both, the client's current pane. The focused pane
			// is not consulted.
			//
			// So the two halves of `from` support and `--no-focus` are mutually exclusive here, and it is
			// not a matter of ordering: focusing a pane and then passing `--no-focus` splits the pane
			// cyber-mux is RUNNING IN, reports a plausible id for it, and exits 0. That is the silent
			// wrong-pane failure this adapter is built to refuse, so `--no-focus` is passed only where
			// there is no target to choose.
			//
			// (Impersonating the issuing pane — `ZELLIJ_PANE_ID=<from> zellij action new-pane --no-focus` —
			// would get both at once, and is not available: `Exec` runs a command and args, with no env, by
			// construction. Reaching for it would widen the seam every adapter shares to buy one backend an
			// undocumented internal.)
			//
			// One `list-panes` serves both jobs below, taken BEFORE anything else happens: the id set is
			// the open's BEFORE side (see `openedForPane` — the id zellij prints is only believable once it
			// names a pane that was not already standing), and `is_focused` is where focus has to be put
			// back. Listing first also means the reading predates the focus move, which is the only moment
			// it is the answer we want.
			const standing = listZellijPanes(exec)
			const before = new Set(standing.map((pane) => normalizePaneId(pane.id)))
			// Undefined when no pane reports focus — a session no client has attached to answers exactly
			// that (see the header). Nothing to restore then, and nothing was stolen either.
			const focusedBefore = standing.find((pane) => pane.is_focused === true)
			const restoreTo = focusedBefore ? normalizePaneId(focusedBefore.id) : undefined
			// `from` is honored by focusing that pane FIRST — still the sole way to choose which pane a
			// split lands beside, and for a float how it lands over the caller's REGION rather than the one
			// the user is looking at. That focus move is now UNDONE at the end of this branch rather than
			// left standing, which is the whole of what changed.
			if (opts.from) adapter.focus(exec, opts.from)
			// `--floating` and `--direction` are mutually exclusive by construction: a float sits above the
			// layout, so there is no side of anything for it to be on. `ratio` is dropped on BOTH paths
			// here — a tiled split cannot be sized at all (see `canSizeSplits`), and a float has no
			// original pane whose fraction it could be (see `MuxOpenOptions.ratio`).
			const placement = at === 'pane:float' ? ['--floating'] : ['--direction', at === 'pane:down' ? 'down' : 'right']
			// `--no-focus` ONLY with no `from` to honor. There it is strictly better than the focus dance
			// below: nothing moves at any instant, and the anchor it picks — the issuing pane — is a
			// sharper default than "whatever the user happens to be looking at". That IS a change to this
			// backend's no-`from` default, and the seam permits it: `MuxOpenOptions.from` specifies that
			// omitting it means "whatever this backend defaults to" and that the defaults differ per
			// backend, which is exactly why it tells callers to pass it.
			const focusFlag = opts.from ? [] : ['--no-focus']
			const args = ['action', 'new-pane', ...placement, ...focusFlag, '--cwd', opts.cwd]
			// `--name` names the pane at birth — Zellij can title a pane, unlike wezterm.
			if (opts.label) args.push('--name', opts.label)
			const out = exec('zellij', args)
			if (out === null) throw new Error(withReason(exec, 'zellij action new-pane failed'))
			const opened = openedForPane(exec, out.trim(), before, deps.session)
			// Put focus back where the open found it. Only on the `from` path — the other one never moved
			// it — and only when a pane actually reported focus.
			//
			// `focus-pane-id`, NOT 0.45.0's `focus-last-pane`, and the choice is forced rather than
			// stylistic. `focus-last-pane` restores the previously-focused pane WITHIN THE ACTIVE TAB
			// (v0.45.0 `screen.rs` dispatches it under `active_tab_and_connected_client_id!`), and `from`
			// is free to live in another tab — this adapter's own `focus` exists because zellij pane ids
			// cross tabs. It also reads a focus history one entry deep, and the sequence here makes two
			// moves, so even within one tab it would land on `from` rather than on the caller. An explicit
			// id has neither limit, and it is a primitive already driven against a live 0.44.3.
			if (opts.from && restoreTo) exec('zellij', ['action', 'focus-pane-id', restoreTo])
			runLaunch(adapter, exec, opened, opts.env, opts.launch)
			return opened
		},

		rename(exec, target, tier, name) {
			if (tier === 'tab') {
				// `rename-tab-by-id` names a tab by id without visiting it — the read-only side effects a
				// rename promises. (`rename-tab` alone would target the focused tab.)
				exec('zellij', ['action', 'rename-tab-by-id', target.id, name])
				return
			}
			// `rename-pane --pane-id` names a specific pane by id — no focus move, unlike the bare
			// `rename-pane` which renames the focused pane.
			exec('zellij', ['action', 'rename-pane', '--pane-id', target.id, name])
		},

		group() {
			// A complete no-op, herdr/wezterm-style, and for the same reason: Zellij's session is a real
			// workspace tier that already groups every tab in it — that grouping is exactly what
			// `OpenedPane.workspace` reports. The grouping TAG (`MuxOpenOptions.workspaceGroup`) exists for
			// a backend with NO workspace tier to hold one in (tmux, via a window option). Zellij has no
			// per-tab opaque metadata store to stash a finer tag in AND has a real tier, so there is
			// nothing for this to add. The granularity is the whole session, coarser than a per-caller
			// tag, matching wezterm's per-window answer.
		},

		sendText(exec, target, text) {
			// `write-chars` types the literal characters with NO trailing newline — the literal-text-no-
			// Enter guarantee. Literal means literal: text that names a key (`Enter`) is typed as those
			// characters, never pressed. That is why this is its own verb, not a mode of `sendKeys`.
			exec('zellij', ['action', 'write-chars', '--pane-id', target.id, text])
		},

		sendKeys(exec, target, keys) {
			// `send-keys` names each key in Zellij's own vocabulary (`Enter`, `Ctrl c`, `F1`), one key per
			// argument. A core token is renamed to its Zellij spelling (`Escape`→`Esc`, `C-c`→`Ctrl c`);
			// anything outside the core is forwarded verbatim — the seam's passthrough — reaching a
			// backend-specific key at the cost of portability. `Enter` is a key like any other here: this
			// presses it because the caller asked; it never ADDS one (that is `submit`'s job).
			exec('zellij', ['action', 'send-keys', '--pane-id', target.id, ...keys.map(toZellijKey)])
		},

		submit(exec, target, text) {
			// No atomic literal-text-plus-Enter primitive, so this composes exactly as tmux/wezterm do:
			// the bare-flush case presses Enter alone, typing nothing (flushing a staged buffer without
			// re-typing it); otherwise the literal text first, then Enter as its own key.
			if (!text) {
				adapter.sendKeys(exec, target, ['Enter'])
				return
			}
			adapter.sendText(exec, target, text)
			adapter.sendKeys(exec, target, ['Enter'])
		},

		read(exec, target, opts?: MuxReadOptions | undefined) {
			// `dump-screen` with no file path writes the pane's viewport to stdout. There is no
			// "last N lines" primitive, so a `lines` request dumps the full scrollback (`--full`) and keeps
			// the trailing N — the closest Zellij offers to tmux's `-S -N`, not guaranteed to line up
			// cell-for-cell.
			// `--full` IS Zellij's all-history spelling, so an unbounded window is its own primitive rather
			// than a trimmed one — and nothing was omitted from it by construction.
			if (opts?.lines === 'all') {
				const text = exec('zellij', ['action', 'dump-screen', '--pane-id', target.id, '--full']) ?? ''
				return opts.truncation ? { text, truncated: false } : { text }
			}
			if (opts?.lines != null) {
				const full = exec('zellij', ['action', 'dump-screen', '--pane-id', target.id, '--full']) ?? ''
				const text = lastLines(full, opts.lines)
				// The one backend whose truncation answer costs NO extra query: a `lines` read already holds
				// the whole scrollback, and the rows this dropped off the top are exactly the rows omitted.
				// Same rule as everywhere else (`isReadTruncated`), just with the deeper read already in hand.
				return opts.truncation ? { text, truncated: isReadTruncated(text, full) } : { text }
			}
			const text = exec('zellij', ['action', 'dump-screen', '--pane-id', target.id]) ?? ''
			if (!opts?.truncation) return { text }
			// A bare read is the viewport, so the deeper read is the full scrollback — Zellij has no
			// "viewport plus one row" form, and taking the whole dump answers the same question: more rows
			// than the viewport means rows sit above it.
			const full = exec('zellij', ['action', 'dump-screen', '--pane-id', target.id, '--full']) ?? ''
			return { text, truncated: isReadTruncated(text, full) }
		},

		// No wait-for-output primitive in `zellij action` — it dumps a screen and never blocks on what is
		// on it. So the wait is the shared poll over this adapter's own read; see `pollForOutput`. The
		// `lines` caveat `read` documents rides along unchanged: a `lines` wait searches the trailing N of
		// a full-scrollback dump, which is Zellij's closest approximation, not a cell-exact viewport.
		waitForOutput(exec, target, opts) {
			return pollForOutput(adapter, exec, target, opts)
		},

		focus(exec, target) {
			// `focus-pane-id` focuses a specific pane by id, crossing tabs to reach it — the one primitive
			// whose name is exactly this method's intent (added in 0.44.1).
			exec('zellij', ['action', 'focus-pane-id', target.id])
		},

		teardown(exec, target) {
			exec('zellij', ['action', 'close-pane', '--pane-id', target.id])
		},

		paneExists(exec, target) {
			return listZellijPanes(exec).some((p) => samePane(p.id, target.id))
		},

		isPaneFocused(exec, target) {
			// `list-panes --json` carries `is_focused` per pane — a real focus primitive, unlike wezterm's
			// always-`unknown`. Unresolvable (no matching record) answers `undefined`, never a false
			// `false`: a caller cannot tell "not focused" from "pane gone" here, and fails OPEN on
			// `undefined`.
			const found = listZellijPanes(exec).find((p) => samePane(p.id, target.id))
			if (!found) return undefined
			return found.is_focused === true
		},

		listPanes(exec): LivePane[] {
			return listZellijPanes(exec).map((p) => {
				// `is_floating` read strictly: only a literal `true` floats, so a record missing the key
				// (an older zellij, or a shape this adapter did not verify) reports the tiled answer
				// rather than a truthy accident.
				const pane: LivePane = { id: p.id, mux: 'zellij' as const, floating: p.is_floating === true }
				// `pane_cwd` is the pane's own working directory, and it rides the listing call this adapter
				// already makes — so cwd costs zellij no second exec. Absent on a plugin pane, which has no
				// working directory to report; omitted then rather than reported as a wrong or empty one,
				// the same absent-not-false convention the rest of `LivePane` follows.
				if (p.pane_cwd) pane.cwd = p.pane_cwd
				// A pane's title CAN be an authored name here (`new-pane --name` / `rename-pane`), unlike
				// wezterm. But Zellij defaults an unnamed pane's title to its running command, so a title
				// equal to `terminal_command` is ambient rather than chosen — dropped the same way tmux drops
				// a title equal to the hostname, so every shell pane does not resolve to one manufactured name.
				const label = zellijLabel(p.title, p.terminal_command)
				if (label) pane.label = label
				return pane
			})
		},

		// No `regions`: geometry is scoped out of this adapter — see the header. `template save` refuses
		// on zellij by naming the backend, the same optional-absence it handles for wezterm.

		// No `worktree`: Zellij has no `worktree` subcommand, so — like tmux and wezterm — it never binds
		// a git worktree to a workspace; callers fall back to plain git plus `open()`.
	}
	return adapter
}

export const zellijMuxAdapter: MuxAdapter = createZellijAdapter({})

/** One pane record from `zellij action list-panes --json`, the fields this adapter reads. */
interface ZellijPane {
	id: string
	tab_id?: number | string | undefined
	title?: string | undefined
	is_focused?: boolean | undefined
	/**
	 * Whether the pane floats above the tiled layout — `is_floating`. Free: it rides the `list-panes
	 * --json` call this adapter already makes, so `LivePane.floating` costs zellij no second exec.
	 *
	 * Verified against a live 0.44.3, not just against the recorded key dump, and the distinction
	 * mattered: a key existing in zellij's pane schema would not by itself prove that a FLOATING pane
	 * appears in the collection `list-panes` returns. It does — a `new-pane --floating` shows up in
	 * the same flat array as the tiled panes, carrying `is_floating: true`, which is what
	 * `mux.zellij.integration.test.ts` pins at the real boundary.
	 */
	is_floating?: boolean | undefined
	/**
	 * Whether this record is a PLUGIN pane rather than a terminal one — `is_plugin`. Load-bearing for
	 * identity, not decoration: zellij numbers plugin panes and terminal panes in separate spaces, so
	 * `id` alone is ambiguous (a live session reports `0` for both its `zellij:link` plugin pane and
	 * its first terminal pane). This is what `zellijPaneId` qualifies a bare id with.
	 */
	is_plugin?: boolean | undefined
	/**
	 * The pane's working directory — `pane_cwd`, the field `LivePane.cwd` is filled from. Present and
	 * populated on a TERMINAL pane's record; a plugin pane's record omits the key entirely, which is
	 * what an earlier probe — sampling a plugin pane — read as "there is no cwd field on 0.44.3".
	 * There is; see `mux.zellij.integration.test.ts`, which reads it back off a pane it opened at a
	 * known directory.
	 */
	pane_cwd?: string | undefined
	/**
	 * The command a terminal pane is running — `terminal_command`, NOT `pane_command`. Verified
	 * against a live 0.44.3 `list-panes --json`; the original doc probe read the wrong name, which
	 * silently disabled the ambient-title guard in `zellijLabel` (every unnamed pane exported its own
	 * command as an authored label). `null` for a plugin pane and for a pane running a plain shell.
	 *
	 * `pane_command` is a SEPARATE, also-real key rather than the wrong spelling of this one — it
	 * carries the shell (`/usr/bin/zsh`) where `terminal_command` is null. This guard wants the one
	 * that is null for a shell: a shell pane's title is `Pane #N`, which is nobody's authored name
	 * either way, while a `zellij action new-pane -- sleep 300` pane titles itself `sleep 300` and
	 * both fields carry it. Nothing reads `pane_command` here, so it is named rather than parsed.
	 */
	terminal_command?: string | undefined
}

/**
 * How many times a listing is re-asked before it is reported as empty, and how many times an open
 * re-looks for the pane it just made.
 *
 * Both exist for ONE verified defect in zellij 0.44.3's CLI, which no amount of adapter care can
 * prevent and every verb here rides on: **a `zellij action` reply can be delivered to the wrong
 * command.** Driven under CPU contention, a command exits 0 having printed NOTHING, and the reply it
 * should have received arrives on the stdout of the command issued after it. Reproduced by
 * alternating `new-tab` and `list-panes --json` 40 times on a loaded 2-core box — twice in 40, the
 * `new-tab` printed an empty string and the `list-panes` that followed it printed `27`. Two hundred
 * back-to-back `list-panes --json` calls with no mutating verb between them lost nothing, so it is
 * the mutating verbs that open the window.
 *
 * The consequences land squarely here. An empty reply to `list-panes --json` is not an empty session
 * — a live zellij session always has at least one pane — so reading it as one made every id
 * resolution in this file fail at once. And an id printed by `new-pane`/`new-tab` may belong to the
 * PREVIOUS command, so it can name a pane that has been standing all along.
 *
 * A retry is the honest remedy because the loss is per-call and independent: the same read reissued
 * answers. These are ceilings on a wedged server, not a wait that decides a pass.
 *
 * What a retry CANNOT reach, stated so a caller knows the edge: a misdelivered reply may also be a
 * valid pane array — an older one, which simply does not carry a pane opened since. Nothing in the
 * shape of that answer marks it stale, so `listPanes` cannot reject it and a single negative read
 * (`paneExists`, `isPaneFocused`) can be wrong. A caller that needs certainty on this backend re-asks;
 * `mux.zellij.integration.test.ts` does exactly that.
 */
const LIST_PANES_ATTEMPTS = 3
const OPEN_RESOLVE_ATTEMPTS = 10

/**
 * One `zellij action list-panes --json` read, parsed defensively — `undefined` for output that is not
 * a pane array, so a caller can tell "zellij did not answer" from "zellij answered, with no panes".
 * Every id is QUALIFIED on the way out (see `zellijPaneId`), so what this returns — and therefore
 * what `LivePane.id` carries and what `samePane` compares — names exactly one live pane.
 */
function readZellijPanes(exec: Exec): ZellijPane[] | undefined {
	const out = exec('zellij', ['action', 'list-panes', '--json'])
	if (!out) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return undefined
	}
	if (!Array.isArray(parsed)) return undefined
	return parsed
		.filter((p): p is ZellijPane => p != null && (p as ZellijPane).id != null)
		.map((p) => ({ ...p, id: zellijPaneId(p.id, p.is_plugin) }))
}

/**
 * The id a listing record is reported under — qualified by KIND, because zellij's bare number is not
 * unique. Plugin panes and terminal panes are numbered in separate spaces, so a live session reports
 * `id: 0` for both its suppressed `zellij:link` plugin pane and its first terminal pane; reporting
 * both as `'0'` collapsed two genuinely different panes onto one `LivePane.id`, and every resolution
 * by id — `paneExists`, `isPaneFocused`, and `openedForPane`'s guard against a phantom `new-pane`
 * result — could then land on the wrong one.
 *
 * A bare integer therefore takes the `terminal_`/`plugin_` prefix its `is_plugin` names, which is the
 * form `new-pane` already prints and the form `--pane-id` accepts for BOTH kinds (verified against a
 * live 0.44.3). An id that already carries a prefix is left exactly as it is — this qualifies what
 * zellij left ambiguous, it does not rewrite what zellij spelled out.
 *
 * A record with no `is_plugin` at all is read as a terminal pane: that is the same answer
 * `normalizePaneId` gives a bare id, and the kind zellij's own bare-id addressing resolves to.
 */
function zellijPaneId(id: unknown, isPlugin: boolean | undefined): string {
	const raw = String(id)
	if (!/^\d+$/.test(raw)) return raw
	return isPlugin === true ? `plugin_${raw}` : `terminal_${raw}`
}

/**
 * The session's panes — never throws on bad output, and never reports a LOST reply as an empty
 * session. A read that did not come back as a pane array is simply re-asked (`LIST_PANES_ATTEMPTS`);
 * only a session that refuses every time answers `[]`, which is then a real answer rather than a
 * dropped one. See `LIST_PANES_ATTEMPTS` for the defect this stands in front of.
 */
function listZellijPanes(exec: Exec): ZellijPane[] {
	for (let attempt = 1; attempt <= LIST_PANES_ATTEMPTS; attempt++) {
		const panes = readZellijPanes(exec)
		if (panes) return panes
	}
	return []
}

/**
 * The panes standing right now, keyed the way `samePane` compares them — an open's BEFORE side. A
 * pane already in this set cannot be the one the open just made, which is the whole check.
 */
function paneIdSet(exec: Exec): ReadonlySet<string> {
	return new Set(listZellijPanes(exec).map((p) => normalizePaneId(p.id)))
}

/**
 * The TERMINAL panes that appeared since `before` — the only candidates an open can have made.
 *
 * Plugin panes are excluded because zellij loads them on its own schedule, not the caller's: a tab
 * opened by `new-tab` can be carrying a plugin pane in the same listing as its own initial pane, and
 * that plugin record can sort FIRST. Resolving an open to it hands the caller a `plugin_N` — an id
 * that exists, so nothing downstream refuses it, and that then answers nothing a pane is asked. Seen
 * at the real boundary: an `open()` at `tab` returned `plugin_15`, and the `rename()` that followed
 * renamed a pane the caller never opened. `new-tab` and `new-pane` both create a TERMINAL pane, so
 * the kind is the discriminator, and `is_plugin` is the field that carries it.
 */
function appearedTerminals(exec: Exec, before: ReadonlySet<string>): ZellijPane[] {
	return listZellijPanes(exec).filter((p) => p.is_plugin !== true && !before.has(normalizePaneId(p.id)))
}

/**
 * The `OpenedPane` for a pane `new-pane` just made — resolved against the listing rather than taken
 * on the word of the id zellij printed, because that word is not reliable (see
 * `LIST_PANES_ATTEMPTS`): the reply may be empty, or may be the PREVIOUS command's, in which case
 * `paneId` names a pane that has been standing all along.
 *
 * So the id is believed only where it names a pane ABSENT from `before` — the phantom guard this file
 * has always meant to be, now closed. Where it cannot be believed, the session itself answers: a
 * single pane that appeared over this open is unambiguous, and adopting it recovers a reply zellij
 * lost instead of failing an open that genuinely happened. That fallback waits one round, so a
 * printed id that is merely SLOW to appear still wins over a guess.
 *
 * Throws rather than guessing a tab: `OpenedPane.tab` is required (every multiplexer has the Tab
 * level), and a wrong tab is worse than a loud failure.
 */
function openedForPane(
	exec: Exec,
	paneId: string,
	before: ReadonlySet<string>,
	session: string | undefined,
): OpenedPane {
	for (let attempt = 1; attempt <= OPEN_RESOLVE_ATTEMPTS; attempt++) {
		const appeared = appearedTerminals(exec, before)
		const claimed = paneId ? appeared.find((p) => samePane(p.id, paneId)) : undefined
		if (claimed?.tab_id != null) return openedPane(paneId, String(claimed.tab_id), session)
		const only = appeared.length === 1 ? appeared[0] : undefined
		if ((attempt > 1 || !paneId) && only?.tab_id != null) return openedPane(only.id, String(only.tab_id), session)
	}
	throw new Error(
		paneId
			? `zellij did not report a tab for the new pane ${paneId}`
			: 'zellij action new-pane did not report the new pane id, and no new pane appeared',
	)
}

/**
 * The `OpenedPane` for a tab `new-tab` just made — its initial pane resolved as the `list-panes`
 * record that carries that tab id AND was not already standing. Same reply-delivery defect, same
 * shape of answer as `openedForPane`: a `tabId` that names a tab whose panes all predate the open is
 * a stale reply, not this tab, and a single pane that appeared over the open answers when the id
 * cannot.
 *
 * Throws rather than guessing: a new tab must have a pane, and a caller handed a tab with no pane
 * could neither drive nor name it.
 */
function openedForTab(exec: Exec, tabId: string, before: ReadonlySet<string>, session: string | undefined): OpenedPane {
	for (let attempt = 1; attempt <= OPEN_RESOLVE_ATTEMPTS; attempt++) {
		const appeared = appearedTerminals(exec, before)
		const claimed = tabId ? appeared.find((p) => p.tab_id != null && String(p.tab_id) === tabId) : undefined
		if (claimed) return openedPane(claimed.id, tabId, session)
		const only = appeared.length === 1 ? appeared[0] : undefined
		if ((attempt > 1 || !tabId) && only?.tab_id != null) return openedPane(only.id, String(only.tab_id), session)
	}
	throw new Error(
		tabId
			? `zellij did not report a pane in the new tab ${tabId}`
			: 'zellij action new-tab did not report the new tab id, and no new pane appeared',
	)
}

/**
 * Assemble an `OpenedPane`, attaching `workspace` only when the ambient session name is known — the
 * absent-not-false convention. Every Zellij pane genuinely lives in a session, so where the name IS
 * known this is never absent, on every placement including `pane:*`; where it is not (the effect-less
 * singleton), it is omitted rather than reported as a false "none".
 */
function openedPane(id: string, tab: string, session: string | undefined): OpenedPane {
	const opened: OpenedPane = { id, tab }
	if (session) opened.workspace = session
	return opened
}

/**
 * Env is native at NO tier on this backend — `new-pane`/`new-tab` take no `--env`, like wezterm. So
 * every `open` funnels through the same fallback herdr's worktree route uses: with a launch command,
 * env rides in as an `env K=V` prefix; with none, a warning names what did not land. `envFallback` is
 * a no-op when there is no env to carry, so this is safe to call unconditionally.
 */
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
			`env (${fallback.variables.join(', ')}) could not be set on this zellij pane — ` +
				'zellij has no --env flag on new-pane/new-tab\n',
		)
		return
	}
	if (fallback.command !== undefined) adapter.submit(exec, target, fallback.command)
}

/**
 * The core key vocabulary's Zellij spelling — a rename table, NOT a validation table: a token outside
 * the core is forwarded verbatim (the seam's passthrough), so this must not reject what it does not
 * recognize. Only the two members that differ from the core name are listed; `Up` `Down` `Left`
 * `Right` `Enter` `Tab` `Space` `Backspace` `F1`–`F12` are already Zellij's own names. Probed from
 * Zellij's key-binding vocabulary in the docs, not verified against a live `send-keys`:
 *
 * - `Escape` → `Esc`: Zellij's key name for that key is `Esc`.
 * - `C-c` → `Ctrl c`: Zellij writes a modified key as space-separated words (`"Ctrl a"`, `"Alt Shift
 *   b"`), so the whole `Ctrl c` is one argument — the modifier and key are not two keys.
 */
const ZELLIJ_KEY_RENAMES: Readonly<Record<string, string>> = { Escape: 'Esc', 'C-c': 'Ctrl c' }

function toZellijKey(key: string): string {
	return ZELLIJ_KEY_RENAMES[key] ?? key
}

/**
 * A Zellij pane's label — its title, unless that title is the running command Zellij handed an unnamed
 * pane. Zellij defaults an unnamed pane's title to its `terminal_command`, so a title equal to it is
 * ambient rather than chosen; exporting it would put the same manufactured name on every shell pane,
 * exactly the collision tmux's hostname guard exists to prevent. A title that differs from the command
 * is one someone set (`new-pane --name`/`rename-pane`), so it is the author's and survives.
 */
function zellijLabel(title: string | undefined, command: string | undefined): string | undefined {
	return title && title !== command ? title : undefined
}

/**
 * Normalize a pane id to a single canonical form for comparison. Per the Zellij docs a bare integer
 * `N` is the same terminal pane as `terminal_N`; `plugin_N` is a distinct space. So a bare id is
 * folded to its `terminal_` form and everything else is left as-is — a comparison-only transform,
 * never stored (`MuxTarget.id` stays whatever the backend reported).
 */
function normalizePaneId(id: string): string {
	return /^\d+$/.test(id) ? `terminal_${id}` : id
}

/** Whether two pane ids name the same pane, treating a bare `N` and its `terminal_N` twin as equal. */
function samePane(a: string, b: string): boolean {
	return normalizePaneId(a) === normalizePaneId(b)
}

/** The last `n` lines of `text` — `read`'s client-side approximation of a trailing-lines capture. */
function lastLines(text: string, n: number): string {
	const lines = text.split('\n')
	return lines.slice(Math.max(0, lines.length - n)).join('\n')
}
