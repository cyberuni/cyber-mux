import { dirname, resolve } from 'node:path'
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
