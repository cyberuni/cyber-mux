import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import { refuseFloatingPane } from './floating.ts'
import type { LivePane, MuxAdapter, MuxReadOptions, OpenedPane } from './mux.ts'
import { pollForOutput } from './wait-output.ts'

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
 * Probed from the cmux docs and CLI reference — and, for the `workspace-group` family below, from
 * cmux's own Swift source (`manaflow-ai/cmux`, read at commit `71eb616d`). cmux is not installed in
 * this sandbox (it is macOS-GUI-only), so nothing here carries the "verified against a live binary"
 * claim `mux.tmux.ts`/`mux.herdr.ts` make; it makes the same honest disclaimer `mux.wezterm.ts` and
 * `mux.zellij.ts` do, and issue #128 tracks the missing real-boundary suite that would settle it.
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
 * - **Workspace is a real tier.** `cmux new-workspace` creates a genuinely separate workspace,
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
 * - **No `--env` on any route.** Like wezterm and zellij, env is native at no tier, so every open
 *   rides the `envFallback` compensation (an `env K=V` prefix on the launch command, or a stderr
 *   warning when there is no command to ride).
 * - **Splits can be sized** — `cmux new-pane --direction right --size 0.3` sizes the NEW pane, so
 *   `ratio` (fraction kept by the ORIGINAL) is inverted to `1 - ratio`. `canSizeSplits` is true.
 * - **`new-pane` has no split-TARGET flag.** It splits the focused pane (or the biggest space); the
 *   `--workspace` flag specifies which workspace, but not which pane within it. So `from` — which
 *   pane a `pane:*` split lands beside — is honored by FOCUSING that surface first, the sole way to
 *   choose the split target. That is a real focus move, and the honest cost of getting the RIGHT
 *   pane split.
 * - **No pane geometry adapter.** `cmux list-panes --json` does not report position, so `regions`
 *   (`describeRegion`/`describeWorkspace`) is not implementable. `template save` refuses on cmux by
 *   naming the backend, the same optional-absence it handles for wezterm.
 * - **No git-worktree concept in the CLI.** No `worktree` subcommand, so — like tmux, wezterm, and
 *   zellij — this backend never binds a worktree to a workspace; callers fall back to plain git plus
 *   `open()`.
 * - **Naming surfaces.** cmux surfaces can be labeled — verified against the skill docs: a label can
 *   be set after creation. No `--label` flag on `new-surface` / `new-pane`, so naming is post-birth.
 */
