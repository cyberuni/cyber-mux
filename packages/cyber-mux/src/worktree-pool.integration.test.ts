import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { acquire, muxWorktreeCreator, release, slotPath, toHarnessExec } from './worktree-pool.ts'

/**
 * `acquire` from `@cyberuni/agent-harness/worktrees`, driven against real git through cyber-mux's own
 * synchronous runner and creator — the integration the re-export exists for. No multiplexer: the
 * herdr bind is covered by the unit suite; this proves the library accepts what cyber-mux hands it.
 */
describe('spec:cyber-mux/mux/worktree — the leased pool against real git', () => {
	let parent: string
	let repo: string
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: 'cyber-mux test',
		GIT_AUTHOR_EMAIL: 'test@example.invalid',
		GIT_COMMITTER_NAME: 'cyber-mux test',
		GIT_COMMITTER_EMAIL: 'test@example.invalid',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_SYSTEM: '/dev/null',
	}
	const exec: Exec = (cmd, args) => {
		try {
			return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
		} catch {
			return null
		}
	}
	const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env })

	beforeAll(() => {
		parent = realpathSync(mkdtempSync(join(tmpdir(), 'cyber-mux-pool-')))
		repo = join(parent, 'repo')
		mkdirSync(repo)
		git('init', '--quiet', '--initial-branch=main')
		writeFileSync(join(repo, 'a.txt'), 'a\n')
		git('add', '.')
		git('commit', '--quiet', '-m', 'init')
	})

	afterAll(() => rmSync(parent, { recursive: true, force: true }))

	it('creates a slot through the mux creator, then reuses it after release', async () => {
		const options = {
			primaryRoot: repo,
			exec: toHarnessExec(exec),
			base: 'main',
			create: muxWorktreeCreator(undefined, { exec }),
			probe: {
				verified: true,
				occupancy: () => ({ busy: false, verified: true, occupants: [], lingering: [], unlinked: [] }),
			},
		}
		const first = await acquire({ ...options, holder: 'test-a' })
		expect(first.reused).toBe(false)
		expect(first.worktree).toBe(slotPath(repo, 1))

		expect(await release(first, { exec: options.exec })).toEqual({ released: true })

		const second = await acquire({ ...options, holder: 'test-b' })
		expect(second.reused).toBe(true)
		expect(second.worktree).toBe(first.worktree)
	})
})
