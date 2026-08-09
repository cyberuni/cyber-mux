import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { currentPane } from '../src/mux-probe.ts'
import { discoverAdapterNames, realDeps, suitesFor } from './test-adapter.ts'

/**
 * The real-boundary suite for `--all` — the runner driven as an actual subprocess against this
 * machine's actual multiplexers, with nothing faked.
 *
 * `--all` is the one form whose whole job is composition: detect the installed adapters and call
 * each one's real suites. Mocking that composition would assert only that a fake fan-out fans out —
 * the "green that verified nothing" this entire tool exists to refuse. So it is verified here or
 * not at all, and this file is opt-in (`pnpm test:integration`), never part of `pnpm test`.
 *
 * It self-skips in the two cases where it cannot run honestly:
 *
 *  - **inside a multiplexer** — the runner refuses to run suites there by design, so `--all` would
 *    report the refusal rather than an aggregate. (This is also why CI never runs it.)
 *  - **no adapter installed** — there would be nothing to aggregate.
 *
 * Running it drives every installed multiplexer for real, including creating and tearing down live
 * panes/workspaces on a shared server. That is the point, and it is why this is a by-hand suite.
 */

const RUNNER = fileURLToPath(new URL('./test-adapter.ts', import.meta.url))
const PKG = fileURLToPath(new URL('..', import.meta.url))

const inside = currentPane(process.env)?.mux
const installed = discoverAdapterNames(realDeps.listSrcFiles()).filter((name) => realDeps.isInstalled(name))

/** Run the real runner, capturing stdout and the exit code rather than throwing on non-zero. */
function runRunner(...args: string[]): { stdout: string; code: number } {
	try {
		const stdout = execFileSync('npx', ['tsx', RUNNER, ...args], {
			cwd: PKG,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		return { stdout, code: 0 }
	} catch (err) {
		const e = err as { stdout?: string; status?: number }
		return { stdout: e.stdout ?? '', code: e.status ?? 1 }
	}
}

describe.skipIf(Boolean(inside) || installed.length === 0)('spec:cyber-mux/conformance', () => {
	describe('--all — the real boundary', () => {
		it('conformance-all-reports-each-and-summarizes', () => {
			const { stdout } = runRunner('--all')

			// Every discovered adapter gets its own line, whatever this machine happens to have.
			const adapters = discoverAdapterNames(realDeps.listSrcFiles())
			for (const name of adapters) {
				expect(stdout).toMatch(new RegExp(`^${name}\\s`, 'm'))
			}

			// …followed by the summary of the outcome counts.
			const lines = stdout.trimEnd().split('\n')
			expect(lines.at(-1)).toMatch(new RegExp(`^${adapters.length} adapters — `))

			// The outcomes it reports are real, so they must agree with what this machine actually is:
			// an uninstalled adapter can only be `skip`, and an installed one with no suite `gap`.
			for (const name of adapters) {
				const line = lines.find((l) => l.startsWith(name)) ?? ''
				if (!realDeps.isInstalled(name)) expect(line).toContain('skip')
				else if (suitesFor(realDeps.listSrcFiles(), name).length === 0) expect(line).toContain('gap')
			}
		})

		it('conformance-all-exits-nonzero-on-any-bad-outcome', () => {
			// Driven against real state rather than a table of injected outcomes: whether this machine
			// yields a bad outcome is a fact about the machine, so the assertion is the IMPLICATION —
			// any gap/no-coverage/fail present ⟺ exit 1 — which holds on every machine.
			const { stdout, code } = runRunner('--all')
			const bad = /\b(gap|no-coverage|fail)\b/.test(stdout)
			expect(code).toBe(bad ? 1 : 0)
		})

		it('conformance-all-exits-zero-when-nothing-bad', () => {
			// The positive companion, verified through the one adapter that can be made to pass for
			// real. If this machine has no clean adapter, the claim is not checkable here and the test
			// says so rather than passing vacuously.
			const clean = installed.filter((name) => suitesFor(realDeps.listSrcFiles(), name).length > 0)
			if (clean.length === 0) {
				expect.unreachable('no installed adapter carries a real-boundary suite — cannot verify the clean path')
			}
			const { stdout, code } = runRunner(clean[0] as string)
			expect(stdout).toMatch(/\b(pass|no-coverage)\b/)
			// A genuine pass must exit 0; a no-coverage on this machine must exit 1. Both are real
			// answers about a real multiplexer — neither is asserted into existence.
			expect(code).toBe(/\bpass\b/.test(stdout) ? 0 : 1)
		})
	})
})
