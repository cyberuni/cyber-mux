import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { isWorktreeRemovable, listWorktreesFromGit, provisionWorktree, type WorktreeEntry } from './worktree.ts'

/**
 * The landed-signal layers against REAL git (issue #151).
 *
 * These cannot be a mocked-`Exec` suite and mean anything. Every layer here is a claim about git's
 * own behavior — that `--merged` is structurally blind to a squash, that `[gone]` appears after a
 * `fetch --prune`, that `commit-tree` + `cherry` recognizes a squash by patch-id and declines a
 * hand-edited one — and a fake that returns the strings this module expects proves only that the
 * parser matches the fixture. So each scenario builds a scratch repo that GENUINELY squash-merges.
 *
 * cyber-mux itself merges with merge commits only, so its own history is exactly the fixture that
 * cannot exercise this. The scratch repos are throwaway, isolated (`GIT_CONFIG_GLOBAL` and friends
 * are pinned per invocation), and removed afterwards.
 */
describe('spec:cyber-mux/mux/worktree — landed signals against real git', () => {
	let root: string

	/**
	 * `nodeExec` with every ambient git identity STRIPPED — no `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, and
	 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at nothing. The library is driven through this
	 * rather than through `nodeExec` on purpose: the squash layer builds a synthetic commit, and
	 * `git commit-tree` REFUSES ("empty ident name") when nothing names an author, which is the state
	 * of a machine that has never configured git — a CI runner, a fresh container. Driven through a
	 * developer's own configured git the layer passes for a reason that is not in the code; driven
	 * through this, the probe has to carry its own identity or the whole layer goes dark.
	 *
	 * The scratch-repo BUILDER (`git` below) keeps its explicit identity — it makes real commits and
	 * has every right to say who made them. This is only for the library under test.
	 */
	const bareExec: Exec = (cmd, args) => {
		try {
			const { GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL, ...env } = process.env
			return execFileSync(cmd, args, {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
			}).trim()
		} catch {
			return null
		}
	}

	/** One git invocation in a scratch repo, with identity and hooks forced so a contributor's own
	 * global config (a `commit.gpgsign`, a template dir, a default branch name) cannot change what
	 * these scenarios build. */
	const git = (cwd: string, ...args: string[]): string =>
		execFileSync('git', args, {
			cwd,
			encoding: 'utf8',
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'cyber-mux test',
				GIT_AUTHOR_EMAIL: 'test@example.invalid',
				GIT_COMMITTER_NAME: 'cyber-mux test',
				GIT_COMMITTER_EMAIL: 'test@example.invalid',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_SYSTEM: '/dev/null',
			},
		}).trim()

	const commit = (cwd: string, file: string, body: string, message: string): void => {
		writeFileSync(join(cwd, file), body)
		git(cwd, 'add', '-A')
		git(cwd, 'commit', '-m', message)
	}

	/**
	 * An origin + a clone of it, the shape every scenario below needs: `origin/HEAD` resolvable (so
	 * `resolveDefaultBranchRef` finds a target the way it does in a real checkout) and a real remote to
	 * delete branches on.
	 */
	const scratchRepo = (name: string): { origin: string; clone: string } => {
		const origin = join(root, `${name}.git`)
		const seed = join(root, `${name}-seed`)
		const clone = join(root, name)
		git(root, 'init', '--bare', '--initial-branch=main', origin)
		git(root, 'init', '--initial-branch=main', seed)
		commit(seed, 'README.md', 'seed\n', 'seed')
		git(seed, 'remote', 'add', 'origin', origin)
		git(seed, 'push', '-u', 'origin', 'main')
		git(root, 'clone', origin, clone)
		// `git clone` sets origin/HEAD from the remote's own HEAD; assert rather than assume, since the
		// whole target resolution rests on it.
		expect(git(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).toBe('origin/main')
		return { origin, clone }
	}

	/** A worktree on a fresh branch carrying one commit — the pod-pool shape this issue is about. */
	const worktreeOnBranch = (clone: string, branch: string, file: string, body: string): string => {
		const path = join(clone, '..', `${branch.replace(/\//g, '-')}-wt`)
		git(clone, 'worktree', 'add', '-b', branch, path, 'main')
		commit(path, file, body, `work on ${branch}`)
		return git(path, 'rev-parse', '--show-toplevel')
	}

	/** Squash-merge `branch` into the clone's `main` and push — a real squash, not a simulated one. */
	const squashMerge = (clone: string, branch: string, edit?: { file: string; body: string }): void => {
		git(clone, 'merge', '--squash', branch)
		if (edit) writeFileSync(join(clone, edit.file), edit.body)
		git(clone, 'add', '-A')
		git(clone, 'commit', '-m', `squash ${branch}`)
		git(clone, 'push', 'origin', 'main')
	}

	const entryFor = (clone: string, path: string): WorktreeEntry => {
		const entries = listWorktreesFromGit(bareExec, clone)
		const entry = entries.find((candidate) => candidate.root === path)
		// Split from the field assertions on purpose: a missing ENTRY and a missing FIELD are different
		// failures, and `find(...)?.merged` cannot tell them apart.
		expect(entry, `no worktree entry for ${path} in ${JSON.stringify(entries.map((e) => e.root))}`).toBeDefined()
		return entry!
	}

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'cyber-mux-worktree-'))
	})

	afterAll(() => {
		rmSync(root, { recursive: true, force: true })
	})

	it('worktree-landed-layered-signals', () => {
		// The whole premise, proven rather than asserted: after a REAL squash merge git's own ancestry
		// answer still says the branch is unmerged. If this ever stops being true the layers below are
		// solving a problem that no longer exists.
		const { clone } = scratchRepo('premise')
		const path = worktreeOnBranch(clone, 'feat/squashed', 'a.txt', 'a\n')
		squashMerge(clone, 'feat/squashed')
		expect(git(clone, 'branch', '--format=%(refname:short)', '--merged', 'origin/main').split('\n')).not.toContain(
			'feat/squashed',
		)
		// And the layered read sees it anyway, by patch-id.
		const entry = entryFor(clone, path)
		expect(entry.merged).toBe(true)
		expect(entry.mergedSignal).toBe('squash-patch')
		expect(isWorktreeRemovable(entry)).toBe(true)
	})

	it('worktree-landed-layered-signals', () => {
		// Layer 2 against a real forge-shaped flow: squash-merge, delete the branch on the remote, then
		// `fetch --prune`. The remote-tracking ref is `[gone]` and that alone settles it — no patch-id
		// reasoning required, which is what makes this layer correct for rebase and merge commits too.
		const { clone } = scratchRepo('gone')
		const path = worktreeOnBranch(clone, 'feat/deleted', 'b.txt', 'b\n')
		git(path, 'push', '-u', 'origin', 'feat/deleted')
		squashMerge(clone, 'feat/deleted')
		git(clone, 'push', 'origin', '--delete', 'feat/deleted')
		git(clone, 'fetch', '--prune')
		expect(git(clone, 'for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads/feat/deleted')).toBe(
			'feat/deleted [gone]',
		)
		const entry = entryFor(clone, path)
		expect(entry.merged).toBe(true)
		expect(entry.mergedSignal).toBe('upstream-gone')
		expect(isWorktreeRemovable(entry)).toBe(true)
	})

	it('worktree-landed-signal-positive-only', () => {
		// A branch whose work genuinely has not landed is cleared by NO layer — the one answer that must
		// never be wrong, because it is the one that would delete work.
		const { clone } = scratchRepo('unmerged')
		const path = worktreeOnBranch(clone, 'feat/open', 'c.txt', 'c\n')
		const entry = entryFor(clone, path)
		expect(entry.merged).toBe(false)
		expect(entry.mergedSignal).toBeUndefined()
		expect(isWorktreeRemovable(entry)).toBe(false)
	})

	it('worktree-landed-signal-positive-only', () => {
		// A squash that was hand-edited on the way in — a conflict resolution, a review fixup folded into
		// the squash commit. The patch-ids do not match, and the answer degrades to "not reusable"
		// rather than to a false positive.
		const { clone } = scratchRepo('edited')
		const path = worktreeOnBranch(clone, 'feat/edited', 'd.txt', 'd\n')
		squashMerge(clone, 'feat/edited', { file: 'd.txt', body: 'd\nreviewer fixup\n' })
		const entry = entryFor(clone, path)
		expect(entry.merged).toBe(false)
		expect(isWorktreeRemovable(entry)).toBe(false)
	})

	it('worktree-landed-signal-positive-only', () => {
		// Landed, then WORK CONTINUED in the same checkout. The collapsed branch no longer matches what
		// the squash put on the trunk, so the signal withdraws — a branch that is ahead of its own merge
		// is not disposable however it was merged.
		const { clone } = scratchRepo('continued')
		const path = worktreeOnBranch(clone, 'feat/continued', 'e.txt', 'e\n')
		squashMerge(clone, 'feat/continued')
		expect(entryFor(clone, path).merged).toBe(true)
		commit(path, 'e2.txt', 'more\n', 'more work after the squash')
		const entry = entryFor(clone, path)
		expect(entry.merged).toBe(false)
		expect(isWorktreeRemovable(entry)).toBe(false)
	})

	it('worktree-landed-signal-guard-outranks', () => {
		// The disagreement case at the real boundary: the squash signal says landed, the checkout carries
		// uncommitted work. The guard wins, and the reason is the whole safety argument — a wrong landed
		// verdict costs at most a checkout (the branch ref survives), but uncommitted work exists nowhere
		// else.
		const { clone } = scratchRepo('dirty')
		const path = worktreeOnBranch(clone, 'feat/dirty', 'f.txt', 'f\n')
		squashMerge(clone, 'feat/dirty')
		writeFileSync(join(path, 'scratch.txt'), 'work in progress\n')
		const entry = entryFor(clone, path)
		expect(entry).toMatchObject({ merged: true, mergedSignal: 'squash-patch', dirty: true })
		expect(isWorktreeRemovable(entry)).toBe(false)
		// Occupancy is the same story on the other guard.
		expect(isWorktreeRemovable({ ...entry, dirty: false, workspace: 'w1' })).toBe(false)
	})

	it('worktree-landed-signals-reach-provision', () => {
		// The reason the issue exists: a pool built on `provision` in a squash-merging repo only ever
		// created, because nothing was ever reported reusable. It recycles now — and the recycled
		// checkout comes back pristine on the requested branch.
		const { clone } = scratchRepo('pool')
		const path = worktreeOnBranch(clone, 'feat/pooled', 'g.txt', 'g\n')
		squashMerge(clone, 'feat/pooled')
		const result = provisionWorktree(bareExec, clone, {
			create: { path: join(clone, '..', 'unused-wt'), branch: 'feat/next' },
		})
		expect(result.action).toBe('reused')
		expect(result.worktree.root).toBe(path)
		expect(result.reused?.mergedSignal).toBe('squash-patch')
		expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/next')
		expect(git(path, 'status', '--porcelain')).toBe('')
		// The recycled branch's REF survives — the reason a wrong landed verdict costs no committed work.
		expect(git(clone, 'rev-parse', '--verify', 'refs/heads/feat/pooled')).toMatch(/^[0-9a-f]{40}$/)
	})

	it('worktree-landed-signals-reach-provision', () => {
		// And with nothing landed, provision still creates rather than reclaiming a live worktree.
		const { clone } = scratchRepo('pool-busy')
		worktreeOnBranch(clone, 'feat/busy', 'h.txt', 'h\n')
		const fresh = join(clone, '..', 'fresh-wt')
		const result = provisionWorktree(bareExec, clone, { create: { path: fresh, branch: 'feat/fresh' } })
		expect(result.action).toBe('created')
	})

	it('worktree-landed-layered-signals', () => {
		// A merge-commit repo is unchanged by all of this — layer 1 answers first and names itself, so
		// the pre-existing behavior is not merely preserved but attributed.
		const { clone } = scratchRepo('merge-commit')
		const path = worktreeOnBranch(clone, 'feat/classic', 'i.txt', 'i\n')
		git(clone, 'merge', '--no-ff', '-m', 'merge feat/classic', 'feat/classic')
		git(clone, 'push', 'origin', 'main')
		const entry = entryFor(clone, path)
		expect(entry.merged).toBe(true)
		expect(entry.mergedSignal).toBe('ancestor')
	})
})
