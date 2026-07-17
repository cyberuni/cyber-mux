function printJson(data: unknown) {
	console.log(JSON.stringify(data, null, 2))
}

export function printFields(fields: Record<string, string | null | undefined>) {
	const entries = Object.entries(fields).filter(([, v]) => v != null) as [string, string][]
	if (entries.length === 0) return
	const width = Math.max(...entries.map(([k]) => k.length))
	for (const [key, val] of entries) {
		console.log(`${key.padEnd(width)}  ${val}`)
	}
}

export function printTable<T>(items: T[], cols: { label: string; get: (item: T) => string }[]) {
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
 * writer that owes it: a structured ERROR goes to stderr rather than through `output()` (which writes
 * stdout), and it has to honor `--format json` exactly as the success path does.
 */
export function isJsonOutput(): boolean {
	return getFormat() === 'json'
}

// True when the caller is a script or agent — suppress interactive prompts.
export function isAutomatedOutput(): boolean {
	const fmt = getFormat()
	return fmt === 'json' || fmt === 'agent'
}

export function output(data: unknown, readable: () => void) {
	if (isJsonOutput()) printJson(data)
	else readable()
}
