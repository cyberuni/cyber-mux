import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import {
	assertDistinctFromPrimary,
	ghForgeMergedProbe,
	gitWorktreeAdapter,
	isWorktreeRemovable,
	listWorktreesFromGit,
	provisionWorktree,
	pruneWorktrees,
	removeWorktreeSafely,
	resolvePrimaryRoot,
	resolveWorktreePath,
	type WorktreeEntry,
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

		/**
		 * `listWorktreesFromGit` runs four DIFFERENT git commands, so a fake that answers every call with
		 * one string would feed the porcelain dump to `status` too. Route by verb; every signal read
		 * defaults to `null` (git could not say) so a test opts INTO a signal rather than inheriting one.
		 */
		const gitFake = (answers: {
			porcelain: string | null
			originHead?: string | null
			merged?: string | null
			status?: (root: string) => string | null
		}): Exec => {
			return (_cmd, args) => {
				if (args.includes('symbolic-ref')) return answers.originHead ?? null
				if (args.includes('branch')) return answers.merged ?? null
				if (args.includes('status')) return answers.status?.(args[1]!) ?? null
				return answers.porcelain
			}
		}

		const listing = (out: string | null) => listWorktreesFromGit(gitFake({ porcelain: out }), '/repo')

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
			// The `branch` key is OMITTED (absent), not carried as an explicit `undefined` — a detached
			// HEAD has no branch, and under exactOptionalPropertyTypes `branch?` is an absent-or-present field.
			const detached = listing(porcelain)[2]!
			expect(detached).toMatchObject({ linked: true })
			expect(detached).not.toHaveProperty('branch')
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

	describe('listWorktreesFromGit disposability signals', () => {
		// The primary on `main`, plus one linked worktree per case the signal has to survive.
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/landed',
			'branch refs/heads/feat/landed',
			'',
			'worktree /repo.worktrees/open',
			'branch refs/heads/feat/open',
			'',
			'worktree /repo.worktrees/spike',
			'detached',
			'',
			'worktree /repo.worktrees/gone',
			'branch refs/heads/feat/gone',
			'prunable gitdir file points to non-existent location',
			'',
		].join('\n')

		const gitFake = (answers: {
			originHead?: string | null
			merged?: string | null
			status?: (root: string) => string | null
			calls?: string[][]
		}): Exec => {
			return (_cmd, args) => {
				answers.calls?.push(args)
				if (args.includes('symbolic-ref')) return answers.originHead ?? null
				if (args.includes('branch')) return answers.merged ?? null
				if (args.includes('status')) return answers.status?.(args[1]!) ?? null
				return porcelain
			}
		}

		const byRoot = (exec: Exec) => new Map(listWorktreesFromGit(exec, '/repo').map((w) => [w.root, w]))

		it('reports a merged, clean worktree as removable', () => {
			const entries = byRoot(
				gitFake({
					originHead: 'origin/main',
					merged: 'main\nfeat/landed',
					status: () => '',
				}),
			)
			expect(entries.get('/repo.worktrees/landed')).toMatchObject({ merged: true, dirty: false })
			expect(isWorktreeRemovable(entries.get('/repo.worktrees/landed')!)).toBe(true)
		})

		it('a merged worktree with uncommitted changes is not removable', () => {
			const entries = byRoot(
				gitFake({
					originHead: 'origin/main',
					merged: 'main\nfeat/landed',
					status: (root) => (root === '/repo.worktrees/landed' ? ' M src/a.ts' : ''),
				}),
			)
			expect(entries.get('/repo.worktrees/landed')).toMatchObject({ merged: true, dirty: true })
			expect(isWorktreeRemovable(entries.get('/repo.worktrees/landed')!)).toBe(false)
		})

		it('an unmerged worktree is not removable however clean it is', () => {
			const entries = byRoot(gitFake({ originHead: 'origin/main', merged: 'main', status: () => '' }))
			expect(entries.get('/repo.worktrees/open')).toMatchObject({ merged: false, dirty: false })
			expect(isWorktreeRemovable(entries.get('/repo.worktrees/open')!)).toBe(false)
		})

		it('worktree-disposability-absent-not-false', () => {
			const entries = byRoot(gitFake({ originHead: 'origin/main', merged: 'main', status: () => '' }))
			const spike = entries.get('/repo.worktrees/spike')!
			expect(spike.merged).toBeUndefined()
			expect(spike.dirty).toBe(false)
			expect(isWorktreeRemovable(spike)).toBe(false)
		})

		it('worktree-disposability-absent-not-false', () => {
			const calls: string[][] = []
			const entries = byRoot(gitFake({ originHead: 'origin/main', merged: 'main\nfeat/gone', status: () => '', calls }))
			const gone = entries.get('/repo.worktrees/gone')!
			expect(gone.dirty).toBeUndefined()
			// The one place the per-worktree cost is skipped: there is no directory to stat.
			expect(calls.filter((args) => args.includes('status')).map((args) => args[1])).not.toContain(
				'/repo.worktrees/gone',
			)
			// A gone checkout says `(gone)` on ROOT; it must never also claim `(removable)`.
			expect(isWorktreeRemovable(gone)).toBe(false)
		})

		it('worktree-merged-against-resolved-default', () => {
			const calls: string[][] = []
			byRoot(gitFake({ originHead: null, merged: 'main\nfeat/landed', status: () => '', calls }))
			const mergedCall = calls.find((args) => args.includes('--merged'))!
			expect(mergedCall.at(-1)).toBe('main')
		})

		it('worktree-merged-against-resolved-default', () => {
			// A detached primary with no origin: nothing to compare against, so nothing is claimed.
			const detachedPrimary = [
				'worktree /repo',
				'detached',
				'',
				'worktree /repo.worktrees/x',
				'branch refs/heads/x',
				'',
			].join('\n')
			const entries = listWorktreesFromGit((_cmd, args) => {
				if (args.includes('symbolic-ref')) return null
				if (args.includes('branch')) throw new Error('git branch --merged must not run without a target')
				if (args.includes('status')) return ''
				return detachedPrimary
			}, '/repo')
			expect(entries.every((w) => w.merged === undefined)).toBe(true)
		})

		it('leaves the signal absent, never false, when git refuses to answer', () => {
			const entries = byRoot(gitFake({ originHead: 'origin/main', merged: null, status: () => null }))
			const landed = entries.get('/repo.worktrees/landed')!
			expect(landed.merged).toBeUndefined()
			expect(landed.dirty).toBeUndefined()
			expect(isWorktreeRemovable(landed)).toBe(false)
		})

		it('reads the whole repo merge set in one batched call', () => {
			const calls: string[][] = []
			byRoot(gitFake({ originHead: 'origin/main', merged: 'main', status: () => '', calls }))
			expect(calls.filter((args) => args.includes('--merged'))).toHaveLength(1)
		})
	})

	/**
	 * The layered landed-signals (issue #151). `git branch --merged` cannot see a squash merge — the
	 * squash commit on the target is a rewritten tip with no ancestry link — so a squash-merging repo
	 * under-reports every reusable worktree and a pool built on `provision` only ever creates. These
	 * cover the layers as LAYERS: cost order, positive-only composition, and the guard that outranks
	 * every one of them.
	 */
	describe('landed signals — layered, positive-only', () => {
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/squashed',
			'branch refs/heads/feat/squashed',
			'',
			'worktree /repo.worktrees/deleted',
			'branch refs/heads/feat/deleted',
			'',
			'worktree /repo.worktrees/open',
			'branch refs/heads/feat/open',
			'',
		].join('\n')

		/**
		 * A fake that answers every git verb the layered read runs, routed by VERB rather than by a
		 * substring of the whole argv — the layers share words (`branch` appears in `--merged` and in a
		 * ref name), and a fake that guessed would silently feed one layer another layer's answer.
		 *
		 * `commit-tree` hands back a synthetic id that names the branch it collapsed, which is what lets
		 * `cherry` answer per branch — the same coupling real git has, where the id is the only thing
		 * carried from one call to the next.
		 */
		const gitFake = (answers: {
			originHead?: string | null
			merged?: string | null
			gone?: string[] | null
			squashApplied?: string[]
			status?: (root: string) => string | null
			calls?: string[][]
		}): Exec => {
			return (_cmd, args) => {
				answers.calls?.push(args)
				const verb = args[0] === '-C' ? args[2] : args[0]
				switch (verb) {
					case 'symbolic-ref':
						return answers.originHead === undefined ? 'origin/main' : answers.originHead
					case 'branch':
						return answers.merged === undefined ? 'main' : answers.merged
					case 'status':
						return answers.status?.(args[1]!) ?? ''
					case 'for-each-ref':
						if (answers.gone === null) return null
						return ['main', 'feat/squashed', 'feat/deleted', 'feat/open']
							.map((name) => `${name}\t${answers.gone?.includes(name) ? '[gone]' : ''}`)
							.join('\n')
					case 'merge-base':
						return `base-${args[4]}`
					case 'commit-tree':
						// args[3] is `<branch>^{tree}` — carry the branch into the id so `cherry` can answer.
						return `synthetic-${args[3]!.replace('^{tree}', '')}`
					case 'cherry': {
						const branch = args[4]!.replace('synthetic-', '')
						return answers.squashApplied?.includes(branch) ? `- ${branch}` : `+ ${branch}`
					}
					default:
						return porcelain
				}
			}
		}

		const byRoot = (exec: Exec, signals?: Parameters<typeof listWorktreesFromGit>[3]) =>
			new Map(listWorktreesFromGit(exec, '/repo', undefined, signals).map((w) => [w.root, w]))

		it('worktree-landed-layered-signals', () => {
			// Layer 1 still answers first and still names itself, so the pre-#151 behavior is intact.
			const entries = byRoot(gitFake({ merged: 'main\nfeat/squashed' }))
			expect(entries.get('/repo.worktrees/squashed')).toMatchObject({ merged: true, mergedSignal: 'ancestor' })
		})

		it('worktree-landed-layered-signals', () => {
			// Layer 2: the forge merged the PR and deleted the head branch, so the remote-tracking ref is
			// `[gone]`. No ancestry link exists and none is needed.
			const entries = byRoot(gitFake({ merged: 'main', gone: ['feat/deleted'] }))
			expect(entries.get('/repo.worktrees/deleted')).toMatchObject({ merged: true, mergedSignal: 'upstream-gone' })
			expect(isWorktreeRemovable(entries.get('/repo.worktrees/deleted')!)).toBe(true)
		})

		it('worktree-landed-layered-signals', () => {
			// Layer 3: the branch collapsed to one synthetic commit is already applied on the target — the
			// squash merge git's own `--merged` is structurally blind to.
			const entries = byRoot(gitFake({ merged: 'main', squashApplied: ['feat/squashed'] }))
			expect(entries.get('/repo.worktrees/squashed')).toMatchObject({ merged: true, mergedSignal: 'squash-patch' })
			expect(isWorktreeRemovable(entries.get('/repo.worktrees/squashed')!)).toBe(true)
		})

		it('worktree-landed-signals-cost-order', () => {
			// Cost order is a PROPERTY, not an accident: a branch layer 2 already cleared must never pay
			// for layer 3's per-branch plumbing, and the two cheap layers are each read once for the
			// whole repo rather than once per worktree.
			const calls: string[][] = []
			byRoot(gitFake({ merged: 'main', gone: ['feat/deleted'], squashApplied: ['feat/squashed'], calls }))
			expect(calls.filter((args) => args.includes('--merged'))).toHaveLength(1)
			expect(calls.filter((args) => args.includes('for-each-ref'))).toHaveLength(1)
			expect(calls.filter((args) => args.includes('merge-base')).map((args) => args[4])).not.toContain('feat/deleted')
		})

		it('worktree-landed-signal-positive-only', () => {
			// A squash the heuristic cannot match — conflict-resolved or hand-edited on the way in — is the
			// case that MUST degrade to "not reusable" rather than to a false positive.
			const entries = byRoot(gitFake({ merged: 'main', squashApplied: [] }))
			const squashed = entries.get('/repo.worktrees/squashed')!
			expect(squashed.merged).toBe(false)
			expect(squashed.mergedSignal).toBeUndefined()
			expect(isWorktreeRemovable(squashed)).toBe(false)
		})

		it('worktree-landed-signal-positive-only', () => {
			// Every layer silent and layer 1 unable to answer: undeterminable stays ABSENT, never `false`,
			// and an absent signal is never removable.
			const entries = byRoot(gitFake({ merged: null, gone: null }))
			const open = entries.get('/repo.worktrees/open')!
			expect(open.merged).toBeUndefined()
			expect(open.mergedSignal).toBeUndefined()
			expect(isWorktreeRemovable(open)).toBe(false)
		})

		it('worktree-landed-signal-guard-outranks', () => {
			// THE disagreement case: a landed signal says the work is on the trunk, a guard says the
			// checkout is in use. The guard wins — on every signal, in both directions of the pairing.
			const dirty = byRoot(
				gitFake({
					merged: 'main',
					gone: ['feat/deleted'],
					status: (root) => (root === '/repo.worktrees/deleted' ? ' M src/a.ts' : ''),
				}),
			).get('/repo.worktrees/deleted')!
			expect(dirty).toMatchObject({ merged: true, mergedSignal: 'upstream-gone', dirty: true })
			expect(isWorktreeRemovable(dirty)).toBe(false)

			const occupied = byRoot(gitFake({ merged: 'main', squashApplied: ['feat/squashed'] })).get(
				'/repo.worktrees/squashed',
			)!
			expect(isWorktreeRemovable({ ...occupied, workspace: 'w1' })).toBe(false)
		})

		it('worktree-landed-signal-forge-optional', () => {
			// Layer 4 is opt-in: with no probe injected nothing reaches for a forge, and every other layer
			// still works offline.
			const entries = byRoot(gitFake({ merged: 'main', gone: ['feat/deleted'] }))
			expect(entries.get('/repo.worktrees/deleted')).toMatchObject({ merged: true, mergedSignal: 'upstream-gone' })
			// And when one IS injected it is never asked about a branch the offline layers already cleared.
			const asked: string[] = []
			byRoot(gitFake({ merged: 'main', gone: ['feat/deleted'] }), {
				forge: (branch) => {
					asked.push(branch)
					return undefined
				},
			})
			expect(asked).not.toContain('feat/deleted')
		})

		it('worktree-landed-signal-forge-optional', () => {
			const asked: string[] = []
			const entries = byRoot(gitFake({ merged: 'main' }), {
				forge: (branch) => {
					asked.push(branch)
					return branch === 'feat/open'
				},
			})
			expect(entries.get('/repo.worktrees/open')).toMatchObject({ merged: true, mergedSignal: 'forge' })
			expect(entries.get('/repo.worktrees/squashed')?.merged).toBe(false)
			// Only branches the offline layers left unresolved reach the network.
			expect(asked).not.toContain('main')
		})

		it('worktree-landed-signal-forge-optional', () => {
			// A forge that cannot say (no auth, no network, a local-only branch) is not a `false`: it
			// leaves the verdict exactly where the offline layers left it.
			const entries = byRoot(gitFake({ merged: 'main' }), { forge: () => undefined })
			expect(entries.get('/repo.worktrees/open')?.merged).toBe(false)
		})

		it('worktree-landed-signals-reach-provision', () => {
			// The point of the whole change: a pool built on `provision` recycles a squash-merged
			// worktree instead of only ever creating.
			const exec = gitFake({ merged: 'main', squashApplied: ['feat/squashed'] })
			const result = provisionWorktree(exec, '/repo', { create: { path: '/repo.worktrees/new', branch: 'feat/next' } })
			expect(result.action).toBe('reused')
			expect(result.reused).toMatchObject({ root: '/repo.worktrees/squashed', mergedSignal: 'squash-patch' })
		})

		it('worktree-landed-signals-reach-provision', () => {
			// And it still refuses when no layer clears anything — reuse never becomes the default.
			const exec = gitFake({ merged: 'main', gone: [], squashApplied: [] })
			const result = provisionWorktree(exec, '/repo', { create: { path: '/repo.worktrees/new', branch: 'feat/next' } })
			expect(result.action).toBe('created')
		})

		it('worktree-landed-signals-reach-prune', () => {
			const removed: string[] = []
			const exec: Exec = (cmd, args) => {
				if (args[2] === 'worktree' && args[3] === 'remove') {
					removed.push(args[4]!)
					return ''
				}
				return gitFake({ merged: 'main', gone: ['feat/deleted'], squashApplied: ['feat/squashed'] })(cmd, args)
			}
			const result = pruneWorktrees(exec, '/repo', { fs: { exists: () => true, realpath: (p) => p } })
			expect(removed.sort()).toEqual(['/repo.worktrees/deleted', '/repo.worktrees/squashed'])
			expect(result.skipped.map((s) => s.entry.root)).toEqual(['/repo.worktrees/open'])
			expect(result.skipped[0]?.reason).toMatch(/has not landed/)
		})
	})

	describe('ghForgeMergedProbe', () => {
		it('worktree-landed-signal-forge-optional', () => {
			const calls: string[][] = []
			const exec: Exec = (cmd, args) => {
				calls.push([cmd, ...args])
				if (cmd === 'git') return 'git@github.com:cyberuni/cyber-mux.git'
				return '[{"number":151}]'
			}
			expect(ghForgeMergedProbe(exec, '/repo')('feat/x')).toBe(true)
			// The slug comes from the REMOTE, never from the process cwd — `Exec` runs without one.
			expect(calls[1]).toEqual([
				'gh',
				'pr',
				'list',
				'--repo',
				'cyberuni/cyber-mux',
				'--head',
				'feat/x',
				'--state',
				'merged',
				'--json',
				'number',
				'--limit',
				'1',
			])
		})

		it('worktree-landed-signal-forge-optional', () => {
			const exec: Exec = (cmd) => (cmd === 'git' ? 'https://github.com/cyberuni/cyber-mux' : '[]')
			expect(ghForgeMergedProbe(exec, '/repo')('feat/x')).toBe(false)
		})

		it('worktree-landed-signal-forge-optional', () => {
			// No origin, no gh, or an answer that is not the JSON asked for — all "could not say".
			expect(ghForgeMergedProbe(() => null, '/repo')('feat/x')).toBeUndefined()
			const noGh: Exec = (cmd) => (cmd === 'git' ? 'git@github.com:o/r.git' : null)
			expect(ghForgeMergedProbe(noGh, '/repo')('feat/x')).toBeUndefined()
			const garbage: Exec = (cmd) => (cmd === 'git' ? 'git@github.com:o/r.git' : 'not json')
			expect(ghForgeMergedProbe(garbage, '/repo')('feat/x')).toBeUndefined()
		})
	})

	describe('isWorktreeRemovable', () => {
		const removable = {
			root: '/repo.worktrees/x',
			branch: 'x',
			linked: true,
			prunable: false,
			merged: true,
			dirty: false,
		}

		it('is false for the primary checkout, which is never disposable', () => {
			expect(isWorktreeRemovable({ ...removable, linked: false })).toBe(false)
		})

		it('is false while a workspace still holds the worktree', () => {
			expect(isWorktreeRemovable({ ...removable, workspace: 'ws-1' })).toBe(false)
		})

		it('is true only when merged, clean, unoccupied, and on disk', () => {
			expect(isWorktreeRemovable(removable)).toBe(true)
		})
	})

	describe('pruneWorktrees', () => {
		// Primary + one linked worktree per outcome the gate has to survive: merged/clean (removable),
		// unmerged, merged/dirty, and gone-from-git — the same porcelain shape the disposability suite
		// above uses for `isWorktreeRemovable`.
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/landed',
			'branch refs/heads/feat/landed',
			'',
			'worktree /repo.worktrees/open',
			'branch refs/heads/feat/open',
			'',
			'worktree /repo.worktrees/dirty',
			'branch refs/heads/feat/dirty',
			'',
			'worktree /repo.worktrees/gone',
			'branch refs/heads/feat/gone',
			'prunable gitdir file points to non-existent location',
			'',
		].join('\n')

		// A fake disk that reports every worktree path as present — the removal half is under test here,
		// not the "already gone from the filesystem" branch `removeWorktreeSafely` already covers.
		const fakeFs = { exists: () => true, realpath: (path: string) => path }

		const gitFake =
			(calls: string[][] = []): Exec =>
			(_cmd, args) => {
				calls.push(args)
				if (args.includes('symbolic-ref')) return 'main'
				if (args.includes('--merged')) return 'main\nfeat/landed\nfeat/dirty'
				if (args.includes('status')) return args[1] === '/repo.worktrees/dirty' ? ' M src/a.ts' : ''
				return porcelain
			}

		it('removes exactly the entries isWorktreeRemovable clears, sparing the primary and the rest', () => {
			const calls: string[][] = []
			const result = pruneWorktrees(gitFake(calls), '/repo', { fs: fakeFs })
			expect(result.removed.map((e) => e.root)).toEqual(['/repo.worktrees/landed'])
			expect(result.skipped.map((s) => s.entry.root)).toEqual([
				'/repo.worktrees/open',
				'/repo.worktrees/dirty',
				'/repo.worktrees/gone',
			])
			expect(calls.some((args) => args.includes('remove') && args.includes('/repo.worktrees/landed'))).toBe(true)
			expect(calls.some((args) => args.includes('remove') && args.includes('/repo.worktrees/open'))).toBe(false)
			// The primary checkout is never a candidate — not removed, not reported as skipped either.
			expect(result.removed.some((e) => e.root === '/repo')).toBe(false)
			expect(result.skipped.some((s) => s.entry.root === '/repo')).toBe(false)
		})

		it('reports why each non-removable entry was left alone', () => {
			const result = pruneWorktrees(gitFake(), '/repo', { fs: fakeFs })
			const reasons = new Map(result.skipped.map((s) => [s.entry.root, s.reason]))
			expect(reasons.get('/repo.worktrees/open')).toMatch(/has not landed/)
			expect(reasons.get('/repo.worktrees/dirty')).toMatch(/uncommitted changes/)
			expect(reasons.get('/repo.worktrees/gone')).toMatch(/git worktree prune/)
		})

		it('dryRun reports the same candidates without removing anything', () => {
			const calls: string[][] = []
			const result = pruneWorktrees(gitFake(calls), '/repo', { dryRun: true, fs: fakeFs })
			expect(result.removed.map((e) => e.root)).toEqual(['/repo.worktrees/landed'])
			expect(calls.some((args) => args.includes('remove'))).toBe(false)
		})
	})

	describe('provisionWorktree', () => {
		// Primary on main + two landed (merged, clean) candidates and one unmerged worktree — the pool
		// provision recycles from, the twin of prune's own porcelain.
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/landed',
			'branch refs/heads/feat/landed',
			'',
			'worktree /repo.worktrees/landed2',
			'branch refs/heads/feat/landed2',
			'',
			'worktree /repo.worktrees/open',
			'branch refs/heads/feat/open',
			'',
		].join('\n')

		const fakeFs = { exists: () => true, realpath: (path: string) => path }

		// Route by verb so the internal `list` read and the recycle/add writes each get their own answer;
		// `switch`/`reset`/`clean`/`add` all succeed with an empty string, never the porcelain dump.
		const gitFake =
			(calls: string[][], answers: { merged: string; status?: (root: string) => string | null }): Exec =>
			(_cmd, args) => {
				calls.push(args)
				if (args.includes('symbolic-ref')) return 'origin/main'
				if (args.includes('--merged')) return answers.merged
				if (args[2] === 'status') return answers.status?.(args[1]!) ?? ''
				if (args[2] === 'worktree' && args[3] === 'list') return porcelain
				return ''
			}

		const bothLanded = { merged: 'main\nfeat/landed\nfeat/landed2', status: () => '' }

		it('worktree-provision-reuses-free', () => {
			const calls: string[][] = []
			const result = provisionWorktree(gitFake(calls, bothLanded), '/repo', {
				create: { path: '/repo.worktrees/new', branch: 'feat/new' },
				fs: fakeFs,
			})
			expect(result.action).toBe('reused')
			expect(result.worktree).toEqual({ root: '/repo.worktrees/landed', branch: 'feat/new' })
			expect(result.reused).toMatchObject({ root: '/repo.worktrees/landed', merged: true, dirty: false })
			// The ratified reuse semantics: fresh branch at base, then hard reset, then a full clean.
			// base defaults to the resolved default branch (origin/HEAD → origin/main) when none is given.
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed', 'switch', '-c', 'feat/new', 'origin/main'])
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed', 'reset', '--hard', 'origin/main'])
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed', 'clean', '-fdx'])
			// Reuse means NO new checkout — the whole point.
			expect(calls.some((a) => a[2] === 'worktree' && a[3] === 'add')).toBe(false)
		})

		it('worktree-provision-explicit-base', () => {
			const calls: string[][] = []
			provisionWorktree(gitFake(calls, bothLanded), '/repo', {
				create: { path: '/repo.worktrees/new', branch: 'feat/new', base: 'release/1.0' },
				fs: fakeFs,
			})
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed', 'switch', '-c', 'feat/new', 'release/1.0'])
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed', 'reset', '--hard', 'release/1.0'])
		})

		it('worktree-provision-creates-fresh', () => {
			const calls: string[][] = []
			const result = provisionWorktree(gitFake(calls, bothLanded), '/repo', {
				create: { path: '/repo.worktrees/new', branch: 'feat/new', base: 'origin/main' },
				available: () => false,
				fs: fakeFs,
			})
			expect(result.action).toBe('created')
			expect(result.worktree).toEqual({ root: '/repo.worktrees/new', branch: 'feat/new' })
			expect(result.reused).toBeUndefined()
			expect(calls).toContainEqual([
				'-C',
				'/repo',
				'worktree',
				'add',
				'-b',
				'feat/new',
				'/repo.worktrees/new',
				'origin/main',
			])
			expect(calls.some((a) => a[2] === 'switch')).toBe(false)
		})

		it('worktree-provision-skips-unmerged', () => {
			const calls: string[][] = []
			// Only the primary's own branch is merged — no linked worktree qualifies, so provision creates.
			const result = provisionWorktree(gitFake(calls, { merged: 'main', status: () => '' }), '/repo', {
				create: { path: '/repo.worktrees/new', branch: 'feat/new', base: 'origin/main' },
				fs: fakeFs,
			})
			expect(result.action).toBe('created')
			expect(calls.some((a) => a[2] === 'switch')).toBe(false)
		})

		it('worktree-provision-respects-predicate', () => {
			const calls: string[][] = []
			// A host predicate standing in for "a live session is bound to /landed": it is disqualified even
			// though the generic gate would clear it, so provision recycles /landed2 instead.
			const held = '/repo.worktrees/landed'
			const result = provisionWorktree(gitFake(calls, bothLanded), '/repo', {
				create: { path: '/repo.worktrees/new', branch: 'feat/new', base: 'origin/main' },
				available: (entry: WorktreeEntry) => entry.root !== held && isWorktreeRemovable(entry),
				fs: fakeFs,
			})
			expect(result.action).toBe('reused')
			expect(result.reused?.root).toBe('/repo.worktrees/landed2')
			expect(calls.some((a) => a[2] === 'switch' && a[1] === held)).toBe(false)
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed2', 'switch', '-c', 'feat/new', 'origin/main'])
		})

		it('worktree-provision-skips-primary', () => {
			const calls: string[][] = []
			// A predicate that says yes to everything still cannot reach the primary — it is filtered before
			// the gate runs, matching prune's own absolute refusal.
			const result = provisionWorktree(gitFake(calls, bothLanded), '/repo', {
				create: { path: '/repo.worktrees/new', branch: 'feat/new', base: 'origin/main' },
				available: () => true,
				fs: fakeFs,
			})
			expect(result.reused?.root).not.toBe('/repo')
			expect(calls.some((a) => a[2] === 'switch' && a[1] === '/repo')).toBe(false)
		})

		it('throws this module’s own error, not a bare git failure, when a recycle step fails', () => {
			const failingSwitch: Exec = (_cmd, args) => {
				if (args.includes('symbolic-ref')) return 'origin/main'
				if (args.includes('--merged')) return bothLanded.merged
				if (args[2] === 'status') return ''
				if (args[2] === 'worktree' && args[3] === 'list') return porcelain
				if (args[2] === 'switch') return null
				return ''
			}
			expect(() =>
				provisionWorktree(failingSwitch, '/repo', {
					create: { path: '/repo.worktrees/new', branch: 'feat/new', base: 'origin/main' },
					fs: fakeFs,
				}),
			).toThrow(/switch failed while recycling/)
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

		it('list() defaults its root to primaryRoot() and delegates', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return args.includes('--git-common-dir') ? '/repo/.git' : ''
			}
			expect(worktreeApi({ exec }).list()).toEqual([])
			expect(calls[0]).toEqual(['rev-parse', '--path-format=absolute', '--git-common-dir'])
			expect(calls[1]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain'])
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

		it('prune() defaults its root to primaryRoot() and delegates', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return args.includes('--git-common-dir') ? '/repo/.git' : ''
			}
			expect(worktreeApi({ exec }).prune()).toEqual({ removed: [], skipped: [] })
			expect(calls[0]).toEqual(['rev-parse', '--path-format=absolute', '--git-common-dir'])
			expect(calls[1]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain'])
		})

		it('provision() defaults its root to primaryRoot() and creates when the pool is empty', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				if (args.includes('--git-common-dir')) return '/repo/.git'
				// An empty worktree list: nothing to reuse, so provision falls through to add.
				if (args[2] === 'worktree' && args[3] === 'list') return ''
				return ''
			}
			const result = worktreeApi({ exec }).provision({
				create: { path: '/repo.worktrees/x', branch: 'b', base: 'origin/main' },
			})
			expect(result).toEqual({ action: 'created', worktree: { root: '/repo.worktrees/x', branch: 'b' } })
			expect(calls[0]).toEqual(['rev-parse', '--path-format=absolute', '--git-common-dir'])
			expect(calls[1]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain'])
			expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'b', '/repo.worktrees/x', 'origin/main'])
		})
	})
})
