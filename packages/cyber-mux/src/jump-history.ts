import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxTarget } from './mux.ts'
import { currentPane } from './mux-probe.ts'

/**
 * Jump history: every focus records **target ← source**, and `focusBack` follows that link for the
 * pane it runs in (cyber-mux#263).
 *
 * The history is a map from each pane to the pane it was entered from, not a stack ordered by time.
 * A stack breaks as soon as the user moves between panes by hand: back would pop the origin of a jump
 * that was never made from the current pane. Two rules are expensive to unwind, because changing
 * either changes what back means:
 * - links are stored by pane, so the latest jump into a pane replaces the one before it;
 * - back records nothing, so back from A after returning to A goes to A's own origin, not to B.
 *
 * The source of a jump is the pane the focus is CALLED from (`currentPane`), which is where the view
 * is when a person types `/jump` or presses a key bound to `focus --back`. A focus called from no pane
 * of the same multiplexer records nothing: there is no source to return to.
 *
 * Links are keyed by backend, server instance, and pane id. The server instance comes from the env
 * the backend sets in every pane (`jumpServer`), so recording costs no extra multiplexer call.
 */

/** The history file's raw contents — the filesystem seam, injected so tests run with no real file. */
export interface JumpStore {
	/** The file's contents, or `null` when it does not exist or cannot be read. */
	read(): string | null
	/** Replace the file's contents atomically. */
	write(contents: string): void
}

/** What a recording or a back needs besides the multiplexer: where the caller runs, and the file. */
export interface JumpContext {
	/** The caller's env: its pane (the jump's source, or where back runs) and its server instance. */
	env: NodeJS.ProcessEnv
	store: JumpStore
	/** Clock for each link's timestamp; defaults to `Date.now`. */
	now?: (() => number) | undefined
}

/**
 * Where the history lives: `$CYBER_MUX_STATE_DIR/jumps.json`, else `~/.agents/cyber-mux/jumps.json`.
 * A state file of its own, kept apart from any settings file a person edits.
 */
export function jumpStatePath(env: NodeJS.ProcessEnv): string {
	return join(env['CYBER_MUX_STATE_DIR'] || join(homedir(), '.agents', 'cyber-mux'), 'jumps.json')
}

/**
 * The history file on disk. A write goes to a temp file beside it and is renamed over it, so a reader
 * never sees half a file and a crash mid-write leaves the old history whole.
 */
export function nodeJumpStore(path: string): JumpStore {
	return {
		read() {
			try {
				return readFileSync(path, 'utf8')
			} catch {
				return null
			}
		},
		write(contents) {
			mkdirSync(dirname(path), { recursive: true })
			const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
			writeFileSync(tmp, contents, 'utf8')
			renameSync(tmp, path)
		},
	}
}

/**
 * One multiplexer server. `home` is where a server lives (a socket, a session) and `run` tells one
 * run of it from the next. A restarted server reuses pane ids, so a link from an earlier run must
 * not be followed (S10). One home hosts one run at a time, so a different run at the same home is
 * the old server, and its links are dropped.
 */
export interface JumpServer {
	mux: string
	home: string
	run: string
}

/**
 * The server instance the caller's pane belongs to, read from the env its backend sets in every pane.
 * tmux and rmux export `socket,pid,session` (`$TMUX`, `$RMUX`): the socket is the home and the pid is
 * the run. zellij pane ids are per session, so the session is the home. wezterm's mux socket is the
 * home. A backend whose panes carry no such var gets an empty instance: its links are still checked
 * against the live panes on every read, but a restart that reuses a pane id is not detected.
 */
function jumpServer(mux: string, env: NodeJS.ProcessEnv): JumpServer {
	const triple = (value: string | undefined): JumpServer => {
		const [home = '', run = ''] = (value ?? '').split(',')
		return { mux, home, run }
	}
	if (mux === 'tmux') return triple(env['TMUX'])
	if (mux === 'rmux') return triple(env['RMUX'])
	if (mux === 'zellij') return { mux, home: env['ZELLIJ_SESSION_NAME'] ?? '', run: '' }
	if (mux === 'wezterm') return { mux, home: env['WEZTERM_UNIX_SOCKET'] ?? '', run: '' }
	return { mux, home: '', run: '' }
}

