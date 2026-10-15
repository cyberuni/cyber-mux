import { existsSync } from 'node:fs'
import {
	AcquireError,
	type AcquireResult,
	acquire,
	listWorktrees as listGitWorktrees,
	normalizeWorktreePath,
	type PruneOutcome,
	primaryRoot,
	pruneWorktrees,
	readDirty,
	release,
	removeWorktree as removeGitWorktree,
	slotNumber,
	slotPath,
	type WorktreeEntry,
} from '@cyberuni/agent-harness/worktrees'
import type { Exec } from './exec.ts'
import type { MuxAdapter, MuxPlacement, MuxTarget, OpenedPane } from './mux.ts'
import { assertDistinctFromPrimary, gitWorktreeAdapter, type Worktree, WorktreeGitError } from './worktree.ts'
import { toHarnessExec } from './worktree-pool.ts'

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
	workspace?: string | undefined
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
		base?: string | undefined
		launch?: string | undefined
		/** Environment set in the opened root pane at birth — native at every tier on both backends. */
		env?: Record<string, string> | undefined
		at?: MuxPlacement | undefined
		label?: string | undefined
		/** Passed to `open` for a `pane:*` placement; see `MuxOpenOptions.from`. */
		from?: MuxTarget | undefined
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
export async function openExistingWorktree(
	exec: Exec,
	adapter: MuxAdapter,
	opts: {
		primaryRoot: string
		path: string
		launch?: string | undefined
		/** Environment set in the opened root pane; honored natively on the `open` route, compensated on the bind route. */
		env?: Record<string, string> | undefined
		at?: MuxPlacement | undefined
		label?: string | undefined
		/** Passed to `open` for a `pane:*` placement; see `MuxOpenOptions.from`. */
		from?: MuxTarget | undefined
	},
): Promise<OpenedWorktree> {
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
	const root = await normalizeWorktreePath(opts.path)
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
	const worktrees = await listGitWorktrees({ primaryRoot: opts.primaryRoot, exec: toHarnessExec(exec) })
	const branch = worktrees.find((entry) => entry.root === root)?.branch
	return { worktree: { root, branch: branch ?? '' }, target, degraded: isDegraded(adapter, at), envHonored: true }
}

/** A worktree as git reports it, plus the workspace a backend has it open in. */
export type ListedWorktree = WorktreeEntry & {
	/** The multiplexer workspace this worktree is open in; absent on a backend with no binding, and when
	 * nothing is open on it. */
	workspace?: string | undefined
}

/**
 * Every worktree of the repo, with the workspace each is open in.
 *
 * The facts come from git on EVERY backend and the backend contributes only the binding, joined by
 * normalized path. A backend that also enumerates worktrees is merely re-reading git, so letting it
 * answer would let two backends report a different branch for the same worktree — this is
 * structurally incapable of that.
 */
export async function listWorktrees(
	exec: Exec,
	adapter: MuxAdapter | undefined,
	opts: { primaryRoot: string },
): Promise<ListedWorktree[]> {
	const bindings = adapter?.worktree?.bindings(exec, { primaryRoot: opts.primaryRoot })
	const worktrees = await listGitWorktrees({ primaryRoot: opts.primaryRoot, exec: toHarnessExec(exec) })
	return worktrees.map((entry) => {
		const workspace = bindings?.get(entry.root)
		return workspace ? { ...entry, workspace } : entry
	})
}

/**
 * The library's prune over the worktrees nothing is open in — a worktree a workspace holds is in use
 * whatever git thinks of it, and the library cannot see a multiplexer's bindings. `apply: false` is the
 * dry run `worktree list` marks `(removable)` from, so the marker and the prune can never disagree.
 *
 * `strict: false` because cyber-mux's prune predates the process probe: where the probe cannot read
 * processes (anything but Linux) the prune proceeds as it always did, rather than skipping everything.
 */
export async function pruneUnboundWorktrees(
	exec: Exec,
	worktrees: ListedWorktree[],
	opts: { primaryRoot: string; apply: boolean },
): Promise<PruneOutcome[]> {
	const roots = worktrees.filter((w) => w.linked && !w.workspace).map((w) => w.root)
	if (roots.length === 0) return []
	const report = await pruneWorktrees({
		primaryRoot: opts.primaryRoot,
		apply: opts.apply,
		roots,
		strict: false,
		exec: toHarnessExec(exec),
	})
	return report.worktrees
}

/**
 * The next free slot path (`<parent>/<repo>.worktrees/<repo>-<n>`): the lowest `n` that no worktree of
 * the repo holds and nothing occupies on disk. Where `worktree add` checks out when the caller names no
 * path, so the library recognizes the result as its own and its prune and reuse reach it.
 */
