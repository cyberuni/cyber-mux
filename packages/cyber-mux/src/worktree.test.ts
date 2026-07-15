import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { assertDistinctFromPrimary, gitWorktreeAdapter, resolvePrimaryRoot } from './worktree.ts'

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
