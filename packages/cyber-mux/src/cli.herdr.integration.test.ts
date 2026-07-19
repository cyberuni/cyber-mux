import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrSessionAdapter } from './session.herdr.ts'

/**
 * The CLI-level half of the real-herdr boundary. `session.herdr.integration.test.ts` drives the
 * ADAPTER against the real binary; this drives the actual `cyber-mux` executable, because the one
 * frozen scenario it exists for is about the CLI's own output surface — which stream a help entry
 * lands on — and an adapter test cannot see a stream it never writes to.
 *
 * Pins `mux.feature`'s "the lost-grouping note is a help entry on stdout, not a line on stderr".
 * At #40's impl gate (PR #41) that scenario could not be stood up live and was verified by source
 * re-derivation plus a mutation backstop against the mocked-Exec CLI test; #44 asked for the live
 * pass. This is it.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = join(packageRoot, 'bin', 'cyber-mux.mjs')
const cliBundle = join(packageRoot, 'dist', 'cli.mjs')

function hasHerdr(): boolean {
	try {
		execFileSync('herdr', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * `bin/cyber-mux.mjs` imports `dist/cli.mjs`, so this suite needs a BUILT package — it drives the
 * shipped executable, not the sources. Skipped rather than failed when the bundle is absent: an
 * unbuilt tree is a missing precondition, not a broken contract. CI builds before running it.
 */
const runnable = hasHerdr() && existsSync(cliBundle)

/**
 * `--at pane:right` splits whatever pane herdr considers current — the CALLER's own when this runs
 * from inside a herdr pane. Gated exactly like the adapter suite's `pane:right` block: it executes
 * only from a plain shell outside any herdr pane (`HERDR_PANE_ID` unset), which is what CI is.
 */
const insideHerdrPane = Boolean(process.env.HERDR_PANE_ID)

const realExec: Exec = (cmd, args) => {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	} catch {
		return null
	}
}

function scratchRepo(): string {
	const repoRoot = mkdtempSync(join(tmpdir(), 'cyber-mux-cli-itest-repo-'))
	execFileSync('git', ['init', '-q', repoRoot])
	execFileSync('git', [
		'-C',
		repoRoot,
		'-c',
		'user.email=itest@cyber-mux.local',
		'-c',
		'user.name=cyber-mux itest',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'init',
	])
	return repoRoot
}

/** The `pane: <id>` line the text renderer prints — how cleanup finds what the run opened. */
function paneIdFrom(stdout: string): string | undefined {
	return /^pane:\s*(\S+)$/m.exec(stdout)?.[1]
}

describe.skipIf(!runnable)('spec:cyber-mux/mux', () => {
	describe.skipIf(insideHerdrPane)('cyber-mux worktree add — real herdr boundary, real binary', () => {
		const opened: string[] = []
		const scratch: string[] = []

		afterAll(() => {
			for (const id of opened) {
				try {
					herdrSessionAdapter.teardown(realExec, { id })
				} catch {
					// A pane the run never opened, or one herdr already reclaimed. Cleanup, not a contract.
				}
			}
			for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
		})

		it('reports the lost grouping as a help entry on stdout, leaving stderr empty and exiting 0', () => {
			const repoRoot = scratchRepo()
			scratch.push(repoRoot)

			// `CYBER_MUX=herdr` is the documented fast-path override — it pins the backend rather than
			// letting detection walk an ancestry that, outside a herdr pane, would not find one.
			const run = spawnSync(
				process.execPath,
				[cliEntry, 'worktree', 'add', '--branch', 'cyber-mux-itest-grouping', '--at', 'pane:right'],
				{ cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CYBER_MUX: 'herdr' } },
			)

			const paneId = paneIdFrom(run.stdout ?? '')
			if (paneId) opened.push(paneId)

			expect(run.status).toBe(0)
			// The whole point of the scenario: the note is NOT on the stream the agent does not read.
			expect(run.stderr).toBe('')
			// The help block itself, and the flag that would have grouped what was opened.
			expect(run.stdout).toMatch(/^help\[\d+]:/m)
			expect(run.stdout).toContain('--at workspace')
		})
	})
})
