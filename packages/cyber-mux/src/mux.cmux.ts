import { launchFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import { refuseFloatingPane } from './floating.ts'
import { refusePaneMove } from './move.ts'
import type { LivePane, MuxAdapter, MuxReadOptions, OpenedPane } from './mux.ts'
import { pollForOutput } from './wait-output.ts'
import { refusePaneZoom } from './zoom.ts'

/**
 * cmux backend — detected via `$CMUX_WORKSPACE_ID`. Drives cmux's CLI through `cmux <verb> …`
 * (https://cmux.com/docs/api), the same synchronous-CLI shape tmux, herdr, wezterm, and zellij
 * already give `Exec`.
 *
 * cmux is a Ghostty-based macOS terminal with vertical tabs and notifications for AI coding agents.
 * Its hierarchy is Window → Workspace → Pane → Surface. A **Surface** is the terminal unit (a tab
 * within a pane), which maps to cyber-mux's `LivePane`. The env variable `$CMUX_SURFACE_ID` carries
 * the caller's surface identity — analogous to `$TMUX_PANE` or `$WEZTERM_PANE`.
 *
 * Probed from cmux's own Swift source (`manaflow-ai/cmux`, read at commit `71eb616d`) — the CLI's
 * argument parser (`CLI/cmux.swift`), its own verb inventory
 * (`CLI/CMUXCLI+CommandSuggestions.swift`), the server-side payload builders under
 * `Packages/macOS/CmuxControlSocket/`, and `docs/cli-contract.md`. cmux is not installed in this
 * sandbox (it is macOS-GUI-only), so nothing here carries the "verified against a live binary"
 * claim `mux.tmux.ts`/`mux.herdr.ts` make; it makes the same honest disclaimer `mux.wezterm.ts` and
 * `mux.zellij.ts` do, and issue #128 tracks the missing real-boundary suite that would settle it.
 * A source read is materially stronger than the docs read this file used to rest on, and it is
 * still not a verification.
 *
 * Prefer the source over https://cmux.com/docs/api when they disagree: that page documents 27 of
 * cmux's 162 top-level commands and never claimed to be an inventory, so absence from it is not
 * evidence a verb does not exist. That misreading is what issue #132 was originally filed on.
 *
 * Real capability shape that fell out of the probe:
 *
 * - **Surface is the terminal unit, not Pane.** cmux's "pane" holds multiple "surfaces" (tabs). The
 *   terminal a command runs in is a surface, so `CMUX_SURFACE_ID` is the self-identity env var and
 *   `LivePane.id` carries a surface id. `--at tab` maps to `cmux new-surface` (a new tab in the
 *   current pane); `--at pane:*` maps to `cmux new-pane` (a split, which creates a pane with one
 *   surface).
 * - **Workspace is a real tier.** `cmux workspace create` creates a genuinely separate workspace,
 *   reported as `OpenedPane.workspace`.
 * - **And there is a real tier ABOVE it.** `workspace-group` groups multiple top-level WORKSPACES into
 *   a named, collapsible sidebar section. This is the tier `MuxOpenOptions.workspaceGroup` targets, and
 *   it is why `group` is NOT the no-op this header used to justify: the old reasoning ("cmux's workspace
 *   tier already groups every surface in it, so there is nothing to add") is sound for Pane → Surface
 *   and simply does not reach the tier the flag is about. See `group` for the mapping.
 * - **Grouping OPENS a workspace, once per group id.** `workspace-group create` always mints a brand-new
 *   ANCHOR workspace for the group, so the first `group` call for a given id adds a visible workspace to
 *   the user's sidebar that the caller did not ask for. That is a real deviation from the seam's "as
 *   read-only in its side effects as `rename`, it opens nothing", declared here rather than hidden: the
 *   alternative was the silent drop this replaced, and cmux offers no membership-only create. It does
 *   NOT steal focus (`selectAnchor: false`), and later calls for the same id open nothing.
 * - **Env is native at the WORKSPACE tier only, and is not adopted yet.** `workspace create` takes
 *   `--env KEY=VALUE` (repeatable) and `--env-file <path>` (`cmux.swift:10429`,
 *   `parseWorkspaceEnvOptions`), and `docs/cli-contract.md` says that env is inherited by every pane,
 *   surface and split created later in the workspace. `new-surface` and `new-pane` take no env flag
 *   at all. This header used to claim "no `--env` on any route", which was wrong. Every route still
 *   rides the `envFallback` compensation (an `env K=V` prefix on the launch command, or a stderr
 *   warning when there is no command to ride): swapping a WORKING compensation for a native flag
 *   changes behavior on source-only evidence, which is the half of issue #132 held for someone with
 *   a Mac. The false claim is corrected here; the capability stays unclaimed until it is verified.
 * - **Splits CANNOT be sized.** `new-pane` accepts only `--type --direction --url --profile
 *   --placement --focus --workspace --window` (`cmux.swift:7263-7291`) — there is no `--size`, and it
 *   validates no unknown flag, so the `--size` this adapter used to send was accepted and ignored.
 *   The only sizing verb is `resize-pane`, which is cell-based rather than fractional and so cannot
 *   render a `ratio` either. `canSizeSplits` is therefore omitted, zellij's answer exactly, and a
 *   `ratio` is dropped to cmux's own even split.
 * - **`new-pane` takes no `--cwd` either** — the same silent ignore, and the asymmetry is real:
 *   `new-surface` DOES take `--cwd` (an alias of `--working-directory`, run through `resolvePath`,
 *   `cmux.swift:7299`) and so does `workspace create`, so only the `pane:*` route loses it. Dropping
 *   the flag alone would open the split in the wrong directory silently, so the route compensates the
 *   way `envFallback` does: a `cd <dir>` that rides the launch command, or is sent alone when there is
 *   none. That is a shell-level cd, not a native cwd — it lands in the surface's shell history, and it
 *   only means anything in a shell surface.
 * - **The listing verb is `list-panels`, not `list-panes`.** `list-panes` (`pane.list`) reports PANES
 *   — `{"panes":[…]}`, one row per geometric container, carrying surface ids as flat arrays and no
 *   title. `list-panels` (`surface.list`) reports SURFACES — `{"surfaces":[…]}` with per-row `ref`,
 *   `title`, `type`, `focused`, `pane_ref`, `selected_in_pane` (`ControlCommandCoordinator+Surface.swift:150-186`)
 *   — which is the tier `LivePane` maps to here. Note the key names: the id is `ref` (`surface_ref` is
 *   the spelling in CREATION payloads, not list rows) and focus is `focused`, not `is_focused`.
 * - **No live cwd anywhere in the listing.** The nearest field is `requested_working_directory`, on
 *   terminal surfaces only, and it is the directory requested at CREATION — reporting it as
 *   `LivePane.cwd` would become a quiet lie the moment the user `cd`s. So `cwd` is absent from a cmux
 *   pane listing, and the `lookup-listing-reports-cwd` scenario no longer carries a cmux row.
 * - **`new-pane` has no split-TARGET flag.** It splits the focused pane (or the biggest space); the
 *   `--workspace` flag specifies which workspace, but not which pane within it. So `from` — which
 *   pane a `pane:*` split lands beside — is honored by FOCUSING that surface first, the sole way to
 *   choose the split target. That is a real focus move, and the honest cost of getting the RIGHT
 *   pane split.
 * - **No pane zoom at any CLI or socket layer.** cmux binds "Toggle Pane Zoom" to ⌘⇧↩ in the GUI and
 *   exposes it nowhere a program can reach: no zoom verb in the CLI, no `pane.zoom` among the socket's
 *   nine pane methods, and no zoom field in the pane listing. `setPaneZoom` refuses BY NAME and
 *   `isPaneZoomed` answers `undefined` (never `false` — the user can zoom by hand). The tmux-compat
 *   `resize-pane -Z` is the trap: it parses, does nothing, and exits 0. See `setPaneZoom`.
 * - **No pane geometry adapter.** Neither `list-panes` nor `list-panels` reports position, so `regions`
 *   (`describeRegion`/`describeWorkspace`) is not implementable. `template save` refuses on cmux by
 *   naming the backend, the same optional-absence it handles for wezterm.
 * - **No git-worktree concept in the CLI.** No `worktree` subcommand, so — like tmux, wezterm, and
 *   zellij — this backend never binds a worktree to a workspace; callers fall back to plain git plus
 *   `open()`.
 * - **Naming is a TAB rename, and cmux's tab IS its surface.** `rename-surface` and `rename-pane`,
 *   which this adapter used to run, appear nowhere in cmux — not in the dispatch, not in the help
 *   text, not in `topLevelCommandNames`. The real verb is `rename-tab --surface <id> --title <text>`
 *   (`cmux.swift:6985` → `runRenameTab` `:11541`), a documented alias for `tab-action --action
 *   rename`, whose `--surface` is itself an alias for `--tab` and which accepts a `tab:<n>` or
 *   `surface:<n>` handle. **No pane rename exists at any layer** — the only rename verbs cmux has are
 *   `rename-tab`, `rename-window`, `rename-workspace`, and the socket API has no `pane.rename`,
 *   because a cmux pane is a geometric container with no name to set. So the `pane` tier retargets
 *   the pane's surface rather than refusing; see `rename`.
 * - **A workspace is created by `workspace create`, not `new-workspace`.** Both reach the same
 *   `workspace.create` method, but `new-workspace` hardcodes `honorJSONOutput: false`
 *   (`cmux.swift:7155`) and the JSON print is gated on it (`:10491`), so `cmux --json new-workspace`
 *   prints the human line `OK workspace:3` and never JSON — the adapter parsed `{}` out of it and
 *   threw on every call. The namespaced `workspace create` (`:11166`) honors `--json` and answers
 *   `{window_*, workspace_*, surface_*}` (`TerminalController+WorkspaceCreate.swift:156-198`). It also
 *   takes `--name`, so a workspace is NAMED AT BIRTH here rather than renamed afterwards.
 *   The payload carries **no `pane_ref`**, so a workspace open reports its own surface as
 *   `OpenedPane.tab` — which `group`'s lookup resolves, since it accepts either handle kind.
 * - **Closing an explicit surface needs its workspace.** With `--surface` given, `close-surface`
 *   resolves the surface *within* a workspace and throws "close-surface requires --workspace or
 *   --window with explicit --surface" when it has neither (`cmux.swift:7360-7377`). It falls back to
 *   `$CMUX_WORKSPACE_ID` first (`:7351`), so the flagless form this adapter used to send works
 *   whenever the caller is itself inside cmux — and fails for a library caller with no cmux env, and
 *   resolves against the WRONG workspace for a surface outside the caller's own. `teardown` now names
 *   the workspace whenever the adapter is bound to one.
 */
export function createCmuxAdapter(deps: { workspace?: string | undefined }): MuxAdapter {
	const adapter: MuxAdapter = {
		name: 'cmux',

		// No `canSizeSplits`: `new-pane` has no size flag at all and `resize-pane` is cell-based, so
		// there is nothing to render a fractional `ratio` with. Its absence is what callers degrade on
		// — zellij's answer exactly. This used to be `true`, backed by a `--size` flag cmux never had.

		/**
		 * `canBreakPanes` alone, and the split between the two flags is cmux's whole contribution to the
		 * shape of this member: it HAS a break-out (`break-pane` → `pane.break`, which detaches a surface
		 * into its own workspace) and has nothing that puts a surface beside a NAMED pane on a NAMED
		 * side, so `canMovePanes` is omitted and `movePane` refuses by name. One `canRelocatePanes` would
		 * have had to answer `false` here and throw away the half cmux really does.
		 *
		 * Declared on a SOURCE read at `ae18c88`, never on a live drive — the caveat every capability in
		 * this file carries, and the reason it is stated here rather than assumed from the pattern the
		 * other adapters set, where these flags are backed by a driven binary.
		 */
		canBreakPanes: true,

		/**
		 * `false`, and cmux needs BOTH halves to be true to say otherwise. No creating verb documents a
		 * suppress-focus flag, so a new pane activates; and `new-pane` has no split-TARGET flag, so
		 * `from` is honored by focusing that surface first (see the header and `open` below) — a focus
		 * move made before the open even runs. Suppressing only one would still move the user, which
		 * the seam's own wording rules out.
		 *
		 * Read off cmux's documented CLI, NOT verified against a live binary — no cmux on the machine
		 * this was written on, matching the rest of this header.
		 */
		opensWithoutStealingFocus: false,

		open(exec, opts) {
			const at = opts.at ?? 'tab'

			if (at === 'workspace') {
				// `cmux workspace create` creates a genuinely separate workspace — the NAMESPACED spelling,
				// not the `new-workspace` alias, which is the same method behind a hardcoded
				// `honorJSONOutput: false` and so answers the human line `OK workspace:3` to a `--json`
				// request. Parsing that never yielded a ref, so this route threw on every call.
				const args = ['--json', 'workspace', 'create']
				if (opts.cwd) args.push('--cwd', opts.cwd)
				// Named at BIRTH, unlike every other tier here: `workspace create --name` is the flag the
				// seam's `label` maps to at this tier, so there is no post-birth rename to make.
				if (opts.label) args.push('--name', opts.label)
				const out = exec('cmux', args)
				if (!out) throw new Error(withReason(exec, 'cmux workspace create failed'))
				const parsed = parseCmuxOutput(out)
				if (!parsed.workspace_ref) throw new Error('cmux workspace create did not report the workspace ref')
				// The payload reports the new workspace's initial surface; it carries no pane ref, so
				// `openedSurface` reports that surface as the tab too.
				const surfaceId = parsed.surface_ref
				if (!surfaceId) throw new Error('cmux workspace create did not report the initial surface ref')
				const opened = openedSurface(surfaceId, parsed.pane_ref, parsed.workspace_ref)
				// Through `group`, not a second spelling of create/add here: grouping a workspace this open
				// just created and grouping one that was already open are the same act, so one spelling per
				// backend is the only way the two cannot drift. Gated on the WORKSPACE route alone — a `tab`
				// or `pane:*` open lands in the caller's existing workspace, and grouping that would group a
				// space the caller never opened, which is the same line tmux draws at its split.
				//
				// Unlike tmux this does NOT come free: cmux's group tier is the workspace while `group`'s
				// target is a tab, so it pays the `rpc surface.list` lookup even here, where the workspace ref
				// is already in hand. Spelling create/add a second time to save that call is the drift the
				// seam routes through one member to prevent, and the call is the honest price of not drifting.
				// `{ id: opened.tab }` is what `group` takes — a TAB id. On THIS route that is the new
				// workspace's own surface, because `workspace create` reports no pane ref; on a split it is a
				// pane ref. `paneToWorkspace` resolves either kind, which is what keeps the one spelling.
				if (opts.workspaceGroup != null) adapter.group(exec, { id: opened.tab }, opts.workspaceGroup)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}

			if (at === 'tab') {
				// `cmux new-surface` creates a new surface (tab) in the current pane.
				// If `within` is provided, it names the pane to create the surface in.
				const args = ['--json', 'new-surface']
				if (opts.within) args.push('--pane', opts.within)
				if (opts.cwd) args.push('--cwd', opts.cwd)
				const out = exec('cmux', args)
				if (!out) throw new Error(withReason(exec, 'cmux new-surface failed'))
				const parsed = parseCmuxOutput(out)
				const surfaceId = parsed.surface_ref
				if (!surfaceId) throw new Error('cmux new-surface did not report the surface ref')
				const opened = openedSurface(surfaceId, parsed.pane_ref, deps.workspace)
				if (opts.label) adapter.rename(exec, opened, 'tab', opts.label)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}

			// cmux has no floating-pane concept: `new-pane` always takes a share of the region and resizes
			// its neighbors, and nothing in the CLI opens a pane above the layout. So this REFUSES by name
			// rather than substituting a split — the substitute would satisfy the caller's pane id and
			// violate the one property they asked for. No `canFloatPanes` above is the declaration; this
			// is the enforcement, and both are needed for the same reason `agent wait` checks twice: the
			// CLI's pre-flight check is not on the path a library caller reaching `open()` directly takes.
			if (at === 'pane:float') refuseFloatingPane(adapter.name)

			// pane:right / pane:down — a split. Creates a new pane with one surface.
			// `new-pane` has no split-target flag, so `from` is honored by focusing first.
			if (opts.from) adapter.focus(exec, opts.from)

			// `--direction` is the whole flag set this route can use. `--cwd` and `--size` are NOT flags
			// `new-pane` has, and it rejects no unknown flag, so the two this used to send were accepted
			// and dropped on the floor: the split opened in the wrong directory and the ratio did nothing.
			// `ratio` degrades to cmux's even split (see `canSizeSplits`); `cwd` is compensated below.
			const direction = at === 'pane:down' ? 'down' : 'right'
			const out = exec('cmux', ['--json', 'new-pane', '--direction', direction])
			if (!out) throw new Error(withReason(exec, 'cmux new-pane failed'))
			const parsed = parseCmuxOutput(out)
			const surfaceId = parsed.surface_ref
			if (!surfaceId) throw new Error('cmux new-pane did not report the surface ref')
			const opened = openedSurface(surfaceId, parsed.pane_ref, deps.workspace)
			if (opts.label) adapter.rename(exec, opened, 'pane', opts.label)
			runLaunch(adapter, exec, opened, opts.env, opts.launch, opts.cwd)
			return opened
		},

		/**
		 * One command for BOTH tiers, because cmux has one nameable space here: the surface.
		 *
		 * `rename-surface`/`rename-pane`, which this used to run, do not exist — no dispatch, no help
		 * text, no entry in the CLI's own verb inventory. `rename-tab` is the real verb, and cmux's tab
		 * IS its surface (`--surface` is a documented alias for `--tab`, and `$CMUX_TAB_ID` aliases
		 * `$CMUX_SURFACE_ID`). The `pane` tier retargets rather than refusing, per the seam's rule that
		 * `rename` is REQUIRED: a cmux pane is a geometric container with no name at any layer, so the
		 * truthful realization of "name this pane" is to name the surface the user actually reads.
		 *
		 * `target.id` may be either handle kind and this never parses one to find out — the seam addresses
		 * the `tab` tier by `OpenedPane.tab`, which is a pane ref on a split and a surface ref on a
		 * workspace open, and under `--id-format uuids` neither kind is distinguishable by shape anyway.
		 * `resolveSurface` answers with the listing instead, which costs the one extra exec that buys a
		 * rename that works on both.
		 */
		rename(exec, target, _tier, name) {
			const surface = resolveSurface(exec, target.id)
			if (!surface) {
				throw new Error(withReason(exec, `cmux could not resolve a surface to rename for ${target.id}`))
			}
			exec('cmux', ['rename-tab', '--surface', surface, '--title', name])
		},

		group(exec, target, group) {
			// NOT a no-op, and the reason the old one gave was the right answer to the wrong tier. cmux's
			// workspace tier does group every surface in it — but the tier this flag targets is the one
			// ABOVE it. cmux ships a first-class `workspace-group` family that groups multiple top-level
			// WORKSPACES into a named, collapsible sidebar section, so a caller passing `workspaceGroup`
			// has a real cmux realization and used to get silence.
			//
			// `target.id` is a TAB id, which on this backend is a PANE ref (`openedSurface` reports
			// `tab: pane_ref`), while the groupable space is the WORKSPACE that pane sits in — so the
			// membership call needs a lookup the other backends do not. `cmux rpc surface.list` is that
			// lookup; see `paneToWorkspace`.
			const workspace = paneToWorkspace(exec, target.id)
			if (!workspace) {
				throw new Error(withReason(exec, `cmux could not resolve the workspace holding ${target.id}`))
			}
			// The seam's group id is OPAQUE and caller-chosen; cmux mints its OWN group ids (a UUID, and a
			// per-session `workspace_group:N` ref), so the id cannot simply BE the group. `--idempotency-key`
			// is the seam's exact counterpart: a second `create` carrying the same key returns the existing
			// group with `"created": false` rather than minting a second one, so this stays the single
			// spelling for both "make the group" and "find the group I already made". The same value also
			// rides `--name` so the sidebar section a human sees carries the caller's own id — cmux ignores
			// the name on the repeat call (it never consults names for identity), so the two calls agree.
			const out = exec('cmux', ['--json', 'workspace-group', 'create', '--name', group, '--idempotency-key', group])
			if (!out) throw new Error(withReason(exec, 'cmux workspace-group create failed'))
			const groupRef = parseGroupRef(out)
			if (!groupRef) throw new Error('cmux workspace-group create did not report the group ref')
			// Unconditional, no membership pre-check: `add` on a workspace already in this group short-circuits
			// and still reports success, so re-grouping is idempotent and a pre-flight read would buy nothing.
			exec('cmux', ['workspace-group', 'add', '--group', groupRef, '--workspace', workspace])
		},

		sendText(exec, target, text) {
			// `cmux send` types literal characters. Use `--surface` to target a specific surface.
			exec('cmux', ['send', '--surface', target.id, text])
		},

		sendKeys(exec, target, keys) {
			// `cmux send-key` presses named keys. Each key is a separate call.
			for (const key of keys) {
				exec('cmux', ['send-key', '--surface', target.id, toCmuxKey(key)])
			}
		},

		submit(exec, target, text) {
			// No atomic literal-text-plus-Enter primitive, so this composes: bare flush presses Enter
			// alone; otherwise literal text first, then Enter.
			if (!text) {
				adapter.sendKeys(exec, target, ['Enter'])
				return
			}
			adapter.sendText(exec, target, text)
			adapter.sendKeys(exec, target, ['Enter'])
		},

		read(exec, target, opts?: MuxReadOptions | undefined) {
			// `cmux read-screen` reads the terminal contents.
			const args = ['read-screen', '--surface', target.id]
			if (opts?.lines != null) args.push('--lines', String(opts.lines))
			const text = exec('cmux', args) ?? ''
			// cmux does not expose truncation info — report it unknown when asked.
			return { text }
		},

		waitForOutput(exec, target, opts) {
			return pollForOutput(adapter, exec, target, opts)
		},

		focus(exec, target) {
			// `cmux focus-surface` or `cmux focus-panel` focuses a specific surface.
			exec('cmux', ['focus-panel', '--panel', target.id])
		},

		teardown(exec, target) {
			// Close the surface. cmux does not allow closing the last pane in a workspace.
			//
			// The workspace is NAMED whenever this adapter is bound to one: with an explicit `--surface`,
			// `close-surface` resolves the surface inside a workspace and refuses outright when it has
			// neither `--workspace` nor `--window`. It does fall back to `$CMUX_WORKSPACE_ID`, which is why
			// the flagless form worked from inside cmux at all — but that fallback is the caller's OWN
			// workspace, so a surface in another one resolved against the wrong space, and a library caller
			// with no cmux env got the refusal. Unbound, this still sends the flagless form and still leans
			// on that fallback; there is nothing truer to send.
			const args = ['close-surface', '--surface', target.id]
			if (deps.workspace) args.push('--workspace', deps.workspace)
			exec('cmux', args)
		},

		paneExists(exec, target) {
			return listCmuxSurfaces(exec).some((s) => s.id === target.id)
		},

		isPaneFocused(exec, target) {
			// `focused` per surface, off the same listing `listPanes` makes — `undefined` only for a surface
			// the listing does not carry, which is the seam's "cannot tell" rather than a false negative.
			// This used to answer `undefined` for EVERY surface, because the listing it read was empty for
			// every real response. `identify` would answer without the listing, and adopting it changes
			// working behavior on source-only evidence — the half of #132 held for someone with a Mac.
			const found = listCmuxSurfaces(exec).find((s) => s.id === target.id)
			if (!found) return undefined
			return found.focused === true
		},

		/**
		 * REFUSED BY NAME — cmux has no pane-zoom verb, so there is nothing to drive and nothing
		 * truthful to substitute. No `canZoomPanes` above is the declaration; this is the enforcement,
		 * the same pairing `'pane:float'` uses.
		 *
		 * Read from cmux's Swift source at HEAD `ae18c88`, NOT from a live binary, which is this whole
		 * file's standing disclaimer — but the read here is exhaustive rather than a failure to find
		 * something. A case-insensitive scan of `CLI/` for `zoom|maximi[sz]e|fullscreen` returns only
		 * `cmux canvas zoom` (viewport magnification) and `cmux browser zoom` (web page zoom); the flat
		 * verb table in `CMUXCLI+CommandSuggestions.swift` carries thirteen `*-pane` verbs and no zoom;
		 * and the control socket's pane methods are exactly nine (`pane.break` `pane.create`
		 * `pane.focus` `pane.join` `pane.last` `pane.list` `pane.resize` `pane.surfaces` `pane.swap`),
		 * with no `pane.zoom` at any layer. The capability exists only as a GUI keybinding
		 * (`ShortcutAction.toggleSplitZoom`, ⌘⇧↩) and a command-palette entry, neither of which the
		 * socket exposes. Upstream issue #351 asked for the CLI verb and was closed on the keybinding
		 * alone; PR #353, which would add it, is still unmerged, and issue #2100 is still open.
		 *
		 * **Emulating it through the tmux-compat shim is the specific trap this refusal exists for.**
		 * `cmux resize-pane -Z -t <pane>` looks like it should work and is a SILENT NO-OP: `-Z` is not
		 * in that verb's `boolFlags`, `parseTmuxArguments` pushes an unrecognized short flag into
		 * `positional` rather than erroring, and the resize dispatch chain has no final `else`. So it
		 * resolves the pane, does nothing, and exits 0 — a green that zoomed nothing. Refusing by name
		 * is the only answer that tells the caller the truth.
		 */
		setPaneZoom() {
			refusePaneZoom('cmux')
		},

		/**
		 * `undefined` — cmux cannot be ASKED, which is not the same as "not zoomed", and the difference
		 * is real here rather than pedantic: a user can zoom a pane with ⌘⇧↩ this instant and no cmux
		 * CLI or socket call would report it. `paneListPayload` emits `id ref index focused surface_ids
		 * surface_refs selected_surface_id selected_surface_ref surface_count pixel_frame columns rows
		 * cell_width_px cell_height_px cell_width_points cell_height_points dock_scope` and no zoom key;
		 * `window_zoomed_flag` appears nowhere in the CLI or socket sources (its only hits are
		 * `RemoteTmuxWindowMirror*`, where cmux CONSUMES a remote tmux server's zoom state as a tmux
		 * client rather than exposing its own).
		 *
		 * So this answers `undefined` on every surface, `isPaneFocused`'s wezterm shape — never `false`,
		 * which would be a confident lie about a pane the user has zoomed by hand. Contrast
		 * `LivePane.floating`, which IS `false` by construction on the backends that cannot float,
		 * because those backends genuinely have only tiled panes.
		 */
		isPaneZoomed() {
			return undefined
		},

		/**
		 * Refused BY NAME, and NOT because cmux cannot move a pane — it has two container moves, and
		 * neither one takes this member's destination.
		 *
		 * - `move-surface --surface <s> --pane <p>` moves a surface into another PANE CONTAINER, where it
		 *   lands as one of that container's TABS, ordered by `--before`/`--after`/`--index`. There is no
		 *   side, because nothing is split: the destination pane keeps its geometry and gains a tab.
		 * - `split-off` / `drag-surface-to-split --surface <s> <left|right|up|down>` DOES split, and takes
		 *   no destination at all — it splits the surface off inside its own pane, wherever that is.
		 *
		 * So "beside pane X, on side S" is the one thing cmux's move verbs cannot spell between them.
		 * Substituting either would satisfy the caller's id and violate the placement they asked for,
		 * which is the trade `MuxAdapter.movePane` refuses. Read from cmux's Swift source at HEAD
		 * `ae18c88` (`CLI/cmux.swift`, `CLI/CMUXCLI+MoveTabToNewWorkspace.swift`), never driven — the
		 * standing caveat this whole header carries.
		 *
		 * RECHECK TRIGGER: a cmux verb that names a destination surface AND a split direction. #128 is
		 * the missing real-boundary suite.
		 */
		movePane() {
			refusePaneMove('cmux')
		},

		/**
		 * `break-pane --surface <id> --focus false` → the socket's `pane.break`, which detaches a surface
		 * into a NEW WORKSPACE (`sourceWorkspace.detachSurface(...)` then
		 * `tabManager.addWorkspace(fromDetachedSurface:)`, with rollback on failure) and answers
		 * `{window_*, workspace_*, pane_*, surface_*}` — every id this member needs.
		 *
		 * **`at` collapses UPWARD here, the mirror of tmux's downward collapse, and the seam's own
		 * `open` already makes both kinds.** A cmux surface IS a tab, so there is no "give this surface
		 * its own tab" to ask for; `pane.break` is the only break cmux has, and it always lands the
		 * surface alone in a fresh workspace — which satisfies `'tab'` by over-delivering rather than by
		 * failing. The returned `OpenedPane` reports the new workspace, so a caller that asked for a tab
		 * sees exactly where it landed rather than being told a comfortable lie.
		 *
		 * `--surface` is passed ALWAYS and that is load-bearing: with neither `--pane` nor `--surface`,
		 * `pane.break` breaks out the FOCUSED surface — a silent wrong-pane break for any library caller
		 * whose focus is not where it thinks. `--workspace` is the SOURCE context (it is what `--surface`
		 * is resolved within, not a destination), so it rides only when this adapter is bound to one,
		 * exactly as `teardown` sends it.
		 *
		 * `--focus false` is explicit even though cmux's own default is `false`: `runTmuxCompatCommand`
		 * validates no unknown flag, so nothing here would report a typo, and the explicit value is what
		 * makes the intent auditable.
		 *
		 * Read from cmux's Swift source at `ae18c88` — the CLI dispatch (`cmux.swift:27398`), the
		 * coordinator (`ControlCommandCoordinator+Pane.swift`, the `.broken` case) and the app path —
		 * and NEVER DRIVEN, like every other cmux member. That is why `canBreakPanes` is declared on a
		 * source read and says so, rather than on the live evidence the other four capable backends
		 * carry.
		 */
		breakPane(exec, target, at) {
			const args = ['--json', 'break-pane', '--surface', target.id, '--focus', 'false']
			if (deps.workspace) args.push('--workspace', deps.workspace)
			const out = exec('cmux', args)
			if (!out) throw new Error(withReason(exec, `cmux could not break out surface ${target.id} into its own ${at}`))
			const parsed = parseCmuxOutput(out)
			if (!parsed.surface_ref) throw new Error('cmux break-pane did not report the surface ref')
			return openedSurface(parsed.surface_ref, parsed.pane_ref, parsed.workspace_ref)
		},

		listPanes(exec): LivePane[] {
			return listCmuxSurfaces(exec).map((s) => {
				// `floating` is `false` BY CONSTRUCTION, not a stub and not a refusal: cmux has no floating-pane
				// concept at all, so every pane it can report really is tiled. The create side refuses a
				// `'pane:float'` open by NAME (`refuseFloatingPane` in `open` above) because there is no
				// truthful pane to hand back; the read side has a truthful answer, and this is it.
				//
				// No `cwd`: cmux reports none. A surface row carries `requested_working_directory` — the
				// directory asked for at creation — and nothing that tracks where the shell IS, so exporting
				// it would answer the "which pane is in this repo" question wrongly the moment anyone `cd`s.
				const pane: LivePane = { id: s.id, mux: 'cmux' as const, floating: false }
				if (s.title) pane.label = s.title
				return pane
			})
		},

		// No `regions`: geometry is not available from cmux's CLI.
		// No `worktree`: cmux has no worktree subcommand.
	}
	return adapter
}

export const cmuxMuxAdapter: MuxAdapter = createCmuxAdapter({})

interface CmuxOutput {
	surface_ref?: string
	pane_ref?: string
	workspace_ref?: string
	window_ref?: string
}

function parseCmuxOutput(out: string): CmuxOutput {
	try {
		return JSON.parse(out) as CmuxOutput
	} catch {
		return {}
	}
}

/**
 * The group ref `workspace-group create` reports, out of its `{ group, created }` envelope.
 *
 * `ref` first because cmux's DEFAULT `--id-format` is `refs`, which strips `id` from any object that
 * carries a sibling `ref` — so under the plain `--json` this adapter sends, `workspace_group:N` is the
 * only id present. `id` is read as a fallback rather than ignored: it is what an `--id-format uuids`
 * or `both` response carries, and `workspace-group add --group` accepts either spelling.
 */
function parseGroupRef(out: string): string | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return undefined
	}
	if (!parsed || typeof parsed !== 'object') return undefined
	const group = (parsed as { group?: { ref?: string; id?: string } }).group
	return group?.ref ?? group?.id
}

