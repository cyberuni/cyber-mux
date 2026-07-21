import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'

/**
 * The CLI-level half of the real-herdr boundary. `session.herdr.integration.test.ts` drives the
 * ADAPTER against the real binary; this drives the actual `cyber-mux` executable, because the one
 * frozen scenario it exists for is about the CLI's own output surface — which stream a help entry
 * lands on — and an adapter test cannot see a stream it never writes to.
 *
 * Pins `worktree.feature`'s "the lost-grouping note is a help entry on stdout, not a line on stderr".
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
	describe('cyber-mux worktree add — real herdr boundary, real binary', () => {
		const opened: string[] = []
		const scratch: string[] = []

		afterAll(() => {
			for (const id of opened) {
				try {
					herdrMuxAdapter.teardown(realExec, { id })
				} catch {
					// A pane the run never opened, or one herdr already reclaimed. Cleanup, not a contract.
				}
			}
			for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
		})

		it('reports the lost grouping as a help entry on stdout, leaving stderr empty and exiting 0', () => {
			const repoRoot = scratchRepo()
			scratch.push(repoRoot)

			// The pane the split lands on, opened in a workspace of this suite's own. `pane:right`
			// otherwise means "split whatever herdr considers CURRENT", which is either the caller's own
			// pane (running from inside herdr) or the UI-focused one — someone else's work in both
			// readings — and is nothing at all with no client attached, which is why this failed in CI
			// as `herdr pane split failed`.
			const host = herdrMuxAdapter.open(realExec, { cwd: repoRoot, launch: 'sh', at: 'workspace' })
			opened.push(host.id)

			// `CYBER_MUX` + `CYBER_MUX_PANE` is the documented fast-path: it pins the backend AND this
			// process's own pane identity, which `callerPane` turns into the split's explicit `from`.
			// So the split targets `host` by id, needing neither an ancestry walk nor a focused pane.
			const run = spawnSync(
				process.execPath,
				[cliEntry, 'worktree', 'add', '--branch', 'cyber-mux-itest-grouping', '--at', 'pane:right'],
				{
					cwd: repoRoot,
					encoding: 'utf8',
					env: { ...process.env, CYBER_MUX: 'herdr', CYBER_MUX_PANE: host.id },
				},
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