export async function nextSlotPath(exec: Exec, primaryRoot: string): Promise<string> {
	const worktrees = await listGitWorktrees({ primaryRoot, exec: toHarnessExec(exec) })
	const taken = new Set(worktrees.map((w) => slotNumber(primaryRoot, w.root)).filter((n) => n !== undefined))
	for (let n = 1; ; n++) {
		const path = slotPath(primaryRoot, n)
		if (!taken.has(n) && !existsSync(path)) return path
	}
}

/** Why the library left a named worktree in place, in this CLI's words. */
const REMOVE_SKIP_PROSE: Partial<Record<NonNullable<PruneOutcome['reason']>, string>> = {
	leased: 'is leased — its holder must release it first',
	busy: 'has a live agent session working in it — end the session first',
	unverified: 'could not be checked for live agent sessions',
	unlisted: 'is not a worktree of this repository',
}

/**
 * Remove a worktree, with identical gates on every backend: refuse the primary checkout (absolute),
 * tolerate one already gone from disk, refuse uncommitted changes unless `force`. The removal itself is
 * the library's `removeWorktree`, which adds its own: a leased worktree, or one a live agent session
 * works in, is never removed.
 *
 * The caller named the worktree, so its branch need not have landed and it need not be the library's
 * own: once cyber-mux's dirty gate has passed, the library is asked with `force: true`, which waives
 * only those and the dirty check this already made.
 *
 * Removal is never handed to the backend — only the binding's release is, and only once git removed
 * the checkout, so a refused removal keeps its workspace. See `WorktreeWorkspaceCapability`.
 */
export async function removeWorktree(
	exec: Exec,
	adapter: MuxAdapter | undefined,
	path: string,
	opts: { primaryRoot: string; force?: boolean | undefined },
): Promise<void> {
	assertDistinctFromPrimary(path, opts.primaryRoot)
	const capability = adapter?.worktree
	const workspace = capability?.bindings(exec, { primaryRoot: opts.primaryRoot }).get(await normalizeWorktreePath(path))
	const releaseBinding = () => {
		if (capability && workspace) capability.releaseWorkspace(exec, workspace)
	}
	if (!existsSync(path)) {
		// A checkout already gone but still bound is exactly the orphan this releases; git has nothing
		// left to remove.
		releaseBinding()
		return
	}
	const harnessExec = toHarnessExec(exec)
	if (!opts.force && (await readDirty(path, { exec: harnessExec })) === true) {
		throw new WorktreeGitError(`worktree "${path}" has uncommitted changes — pass --force to discard them`)
	}
	const outcome = await removeGitWorktree({
		primaryRoot: opts.primaryRoot,
		root: path,
		force: true,
		strict: false,
		exec: harnessExec,
	})
	if (outcome.status === 'skipped') {
		const why = (outcome.reason && REMOVE_SKIP_PROSE[outcome.reason]) ?? `was skipped (${outcome.reason})`
		throw new WorktreeGitError(`worktree "${path}" ${why}`)
	}
	if (outcome.status !== 'removed') throw new WorktreeGitError(`git worktree remove failed for ${path}`)
	releaseBinding()
}

/**
 * The primary checkout's root, through the library — in this CLI's words when there is none, since
 * `reportWorktreeFailure` forwards only a `WorktreeGitError`'s message.
 */
export async function primaryCheckout(exec: Exec): Promise<string> {
	try {
		return await primaryRoot({ exec: toHarnessExec(exec) })
	} catch {
		throw new WorktreeGitError('cannot resolve the primary checkout — not inside a git repository')
	}
}

/**
 * Reuse an idle worktree or create one at the next free slot — the library's `acquire` under its own
 * gates (the library's own, unleased, idle, clean, landed), with the lease given straight back.
 *
 * Released because a one-shot verb has no later moment to release it: the worktree is handed back
 * unleased, exactly as before the pool existed, and a host that needs to hold one calls `acquire`
 * itself and releases when its work is done.
 */
export async function provisionWorktree(
	exec: Exec,
	opts: { primaryRoot: string; branch: string; base?: string | undefined },
): Promise<AcquireResult> {
	const harnessExec = toHarnessExec(exec)
	let acquired: AcquireResult
	try {
		acquired = await acquire({
			primaryRoot: opts.primaryRoot,
			holder: 'cyber-mux worktree provision',
			branch: opts.branch,
			base: opts.base,
			exec: harnessExec,
		})
	} catch (err) {
		if (err instanceof AcquireError) throw new WorktreeGitError(ACQUIRE_ERROR_PROSE[err.code])
		throw err
	}
	await release(acquired, { exec: harnessExec })
	return acquired
}

/** Why `acquire` handed back nothing, in this CLI's words. */
const ACQUIRE_ERROR_PROSE: Record<AcquireError['code'], string> = {
	'pool-full': 'every worktree slot is in use',
	'no-base': 'cannot resolve a branch to start from — pass --base',
	contended: 'another caller claimed every candidate worktree first — re-run',
}
