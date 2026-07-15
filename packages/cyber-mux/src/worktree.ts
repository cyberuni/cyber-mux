import { existsSync } from 'node:fs'
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
}

export interface Worktree {
	root: string
	branch: string
}

interface WorktreeRemoveOptions {
	primaryRoot: string
}

interface WorktreeAdapter {
	add(exec: Exec, opts: WorktreeAddOptions): Worktree
	remove(exec: Exec, path: string, opts: WorktreeRemoveOptions): void
}

/** The only worktree backend at MVP — plain `git worktree`. */
export const gitWorktreeAdapter: WorktreeAdapter = {
	add(exec, opts) {
		const out = exec('git', ['-C', opts.primaryRoot, 'worktree', 'add', '-b', opts.branch, opts.path])
		if (out === null) throw new Error(`git worktree add failed for ${opts.path}`)
		return { root: resolve(opts.path), branch: opts.branch }
	},

	remove(exec, path, opts) {
		const out = exec('git', ['-C', opts.primaryRoot, 'worktree', 'remove', path, '--force'])
		if (out === null) throw new Error(`git worktree remove failed for ${path}`)
	},
}

/**
 * Resolve the primary checkout's root regardless of whether the caller's cwd is the primary
 * checkout or a linked worktree — `--git-common-dir` always points at the main repo's `.git`.
 */
export function resolvePrimaryRoot(exec: Exec): string {
	const commonDir = exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!commonDir) throw new Error('cannot resolve the primary checkout — not inside a git repository')
	return dirname(commonDir)
}

/**
 * Refuse the primary checkout: a spawned session's resolved worktree root must never be the primary
 * checkout itself.
 */
export function assertDistinctFromPrimary(worktreeRoot: string, primaryRoot: string): void {
	if (resolve(worktreeRoot) === resolve(primaryRoot)) {
		throw new Error('refusing to run in the primary checkout — spawn a worktree distinct from the primary checkout')
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
 */
export function removeWorktreeSafely(exec: Exec, path: string, opts: { primaryRoot: string; force?: boolean }): void {
	assertDistinctFromPrimary(path, opts.primaryRoot)
	if (!existsSync(path)) return
	if (!opts.force && isDirty(exec, path)) {
		throw new Error(`worktree "${path}" has uncommitted changes — pass --force to discard them`)
	}
	gitWorktreeAdapter.remove(exec, path, { primaryRoot: opts.primaryRoot })
}