interface JumpLink {
	from: string
	at: number
}

interface ServerHistory extends JumpServer {
	links: Record<string, JumpLink>
}

interface JumpFile {
	version: 1
	servers: ServerHistory[]
}

/** Parse the file, reading anything unreadable or of another shape as empty history — a broken file
 * must never block a jump, and the next write replaces it. */
function load(store: JumpStore): JumpFile {
	const raw = store.read()
	if (raw == null) return { version: 1, servers: [] }
	try {
		const parsed = JSON.parse(raw) as Partial<JumpFile>
		if (parsed.version !== 1 || !Array.isArray(parsed.servers)) return { version: 1, servers: [] }
		const servers = parsed.servers.filter(
			(s): s is ServerHistory =>
				s != null &&
				typeof s.mux === 'string' &&
				typeof s.home === 'string' &&
				typeof s.run === 'string' &&
				s.links != null &&
				typeof s.links === 'object',
		)
		return { version: 1, servers }
	} catch {
		return { version: 1, servers: [] }
	}
}

function save(store: JumpStore, file: JumpFile): void {
	store.write(`${JSON.stringify(file, null, '\t')}\n`)
}

/** The history of `server`, after dropping any earlier run at the same home (S10). Creates it. */
function historyOf(file: JumpFile, server: JumpServer): ServerHistory {
	file.servers = file.servers.filter((s) => s.mux !== server.mux || s.home !== server.home || s.run === server.run)
	let history = file.servers.find((s) => s.mux === server.mux && s.home === server.home)
	if (!history) {
		history = { ...server, links: {} }
		file.servers.push(history)
	}
	return history
}

/**
 * Record target ← the caller's pane. Records nothing when the caller is in no pane of `muxName`, or
 * when it is the target itself (S6). The latest jump into a pane replaces the one before (S4, S11).
 */
export function recordJump(muxName: string, target: MuxTarget, ctx: JumpContext): void {
	const self = currentPane(ctx.env)
	if (!self || self.mux !== muxName || self.pane === target.id) return
	const file = load(ctx.store)
	historyOf(file, jumpServer(muxName, ctx.env)).links[target.id] = {
		from: self.pane,
		at: (ctx.now ?? Date.now)(),
	}
	save(ctx.store, file)
}

/** Each wrapped adapter's unwrapped original, so a focus can run without being recorded (back). */
const unwrapped = new WeakMap<MuxAdapter, MuxAdapter>()

/** The adapter's focus without the recording `withJumpHistory` adds. */
function rawFocus(adapter: MuxAdapter): MuxAdapter['focus'] {
	return (unwrapped.get(adapter) ?? adapter).focus
}

/**
 * Focus `target`, then record target ← the caller's pane. A failed focus records nothing. A failed
 * write never fails the focus: the view already moved, and reporting failure would be false.
 */
export function focusAndRecord(adapter: MuxAdapter, exec: Exec, target: MuxTarget, ctx: JumpContext): void {
	rawFocus(adapter)(exec, target)
	try {
		recordJump(adapter.name, target, ctx)
	} catch {
		// History is best-effort; see above.
	}
}

/**
 * Give an adapter a `focus` that records each jump, reading the caller's pane from `process.env` and
 * writing `jumpStatePath(process.env)`. Every adapter the library exports is wrapped, so a host that
 * calls `adapter.focus` directly (cyberlegion's `unit focus`) records with no change of its own.
 */
export function withJumpHistory(adapter: MuxAdapter): MuxAdapter {
	const original = unwrapped.get(adapter) ?? adapter
	const wrapped: MuxAdapter = {
		...original,
		focus(exec, target) {
			const env = process.env
			focusAndRecord(original, exec, target, { env, store: nodeJumpStore(jumpStatePath(env)) })
		},
	}
	unwrapped.set(wrapped, original)
	return wrapped
}

