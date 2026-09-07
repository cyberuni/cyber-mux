import { describe, expect, it } from 'vitest'
import type { PaneMux } from '../src/mux-probe.ts'
import {
	type Adapter,
	discover,
	discoverAdapterNames,
	main,
	outcomeOf,
	project,
	type RunnerDeps,
	reportFor,
	type SuiteReport,
	suitesFor,
	type VitestReport,
	verify,
	vitestArgs,
} from './test-adapter.ts'

describe('spec:cyber-mux/conformance', () => {
	// The fixture the frozen discovery scenarios name: four adapters, herdr carrying two integration
	// suites, wezterm and zellij carrying none, plus the unit tests and non-adapter modules beside
	// them. It is a test vector, not a mirror of src/ — the repo has since grown cmux and otty, and
	// `conformance-new-adapter-needs-no-edit` below leans on exactly that (cmux was discovered with
	// no edit to this runner, which is the claim that scenario exists to make).
	const REAL_FILES = [
		'mux.ts',
		'mux.tmux.ts',
		'mux.tmux.test.ts',
		'mux.tmux.integration.test.ts',
		'mux.herdr.ts',
		'mux.herdr.test.ts',
		'mux.herdr.integration.test.ts',
		'cli.herdr.integration.test.ts',
		'mux.wezterm.ts',
		'mux.wezterm.test.ts',
		'mux.zellij.ts',
		'mux.zellij.test.ts',
		'backend.ts',
		'exec.ts',
	]

	const PASSING: SuiteReport = { collected: 6, passed: 6, failed: 0, skipped: 0 }
	const ALL_SKIPPED: SuiteReport = { collected: 6, passed: 0, failed: 0, skipped: 6 }
	const FAILING: SuiteReport = { collected: 6, passed: 5, failed: 1, skipped: 0 }

	/**
	 * A runner wired to a fake world: a file listing, a set of installed binaries, and a per-adapter
	 * suite report. `runs` records every suite invocation, so "vitest was never invoked" is asserted
	 * against a fact rather than an absence of output.
	 */
	function harness(opts: {
		files?: readonly string[]
		installed?: readonly string[]
		reports?: Record<string, SuiteReport>
		inside?: PaneMux | undefined
		/** The vitest report `--report=<file>` finds at whatever path it is handed. */
		vitest?: VitestReport
		/** What reading that path throws instead, for the unreadable-report branch. */
		readError?: Error
	}) {
		const runs: { name: string; suites: readonly string[] }[] = []
		const reads: string[] = []
		const lines: string[] = []
		const deps: RunnerDeps = {
			listSrcFiles: () => opts.files ?? REAL_FILES,
			isInstalled: (name) => (opts.installed ?? []).includes(name),
			runSuites: (name, suites) => {
				runs.push({ name, suites })
				return opts.reports?.[name] ?? PASSING
			},
			insideMux: () => opts.inside,
			readReport: (path) => {
				reads.push(path)
				if (opts.readError) throw opts.readError
				return opts.vitest ?? {}
			},
		}
		const run = (...argv: string[]) => main(argv, deps, (line) => lines.push(line))
		return { deps, runs, reads, lines, run, out: () => lines.join('\n') }
	}

	/**
	 * A vitest JSON report, written the way vitest writes one: absolute paths, one entry per test
	 * carrying its status. `'skipped'` is what a `describe.skipIf` gate produces — the exact shape
	 * that makes vitest exit 0 having verified nothing.
	 */
	const vitestReport = (files: Record<string, readonly string[]>): VitestReport => ({
		testResults: Object.entries(files).map(([name, statuses]) => ({
			name: `/home/runner/work/cyber-mux/packages/cyber-mux/src/${name}`,
			assertionResults: statuses.map((status) => ({ status })),
		})),
	})

	const executed = (n: number) => Array.from({ length: n }, () => 'passed')
	const allSkipped = (n: number) => Array.from({ length: n }, () => 'skipped')

	const adapter = (over: Partial<Adapter> = {}): Adapter => ({
		name: 'tmux',
		suites: ['mux.tmux.integration.test.ts'],
		installed: true,
		...over,
	})

	// ── Discovery (shared sub-graph) ──

	it('conformance-adapters-derived-from-source', () => {
		expect(discoverAdapterNames(REAL_FILES)).toEqual(['herdr', 'tmux', 'wezterm', 'zellij'])
	})

	it('conformance-unit-test-is-not-an-adapter', () => {
		const names = discoverAdapterNames(['mux.tmux.ts', 'mux.tmux.test.ts'])
		expect(names).toContain('tmux')
		// `mux.tmux.test.ts` would yield the name `tmux.test`; the dot-free `<name>` keeps it out, and
		// `mux.ts` (no `<name>` at all) never enters either.
		expect(names).not.toContain('tmux.test')
		expect(discoverAdapterNames(['mux.ts'])).toEqual([])
	})

	it('conformance-new-adapter-needs-no-edit', () => {
		// An adapter this runner names nowhere. Only real filesystem derivation can find it — a
		// hardcoded table of today's four would pass every other discovery scenario and fail this one.
		const files = [...REAL_FILES, 'mux.cmux.ts']
		expect(discoverAdapterNames(files)).toContain('cmux')

		const probed: string[] = []
		discover({
			listSrcFiles: () => files,
			isInstalled: (name) => {
				probed.push(name)
				return false
			},
			runSuites: () => PASSING,
			insideMux: () => undefined,
			readReport: () => ({}),
		})
		expect(probed).toContain('cmux')
	})

	it('conformance-adapter-with-several-suites', () => {
		expect(suitesFor(REAL_FILES, 'herdr')).toEqual(['cli.herdr.integration.test.ts', 'mux.herdr.integration.test.ts'])
	})

	it('conformance-adapter-with-no-suite', () => {
		expect(suitesFor(REAL_FILES, 'wezterm')).toEqual([])
	})

	it('conformance-empty-discovery-is-an-error', () => {
		const { run, out } = harness({ files: ['backend.ts', 'exec.ts'] })
		expect(run()).toBe(1)
		expect(out()).toContain('found no adapters')
	})

	// ── test-adapter — the listing form ──

	it('conformance-listing-reports-installation', () => {
		const { run, out } = harness({ installed: ['tmux'] })
		expect(run()).toBe(0)
		expect(out()).toMatch(/tmux\s+installed\s+suites=1/)
		for (const absent of ['herdr', 'wezterm', 'zellij']) {
			expect(out()).toMatch(new RegExp(`${absent}\\s+not installed`))
		}
	})

	it('conformance-listing-projects-skip', () => {
		expect(project(adapter({ name: 'herdr', installed: false, suites: ['a', 'b'] }))).toBe('skip')
	})

	it('conformance-listing-projects-gap', () => {
		expect(project(adapter({ name: 'wezterm', installed: true, suites: [] }))).toBe('gap')
	})

	it('conformance-listing-projects-runnable', () => {
		expect(project(adapter({ installed: true, suites: ['mux.tmux.integration.test.ts'] }))).toBe('runnable')

		// And the listing form claims no run outcome, because it runs nothing at all.
		const { run, runs, out } = harness({ installed: ['tmux'] })
		expect(run()).toBe(0)
		expect(runs).toEqual([])
		expect(out()).toMatch(/tmux\s+installed\s+suites=1\s+runnable/)
		for (const claimed of ['pass', 'fail', 'no-coverage']) expect(out()).not.toContain(claimed)
	})

	it('conformance-listing-exits-zero-despite-a-gap', () => {
		// wezterm is installed and suiteless, so the listing projects a gap — and still exits 0. A
		// subject that reused --all's "any bad outcome exits 1" aggregation here would return 1.
		const { run, out } = harness({ installed: ['wezterm'] })
		expect(run()).toBe(0)
		expect(out()).toMatch(/wezterm\s+installed\s+suites=0\s+gap/)
	})

	it('conformance-listing-shows-gap-when-uninstalled', () => {
		// Nothing installed: the gap is still visible from a machine that cannot exercise it.
		const { run, out } = harness({ installed: [] })
		expect(run()).toBe(0)
		expect(out()).toMatch(/wezterm\s+not installed\s+suites=0/)
	})

	// ── test-adapter <adapter> — verify one adapter ──

	it('conformance-selects-only-that-adapters-suites', () => {
		const { run, runs } = harness({ installed: ['tmux', 'herdr'] })
		expect(run('tmux')).toBe(0)
		expect(runs).toHaveLength(1)
		expect(runs[0]?.suites).toEqual(['mux.tmux.integration.test.ts'])

		const args = vitestArgs(runs[0]?.suites ?? [], '/tmp/report.json')
		expect(args).toContain('vitest.integration.config.ts')
		const files = args.filter((arg) => arg.includes('integration.test.ts'))
		expect(files).toEqual(['src/mux.tmux.integration.test.ts'])
		expect(files.some((file) => file.includes('herdr'))).toBe(false)
	})

	it('conformance-uninstalled-skips', () => {
		const { run, runs, out } = harness({ installed: [] })
		expect(run('herdr')).toBe(0)
		expect(out()).toContain('skip')
		// herdr has two suites, so "nothing ran" is a decision about installation, not about coverage.
		expect(runs).toEqual([])
	})

	it('conformance-installed-without-suite-is-a-gap', () => {
		const { run, runs, out } = harness({ installed: ['wezterm'] })
		expect(run('wezterm')).toBe(1)
		expect(out()).toContain('gap')
		expect(runs).toEqual([])
	})

	it('conformance-all-skipped-is-no-coverage', () => {
		// The measured case: vitest reports success and exits 0 for a fully-skipped suite, so only the
		// executed count separates "verified nothing" from "verified everything".
		expect(outcomeOf(ALL_SKIPPED)).toBe('no-coverage')

		const { run, out } = harness({ installed: ['tmux'], reports: { tmux: ALL_SKIPPED } })
		expect(run('tmux')).toBe(1)
		expect(out()).toContain('no-coverage')
		expect(out()).toContain('6 skipped')
	})

	it('conformance-passing-suite-passes', () => {
		expect(outcomeOf(PASSING)).toBe('pass')
		const { run, out } = harness({ installed: ['tmux'], reports: { tmux: PASSING } })
		expect(run('tmux')).toBe(0)
		expect(out()).toContain('pass')
		expect(out()).toContain('6 executed')
	})

	it('conformance-failing-suite-fails', () => {
		expect(outcomeOf(FAILING)).toBe('fail')
		const { run, out } = harness({ installed: ['tmux'], reports: { tmux: FAILING } })
		expect(run('tmux')).toBe(1)
		expect(out()).toContain('fail')
	})

	it('conformance-unknown-adapter-is-usage-error', () => {
		const { run, out } = harness({ installed: ['tmux'] })
		// `screen` is recognized by cyber-mux as a mux and deliberately not drivable, so it has no
		// adapter file and is the name a caller is most likely to try.
		expect(run('screen')).toBe(2)
		expect(out()).toContain('not a known adapter: screen')
		for (const known of ['tmux', 'herdr', 'wezterm', 'zellij']) expect(out()).toContain(known)
	})

	// ── test-adapter --all — verify every installed adapter ──
	//
	// `--all`'s three scenarios are NOT verified here. Its whole job is composition — detect the
	// installed adapters and call each one's real suites — and a fan-out over faked deps would only
	// assert that a fake fan-out fans out. It is verified against the real boundary in
	// `test-adapter.integration.test.ts` (opt-in, `pnpm test:integration`) or not at all.

	it('conformance-unknown-flag-is-usage-error', () => {
		const { run, out } = harness({ installed: ['tmux'] })
		expect(run('--everything')).toBe(2)
		expect(out()).toContain('unrecognized flag: --everything')
		expect(out()).toContain('--all')
	})

	// ── test-adapter --report=<file> — the same rule, over a run that already happened ──
	//
	// This is the shape CI runs. `live-backends` keeps `pnpm cm test:integration` — one vitest
	// process over every suite, including `scripts/`, which no adapter owns and `--all` therefore
	// never runs — and then hands the JSON report here. Nothing about coverage is redefined: the
	// counts arrive from a file rather than a spawn, and `verify`/`outcomeOf` decide as before.

	// The discovery fixture above deliberately leaves wezterm and zellij suiteless, which is a `gap`
	// and a different question from this one. These rows are about a suite that EXISTS and did or did
	// not execute, so they run against the world `live-backends` actually installs: four adapters,
	// every one of them carrying a real-boundary suite.
	const CI_FILES = [...REAL_FILES, 'mux.wezterm.integration.test.ts', 'mux.zellij.integration.test.ts']
	const CI_INSTALLED = ['tmux', 'herdr', 'wezterm', 'zellij']

	const CI_RUN = {
		'mux.tmux.integration.test.ts': executed(18),
		'mux.herdr.integration.test.ts': executed(16),
		'cli.herdr.integration.test.ts': executed(1),
		'mux.wezterm.integration.test.ts': executed(7),
		'mux.zellij.integration.test.ts': executed(15),
	}

	it('conformance-report-folds-a-run-per-adapter', () => {
		const report = vitestReport({
			'mux.herdr.integration.test.ts': ['passed', 'failed', 'skipped'],
			'cli.herdr.integration.test.ts': ['passed'],
			'mux.tmux.integration.test.ts': executed(18),
		})
		// herdr's two suites fold together, and tmux's eighteen stay out of them.
		expect(reportFor(report, suitesFor(REAL_FILES, 'herdr'))).toEqual({
			collected: 4,
			passed: 2,
			failed: 1,
			skipped: 1,
		})
	})

	it('conformance-report-matches-a-suite-on-any-separator', () => {
		// The report names an absolute path from whatever platform produced it; `suites` names a bare
		// file name. Matching on the file name is what lets a Windows report be read anywhere.
		const report: VitestReport = {
			testResults: [
				{
					name: 'D:\\a\\cyber-mux\\packages\\cyber-mux\\src\\mux.tmux.integration.test.ts',
					assertionResults: [{ status: 'passed' }],
				},
			],
		}
		expect(reportFor(report, ['mux.tmux.integration.test.ts']).passed).toBe(1)
	})

	it('conformance-report-passes-when-every-installed-adapter-executed', () => {
		const { run, runs, reads, out } = harness({
			files: CI_FILES,
			installed: CI_INSTALLED,
			vitest: vitestReport(CI_RUN),
		})
		expect(run('--report=/tmp/report.json')).toBe(0)
		expect(reads).toEqual(['/tmp/report.json'])
		// The whole point of this mode: the counts come from the file, so vitest is never spawned again.
		expect(runs).toEqual([])
		expect(out()).toMatch(/tmux\s+pass — 18 executed/)
		expect(out()).toMatch(/zellij\s+pass — 15 executed/)
	})

	it('conformance-report-no-coverage-names-the-adapter-that-executed-nothing', () => {
		// Issue #125's run, exactly: zellij installed, its suite collected and skipped every test,
		// vitest exits 0 reporting success. Four passing neighbours do not average it away.
		const { run, out } = harness({
			files: CI_FILES,
			installed: CI_INSTALLED,
			vitest: vitestReport({ ...CI_RUN, 'mux.zellij.integration.test.ts': allSkipped(13) }),
		})
		expect(run('--report=/tmp/report.json')).toBe(1)
		expect(out()).toMatch(/zellij\s+no-coverage — the suite ran but executed 0 tests \(13 skipped\)/)
		expect(out()).toMatch(/tmux\s+pass/)
	})

	it('conformance-report-untouched-suite-is-no-coverage', () => {
		// An installed adapter whose suite the run never reached at all verified exactly as much as
		// one whose every test skipped itself, so it gets the same verdict.
		const { run, out } = harness({
			files: CI_FILES,
			installed: CI_INSTALLED,
			vitest: vitestReport({ ...CI_RUN, 'mux.wezterm.integration.test.ts': [] }),
		})
		expect(run('--report=/tmp/report.json')).toBe(1)
		expect(out()).toMatch(/wezterm\s+no-coverage/)
	})

	it('conformance-report-leaves-an-uninstalled-adapter-alone', () => {
		// The local guarantee, and the reason this mode can be demanded in CI without changing what a
		// developer sees: a machine without zellij skips it, silently, and the run still exits 0. Only
		// a machine that HAS the binary is asked to have covered it.
		const { run, out } = harness({
			files: CI_FILES,
			installed: ['tmux', 'herdr'],
			vitest: vitestReport({
				'mux.tmux.integration.test.ts': executed(18),
				'mux.herdr.integration.test.ts': executed(16),
				'cli.herdr.integration.test.ts': executed(1),
			}),
		})
		expect(run('--report=/tmp/report.json')).toBe(0)
		expect(out()).toMatch(/zellij\s+skip — not installed/)
		expect(out()).toMatch(/wezterm\s+skip — not installed/)
	})

	it('conformance-report-is-exempt-from-the-refusal', () => {
		// It reads a run that already happened, so it drives no multiplexer and endangers no pane.
		const { run, runs, out } = harness({
			installed: ['tmux'],
			inside: 'herdr',
			vitest: vitestReport({ 'mux.tmux.integration.test.ts': executed(18) }),
		})
		expect(run('--report=/tmp/report.json')).toBe(0)
		expect(out()).not.toContain('refusing to run')
		expect(runs).toEqual([])
	})

	it('conformance-report-without-a-file-is-a-usage-error', () => {
		const { run, reads, out } = harness({ installed: ['tmux'] })
		expect(run('--report=')).toBe(2)
		expect(out()).toContain('--report needs the file to read')
		expect(reads).toEqual([])
	})

	it('conformance-unreadable-report-is-an-error-not-a-pass', () => {
		// A report that cannot be read is the one thing this mode must never call a pass — it is the
		// same "nothing was verified" the tool exists to refuse, arriving one step earlier.
		const { run, out } = harness({
			installed: ['tmux'],
			readError: new Error('ENOENT: no such file or directory'),
		})
		expect(run('--report=/tmp/missing.json')).toBe(1)
		expect(out()).toContain('cannot read the vitest report at /tmp/missing.json')
		expect(out()).toContain('ENOENT')
	})

	// ── Refusing to run from inside a multiplexer ──

	it('conformance-refuses-inside-a-multiplexer', () => {
		// The outline's six rows: every backend cyber-mux can be inside. The rule is blunt on purpose
		// — being inside tmux blocks verifying herdr too, because "which cross-adapter combinations
		// happen to be safe" is not a judgment this tool encodes.
		for (const mux of ['tmux', 'herdr', 'wezterm', 'zellij', 'cmux', 'otty'] as const) {
			const { run, runs, out } = harness({ installed: ['tmux'], inside: mux })
			expect(run('tmux')).toBe(1)
			expect(out()).toContain(`refusing to run: this shell is inside ${mux}`)
			expect(runs).toEqual([])
		}
	})

	it('conformance-refuses-inside-a-multiplexer-for-all', () => {
		const { run, runs, out } = harness({ installed: ['tmux', 'herdr'], inside: 'herdr' })
		expect(run('--all')).toBe(1)
		expect(out()).toContain('refusing to run: this shell is inside herdr')
		expect(runs).toEqual([])
	})

	it('conformance-usage-error-outranks-the-refusal', () => {
		// A mistyped name is wrong however it was invoked. Answering "you are inside herdr" first
		// would send the caller to another terminal to retype the same typo.
		const { run, runs, out } = harness({ installed: ['tmux'], inside: 'herdr' })
		expect(run('screan')).toBe(2)
		expect(out()).toContain('not a known adapter: screan')
		expect(out()).not.toContain('refusing to run')
		expect(runs).toEqual([])
	})

	it('conformance-listing-is-exempt-from-the-refusal', () => {
		// The listing runs no suite, so it carries none of the risk the refusal exists to prevent.
		const { run, runs, out } = harness({ installed: ['tmux'], inside: 'herdr' })
		expect(run()).toBe(0)
		expect(out()).not.toContain('refusing to run')
		expect(out()).toMatch(/tmux\s+installed\s+suites=1\s+runnable/)
		expect(runs).toEqual([])
	})

	// ── the resolution seam itself ──

	it('verify routes each adapter state to its outcome', () => {
		const deps: RunnerDeps = {
			listSrcFiles: () => REAL_FILES,
			isInstalled: () => true,
			runSuites: () => PASSING,
			insideMux: () => undefined,
			readReport: () => ({}),
		}
		expect(verify(adapter({ installed: false }), deps).outcome).toBe('skip')
		expect(verify(adapter({ suites: [] }), deps).outcome).toBe('gap')
		expect(verify(adapter(), deps).outcome).toBe('pass')
	})
})
