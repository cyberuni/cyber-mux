import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { WorktreeWorkspace } from './mux.ts'
import { muxWorktreeCreator, toHarnessExec } from './worktree-pool.ts'

const HERDR_WORKTREE_OUT = JSON.stringify({
	result: {
		root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' },
		workspace: { workspace_id: 'w9' },
		worktree: { path: '/repo.worktrees/repo-1', branch: 'feat/x' },
	},
})

/** Records every call; answers by the joined invocation's prefix, `''` otherwise. */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (cmd, args) => {
		calls.push([cmd, ...args])
		const key = [cmd, ...args].join(' ')
		const match = Object.keys(responses).find((prefix) => key.startsWith(prefix))
		return match === undefined ? '' : responses[match]!
	}
}

const REQUEST = { primaryRoot: '/repo', path: '/repo.worktrees/repo-1', base: 'origin/main', branch: 'feat/x' }

describe('toHarnessExec', () => {
	it('resolves what the synchronous runner returns, null included', async () => {
		const exec = toHarnessExec((cmd, args) => (cmd === 'git' ? args.join(' ') : null))
		await expect(exec('git', ['status'])).resolves.toBe('status')
		await expect(exec('herdr', [])).resolves.toBeNull()
	})
})

describe('muxWorktreeCreator', () => {
	it('creates with git and opens nothing on a backend that does not bind', async () => {
		const calls: string[][] = []
		await muxWorktreeCreator(tmuxMuxAdapter, { exec: fakeExec(calls, { 'git -C /repo rev-parse --verify': null }) })(
			REQUEST,
		)
		expect(calls.filter(([cmd]) => cmd !== 'git')).toEqual([])
		expect(calls.at(-1)).toEqual([
			'git',
			'-C',
			'/repo',
			'worktree',
			'add',
			'--quiet',
			'-b',
			'feat/x',
			'/repo.worktrees/repo-1',
			'origin/main',
		])
	})

	it('creates with git and opens nothing when there is no multiplexer', async () => {
		const calls: string[][] = []
		await muxWorktreeCreator(undefined, { exec: fakeExec(calls) })(REQUEST)
		expect(calls.every(([cmd]) => cmd === 'git')).toBe(true)
	})

	it('binds the new checkout through herdr worktree open, after git created it', async () => {
		const calls: string[][] = []
		const bound: WorktreeWorkspace[] = []
		await muxWorktreeCreator(herdrMuxAdapter, {
			exec: fakeExec(calls, { 'herdr worktree open': HERDR_WORKTREE_OUT }),
			label: 'unit-x',
			onBound: (b) => bound.push(b),
		})(REQUEST)
		const add = calls.findIndex(([cmd, , , sub, verb]) => cmd === 'git' && sub === 'worktree' && verb === 'add')
		const open = calls.findIndex(([cmd, sub, verb]) => cmd === 'herdr' && sub === 'worktree' && verb === 'open')
		expect(add).toBeGreaterThanOrEqual(0)
		expect(open).toBeGreaterThan(add)
		expect(calls[open]).toEqual([
			'herdr',
			'worktree',
			'open',
			'--cwd',
			'/repo',
			'--path',
			'/repo.worktrees/repo-1',
			'--label',
			'unit-x',
			'--no-focus',
		])
		expect(bound.map((b) => b.workspace)).toEqual(['w9'])
	})

	it('does not bind when git fails to create the checkout', async () => {
		const calls: string[][] = []
		const create = muxWorktreeCreator(herdrMuxAdapter, {
			exec: fakeExec(calls, { 'git -C /repo worktree add': null }),
		})
		await expect(create(REQUEST)).rejects.toThrow('git worktree add failed')
		expect(calls.some(([cmd]) => cmd === 'herdr')).toBe(false)
	})

	it('throws when the bind fails, after the checkout exists', async () => {
		const calls: string[][] = []
		const create = muxWorktreeCreator(herdrMuxAdapter, {
			exec: fakeExec(calls, { 'herdr worktree open': null }),
		})
		await expect(create(REQUEST)).rejects.toThrow('herdr worktree open failed')
	})
})
