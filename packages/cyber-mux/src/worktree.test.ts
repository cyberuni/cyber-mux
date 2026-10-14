import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import {
	assertDistinctFromPrimary,
	gitWorktreeAdapter,
	removeWorktreeSafely,
	resolvePrimaryRoot,
	worktreeApi,
} from './worktree.ts'

describe('spec:cyber-mux/mux/worktree', () => {
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
			expect(() => gitWorktreeAdapter.remove(exec, '/repo/x', { primaryRoot: '/repo' })).toThrow(
				/worktree remove failed/,
			)
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

	describe('removeWorktreeSafely', () => {
		it('worktree remove tolerates a worktree already gone from disk', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return ''
			}
			expect(() =>
				removeWorktreeSafely(exec, '/repo/.worktrees/does-not-exist', { primaryRoot: '/repo' }),
			).not.toThrow()
			expect(calls).toEqual([])
		})

		it('refuses the primary checkout even with --force', () => {
			const exec: Exec = () => ''
			expect(() => removeWorktreeSafely(exec, '/repo', { primaryRoot: '/repo', force: true })).toThrow(
				/primary checkout/,
			)
		})

		// This module's own directory stands in for "a worktree that exists on disk" — existsSync is real,
		// so the dirty-check path needs a real path; git itself is fully faked via exec.
		const realExistingDir = new URL('.', import.meta.url).pathname

		it('worktree remove refuses uncommitted changes unless --force', () => {
			const exec: Exec = (_cmd, args) => (args[2] === 'status' ? ' M some/file' : '')
			// The refusal must NAME --force as the way to discard them — that clause is the whole
			// point of refusing rather than just failing.
			expect(() => removeWorktreeSafely(exec, realExistingDir, { primaryRoot: '/repo' })).toThrow(
				/uncommitted changes[\s\S]*--force/,
			)
		})

		it('worktree-remove-ignores-disposability-signal', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return ''
			}
			removeWorktreeSafely(exec, realExistingDir, { primaryRoot: '/repo' })
			expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'remove', realExistingDir, '--force'])
		})

		it('reads existence through the INJECTED fs seam, so a purely-fictional path can be driven', () => {
			// The seam: existence is asked of the injected WorktreeFs, never `node:fs` — so a fake disk
			// stands in and no real directory is needed to exercise the exists→remove path.
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return ''
			}
			const fs = { exists: (p: string) => p === '/fake/wt', realpath: (p: string) => p }
			removeWorktreeSafely(exec, '/fake/wt', { primaryRoot: '/repo', fs })
			expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'remove', '/fake/wt', '--force'])

			// And when the fake disk reports the checkout gone, git is never called — releaseBinding runs.
			let released = false
			const gitCalls: string[][] = []
			removeWorktreeSafely(
				(_cmd, args) => {
					gitCalls.push(args)
					return ''
				},
				'/fake/wt',
				{
					primaryRoot: '/repo',
					fs: { exists: () => false, realpath: (p: string) => p },
					releaseBinding: () => {
						released = true
					},
				},
			)
			expect(released).toBe(true)
			expect(gitCalls).toEqual([])
		})

		it('worktree remove --force discards uncommitted changes without the dirty check', () => {
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
			it('worktree-remove-refuses-dirty-before-release', () => {
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

			it('worktree-remove-releases-before-git', () => {
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

			it('worktree-remove-releases-orphan-binding', () => {
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

	describe('worktreeApi — the bound facade', () => {
		it('binds exec: primaryRoot() resolves through the bound runner, no exec threaded', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return args.includes('--git-common-dir') ? '/repo/.git' : ''
			}
			const wt = worktreeApi({ exec })
			expect(wt.primaryRoot()).toBe('/repo')
			expect(calls[0]).toEqual(['rev-parse', '--path-format=absolute', '--git-common-dir'])
		})

		it('add() delegates to the git adapter with the bound runner', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return ''
			}
			expect(worktreeApi({ exec }).add({ primaryRoot: '/repo', path: '/repo/x', branch: 'b' })).toEqual({
				root: '/repo/x',
				branch: 'b',
			})
			expect(calls[0]).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'b', '/repo/x'])
		})
	})
})
