import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Exec } from './exec.ts'

/** Generic worktree seam — no host-specific concepts. */

interface WorktreeAddOptions {
	/** The primary checkout's root — the repo `git worktree add` runs against. */
	primaryRoot: string
	/** Where the new worktree should be checked out. */
	path: string
	/** Branch to create the worktree on. */
	branch: string
	/** Start point for the new branch; omit for git's own default (the current HEAD). */
	base?: string
}

export interface Worktree {
	root: string
	branch: string
}

/**
 * A worktree as reported when ENUMERATING — deliberately distinct from `Worktree`, which is the
 * result of CREATING one (where a branch exists by construction). Listing has to represent what
 * creation cannot produce: a detached HEAD, the primary checkout itself, and an entry whose
 * checkout git considers stale.
 */
export interface WorktreeEntry {
	/** Absolute checkout path, normalized. */
	root: string
	/** Branch checked out there; absent for a detached HEAD or a bare entry. */
	branch?: string
	/** `false` for the primary checkout, `true` for a linked worktree. */
	linked: boolean
	/** git considers the entry stale — its checkout is gone from disk. */
	prunable: boolean
	/**
	 * The multiplexer workspace this worktree is currently open in. Joined in by the caller from a
	 * backend's binding; always absent on a backend that has no worktree/workspace binding, and when
	 * nothing is open on the worktree.
	 */
	workspace?: string
}

interface WorktreeRemoveOptions {
	primaryRoot: string
}

interface WorktreeAdapter {
	add(exec: Exec, opts: WorktreeAddOptions): Worktree
	remove(exec: Exec, path: string, opts: WorktreeRemoveOptions): void
}

/**
 * This module's own refusals and failures — plain cyber-mux prose, never a dependency's raw words.
 * `reportWorktreeFailure` (`cli.ts`) forwards a `WorktreeGitError`'s message onto stdout verbatim
 * because it is safe to: everything thrown here is this CLI's own text. Anything else that reaches
 * that catch-all (a `session.tmux.ts`/`session.herdr.ts` throw, which embeds the backend's own name
 * and its raw stderr via `withReason`) is a different case and is translated, not forwarded.
 */
export class WorktreeGitError extends Error {}

/** The only worktree backend at MVP — plain `git worktree`. */
export const gitWorktreeAdapter: WorktreeAdapter = {
	add(exec, opts) {
		const args = ['-C', opts.primaryRoot, 'worktree', 'add', '-b', opts.branch, opts.path]
		// git takes the start-point as a trailing commit-ish, after the path.
		if (opts.base) args.push(opts.base)
		const out = exec('git', args)
		if (out === null) throw new WorktreeGitError(`git worktree add failed for ${opts.path}`)
		return { root: resolve(opts.path), branch: opts.branch }
	},

	remove(exec, path, opts) {
		const out = exec('git', ['-C', opts.primaryRoot, 'worktree', 'remove', path, '--force'])
		if (out === null) throw new WorktreeGitError(`git worktree remove failed for ${path}`)
	},
}

/**
 * Resolve the primary checkout's root regardless of whether the caller's cwd is the primary
 * checkout or a linked worktree — `--git-common-dir` always points at the main repo's `.git`.
 */
export function resolvePrimaryRoot(exec: Exec): string {
	const commonDir = exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!commonDir) throw new WorktreeGitError('cannot resolve the primary checkout — not inside a git repository')
	return dirname(commonDir)
}

/**
 * The single normalization point for every path that gets MATCHED against another — a multiplexer
 * reports its own checkout paths, and those only line up with git's if both sides are resolved the
 * same way (a symlinked repo, or macOS's `/tmp` → `/private/tmp`, otherwise silently fails to
 * match). Falls back to `resolve` for a path that isn't on disk, where there is no link to follow.
 */
export function normalizeWorktreePath(path: string): string {
	try {
		return realpathSync.native(path)
	} catch {
		return resolve(path)
	}
}

