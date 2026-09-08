/**
 * The per-adapter conformance runner — spec: `.agents/spec/conformance/`.
 *
 * `pnpm test:integration` runs every real-boundary suite at once, cannot select one adapter, and
 * cannot tell a skip from a pass — a suite whose every test self-skips makes vitest exit 0 reporting
 * success. This runner answers, per adapter: is this multiplexer here, is there a real-boundary
 * suite for it, and did that suite actually exercise anything.
 *
 * CI's live-backends job installs tmux, herdr, wezterm and zellij and runs those suites on every PR,
 * which is what makes the skip-versus-pass question matter more rather than less: a fully-skipped
 * suite reports green in a job that is now blocking. cmux and otty stay out of reach there — their
 * CLIs are clients of a GUI app — so verifying them stays local, per platform, per adapter.
 *
 * Two ways in, one definition of coverage. `--all` spawns vitest per adapter, which is the shape a
 * maintainer wants when selecting; `--report=<file>` reads the JSON report a single
 * `pnpm test:integration` already wrote, which is the shape CI wants — it keeps one vitest process
 * (and with it the `scripts/` suite, which no adapter owns), and costs a file read. `live-backends`
 * runs the second, so the executed-count rule below is what that job's green now means.
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
import { currentPane, type PaneMux } from '../src/mux-probe.ts'

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
	/** The multiplexer this shell is itself inside, if any. */
	insideMux(): PaneMux | undefined
	/** Parse the vitest JSON report at this path. Throws when it is unreadable or not JSON. */
	readReport(path: string): VitestReport
}

/**
 * The slice of vitest's JSON report this reads — one entry per suite FILE, each carrying one entry
 * per test with its status. Every field is optional because the report is another process's
 * artifact: a shape that carries no file, or a file that carries no test, is a report that executed
 * nothing, which is a finding this tool already has a name for rather than a crash.
 */
export interface VitestReport {
	readonly testResults?:
		| readonly {
				readonly name?: string | undefined
				readonly assertionResults?: readonly { readonly status?: string | undefined }[] | undefined
		  }[]
		| undefined
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

/**
 * `--report=<file>` — verify against a vitest JSON report this process did not produce, rather than
 * spawning vitest per adapter. Written `--report=<file>` and not `--report <file>` because a bare
 * positional here is an adapter name; keeping the value attached is what stops a path from being
 * read as one.
 */
const REPORT_FLAG = /^--report=(.*)$/

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

/**
 * Fold a whole-run vitest report down to one adapter's counts, by suite file name.
 *
 * This is what lets the executed-count rule above be applied to a report the runner did not produce
 * — `pnpm test:integration`'s, from a single vitest process covering every adapter at once. The
 * match is on the file name because that is all the two sides share: the report names absolute
 * paths, `suites` names bare file names, and both separators appear across the platforms this tool
 * runs on.
 *
 * A suite the report never mentions folds to all-zero, and `outcomeOf` calls that `no-coverage` —
 * which is right and is not an accident: an installed adapter whose suite the run never touched
 * verified exactly as much as one whose every test skipped itself.
 */
export function reportFor(report: VitestReport, suites: readonly string[]): SuiteReport {
	let collected = 0
	let passed = 0
	let failed = 0
	for (const file of report.testResults ?? []) {
		const path = (file.name ?? '').replace(/\\/g, '/')
		if (!suites.some((suite) => path === suite || path.endsWith(`/${suite}`))) continue
		for (const test of file.assertionResults ?? []) {
			collected++
			if (test.status === 'passed') passed++
			else if (test.status === 'failed') failed++
		}
	}
	// Anything neither passed nor failed did not execute, whatever vitest chose to call it.
	return { collected, passed, failed, skipped: collected - passed - failed }
}

/**
 * The same runner, sourcing its counts from an already-written report instead of spawning vitest.
 * Only `runSuites` moves: which adapters are installed, which have suites, and what an outcome
 * means all stay exactly as they are, which is what keeps the two modes from drifting into two
 * different definitions of coverage.
 */
export function reportDeps(deps: RunnerDeps, report: VitestReport): RunnerDeps {
	return { ...deps, runSuites: (_name, suites) => reportFor(report, suites) }
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

	const reportFlag = flags.find((flag) => REPORT_FLAG.test(flag))
	const reportPath = reportFlag ? (REPORT_FLAG.exec(reportFlag)?.[1] ?? '') : undefined

	const unknownFlag = flags.filter((flag) => flag !== reportFlag).find((flag) => !VALID_FLAGS.includes(flag))
	if (unknownFlag) {
		out(`unrecognized flag: ${unknownFlag}`)
		out(`valid flags: ${[...VALID_FLAGS, '--report=<file>'].join(', ')}`)
		return USAGE
	}

	if (reportPath === '') {
		out('--report needs the file to read: --report=<file>')
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
	// A report covers every adapter at once, so reading one with no adapter named IS the --all shape:
	// the listing form would otherwise swallow the invocation and report nothing about the run.
	const all = flags.includes('--all') || (reportPath !== undefined && names.length === 0)

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

	// Running a suite from inside ANY multiplexer is refused outright. The real-boundary suites drive
	// live multiplexers, and several verbs resolve against "the caller's own current pane" — from
	// inside herdr, `pane split --current` splits THIS pane and `focus()` yanks THIS focus. The rule
	// is deliberately blunt rather than per-adapter: a manual verification tool is run from a plain
	// shell, and "which cross-adapter combinations happen to be safe" is not a judgment worth
	// encoding. The listing above is exempt because it runs nothing, and so is `--report`, which reads
	// a run that already happened — refusing it would only stop a maintainer inside tmux from reading
	// a file.
	const inside = reportPath === undefined ? deps.insideMux() : undefined
	if (inside) {
		out(`refusing to run: this shell is inside ${inside}`)
		out('the real-boundary suites drive live multiplexers, and some verbs resolve against the')
		out("caller's own pane — run this from a plain shell outside any multiplexer")
		return ERR
	}

	let runDeps = deps
	if (reportPath !== undefined) {
		try {
			runDeps = reportDeps(deps, deps.readReport(reportPath))
		} catch (error) {
			out(`cannot read the vitest report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`)
			return ERR
		}
		out(`report — ${reportPath}`)
	}

	const targets = all ? adapters : adapters.filter((a) => names.includes(a.name))
	const results = targets.map((adapter) => verify(adapter, runDeps))

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
	// The same per-pane env contract detection itself uses (src/mux-probe.ts), not a second copy of
	// it — a new backend teaches this guard about itself by landing its adapter.
	insideMux: () => currentPane(process.env)?.mux,
	readReport: (path) => JSON.parse(readFileSync(path, 'utf8')) as VitestReport,
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = main(process.argv.slice(2), realDeps, (line) => {
		process.stdout.write(`${line}\n`)
	})
}

/* c8 ignore stop */
