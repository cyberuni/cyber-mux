import { homedir } from 'node:os'
import { sep } from 'node:path'

/**
 * A path with the caller's home directory collapsed to `~` — for HUMAN output only. Every worktree
 * of a repo shares a long home-rooted prefix, so the table spends width on a string the reader
 * already knows. JSON output must NEVER pass through here: a consumer needs the absolute path.
 *
 * The match is on a path BOUNDARY, not a prefix — `/home/unionalX` is not under `/home/unional`, so
 * only `$HOME` itself and `$HOME/...` are rewritten. A home of `/` collapses nothing, since every
 * absolute path would otherwise become `~`.
 */
export function tildify(path: string, home: string = homedir()): string {
	if (!home || home === sep || home === '/') return path
	if (path === home) return '~'
	for (const s of new Set([sep, '/'])) {
		if (path.startsWith(home + s)) return `~${path.slice(home.length)}`
	}
	return path
}

function printJson(data: unknown) {
	console.log(JSON.stringify(data, null, 2))
}

export function printFields(fields: Record<string, string | null | undefined>): void {
	const entries = Object.entries(fields).filter(([, v]) => v != null) as [string, string][]
	if (entries.length === 0) return
	const width = Math.max(...entries.map(([k]) => k.length))
	for (const [key, val] of entries) {
		console.log(`${key.padEnd(width)}  ${val}`)
	}
}

/**
 * A #9 contextual-disclosure suggestion: an obvious next move the caller can take, named as data
 * rather than prose. `message` says what is worth doing; `command` is the concrete invocation that
 * does it. Dynamic parts are the caller's OWN values (a name they passed, a branch they named), never
 * a guessed id.
 */
export type HelpEntry = { message: string; command: string }

/**
 * Render #9 suggestions as a `help[N]:` block on stdout — inside the structured payload, the stream an
 * agent reads, not stderr it never does. Each entry is a message line and its command, indented under
 * it. Prints NOTHING for an empty list: a self-contained result owes no suggestion (#9's
 * omit-when-self-contained rule), so the block never appears as noise.
 */
export function printHelp(entries: HelpEntry[]): void {
	entries.forEach((entry, i) => {
		console.log(`help[${i}]: ${entry.message}`)
		console.log(`  -> ${entry.command}`)
	})
}

export function printTable<T>(items: T[], cols: { label: string; get: (item: T) => string }[]): void {
	if (items.length === 0) {
		console.log('(none)')
		return
	}
	const widths = cols.map((c) => Math.max(c.label.length, ...items.map((i) => c.get(i).length)))
	console.log(cols.map((c, i) => c.label.toUpperCase().padEnd(widths[i]!)).join('  '))
	console.log(widths.map((w) => '-'.repeat(w)).join('  '))
	for (const item of items) {
		console.log(cols.map((c, i) => c.get(item).padEnd(widths[i]!)).join('  '))
	}
}

function getFormat(): string | undefined {
	const argv = process.argv
	const fmtIdx = argv.indexOf('--format')
	if (fmtIdx !== -1) return argv[fmtIdx + 1]
	if (argv.includes('--json')) return 'json' // hidden backward-compat alias
	return undefined
}

/**
 * Whether the caller asked for machine-readable output. Exported because `output()` is not the only
 * writer that owes it: a structured ERROR is rendered by `reportError` (`cli-error.ts`) rather than
 * through `output()`, and it has to honor `--format json` exactly as the success path does. Both write
 * stdout — AXI's stream for everything the agent consumes, errors included.
 */
export function isJsonOutput(): boolean {
	return getFormat() === 'json'
}

// True when the caller is a script or agent — suppress interactive prompts.
export function isAutomatedOutput(): boolean {
	const fmt = getFormat()
	return fmt === 'json' || fmt === 'agent'
}

export function output(data: unknown, readable: () => void): void {
	if (isJsonOutput()) printJson(data)
	else readable()
}