/**
 * The workspace holding a pane — the lookup `group` needs and no other member does.
 *
 * `cmux identify` cannot answer this. Its `--surface` flag does not DERIVE a workspace: the workspace
 * comes from `--workspace` or `$CMUX_WORKSPACE_ID`, and `--surface` is only validated against it, so
 * for a space outside the caller's own workspace `identify` reports `"caller": null` and exits 0 — a
 * silent wrong answer, which is the one thing a lookup must never give. `list-panes` does not report
 * an owning workspace either; it takes one as an input FILTER.
 *
 * So this goes through `rpc`, cmux's documented raw-socket verb (`docs/cli-contract.md`, which carries
 * a worked `surface_id` example): `surface.list` resolves its target workspace FROM a `pane_id` or
 * `surface_id` when given no workspace, and echoes it at the top level of the response. The
 * first-class alternative is a sweep — `workspace list`, then `list-panels --workspace` per row — which
 * is what cmux itself does internally, at one round trip per workspace instead of one total.
 *
 * `rpc` skips the id-format pass unless asked, so the response carries BOTH `workspace_ref` and
 * `workspace_id`; the ref is preferred for the reason `parseGroupRef` prefers it.
 *
 * **The tab id is not always a PANE, and the answer is verified rather than assumed.** `group` takes a
 * TAB id, which on this backend is a pane ref for a split (`pane.create` reports `pane_ref`) and a
 * SURFACE ref for a workspace open (`workspace.create` reports no pane, so `openedSurface` falls back
 * to the surface). The coordinator resolves a `kind:N` selector through a handle registry that is
 * keyed by the ref STRING and not by kind, so a surface handle passed as `pane_id` resolves to a UUID
 * that names no pane — and the routing then quietly falls back to the CALLER's own workspace, the
 * silent wrong answer this lookup exists to avoid.
 *
 * So each attempt is checked against its own result: a correctly routed `surface.list` returns the
 * workspace CONTAINING the handle, so its rows must carry that handle as a surface or as a pane. When
 * they do not, the routing fell back and the answer is discarded; the surface spelling is tried next,
 * and a second miss reports nothing rather than a workspace nobody asked about.
 *
 * Read off cmux's own Swift source, NOT verified against a live binary — see the header.
 */
