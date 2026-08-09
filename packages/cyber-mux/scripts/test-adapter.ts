/**
 * The per-adapter conformance runner — spec: `.agents/spec/conformance/`.
 *
 * CI cannot install every multiplexer, so the real-boundary suites are verified by hand, per
 * platform. `pnpm test:integration` runs them all at once and cannot tell a skip from a pass; this
 * runner answers, per adapter: is this multiplexer here, is there a real-boundary suite for it, and
 * did that suite actually exercise anything.
 *
 * A maintainer tool — `scripts/` is absent from package.json `files`, so none of this ships.
 *
 * Everything the runner learns about the world arrives through `RunnerDeps`, so the whole decision
 * core is exercised in `test-adapter.test.ts` with no multiplexer installed and no vitest spawned.
 */

import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The verdict of actually verifying one adapter. */
export type Outcome = 'skip' | 'gap' | 'no-coverage' | 'pass' | 'fail'

/**
 * What the listing can honestly know without running anything. `pass`, `fail` and `no-coverage` are
 * findings OF a run, so the listing never claims one — `runnable` is the honest name for "this
 * machine can verify this adapter, and only running it will say how".
 */
export type Projected = 'skip' | 'gap' | 'runnable'

export interface Adapter {
	readonly name: string
	readonly suites: readonly string[]
	readonly installed: boolean
}

/** The counts a suite run reports. `collected` includes tests that never executed. */
export interface SuiteReport {
	readonly collected: number
	readonly passed: number
	readonly failed: number
	readonly skipped: number
}

export interface RunnerDeps {
	/** Every file name directly under `src/`. */
	listSrcFiles(): readonly string[]
	/** Whether a binary of this name is reachable on `PATH`. */
	isInstalled(name: string): boolean
	/** Run this adapter's suites through the integration config and report the counts. */
	runSuites(name: string, suites: readonly string[]): SuiteReport
}

export interface Reported {
	readonly adapter: Adapter
	readonly outcome: Outcome
	readonly report?: SuiteReport | undefined
}

/** The exit codes `axi.md` fixes: 0 success, 1 error, 2 usage error. */
const OK = 0
const ERR = 1
const USAGE = 2

const VALID_FLAGS = ['--all']

/** Outcomes that mean this machine could have verified something and it did not come out clean. */
const BAD: readonly Outcome[] = ['gap', 'no-coverage', 'fail']

/**
 * `mux.<name>.ts` where `<name>` carries no dot of its own — which is what keeps `mux.tmux.test.ts`
 * and `mux.tmux.integration.test.ts` out (their `<name>` would be `tmux.test`), and `mux.ts` out
 * (no `<name>` at all). Derivation, not a registry: a new adapter file needs no edit here.
 */
const ADAPTER_FILE = /^mux\.([a-z0-9-]+)\.ts$/

export function discoverAdapterNames(files: readonly string[]): string[] {
	const names = new Set<string>()
	for (const file of files) {
		const match = ADAPTER_FILE.exec(file)
		if (match?.[1]) names.add(match[1])
	}
	return [...names].sort()
}

/** Every `*.<name>.integration.test.ts` — an adapter may have several (herdr has two) or none. */
export function suitesFor(files: readonly string[], name: string): string[] {
	const suffix = `.${name}.integration.test.ts`
	return files.filter((file) => file.endsWith(suffix)).sort()
}

export function discover(deps: RunnerDeps): Adapter[] {
	const files = deps.listSrcFiles()
	return discoverAdapterNames(files).map((name) => ({
		name,
		suites: suitesFor(files, name),
		installed: deps.isInstalled(name),
	}))
}

export function project(adapter: Adapter): Projected {
	if (!adapter.installed) return 'skip'
	if (adapter.suites.length === 0) return 'gap'
	return 'runnable'
}

/**
 * A suite that collected tests and executed none is `no-coverage`, never a pass. This is the whole
 * point of the tool: vitest reports `success: true` and exits 0 for a fully-skipped suite, so the
 * executed count — not the exit code — is what says whether anything was actually verified.
 */
export function outcomeOf(report: SuiteReport): Outcome {
	if (report.passed + report.failed === 0) return 'no-coverage'
	return report.failed > 0 ? 'fail' : 'pass'
}

export function verify(adapter: Adapter, deps: RunnerDeps): Reported {
	if (!adapter.installed) return { adapter, outcome: 'skip' }
	if (adapter.suites.length === 0) return { adapter, outcome: 'gap' }
	const report = deps.runSuites(adapter.name, adapter.suites)
	return { adapter, outcome: outcomeOf(report), report }
}

function describe({ outcome, report }: Reported): string {
	switch (outcome) {
		case 'skip':
			return 'skip — not installed'
		case 'gap':
			return 'gap — installed, but no integration suite exists'
		case 'no-coverage':
			return `no-coverage — the suite ran but executed 0 tests (${report?.skipped ?? 0} skipped)`
		case 'pass':
			return `pass — ${(report?.passed ?? 0) + (report?.failed ?? 0)} executed`
		case 'fail':
			return `fail — ${report?.failed ?? 0} failed of ${(report?.passed ?? 0) + (report?.failed ?? 0)} executed`
	}
}

