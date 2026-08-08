import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import type { LivePane, MuxAdapter, MuxReadOptions, OpenedPane } from './mux.ts'
import { pollForOutput } from './wait-output.ts'

/**
 * otty backend — detected via `$OTTY_PANE_ID`. Drives otty's CLI through `otty pane <verb> …`
 * (https://docs.otty.sh/reference/cli), the same synchronous-CLI shape the other backends use.
 *
 * otty is a native terminal-centric workspace app with integrated multiplexing (Windows > Tabs >
 * Splits > Panes). Its hierarchy maps onto cyber-mux's placement tiers as:
 * - **Workspace** → Window (a new window, spawned via `otty open --new-window`)
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
 * - **Window is the workspace tier.** `otty open --new-window` creates a genuinely separate window,
 *   reported as `OpenedPane.workspace`.
 * - **No `--env` on any route.** Like wezterm/zellij/cmux, env is native at no tier, so every open
 *   rides the `envFallback` compensation (an `env K=V` prefix on the launch command, or a stderr
 *   warning when there is no command to ride).
 * - **Split direction is explicit.** `otty pane split --right|--bottom` maps `pane:right`/`pane:down`.
 * - **`send-keys` mixes text and key tokens.** `otty pane send-keys --pane <id> -- "text" key:Enter`
 *   can do both in one call. We implement `sendText` and `sendKeys` separately per the contract.
 * - **No pane geometry adapter.** `otty panes --json` does not report position, so `regions` is not
 *   implementable. `template save` refuses on otty by naming the backend.
 * - **No git-worktree concept in the CLI.** No `worktree` subcommand, so — like tmux, wezterm,
 *   zellij, and cmux — this backend never binds a worktree to a workspace; callers fall back to
 *   plain git plus `open()`.
 */
export function createOttyAdapter(deps: { window?: string | undefined }): MuxAdapter {
	const adapter: MuxAdapter = {
		name: 'otty',

		canSizeSplits: false,

		open(exec, opts) {
			const at = opts.at ?? 'tab'

			if (at === 'workspace') {
				const args = ['open', '--new-window']
				if (opts.cwd) args.push(opts.cwd)
				const out = exec('otty', args)
				if (!out) throw new Error(withReason(exec, 'otty open --new-window failed'))
				const parsed = parseOttyOutput(out)
				if (!parsed.window_id) throw new Error('otty open --new-window did not report the window id')
				const paneId = parsed.pane_id
				if (!paneId) throw new Error('otty open --new-window did not report the initial pane id')
				const opened = openedPane(paneId, parsed.tab_id, parsed.window_id)
				if (opts.label) adapter.rename(exec, opened, 'tab', opts.label)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}

			if (at === 'tab') {
				const args = ['tab', 'new']
				if (opts.cwd) args.push('--cwd', opts.cwd)
				const out = exec('otty', args)
				if (!out) throw new Error(withReason(exec, 'otty tab new failed'))
				const parsed = parseOttyOutput(out)
				const paneId = parsed.pane_id
				if (!paneId) throw new Error('otty tab new did not report the pane id')
				const opened = openedPane(paneId, parsed.tab_id, deps.window)
				if (opts.label) adapter.rename(exec, opened, 'tab', opts.label)
				runLaunch(adapter, exec, opened, opts.env, opts.launch)
				return opened
			}

			// pane:right / pane:down — a split
			if (opts.from) adapter.focus(exec, opts.from)

			const direction = at === 'pane:down' ? '--bottom' : '--right'
			const args = ['pane', 'split', direction]
			if (opts.cwd) args.push('--cwd', opts.cwd)
			const out = exec('otty', args)
			if (!out) throw new Error(withReason(exec, 'otty pane split failed'))
			const parsed = parseOttyOutput(out)
			const paneId = parsed.pane_id
			if (!paneId) throw new Error('otty pane split did not report the pane id')
			const opened = openedPane(paneId, parsed.tab_id, deps.window)
			if (opts.label) adapter.rename(exec, opened, 'pane', opts.label)
			runLaunch(adapter, exec, opened, opts.env, opts.launch)
			return opened
		},

		rename(exec, target, tier, name) {
			if (tier === 'tab') {
				exec('otty', ['tab', 'rename', '--tab', target.id, '--title', name])
				return
			}
			exec('otty', ['pane', 'rename', '--pane', target.id, '--title', name])
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
				const pane: LivePane = { id: p.id, mux: 'otty' as const }
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

/**
 * The core key vocabulary's otty spelling. otty uses PascalCase key names: Enter, Tab, Escape, etc.
 */
const OTTY_KEY_RENAMES: Readonly<Record<string, string>> = {
	'C-c': 'Ctrl+c',
}

function toOttyKey(key: string): string {
	return OTTY_KEY_RENAMES[key] ?? key
}