function paneToWorkspace(exec: Exec, tabId: string): string | undefined {
	return workspaceHolding(exec, { pane_id: tabId }, tabId) ?? workspaceHolding(exec, { surface_id: tabId }, tabId)
}

/** One `surface.list` routing attempt, kept only when its rows actually contain `tabId`. */
function workspaceHolding(exec: Exec, params: Record<string, string>, tabId: string): string | undefined {
	const out = exec('cmux', ['rpc', 'surface.list', JSON.stringify(params)])
	if (!out) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return undefined
	}
	if (!parsed || typeof parsed !== 'object') return undefined
	const shape = parsed as { workspace_ref?: string; workspace_id?: string; surfaces?: unknown }
	const workspace = shape.workspace_ref ?? shape.workspace_id
	if (!workspace) return undefined
	const rows = Array.isArray(shape.surfaces) ? shape.surfaces : []
	const holds = rows.some((row) => {
		if (!row || typeof row !== 'object') return false
		const item = row as { ref?: string; id?: string; pane_ref?: string; pane_id?: string }
		return item.ref === tabId || item.id === tabId || item.pane_ref === tabId || item.pane_id === tabId
	})
	return holds ? workspace : undefined
}

interface CmuxSurface {
	id: string
	title?: string
	focused?: boolean
	/** The pane holding this surface — what lets `rename` accept a pane handle. */
	pane?: string
	/** Whether this is the surface the pane is showing, i.e. the one a pane-tier rename names. */
	selected?: boolean
}

