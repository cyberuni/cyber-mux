import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Exec, nodeExec } from './exec.ts'

/** Generic worktree seam — no host-specific concepts. */

// The worktree library, `@cyberuni/agent-harness/worktrees` — facts, leases, reuse, prune, and single
// remove — and the mux binding offered to it as its creator. The synchronous helpers below are the
// pieces it has no equivalent for: creating at a caller-chosen path, and cyber-mux's remove gates.
export * from './worktree-pool.ts'

/**
 * The filesystem half of the worktree adapter — the one seam here that is NOT `Exec`, exactly as
 * `TemplateStore` is for templates. The remove gate reaches for the disk, and reading it through bare
 * `node:fs` would make it the one worktree path a consumer cannot drive hermetically. Injected
 * (defaulting to `nodeWorktreeFs`), so #339's callers are unchanged and a test can stand in a fake disk.
 */
export interface WorktreeFs {
	/** Whether a path exists on disk — the apply-time check behind the remove gate. */
	exists(path: string): boolean
	/** The path with symlinks resolved, native-cased — the normalization every matched path goes
	 * through. Throws for a path not on disk, exactly as `realpathSync.native` does; callers fall back. */
	realpath(path: string): string
}

export const nodeWorktreeFs: WorktreeFs = {
	exists: existsSync,
	realpath: (path) => realpathSync.native(path),
}

export interface WorktreeAddOptions {
	/** The primary checkout's root — the repo `git worktree add` runs against. */
	primaryRoot: string
	/** Where the new worktree should be checked out. */
	path: string
	/** Branch to create the worktree on. */
	branch: string
	/** Start point for the new branch; omit for git's own default (the current HEAD). */
	base?: string | undefined
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
 * @deprecated Use `primaryRoot({ exec })` from `@cyberuni/agent-harness/worktrees` (re-exported here).
 *
 * Resolve the primary checkout's root regardless of whether the caller's cwd is the primary
 * checkout or a linked worktree — `--git-common-dir` always points at the main repo's `.git`.
 */
export function resolvePrimaryRoot(exec: Exec): string {
	const commonDir = exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!commonDir) throw new WorktreeGitError('cannot resolve the primary checkout — not inside a git repository')
	return dirname(commonDir)
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
 * Whether a worktree has uncommitted changes — gates a safe remove unless the caller forces it. An
 * unanswered `status` collapses to `false` HERE, unlike the library's `readDirty`: a gate that refused
 * on a question git could not answer would block removal of a checkout git has nothing to say about.
 */
function isDirty(exec: Exec, worktreeRoot: string): boolean {
	const out = exec('git', ['-C', worktreeRoot, 'status', '--porcelain'])
	return out !== null && out.length > 0
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
	opts: {
		primaryRoot: string
		force?: boolean | undefined
		releaseBinding?: (() => void) | undefined
		fs?: WorktreeFs | undefined
	},
): void {
	const fs = opts.fs ?? nodeWorktreeFs
	assertDistinctFromPrimary(path, opts.primaryRoot)
	if (!fs.exists(path)) {
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
/** The seams a `WorktreeApi` binds. Both optional, each defaulting to its Node-backed impl. */
export interface WorktreeDeps {
	exec?: Exec | undefined
	fs?: WorktreeFs | undefined
}

/** `removeWorktreeSafely`'s options minus `fs` — the `WorktreeApi` supplies the bound one. */
export interface RemoveWorktreeSafelyOptions {
	primaryRoot: string
	force?: boolean | undefined
	releaseBinding?: (() => void) | undefined
}

/**
 * The synchronous git-worktree helpers with their `Exec`/`WorktreeFs` BOUND. `worktreeApi(deps?)`
 * binds once (defaulting to `nodeExec`/`nodeWorktreeFs`); every method then drops the runner. Listing,
 * pruning, reuse, and path normalization are the async library's (`listWorktrees`, `pruneWorktrees`,
 * `acquire`, `normalizeWorktreePath`, re-exported here), which takes its runner per call.
 */
export interface WorktreeApi {
	/** @deprecated Use `primaryRoot`. The primary checkout's root — `resolvePrimaryRoot` bound. */
	primaryRoot(): string
	/** Create a worktree — `gitWorktreeAdapter.add` bound. */
	add(opts: WorktreeAddOptions): Worktree
	/** Remove a worktree under cyber-mux's gates — `removeWorktreeSafely` bound (its `fs` supplied). */
	removeSafely(path: string, opts: RemoveWorktreeSafelyOptions): void
}

/**
 * Bind the git-worktree helpers to a runner and filesystem once, returning a `WorktreeApi` whose
 * methods no longer take an `Exec`. `deps` default to `nodeExec` / `nodeWorktreeFs`.
 */
export function worktreeApi(deps?: WorktreeDeps | undefined): WorktreeApi {
	const exec = deps?.exec ?? nodeExec
	const fs = deps?.fs ?? nodeWorktreeFs
	return {
		primaryRoot: () => resolvePrimaryRoot(exec),
		add: (opts) => gitWorktreeAdapter.add(exec, opts),
		removeSafely: (path, opts) => removeWorktreeSafely(exec, path, { ...opts, fs }),
	}
}
