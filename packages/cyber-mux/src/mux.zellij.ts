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
 * Requires **Zellij ≥ 0.44.1**. The whole per-pane-addressable surface this adapter stands on landed
 * in 0.44.0 (2026-03-23): `--pane-id` across the action verbs, `list-panes --json`, ids returned from
 * `new-pane`/`new-tab`, and `focus-pane-id`. Before that release Zellij's CLI was almost entirely
 * FOCUS-relative — no stable per-pane handle — and no faithful adapter was possible. On an older
 * binary these commands fail and the adapter surfaces the failure rather than silently mis-targeting
 * the focused pane.
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
 *   `open()` does not propagate that phantom: `openedForPane` cannot find the id in `list-panes` and
 *   throws. Every other verb here works against a session with no client attached.
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
 *   FOCUSING that pane first, the sole way to choose the split target. That is a real focus move, and
 *   the honest cost of getting the RIGHT pane split.
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

		open(exec, opts) {
			const at = opts.at ?? 'tab'
			// `workspace` and `tab` both open a new TAB in the ambient session — the collapse forced by
			// session-scoped pane ids plus a session-less `MuxTarget` (see the header). tmux makes the
			// same collapse onto a Window; the one difference is that `workspace` is still reported here.
			if (at === 'tab' || at === 'workspace') {
				const args = ['action', 'new-tab', '--cwd', opts.cwd]
				// `--name` names the tab at birth — native, unlike wezterm's post-birth `set-tab-title`.
				if (opts.label) args.push('--name', opts.label)
				const out = exec('zellij', args)
				if (!out) throw new Error(withReason(exec, 'zellij action new-tab failed'))
				const tabId = out.trim()
				if (!tabId) throw new Error('zellij action new-tab did not report the new tab id')
				// `new-tab` reports the TAB id, not a pane id; the tab's own initial pane is the single
				// `list-panes` record carrying that `tab_id`.
				const opened = openedForTab(exec, tabId, deps.session)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}
			// pane:right / pane:down / pane:float — all three are `new-pane`, which has no target flag
			// beyond `--tab-id`, so `from` is honored by focusing that pane FIRST. For a split that is the
			// only way to choose which pane it lands beside; for a float it is how the float lands over the
			// caller's REGION rather than the one the user is looking at — the same anchor one tier up.
			// Omitted `from` takes whatever is focused, the backend default the seam documents (never
			// silently "the caller's pane").
			if (opts.from) adapter.focus(exec, opts.from)
			// `--floating` and `--direction` are mutually exclusive by construction: a float sits above the
			// layout, so there is no side of anything for it to be on. `ratio` is dropped on BOTH paths
			// here — a tiled split cannot be sized at all (see `canSizeSplits`), and a float has no
			// original pane whose fraction it could be (see `MuxOpenOptions.ratio`).
			const placement = at === 'pane:float' ? ['--floating'] : ['--direction', at === 'pane:down' ? 'down' : 'right']
			const args = ['action', 'new-pane', ...placement, '--cwd', opts.cwd]
			// `--name` names the pane at birth — Zellij can title a pane, unlike wezterm.
			if (opts.label) args.push('--name', opts.label)
			const out = exec('zellij', args)
			if (!out) throw new Error(withReason(exec, 'zellij action new-pane failed'))
			const paneId = out.trim()
			if (!paneId) throw new Error('zellij action new-pane did not report the new pane id')
			const opened = openedForPane(exec, paneId, deps.session)
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
 * One `zellij action list-panes --json` call, parsed defensively — never throws on bad output. Every
 * id is QUALIFIED on the way out (see `zellijPaneId`), so what this returns — and therefore what
 * `LivePane.id` carries and what `samePane` compares — names exactly one live pane.
 */
function listZellijPanes(exec: Exec): ZellijPane[] {
	const out = exec('zellij', ['action', 'list-panes', '--json'])
	if (!out) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
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
 * The `OpenedPane` for a pane `new-pane` just reported — its tab resolved from the one `list-panes`
 * record carrying that pane id, and the workspace filled from the ambient session name. Throws rather
 * than guessing a tab: `OpenedPane.tab` is required (every multiplexer has the Tab level), and a wrong
 * tab is worse than a loud failure.
 */
function openedForPane(exec: Exec, paneId: string, session: string | undefined): OpenedPane {
	const found = listZellijPanes(exec).find((p) => samePane(p.id, paneId))
	if (!found || found.tab_id == null) throw new Error(`zellij did not report a tab for the new pane ${paneId}`)
	return openedPane(paneId, String(found.tab_id), session)
}

/**
 * The `OpenedPane` for a tab `new-tab` just reported — its initial pane resolved as the single
 * `list-panes` record carrying that tab id. Throws rather than guessing: a new tab must have a pane,
 * and a caller handed a tab with no pane could neither drive nor name it.
 */
function openedForTab(exec: Exec, tabId: string, session: string | undefined): OpenedPane {
	const pane = listZellijPanes(exec).find((p) => p.tab_id != null && String(p.tab_id) === tabId)
	if (!pane) throw new Error(`zellij did not report a pane in the new tab ${tabId}`)
	return openedPane(pane.id, tabId, session)
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