/**
 * Every surface in the caller's workspace — the one read `listPanes`, `paneExists`, `isPaneFocused`
 * and `rename` all share.
 *
 * `list-panels` (`surface.list`), NOT `list-panes` (`pane.list`). The two verbs report different
 * tiers and different shapes: `list-panes` answers `{"panes":[…]}`, one row per geometric container,
 * carrying surface ids as flat arrays, no title and no focus per surface. This function used to read
 * that verb and to require a top-level ARRAY of panes each holding an array of surface OBJECTS —
 * a shape cmux never emits, so it returned `[]` for every real response and took all three members
 * down with it: an always-empty listing, a `paneExists` that was always false, and an `isPaneFocused`
 * that was always unknown.
 *
 * `ref` before `id` for the reason `parseGroupRef` gives: the default `--id-format refs` strips `id`
 * from any object carrying a sibling `ref`, and `--id-format uuids` does the reverse, so reading both
 * is what makes this work under either.
 */
function listCmuxSurfaces(exec: Exec): CmuxSurface[] {
	const out = exec('cmux', ['--json', 'list-panels'])
	if (!out) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return []
	}
	if (!parsed || typeof parsed !== 'object') return []
	const rows = (parsed as { surfaces?: unknown }).surfaces
	if (!Array.isArray(rows)) return []
	const surfaces: CmuxSurface[] = []
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue
		const item = row as {
			ref?: string
			id?: string
			title?: string
			focused?: boolean
			pane_ref?: string
			pane_id?: string
			selected_in_pane?: boolean
		}
		const id = item.ref ?? item.id
		if (!id) continue
		const surface: CmuxSurface = { id }
		if (item.title) surface.title = item.title
		if (typeof item.focused === 'boolean') surface.focused = item.focused
		const pane = item.pane_ref ?? item.pane_id
		if (pane) surface.pane = pane
		if (item.selected_in_pane === true) surface.selected = true
		surfaces.push(surface)
	}
	return surfaces
}

