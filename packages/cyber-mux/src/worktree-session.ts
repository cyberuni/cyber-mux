import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxPlacement, MuxTarget, OpenedPane } from './mux.ts'
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
 * stays a pure git adapter that owes nothing to the session seam; `mux.ts` stays a pure mux seam
 * that owes nothing to git. Deciding between them is a third concern, and it lives here.
 */

/** A worktree that has been opened somewhere — the product of every routing decision below. */
export interface OpenedWorktree {
	worktree: Worktree
	/**
	 * The opened root pane, and the tab it sits in. Both routes report the tab — the binding route from
	 * the backend's own worktree envelope, the plain-git fallback from `open` — so a caller handed this
	 * region can address its tab (to group it, to name it) without reaching for the pane id, which
	 * resolves on tmux and is refused by herdr.
	 */
	target: OpenedPane
	/** The workspace bound to the worktree; absent when it opened ungrouped. */
	workspace?: string
	/**
	 * The backend COULD have bound this worktree to a workspace, but the route taken did not — i.e. a
	 * caller on herdr asked for a pane or tab placement, which its `worktree create` cannot serve.
	 * Never true on a backend with no binding at all (tmux), where no grouping was ever on offer:
	 * there is nothing to report about a feature the backend does not have.
	 */
	degraded: boolean
	/**
	 * Whether a requested `env` actually reached the opened root pane. `false` ONLY on herdr's binding
	 * route, whose `worktree create` has no `env` param at all (unlike `workspace`/`tab`/`pane
	 * create`) and rejects the flag outright. Vacuously `true` when no env was asked for.
	 *
	 * Reported rather than solved here because the remedy is a *command* — prefixing `env K=V` onto
	 * what the pane runs — and this module opens panes; it does not decide what they run. Only the
	 * route taken knows this fact, which is why it is reported rather than inferred by the caller.
	 */
	envHonored: boolean
}

/**
 * Grouping is possible only where the backend binds AND the caller asked for a workspace — herdr's
 * `worktree create` ALWAYS opens a workspace, so it cannot serve a pane or tab placement.
 */
function canBind(adapter: MuxAdapter, at: MuxPlacement | undefined): boolean {
	return Boolean(adapter.worktree) && at === 'workspace'
}

/** True only where a group was on offer and the placement is what cost us it. */
function isDegraded(adapter: MuxAdapter, at: MuxPlacement | undefined): boolean {
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
	adapter: MuxAdapter,
	opts: {
		primaryRoot: string
		branch: string
		path: string
		base?: string
		launch?: string
		/** Environment set in the opened root pane at birth — native at every tier on both backends. */
		env?: Record<string, string>
		at?: MuxPlacement
		label?: string
		/** Passed to `open` for a `pane:*` placement; see `MuxOpenOptions.from`. */
		from?: MuxTarget
	},
): OpenedWorktree {
	if (canBind(adapter, opts.at)) {
		const created = adapter.worktree!.createInWorkspace(exec, {
			primaryRoot: opts.primaryRoot,
			branch: opts.branch,
			path: opts.path,
			base: opts.base,
			launch: opts.launch,
			env: opts.env,
			label: opts.label,
		})
		// herdr's `worktree create` takes no env — the adapter accepts `env` and does not emit it, so
		// say so rather than let the caller assume it landed.
		return { ...created, degraded: false, envHonored: !opts.env }
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
		env: opts.env,
		at: opts.at,
		label: opts.label,
		from: opts.from,
	})
	// This route goes through `open`, where env is native at every tier on both backends.
	return { worktree, target, degraded: isDegraded(adapter, opts.at), envHonored: true }
}

/**
 * Open an EXISTING worktree — the remedy that groups one a bare `worktree add` created earlier, so
 * "add now, group later" is a real story rather than a dead end.
 */
export function openExistingWorktree(
	exec: Exec,
	adapter: MuxAdapter,
	opts: {
		primaryRoot: string
		path: string
		launch?: string
		/** Environment set in the opened root pane; honored natively on the `open` route, compensated on the bind route. */
		env?: Record<string, string>
		at?: MuxPlacement
		label?: string
		/** Passed to `open` for a `pane:*` placement; see `MuxOpenOptions.from`. */
		from?: MuxTarget
	},
): OpenedWorktree {
	const at = opts.at ?? 'workspace'
	if (canBind(adapter, at)) {
		const opened = adapter.worktree!.openInWorkspace(exec, {
			primaryRoot: opts.primaryRoot,
			path: opts.path,
			launch: opts.launch,
			env: opts.env,
			label: opts.label,
		})
		// herdr's `worktree open` takes no env — the adapter compensates on the launch and reports the
		// drop here, exactly as the create route does, so a caller cannot assume env landed.
		return { ...opened, degraded: false, envHonored: !opts.env }
	}
	const root = normalizeWorktreePath(opts.path)
	const target = adapter.open(exec, {
		cwd: root,
		launch: opts.launch,
		env: opts.env,
		at,
		label: opts.label,
		from: opts.from,
	})
	// This route goes through `open`, where env is native at every tier on both backends.
	// The branch is git's answer, not the backend's — same rule as `listWorktrees`.
	const branch = listWorktreesFromGit(exec, opts.primaryRoot).find((entry) => entry.root === root)?.branch
	return { worktree: { root, branch: branch ?? '' }, target, degraded: isDegraded(adapter, at), envHonored: true }
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
	adapter: MuxAdapter | undefined,
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
	adapter: MuxAdapter | undefined,
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
