import { homedir } from 'node:os'
import { sep } from 'node:path'
import { type Answer, result } from 'clibuilder'

/**
 * Answers are clibuilder's own (`output: 'axi'`): a command RETURNS its answer, and core prints it once
 * on stdout in the caller's `--format` — TOON for `toon` (`--format agent`), one line for `json`. What
 * cyber-mux adds is the `text` form a person reads, given to core as the `text` renderer, so the machine
 * formats are core's encoders and the human one stays the aligned fields and tables it always was.
 */

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

/** `key  value` lines, keys aligned, nullish entries dropped. */
export function fields(record: Record<string, string | null | undefined>): string {
	const entries = Object.entries(record).filter(([, v]) => v != null) as [string, string][]
	if (entries.length === 0) return ''
	const width = Math.max(...entries.map(([k]) => k.length))
	return entries.map(([key, val]) => `${key.padEnd(width)}  ${val}`).join('\n')
}

/** An aligned table with an upper-case header and a rule under it, or `(none)` for no rows. */
export function table<T>(items: T[], cols: { label: string; get: (item: T) => string }[]): string {
	if (items.length === 0) return '(none)'
	const widths = cols.map((c) => Math.max(c.label.length, ...items.map((i) => c.get(i).length)))
	return [
		cols.map((c, i) => c.label.toUpperCase().padEnd(widths[i]!)).join('  '),
		widths.map((w) => '-'.repeat(w)).join('  '),
		...items.map((item) => cols.map((c, i) => c.get(item).padEnd(widths[i]!)).join('  ')),
	].join('\n')
}

/** Text blocks joined one per line, empty blocks dropped. */
export function lines(...blocks: string[]): string {
	return blocks.filter((b) => b !== '').join('\n')
}

/**
 * A #9 contextual-disclosure suggestion as one `help` line: what is worth doing, and the concrete
 * invocation that does it. Dynamic parts are the caller's OWN values (a name they passed, a branch they
 * named), never a guessed id.
 */
export function step(message: string, command: string): string {
	return `${message} — run \`${command}\``
}

/**
 * The answer `run()` returns: `value` for the machine formats, `text` for a person. `help` rides inside
 * the answer as `help[N]`, and is left out when empty — a self-contained result owes no suggestion
 * (#9's omit-when-self-contained rule).
 */
export function answer<T>(value: T, text: (value: T) => string, help: string[] = []): Answer {
	// Widened to `Answer`: a renderer of `T` is not a renderer of `unknown`, yet core only ever hands it this `value`.
	return result(value, { help, render: { text } }) as Answer
}