/**
 * The surface a `rename` names, given either a surface handle or a pane handle.
 *
 * A surface handle answers itself. A pane handle answers the surface that pane is SHOWING
 * (`selected_in_pane`), falling back to its first — a pane with several tabs has no single name, and
 * the one the user is looking at is the only defensible choice among them. Neither kind is parsed:
 * the listing is what says which is which, so a UUID under `--id-format uuids` resolves exactly as a
 * `surface:7` ref does.
 */
function resolveSurface(exec: Exec, id: string): string | undefined {
	const surfaces = listCmuxSurfaces(exec)
	if (surfaces.some((s) => s.id === id)) return id
	const inPane = surfaces.filter((s) => s.pane === id)
	if (inPane.length === 0) return undefined
	return (inPane.find((s) => s.selected) ?? inPane[0])?.id
}

function openedSurface(surfaceId: string, paneRef: string | undefined, workspace: string | undefined): OpenedPane {
	const opened: OpenedPane = { id: surfaceId, tab: paneRef ?? surfaceId }
	if (workspace) opened.workspace = workspace
	return opened
}

/**
 * Run the caller's launch command in the freshly opened surface, carrying whatever the route could
 * not set natively.
 *
 * `cwd` is passed ONLY by the `pane:*` route, the one route with no `--cwd` flag to send. Both
 * compensations — the env prefix and the `cd` — and the order they compose in are `launchFallback`'s
 * (`env-fallback.ts`); this route hands it what it lost and submits what comes back. `mux.otty.ts`
 * calls the same function for the same reason, which is why the rule lives there and not here.
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
			`env (${fallback.variables.join(', ')}) could not be set on this cmux surface — ` +
				'cmux has no --env flag on new-pane/new-surface, and its workspace --env is not adopted yet\n',
		)
	}
	if (fallback.command !== undefined) adapter.submit(exec, target, fallback.command)
}

/**
 * The core key vocabulary's cmux spelling. cmux uses lowercase key names: enter, tab, escape, etc.
 */
const CMUX_KEY_RENAMES: Readonly<Record<string, string>> = {
	Enter: 'enter',
	Tab: 'tab',
	Escape: 'escape',
	Backspace: 'backspace',
	Space: 'space',
	Up: 'up',
	Down: 'down',
	Left: 'left',
	Right: 'right',
	'C-c': 'ctrl+c',
}

function toCmuxKey(key: string): string {
	return CMUX_KEY_RENAMES[key] ?? key.toLowerCase()
}
