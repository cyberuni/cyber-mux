import { resolve } from 'node:path'
import type {
	LivePane,
	OpenInNewWorktreeOptions,
	SessionAdapter,
	SessionReadOptions,
	SessionTarget,
} from './session.ts'
import type { Worktree } from './worktree.ts'

/**
 * herdr backend — detected via `$HERDR_ENV`. herdr (https://herdr.dev) is an agent-aware terminal
 * multiplexer that also reports real busy-state (working / idle / blocked / done); this adapter
 * only drives its pane lifecycle, not the state feed. Talks to herdr's own CLI (`herdr pane ...`)
 * rather than its Unix-socket API, so it composes with this codebase's synchronous `Exec`
 * convention exactly like the tmux adapter — no new client/transport needed.
 *
 * The pane lifecycle (split/run/read/close) is verified against a live herdr binary; `pane split`
 * returns a JSON `pane_info` envelope whose id is extracted in `parsePaneId`.
 */
export const herdrSessionAdapter: SessionAdapter = {
	name: 'herdr',

	open(exec, opts) {
		const at = opts.at ?? 'tab'
		let id: string
		if (at === 'workspace') {
			// A genuinely separate workspace, not a pane inside the caller's current one — `--no-focus`
			// so spawning doesn't steal the caller's attention/focus.
			const out = exec('herdr', ['workspace', 'create', '--cwd', opts.cwd, '--no-focus'])
			if (!out) throw new Error('herdr workspace create failed')
			id = parseRootPaneId(out, 'herdr workspace create')
		} else if (at === 'tab') {
			// A real tab in the current window, not a split pane — `--no-focus` so spawning doesn't
			// steal the caller's attention/focus, matching workspace/worktree spawns.
			const out = exec('herdr', ['tab', 'create', '--cwd', opts.cwd, '--no-focus'])
			if (!out) throw new Error('herdr tab create failed')
			id = parseRootPaneId(out, 'herdr tab create')
		} else {
			const direction = at === 'pane:down' ? 'down' : 'right'
			const out = exec('herdr', ['pane', 'split', '--current', '--direction', direction, '--cwd', opts.cwd])
			if (!out) throw new Error('herdr pane split failed')
			id = parsePaneId(out)
		}
		const target: SessionTarget = { id }
		// `pane run` submits text plus Enter atomically — herdr's documented preference over
		// send-text + send-keys Enter for launching a command.
		if (opts.launch) exec('herdr', ['pane', 'run', id, opts.launch])
		return target
	},

	openInNewWorktree(exec, opts: OpenInNewWorktreeOptions) {
		// `herdr worktree create` both creates the git worktree AND opens it in a new workspace,
		// nested under the source workspace in herdr's own sidebar — one call instead of a plain
		// `git worktree add` followed by a disconnected `workspace create`. `--cwd` pins the source
		// repo explicitly rather than relying on the caller's ambient process cwd (matches how the
		// plain git adapter always passes `-C primaryRoot`); `--no-focus` avoids stealing focus.
		const out = exec('herdr', [
			'worktree',
			'create',
			'--cwd',
			opts.primaryRoot,
			'--branch',
			opts.branch,
			'--path',
			opts.path,
			'--no-focus',
		])
		if (!out) throw new Error('herdr worktree create failed')
		const { paneId, worktree } = parseWorktreeCreate(out)
		const target: SessionTarget = { id: paneId }
		exec('herdr', ['pane', 'run', paneId, opts.launch])
		return { target, worktree }
	},

	send(exec, target, text) {
		exec('herdr', ['pane', 'run', target.id, text])
	},

	submit(exec, target) {
		// `pane run <id> ""` is a no-op in herdr, so a bare Enter keystroke is the only way to flush
		// an already-staged buffer without re-typing it.
		exec('herdr', ['pane', 'send-keys', target.id, 'Enter'])
	},

	read(exec, target, opts?: SessionReadOptions) {
		const args = ['pane', 'read', target.id, '--source', 'visible']
		if (opts?.lines != null) args.push('--lines', String(opts.lines))
		return exec('herdr', args) ?? ''
	},

	focus(exec, target) {
		// `herdr pane focus` only accepts `--direction` (no by-id form), and a peer's pane can sit in
		// a different workspace/tab than the attached client — a single pane-level command can't beam
		// the client there. Resolve the pane's own workspace/tab from the backend first (`pane get`)
		// and drive the beam in order: workspace focus, then tab focus. A tab's active pane IS the
		// pane, so landing on the tab lands input focus on it — herdr has no separate by-id pane
		// focus to reach for. Resolution is attempted BEFORE any switch is issued, so an unresolvable
		// pane throws instead of a partial or false-success beam.
		const out = exec('herdr', ['pane', 'get', target.id])
		const { workspaceId, tabId } = parsePaneLocation(out, target.id)
		exec('herdr', ['workspace', 'focus', workspaceId])
		exec('herdr', ['tab', 'focus', tabId])
	},

	teardown(exec, target) {
		exec('herdr', ['pane', 'close', target.id])
	},

	paneExists(exec, target) {
		// `pane read` returns the pane's content for a live pane (empty string when the pane is empty),
		// and fails — Exec yields null — when the pane id no longer names a pane. A live pane is exactly
		// the non-null case; an empty live pane ('') must NOT read as gone.
		return exec('herdr', ['pane', 'read', target.id, '--source', 'visible']) !== null
	},

	isPaneFocused(exec, target) {
		// `herdr pane get <id>` prints `{"result":{"pane":{...,"focused":true|false,...}}}` on success,
		// or `{"error":{"code":"pane_not_found",...}}` when the pane can no longer be resolved. Parse
		// defensively: a missing/non-boolean `focused`, an error envelope, null output, or a JSON parse
		// failure all fall through to unknown rather than a false `false`.
		const out = exec('herdr', ['pane', 'get', target.id])
		if (out == null) return undefined
		try {
			const focused = JSON.parse(out)?.result?.pane?.focused
			return typeof focused === 'boolean' ? focused : undefined
		} catch {
			return undefined
		}
	},

	listPanes(exec): LivePane[] {
		const out = exec('herdr', ['pane', 'list'])
		if (!out) return []
		let panes: unknown
		try {
			panes = JSON.parse(out)?.result?.panes
		} catch {
			return []
		}
		if (!Array.isArray(panes)) return []
		return panes
			.filter(
				(p): p is { pane_id: string; agent: string; cwd?: string } =>
					typeof p?.pane_id === 'string' && typeof p?.agent === 'string' && p.agent !== '',
			)
			.map((p) => ({ id: p.pane_id, mux: 'herdr' as const, harness: p.agent, cwd: p.cwd }))
	},
}