function pad(value: string, width: number): string {
	return value.padEnd(width, ' ')
}

/**
 * The whole CLI, as a function of its arguments and its dependencies. Returns the exit code and
 * writes through `out` rather than touching `process`, so every branch is directly testable.
 */
export function main(argv: readonly string[], deps: RunnerDeps, out: (line: string) => void): number {
	const flags = argv.filter((arg) => arg.startsWith('-'))
	const names = argv.filter((arg) => !arg.startsWith('-'))

	const unknownFlag = flags.find((flag) => !VALID_FLAGS.includes(flag))
	if (unknownFlag) {
		out(`unrecognized flag: ${unknownFlag}`)
		out(`valid flags: ${VALID_FLAGS.join(', ')}`)
		return USAGE
	}

	const adapters = discover(deps)
	if (adapters.length === 0) {
		out('found no adapters — the scan is not looking where the adapters are')
		return ERR
	}

	const known = adapters.map((a) => a.name)
	const unknownName = names.find((name) => !known.includes(name))
	if (unknownName) {
		out(`not a known adapter: ${unknownName}`)
		out(`known adapters: ${known.join(', ')}`)
		return USAGE
	}

	const width = Math.max(...known.map((n) => n.length))
	const all = flags.includes('--all')

	// The listing form: runs nothing, so it reports projections and never a run outcome. Its exit is
	// unconditional — a projected gap is a state of affairs it reports, not a verdict it passes.
	if (!all && names.length === 0) {
		for (const adapter of adapters) {
			const installed = adapter.installed ? 'installed' : 'not installed'
			out(`${pad(adapter.name, width)}  ${pad(installed, 13)}  suites=${adapter.suites.length}  ${project(adapter)}`)
		}
		out(`${adapters.length} adapters — run one with: pnpm test:adapter <adapter>, or all with --all`)
		return OK
	}

	const targets = all ? adapters : adapters.filter((a) => names.includes(a.name))
	const results = targets.map((adapter) => verify(adapter, deps))

	for (const result of results) {
		out(`${pad(result.adapter.name, width)}  ${describe(result)}`)
	}

	if (all) {
		const counts = new Map<Outcome, number>()
		for (const { outcome } of results) counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
		const summary = [...counts.entries()].map(([outcome, n]) => `${outcome}=${n}`).join(' ')
		out(`${results.length} adapters — ${summary}`)
	}

	return results.some(({ outcome }) => BAD.includes(outcome)) ? ERR : OK
}

/**
 * The vitest argv for one adapter's suites. Pure, and exported, so the contract that a run names the
 * integration config and *only this adapter's* suite files is asserted directly rather than inferred
 * from a spawn that a test cannot see.
 */
export function vitestArgs(suites: readonly string[], outFile: string): string[] {
	return [
		'vitest',
		'run',
		'--config',
		'vitest.integration.config.ts',
		...suites.map((suite) => join('src', suite)),
		'--reporter=json',
		`--outputFile=${outFile}`,
	]
}

/* c8 ignore start — the real-world seam; every decision above is tested through injected deps. */

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const PKG = fileURLToPath(new URL('..', import.meta.url))

function onPath(name: string): boolean {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
	for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
		if (!dir) continue
		for (const ext of exts) {
			try {
				accessSync(join(dir, name + ext), constants.X_OK)
				return true
			} catch {
				// keep looking
			}
		}
	}
	return false
}

function runVitest(_name: string, suites: readonly string[]): SuiteReport {
	const dir = mkdtempSync(join(tmpdir(), 'cyber-mux-adapter-'))
	const outFile = join(dir, 'report.json')
	try {
		try {
			execFileSync('npx', vitestArgs(suites, outFile), { cwd: PKG, stdio: ['ignore', 'inherit', 'inherit'] })
		} catch {
			// vitest exits non-zero on a failing suite; the JSON report is still what we read.
		}
		const raw = JSON.parse(readFileSync(outFile, 'utf8')) as {
			numTotalTests?: number
			numPassedTests?: number
			numFailedTests?: number
			numPendingTests?: number
		}
		return {
			collected: raw.numTotalTests ?? 0,
			passed: raw.numPassedTests ?? 0,
			failed: raw.numFailedTests ?? 0,
			skipped: raw.numPendingTests ?? 0,
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

export const realDeps: RunnerDeps = {
	listSrcFiles: () => readdirSync(SRC, { withFileTypes: true }).flatMap((e) => (e.isFile() ? [e.name] : [])),
	isInstalled: onPath,
	runSuites: runVitest,
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = main(process.argv.slice(2), realDeps, (line) => {
		process.stdout.write(`${line}\n`)
	})
}

/* c8 ignore stop */
