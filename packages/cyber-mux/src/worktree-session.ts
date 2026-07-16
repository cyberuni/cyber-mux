import type { Exec } from './exec.ts'
import type { SessionAdapter, SessionPlacement, SessionTarget } from './session.ts'
import {
	gitWorktreeAdapter,
	listWorktreesFromGit,
	normalizeWorktreePath,
	removeWorktreeSafely,
	type Worktree,
	type WorktreeEntry,
} from './worktree.ts'

/**
 * Worktrees × sessions — the routing policy, and the only module that knows both halves. `worktree.ts`
 * stays a pure git adapter that owes nothing to the session seam; `session.ts` stays a pure mux seam
 * that owes nothing to git. Deciding between them is a third concern, and it lives here.
 */

/** A worktree that has been opened somewhere — the product of every routing decision below. */
export interface OpenedWorktree {
	worktree: Worktree
	target: SessionTarget
	/** The workspace bound to the worktree; absent when it opened ungrouped. */
	workspace?: string
	/**
	 * The backend COULD have bound this worktree to a workspace, but the route taken did not — i.e. a
	 * caller on herdr asked for a pane or tab placement, which its `worktree create` cannot serve.
	 * Never true on a backend with no binding at all (tmux), where no grouping was ever on offer:
	 * there is nothing to report about a feature the backend does not have.
	 */
	degraded: boolean
}

/**
 * Grouping is possible only where the backend binds AND the caller asked for a workspace — herdr's
 * `worktree create` ALWAYS opens a workspace, so it cannot serve a pane or tab placement.
 */
function canBind(adapter: SessionAdapter, at: SessionPlacement | undefined): boolean {
	return Boolean(adapter.worktree) && at === 'workspace'
}

/** True only where a group was on offer and the placement is what cost us it. */
function isDegraded(adapter: SessionAdapter, at: SessionPlacement | undefined): boolean {
	return Boolean(adapter.worktree) && !canBind(adapter, at)
}

/**
 * Create a worktree and open it.
 *
 * Routes through the backend's own primitive when it can bind (grouped), and otherwise falls back to
 * `git worktree add` plus a plain `open()`. The fallback is a complete, useful outcome — a worktree
 * open in a split pane — just not a grouped one, so it is REPORTED (`degraded`), never refused.
 * Refusing would make identical flags succeed on tmux and fail on herdr, which is exactly the
 * backend leak this seam exists to prevent.
 */
export function addAndOpenWorktree(
	exec: Exec,
	adapter: SessionAdapter,
	opts: {
		primaryRoot: string
		branch: string
		path: string
		base?: string
		launch?: string
		at?: SessionPlacement
		label?: string
		/** Passed to `open` for a `pane:*` placement; see `SessionOpenOptions.from`. */
		from?: SessionTarget
	},
): OpenedWorktree {
	if (canBind(adapter, opts.at)) {
		const created = adapter.worktree!.createInWorkspace(exec, {
			primaryRoot: opts.primaryRoot,
			branch: opts.branch,
			path: opts.path,
			base: opts.base,
			launch: opts.launch,
			label: opts.label,
		})
		return { ...created, degraded: false }
	}
	const worktree = gitWorktreeAdapter.add(exec, {
		primaryRoot: opts.primaryRoot,
		path: opts.path,
		branch: opts.branch,
		base: opts.base,
	})
	const target = adapter.open(exec, {
		cwd: worktree.root,
		launch: opts.launch,
		at: opts.at,
		label: opts.label,
		from: opts.from,
	})
	return { worktree, target, degraded: isDegraded(adapter, opts.at) }
}

/**
 * Open an EXISTING worktree — the remedy that groups one a bare `worktree add` created earlier, so
 * "add now, group later" is a real story rather than a dead end.
 */
export function openExistingWorktree(
	exec: Exec,
	adapter: SessionAdapter,
	opts: {
		primaryRoot: string
		path: string
		launch?: string
		at?: SessionPlacement
		label?: string
		/** Passed to `open` for a `pane:*` placement; see `SessionOpenOptions.from`. */
		from?: SessionTarget
	},
): OpenedWorktree {
	const at = opts.at ?? 'workspace'
	if (canBind(adapter, at)) {
		const opened = adapter.worktree!.openInWorkspace(exec, {
			primaryRoot: opts.primaryRoot,
			path: opts.path,
			launch: opts.launch,
			label: opts.label,
		})
		return { ...opened, degraded: false }
	}
	const root = normalizeWorktreePath(opts.path)
	const target = adapter.open(exec, { cwd: root, launch: opts.launch, at, label: opts.label, from: opts.from })
	// The branch is git's answer, not the backend's — same rule as `listWorktrees`.
	const branch = listWorktreesFromGit(exec, opts.primaryRoot).find((entry) => entry.root === root)?.branch
	return { worktree: { root, branch: branch ?? '' }, target, degraded: isDegraded(adapter, at) }
}

/**
 * Every worktree of the repo, with the workspace each is open in.
 *
 * The facts come from git on EVERY backend and the backend contributes only the binding, joined by
 * normalized path. A backend that also enumerates worktrees is merely re-reading git, so letting it
 * answer would let two backends report a different branch for the same worktree — this is
 * structurally incapable of that.
 */
export function listWorktrees(
	exec: Exec,
	adapter: SessionAdapter | undefined,
	opts: { primaryRoot: string },
): WorktreeEntry[] {
	const bindings = adapter?.worktree?.bindings(exec, { primaryRoot: opts.primaryRoot })
	return listWorktreesFromGit(exec, opts.primaryRoot).map((entry) => {
		const workspace = bindings?.get(entry.root)
		return workspace ? { ...entry, workspace } : entry
	})
}

/**
 * Remove a worktree, with identical gates on every backend: refuse the primary checkout (absolute),
 * tolerate one already gone from disk, refuse uncommitted changes unless `force`.
 *
 * Removal is never handed to the backend — only the binding's release is. See
 * `WorktreeWorkspaceCapability` for why, and `removeWorktreeSafely` for why the ordering of that
 * release is a specified property rather than an incidental one.
 */
export function removeWorktree(
	exec: Exec,
	adapter: SessionAdapter | undefined,
	path: string,
	opts: { primaryRoot: string; force?: boolean },
): void {
	const capability = adapter?.worktree
	const workspace = capability?.bindings(exec, { primaryRoot: opts.primaryRoot }).get(normalizeWorktreePath(path))
	removeWorktreeSafely(exec, path, {
		primaryRoot: opts.primaryRoot,
		force: opts.force,
		releaseBinding: capability && workspace ? () => capability.releaseWorkspace(exec, workspace) : undefined,
	})
}