/**
 * `herdr pane split` emits a JSON envelope, not a bare id:
 * `{"id":"cli:pane:split","result":{"pane":{"pane_id":"w3:pB", ...},"type":"pane_info"}}`.
 * The pane id herdr's other `pane` subcommands accept lives at `.result.pane.pane_id`. Extract it —
 * passing the whole blob downstream lands it in a filename and blows the path length limit.
 */
function parsePaneId(out: string): string {
	let paneId: unknown
	try {
		paneId = JSON.parse(out)?.result?.pane?.pane_id
	} catch {
		throw new Error(`herdr pane split returned unparseable output: ${out.slice(0, 200)}`)
	}
	if (typeof paneId !== 'string' || paneId === '') {
		throw new Error(`herdr pane split output had no result.pane.pane_id: ${out.slice(0, 200)}`)
	}
	return paneId
}

/**
 * `herdr pane get <id>` emits `{"result":{"pane":{"workspace_id":...,"tab_id":...,...}}}`. Resolving
 * fails — `out` is null (Exec failure: the pane no longer names a live pane in the backend) or the
 * JSON has no string `workspace_id`/`tab_id` — and that must throw so `focus` never issues a
 * workspace/tab switch against a pane it couldn't actually resolve.
 */
function parsePaneLocation(out: string | null, id: string): { workspaceId: string; tabId: string } {
	let workspaceId: unknown
	let tabId: unknown
	if (out != null) {
		try {
			const pane = JSON.parse(out)?.result?.pane
			workspaceId = pane?.workspace_id
			tabId = pane?.tab_id
		} catch {
			// unparseable — falls through to the unresolved check below
		}
	}
	if (typeof workspaceId !== 'string' || workspaceId === '' || typeof tabId !== 'string' || tabId === '') {
		throw new Error(`peer's pane ${id} could not be resolved to beam to`)
	}
	return { workspaceId, tabId }
}

/**
 * `herdr workspace create` and `herdr tab create` both emit their new root pane at
 * `.result.root_pane.pane_id` (a different path than `pane split`'s `.result.pane.pane_id`).
 * `label` names the command in error messages (e.g. "herdr workspace create").
 */
function parseRootPaneId(out: string, label: string): string {
	let paneId: unknown
	try {
		paneId = JSON.parse(out)?.result?.root_pane?.pane_id
	} catch {
		throw new Error(`${label} returned unparseable output: ${out.slice(0, 200)}`)
	}
	if (typeof paneId !== 'string' || paneId === '') {
		throw new Error(`${label} output had no result.root_pane.pane_id: ${out.slice(0, 200)}`)
	}
	return paneId
}

/**
 * `herdr worktree create` emits the same `.result.root_pane.pane_id` shape as `workspace create`,
 * plus the created worktree's own checkout at `.result.worktree.{path,branch}`.
 */
function parseWorktreeCreate(out: string): { paneId: string; worktree: Worktree } {
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		throw new Error(`herdr worktree create returned unparseable output: ${out.slice(0, 200)}`)
	}
	const result = (parsed as { result?: unknown })?.result as
		| { root_pane?: { pane_id?: unknown }; worktree?: { path?: unknown; branch?: unknown } }
		| undefined
	const paneId = result?.root_pane?.pane_id
	const path = result?.worktree?.path
	const branch = result?.worktree?.branch
	if (typeof paneId !== 'string' || paneId === '') {
		throw new Error(`herdr worktree create output had no result.root_pane.pane_id: ${out.slice(0, 200)}`)
	}
	if (typeof path !== 'string' || path === '' || typeof branch !== 'string' || branch === '') {
		throw new Error(`herdr worktree create output had no result.worktree.{path,branch}: ${out.slice(0, 200)}`)
	}
	return { paneId, worktree: { root: resolve(path), branch } }
}