/**
 * Every worktree of the repo, straight from git. These are the facts — path, branch, linked,
 * prunable — on EVERY backend: a multiplexer that also happens to enumerate worktrees is only
 * re-reading git, so reading them here is what keeps two backends from ever disagreeing about the
 * same worktree. The one fact git cannot answer — which workspace a worktree is open in — is joined
 * in by the caller.
 */
export function listWorktreesFromGit(exec: Exec, primaryRoot: string): WorktreeEntry[] {
	const out = exec('git', ['-C', primaryRoot, 'worktree', 'list', '--porcelain'])
	if (!out) return []
	const normalizedPrimary = normalizeWorktreePath(primaryRoot)
	// Porcelain emits one blank-line-separated record per worktree, each opening with `worktree <path>`.
	return out
		.split('\n\n')
		.map((record) => record.trim())
		.filter((record) => record.startsWith('worktree '))
		.map((record) => {
			const lines = record.split('\n')
			const root = normalizeWorktreePath(lines[0]!.slice('worktree '.length))
			// `branch refs/heads/<name>`; absent entirely when detached or bare.
			const branchLine = lines.find((line) => line.startsWith('branch '))
			return {
				root,
				branch: branchLine?.slice('branch '.length).replace(/^refs\/heads\//, ''),
				// Derived from the path rather than record order — git lists the primary first today,
				// but that ordering is not something to depend on.
				linked: root !== normalizedPrimary,
				prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
			}
		})
}

/**
 * Refuse the primary checkout: a spawned session's resolved worktree root must never be the primary
 * checkout itself.
 */
export function assertDistinctFromPrimary(worktreeRoot: string, primaryRoot: string): void {
	if (resolve(worktreeRoot) === resolve(primaryRoot)) {
		throw new WorktreeGitError(
			'refusing to run in the primary checkout — spawn a worktree distinct from the primary checkout',
		)
	}
}

/**
 * Default worktree location — a sibling of the primary checkout (`<parent>/<repo>.worktrees/<name>`),
 * never nested inside the primary's own working tree (an untracked-but-present nested worktree
 * pollutes `git status` in the primary and confuses tools that walk the tree expecting only the
 * primary's own files).
 */
export function resolveWorktreePath(primaryRoot: string, name: string): string {
	return join(dirname(primaryRoot), `${basename(primaryRoot)}.worktrees`, name)
}

/** Whether a worktree has uncommitted changes — gates a safe remove unless the caller forces it. */
function isDirty(exec: Exec, worktreeRoot: string): boolean {
	return !!exec('git', ['-C', worktreeRoot, 'status', '--porcelain'])
}

/**
 * Remove a worktree the safe way: refuse the primary checkout (absolute — `force` never overrides
 * it), tolerate a worktree already gone from disk, and refuse to discard uncommitted changes unless
 * `force` is set.
 *
 * `releaseBinding` detaches whatever a multiplexer has bound to this checkout (a herdr workspace).
 * It stays an opaque callback so this module owes nothing to the session seam. Its ORDER is a
 * specified property, not an incidental one:
 *
 *  - every gate runs BEFORE it, so a REFUSED removal has no side effect — a dirty worktree that
 *    fails the check must not lose its workspace on the way out;
 *  - it runs BEFORE git removes the checkout, so no workspace is ever left pointing at a deleted
 *    directory (and a held cwd can block the removal outright).
 */
export function removeWorktreeSafely(
	exec: Exec,
	path: string,
	opts: { primaryRoot: string; force?: boolean; releaseBinding?: () => void },
): void {
	assertDistinctFromPrimary(path, opts.primaryRoot)
	if (!existsSync(path)) {
		// A checkout already gone but still bound is exactly the orphan this releases; git has nothing
		// left to remove, so the "no git removal command" promise still holds.
		opts.releaseBinding?.()
		return
	}
	if (!opts.force && isDirty(exec, path)) {
		throw new WorktreeGitError(`worktree "${path}" has uncommitted changes — pass --force to discard them`)
	}
	opts.releaseBinding?.()
	gitWorktreeAdapter.remove(exec, path, { primaryRoot: opts.primaryRoot })
}
