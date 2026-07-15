import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import {
	assertDistinctFromPrimary,
	gitWorktreeAdapter,
	removeWorktreeSafely,
	resolvePrimaryRoot,
	resolveWorktreePath,
} from './worktree.ts'

describe('gitWorktreeAdapter', () => {
	it('add() runs git worktree add against the primary root and returns the new worktree', () => {
		const calls: string[][] = []
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return ''
		}
		const wt = gitWorktreeAdapter.add(exec, {
			primaryRoot: '/repo',
			path: '/repo/.worktrees/x',
			branch: 'b',
		})
		expect(calls[0]).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'b', '/repo/.worktrees/x'])
		expect(wt).toEqual({ root: '/repo/.worktrees/x', branch: 'b' })
	})

	it('add() throws (not a silent empty result) when git fails', () => {
		const exec: Exec = () => null
		expect(() => gitWorktreeAdapter.add(exec, { primaryRoot: '/repo', path: '/repo/x', branch: 'b' })).toThrow(
			/worktree add failed/,
		)
	})

	it('remove() runs git worktree remove against the primary root', () => {
		const calls: string[][] = []
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return ''
		}
		gitWorktreeAdapter.remove(exec, '/repo/x', { primaryRoot: '/repo' })
		expect(calls[0]).toEqual(['-C', '/repo', 'worktree', 'remove', '/repo/x', '--force'])
	})

	it('remove() throws when git fails', () => {
		const exec: Exec = () => null
		expect(() => gitWorktreeAdapter.remove(exec, '/repo/x', { primaryRoot: '/repo' })).toThrow(/worktree remove failed/)
	})
})

describe('resolvePrimaryRoot', () => {
	it('derives the primary root from --git-common-dir regardless of caller cwd', () => {
		const exec: Exec = () => '/repo/.git'
		expect(resolvePrimaryRoot(exec)).toBe('/repo')
	})

	it('throws clearly when not inside a git repository', () => {
		const exec: Exec = () => null
		expect(() => resolvePrimaryRoot(exec)).toThrow(/not inside a git repository/)
	})
})

describe('resolveWorktreePath', () => {
	it('resolves a sibling of the primary checkout, never nested inside it', () => {
		expect(resolveWorktreePath('/home/x/repo', 'my-branch')).toBe('/home/x/repo.worktrees/my-branch')
	})
})

describe('removeWorktreeSafely', () => {
	it('tolerates a worktree already gone from disk — no git call, no throw', () => {
		const calls: string[][] = []
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return ''
		}
		expect(() => removeWorktreeSafely(exec, '/repo/.worktrees/does-not-exist', { primaryRoot: '/repo' })).not.toThrow()
		expect(calls).toEqual([])
	})

	it('refuses the primary checkout even with --force', () => {
		const exec: Exec = () => ''
		expect(() => removeWorktreeSafely(exec, '/repo', { primaryRoot: '/repo', force: true })).toThrow(/primary checkout/)
	})

	// This module's own directory stands in for "a worktree that exists on disk" — existsSync is real,
	// so the dirty-check path needs a real path; git itself is fully faked via exec.
	const realExistingDir = new URL('.', import.meta.url).pathname

	it('refuses to discard uncommitted changes unless --force', () => {
		const exec: Exec = (_cmd, args) => (args[2] === 'status' ? ' M some/file' : '')
		expect(() => removeWorktreeSafely(exec, realExistingDir, { primaryRoot: '/repo' })).toThrow(/uncommitted changes/)
	})

	it('removes a clean worktree without needing --force', () => {
		const calls: string[][] = []
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return ''
		}
		removeWorktreeSafely(exec, realExistingDir, { primaryRoot: '/repo' })
		expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'remove', realExistingDir, '--force'])
	})

	it('--force skips the dirty check and removes anyway', () => {
		const calls: string[][] = []
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return args[2] === 'status' ? ' M some/file' : ''
		}
		removeWorktreeSafely(exec, realExistingDir, { primaryRoot: '/repo', force: true })
		expect(calls.some((c) => c[2] === 'status')).toBe(false)
		expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'remove', realExistingDir, '--force'])
	})
})

describe('assertDistinctFromPrimary — refuse the primary checkout', () => {
	it('passes when the worktree root differs from the primary', () => {
		expect(() => assertDistinctFromPrimary('/repo/.worktrees/x', '/repo')).not.toThrow()
	})

	it('refuses when the worktree root resolves onto the primary checkout', () => {
		expect(() => assertDistinctFromPrimary('/repo', '/repo')).toThrow(/primary checkout/)
	})

	it('refuses even when paths differ only by trailing slash / relative segments', () => {
		expect(() => assertDistinctFromPrimary('/repo/sub/..', '/repo')).toThrow(/primary checkout/)
	})
})
