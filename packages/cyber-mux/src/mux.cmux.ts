import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
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
 * Probed from the cmux docs and CLI reference only — cmux is not installed in this sandbox (it is
 * macOS-GUI-only), so nothing here carries the "verified against a live binary" claim
 * `mux.tmux.ts`/`mux.herdr.ts` make; it makes the same honest disclaimer `mux.wezterm.ts` and
 * `mux.zellij.ts` do.
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

		group() {
			// A complete no-op, herdr/wezterm/zellij-style: cmux has a real workspace tier that already
			// groups every surface in it. The grouping TAG (`MuxOpenOptions.workspaceGroup`) exists for
			// a backend with NO workspace tier (tmux) to hold one in. cmux has a real tier, so there is
			// nothing for this to add.
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
				const pane: LivePane = { id: s.id, mux: 'cmux' as const }
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
