import { describe, expect, it } from 'vitest'
import {
	type Adapter,
	discover,
	discoverAdapterNames,
	main,
	outcomeOf,
	project,
	type RunnerDeps,
	type SuiteReport,
	suitesFor,
	verify,
	vitestArgs,
} from './test-adapter.ts'

describe('spec:cyber-mux/conformance', () => {
	// The real src/ listing as it stands: four adapters, herdr carrying two integration suites,
	// wezterm and zellij carrying none, plus the unit tests and non-adapter modules that sit beside
	// them. Every discovery scenario reads from this so the fixtures cannot drift from the repo.
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
	}) {
		const runs: { name: string; suites: readonly string[] }[] = []
		const lines: string[] = []
		const deps: RunnerDeps = {
			listSrcFiles: () => opts.files ?? REAL_FILES,
			isInstalled: (name) => (opts.installed ?? []).includes(name),
			runSuites: (name, suites) => {
				runs.push({ name, suites })
				return opts.reports?.[name] ?? PASSING
			},
		}
		const run = (...argv: string[]) => main(argv, deps, (line) => lines.push(line))
		return { deps, runs, lines, run, out: () => lines.join('\n') }
	}

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

	it('conformance-all-reports-each-and-summarizes', () => {
		const { run, out } = harness({ installed: ['tmux', 'wezterm'], reports: { tmux: PASSING } })
		expect(run('--all')).toBe(1)
		const lines = out().split('\n')
		expect(lines.find((l) => l.startsWith('tmux'))).toContain('pass')
		expect(lines.find((l) => l.startsWith('herdr'))).toContain('skip')
		expect(lines.find((l) => l.startsWith('wezterm'))).toContain('gap')
		expect(lines.at(-1)).toMatch(/4 adapters —/)
		expect(lines.at(-1)).toContain('pass=1')
		expect(lines.at(-1)).toContain('gap=1')
	})

	it('conformance-all-exits-nonzero-on-any-bad-outcome', () => {
		// The outline's three rows: one adapter passes, a second ends gap / no-coverage / fail. Each
		// alone must decide the exit, so a buried bad outcome cannot be averaged away.
		const files = ['mux.tmux.ts', 'mux.tmux.integration.test.ts', 'mux.zellij.ts']

		// gap — zellij installed with no suite.
		expect(harness({ files, installed: ['tmux', 'zellij'] }).run('--all')).toBe(1)

		// no-coverage and fail — zellij given a suite, and a bad report.
		const withSuite = [...files, 'mux.zellij.integration.test.ts']
		for (const bad of [ALL_SKIPPED, FAILING]) {
			const { run } = harness({
				files: withSuite,
				installed: ['tmux', 'zellij'],
				reports: { tmux: PASSING, zellij: bad },
			})
			expect(run('--all')).toBe(1)
		}
	})

	it('conformance-all-exits-zero-when-nothing-bad', () => {
		// tmux passes, herdr is not installed. Skip must not be able to fail the run, or a machine
		// with one multiplexer could never report success.
		const files = ['mux.tmux.ts', 'mux.tmux.integration.test.ts', 'mux.herdr.ts', 'mux.herdr.integration.test.ts']
		const { run, out } = harness({ files, installed: ['tmux'], reports: { tmux: PASSING } })
		expect(run('--all')).toBe(0)
		expect(out()).toContain('skip')
	})

	it('conformance-unknown-flag-is-usage-error', () => {
		const { run, out } = harness({ installed: ['tmux'] })
		expect(run('--everything')).toBe(2)
		expect(out()).toContain('unrecognized flag: --everything')
		expect(out()).toContain('--all')
	})

	// ── the resolution seam itself ──

	it('verify routes each adapter state to its outcome', () => {
		const deps: RunnerDeps = {
			listSrcFiles: () => REAL_FILES,
			isInstalled: () => true,
			runSuites: () => PASSING,
		}
		expect(verify(adapter({ installed: false }), deps).outcome).toBe('skip')
		expect(verify(adapter({ suites: [] }), deps).outcome).toBe('gap')
		expect(verify(adapter(), deps).outcome).toBe('pass')
	})
})
