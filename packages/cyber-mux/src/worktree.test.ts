import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import {
	assertDistinctFromPrimary,
	gitWorktreeAdapter,
	listWorktreesFromGit,
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

	it('add() passes a base as the start-point after the path', () => {
		const calls: string[][] = []
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return ''
		}
		gitWorktreeAdapter.add(exec, { primaryRoot: '/repo', path: '/repo/x', branch: 'b', base: 'origin/main' })
		expect(calls[0]).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'b', '/repo/x', 'origin/main'])
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

describe('listWorktreesFromGit', () => {
	// A real porcelain dump: the primary first, a linked worktree, a detached one, a stale one, and
	// the trailing blank line git actually emits.
	const porcelain = [
		'worktree /repo',
		'HEAD 1111111111111111111111111111111111111111',
		'branch refs/heads/main',
		'',
		'worktree /repo.worktrees/x',
		'HEAD 2222222222222222222222222222222222222222',
		'branch refs/heads/feat/x',
		'',
		'worktree /repo.worktrees/spike',
		'HEAD 3333333333333333333333333333333333333333',
		'detached',
		'',
		'worktree /repo.worktrees/gone',
		'HEAD 4444444444444444444444444444444444444444',
		'branch refs/heads/gone',
		'prunable gitdir file points to non-existent location',
		'',
	].join('\n')

	const listing = (out: string | null) => listWorktreesFromGit(() => out, '/repo')

	it('reads every worktree of the repo, primary included', () => {
		expect(listing(porcelain).map((w) => w.root)).toEqual([
			'/repo',
			'/repo.worktrees/x',
			'/repo.worktrees/spike',
			'/repo.worktrees/gone',
		])
	})

	it('strips the refs/heads/ prefix from the branch', () => {
		expect(listing(porcelain)[1]).toMatchObject({ branch: 'feat/x', linked: true, prunable: false })
	})

	it('marks only the primary checkout as unlinked', () => {
		expect(listing(porcelain).map((w) => w.linked)).toEqual([false, true, true, true])
	})

	it('reports a detached HEAD as a worktree with no branch', () => {
		expect(listing(porcelain)[2]).toMatchObject({ branch: undefined, linked: true })
	})

	it('reports a stale entry as prunable', () => {
		expect(listing(porcelain)[3]).toMatchObject({ branch: 'gone', prunable: true })
	})

	it('reports a bare entry as a worktree with no branch', () => {
		const out = ['worktree /repo/bare', 'bare', ''].join('\n')
		expect(listing(out)).toEqual([{ root: '/repo/bare', branch: undefined, linked: true, prunable: false }])
	})

	it('returns nothing when git says nothing', () => {
		expect(listing(null)).toEqual([])
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

	describe('releaseBinding ordering', () => {
		it('does NOT release the binding when the dirty check refuses — a refused removal has no side effect', () => {
			const exec: Exec = (_cmd, args) => (args[2] === 'status' ? ' M some/file' : '')
			let released = false
			expect(() =>
				removeWorktreeSafely(exec, realExistingDir, {
					primaryRoot: '/repo',
					releaseBinding: () => {
						released = true
					},
				}),
			).toThrow(/uncommitted changes/)
			expect(released).toBe(false)
		})

		it('does NOT release the binding when the primary checkout is refused', () => {
			let released = false
			expect(() =>
				removeWorktreeSafely(() => '', '/repo', {
					primaryRoot: '/repo',
					force: true,
					releaseBinding: () => {
						released = true
					},
				}),
			).toThrow(/primary checkout/)
			expect(released).toBe(false)
		})

		it('releases the binding BEFORE git removes the checkout — no workspace left on a dead directory', () => {
			const order: string[] = []
			const exec: Exec = (_cmd, args) => {
				if (args[2] === 'worktree') order.push('git-remove')
				return ''
			}
			removeWorktreeSafely(exec, realExistingDir, {
				primaryRoot: '/repo',
				releaseBinding: () => order.push('release'),
			})
			expect(order).toEqual(['release', 'git-remove'])
		})

		it('releases the binding of a checkout already gone from disk, still without a git removal', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return ''
			}
			let released = false
			removeWorktreeSafely(exec, '/repo/.worktrees/does-not-exist', {
				primaryRoot: '/repo',
				releaseBinding: () => {
					released = true
				},
			})
			expect(released).toBe(true)
			expect(calls).toEqual([])
		})
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