export function createCmuxAdapter(deps: { workspace?: string | undefined }): MuxAdapter {
	const adapter: MuxAdapter = {
		name: 'cmux',

		canSizeSplits: true,

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
				// `cmux new-workspace` creates a genuinely separate workspace.
				const args = ['--json', 'new-workspace']
				if (opts.cwd) args.push('--cwd', opts.cwd)
				const out = exec('cmux', args)
				if (!out) throw new Error(withReason(exec, 'cmux new-workspace failed'))
				const parsed = parseCmuxOutput(out)
				if (!parsed.workspace_ref) throw new Error('cmux new-workspace did not report the workspace ref')
				// new-workspace returns the workspace ref and a surface_ref for the initial surface.
				const surfaceId = parsed.surface_ref
				if (!surfaceId) throw new Error('cmux new-workspace did not report the initial surface ref')
				const opened = openedSurface(surfaceId, parsed.pane_ref, parsed.workspace_ref)
				if (opts.label) adapter.rename(exec, opened, 'tab', opts.label)
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
				// `{ id: opened.tab }`, never `opened`: `group` takes a TAB id and `opened.id` is a SURFACE.
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

			const direction = at === 'pane:down' ? 'down' : 'right'
			const args = ['--json', 'new-pane', '--direction', direction]
			if (opts.cwd) args.push('--cwd', opts.cwd)
			// `ratio` is the fraction kept by the ORIGINAL pane; cmux's `--size` sizes the NEW pane,
			// so we invert: new size = 1 - ratio.
			if (opts.ratio != null) args.push('--size', String(1 - opts.ratio))
			const out = exec('cmux', args)
			if (!out) throw new Error(withReason(exec, 'cmux new-pane failed'))
			const parsed = parseCmuxOutput(out)
			const surfaceId = parsed.surface_ref
			if (!surfaceId) throw new Error('cmux new-pane did not report the surface ref')
			const opened = openedSurface(surfaceId, parsed.pane_ref, deps.workspace)
			if (opts.label) adapter.rename(exec, opened, 'pane', opts.label)
			runLaunch(adapter, exec, opened, opts.env, opts.launch)
			return opened
		},

		rename(exec, target, tier, name) {
			if (tier === 'tab') {
				// Rename the surface (tab within a pane).
				exec('cmux', ['rename-surface', '--surface', target.id, '--title', name])
				return
			}
			// Rename the pane. The target.id is a surface; we need to get its pane and rename that.
			// For now, assume the caller passed a pane ref or we look it up.
			const paneRef = surfaceToPane(exec, target.id)
			if (paneRef) exec('cmux', ['rename-pane', '--pane', paneRef, '--title', name])
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
			exec('cmux', ['close-surface', '--surface', target.id])
		},

		paneExists(exec, target) {
			return listCmuxSurfaces(exec).some((s) => s.id === target.id)
		},

		isPaneFocused(exec, target) {
			// cmux's identify --json can report the focused surface. For now, return undefined (unknown)
			// since the exact focused surface ref needs verification against a live binary.
			const surfaces = listCmuxSurfaces(exec)
			const found = surfaces.find((s) => s.id === target.id)
			if (!found) return undefined
			return found.is_focused === true
		},

		listPanes(exec): LivePane[] {
			return listCmuxSurfaces(exec).map((s) => {
				// `floating` is `false` BY CONSTRUCTION, not a stub and not a refusal: cmux has no floating-pane
				// concept at all, so every pane it can report really is tiled. The create side refuses a
				// `'pane:float'` open by NAME (`refuseFloatingPane` in `open` above) because there is no
				// truthful pane to hand back; the read side has a truthful answer, and this is it.
				const pane: LivePane = { id: s.id, mux: 'cmux' as const, floating: false }
				if (s.cwd) pane.cwd = s.cwd
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
 * Read off cmux's own Swift source, NOT verified against a live binary — see the header.
 */
function paneToWorkspace(exec: Exec, paneId: string): string | undefined {
	const out = exec('cmux', ['rpc', 'surface.list', JSON.stringify({ pane_id: paneId })])
	if (!out) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return undefined
	}
	if (!parsed || typeof parsed !== 'object') return undefined
	const shape = parsed as { workspace_ref?: string; workspace_id?: string }
	return shape.workspace_ref ?? shape.workspace_id
}

interface CmuxSurface {
	id: string
	title?: string
	cwd?: string
	is_focused?: boolean
}

function listCmuxSurfaces(exec: Exec): CmuxSurface[] {
	// cmux list-panes --json lists all surfaces across all panes in the current workspace.
	const out = exec('cmux', ['list-panes', '--json'])
	if (!out) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	// Flatten: each pane has surfaces; we want the surfaces.
	const surfaces: CmuxSurface[] = []
	for (const pane of parsed) {
		if (pane && Array.isArray(pane.surfaces)) {
			for (const s of pane.surfaces) {
				if (s?.surface_ref) {
					surfaces.push({
						id: s.surface_ref,
						title: s.title,
						cwd: s.cwd,
						is_focused: s.is_focused,
					})
				}
			}
		}
	}
	return surfaces
}

function openedSurface(surfaceId: string, paneRef: string | undefined, workspace: string | undefined): OpenedPane {
	const opened: OpenedPane = { id: surfaceId, tab: paneRef ?? surfaceId }
	if (workspace) opened.workspace = workspace
	return opened
}

function surfaceToPane(exec: Exec, surfaceId: string): string | undefined {
	// Look up the pane that contains this surface.
	const out = exec('cmux', ['list-panes', '--json'])
	if (!out) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return undefined
	}
	if (!Array.isArray(parsed)) return undefined
	for (const pane of parsed) {
		if (pane?.pane_ref && Array.isArray(pane.surfaces)) {
			for (const s of pane.surfaces) {
				if (s && s.surface_ref === surfaceId) return pane.pane_ref as string
			}
		}
	}
	return undefined
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
			`env (${fallback.variables.join(', ')}) could not be set on this cmux surface — ` +
				'cmux has no --env flag on new-pane/new-surface/new-workspace\n',
		)
		return
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