/** Why `focusBack` could not go back. */
export type JumpBackFailure =
	/** Back ran in no pane of this multiplexer, so there is no pane to follow a link for. */
	| 'no-caller-pane'
	/** No jump was recorded into the caller's pane (S5). */
	| 'no-jump'
	/** A link exists, but every pane up its chain is gone (S8). */
	| 'chain-gone'

export class JumpBackError extends Error {
	constructor(
		readonly code: JumpBackFailure,
		message: string,
		/** The pane back ran in, when it ran in one. */
		readonly pane?: string | undefined,
		/** On `no-jump`: the origin of the latest recorded jump on this server that is still live. */
		readonly lastOrigin?: string | undefined,
	) {
		super(message)
		this.name = 'JumpBackError'
	}
}

/** Where back went: from the caller's pane `from` to `to`, past any closed panes in `skipped`. */
export interface FocusBackResult {
	from: string
	to: string
	skipped: string[]
}

/**
 * Follow the link for the caller's pane and focus where it leads. Records nothing (S9).
 *
 * A link to a closed pane is followed through that pane's own stored link to the first live pane
 * (S8). Links to panes that no longer exist are removed on this read; a live pane whose origin
 * closed is re-pointed to the first live pane up its chain, so the chain survives the removal.
 */
export function focusBack(adapter: MuxAdapter, exec: Exec, ctx: JumpContext): FocusBackResult {
	const self = currentPane(ctx.env)
	if (!self || self.mux !== adapter.name) {
		throw new JumpBackError('no-caller-pane', `focus --back must run inside a ${adapter.name} pane`)
	}
	const from = self.pane
	const file = load(ctx.store)
	const before = JSON.stringify(file)
	const history = historyOf(file, jumpServer(adapter.name, ctx.env))
	const links = history.links

	// One listing answers every liveness question. A listing that cannot be read falls back to asking
	// pane by pane, and then nothing is removed: a removal must rest on a full view of the live panes.
	let listed: Set<string> | undefined
	try {
		listed = new Set(adapter.listPanes(exec).map((p) => p.id))
	} catch {
		listed = undefined
	}
	const isLive = (id: string): boolean => (listed ? listed.has(id) : adapter.paneExists(exec, { id }))

	/** The first live pane up the chain from `start`'s link, and the closed panes passed on the way. */
	const resolve = (start: string): { to?: string; skipped: string[] } => {
		const skipped: string[] = []
		const seen = new Set([start])
		let cur = links[start]?.from
		while (cur != null && !seen.has(cur)) {
			if (isLive(cur)) return { to: cur, skipped }
			skipped.push(cur)
			seen.add(cur)
			cur = links[cur]?.from
		}
		return { skipped }
	}

	const hasLink = links[from] != null
	const found = hasLink ? resolve(from) : { skipped: [] }

	if (listed) {
		const pruned: Record<string, JumpLink> = {}
		for (const [target, link] of Object.entries(links)) {
			if (!listed.has(target)) continue
			const origin = listed.has(link.from) ? link.from : resolve(target).to
			if (origin != null) pruned[target] = { from: origin, at: link.at }
		}
		history.links = pruned
	}
	if (Object.keys(history.links).length === 0) file.servers = file.servers.filter((s) => s !== history)
	if (JSON.stringify(file) !== before) save(ctx.store, file)

	if (!hasLink) {
		const latest = Object.values(history.links)
			.filter((link) => isLive(link.from))
			.sort((a, b) => b.at - a.at)[0]
		throw new JumpBackError('no-jump', `no jump into ${from}`, from, latest?.from)
	}
	if (found.to == null) {
		throw new JumpBackError('chain-gone', `every pane back from ${from} is gone`, from)
	}
	rawFocus(adapter)(exec, { id: found.to })
	return { from, to: found.to, skipped: found.skipped }
}
