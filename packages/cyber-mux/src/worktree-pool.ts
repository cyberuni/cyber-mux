import {
	type CreateWorktreeRequest,
	gitWorktreeCreator,
	type Exec as HarnessExec,
	type WorktreeCreator,
} from '@cyberuni/agent-harness/worktrees'
import { type Exec, nodeExec } from './exec.ts'
import type { MuxAdapter, WorktreeWorkspace } from './mux.ts'

/**
 * The leased worktree pool, from `@cyberuni/agent-harness/worktrees` — the library the worktree logic
 * moved to (cyberuni/agent-harness#62): facts, ownership, leases, the process probe, prune, and
 * `.worktreeinclude` seeding. Re-exported here so a `cyber-mux/worktree` consumer reaches it through
 * one import, and so the one mux-specific piece it needs, `muxWorktreeCreator`, sits beside it.
 *
 * Three library names collide with this subpath's older synchronous API (`pruneWorktrees`,
 * `normalizeWorktreePath`, `ghForgeMergedProbe`) and keep their cyber-mux meaning until those are
 * removed; import the library's from `@cyberuni/agent-harness/worktrees` directly. The colliding types
 * are re-exported under a `Harness` prefix.
 */
export {
	AcquireError,
	type AcquireErrorCode,
	type AcquireOptions,
	type AcquireResult,
	acquire,
	type ClassifyOwnerOptions,
	type CreateWorktreeRequest,
	claimLease,
	classifyOwner,
	type DirtyOptions,
	type Exec as HarnessExec,
	type ExplainOptions,
	explain,
	type ForgeMergedProbe as HarnessForgeMergedProbe,
	gitWorktreeCreator,
	holdsLease,
	type LandedSignal,
	LEASE_LIBRARY,
	type Lease,
	type LeaseFs,
	type LeaseReason,
	type LeaseStoreOptions,
	type LeftoverProcess,
	type LeftoverReason,
	type ListWorktreesOptions,
	leaseFile,
	listWorktrees,
	nodeLeaseFs,
	nodeSeedFs,
	type OccupancyOptions,
	occupants,
	type PrimaryRootOptions,
	type ProbeOptions,
	type ProcessInfo,
	type ProcessProbe,
	type ProcessSource,
	type PruneOutcome,
	type PruneReport,
	type PruneSkipReason,
	type PruneWorktreesOptions,
	parseLeaseReason,
	primaryRoot,
	probeProcesses,
	procfsProcessSource,
	type ReleaseResult,
	readDirty,
	release,
	type SeedFs,
	type SeedInventory,
	type SeedSkip,
	type SeedSkipReason,
	type SeedWorktreeOptions,
	type Session,
	type SessionHarnessId,
	type SkipReason,
	seedWorktree,
	slotNumber,
	slotPath,
	WORKTREE_INCLUDE,
	type WorktreeCreator,
	type WorktreeEntry as HarnessWorktreeEntry,
	type WorktreeOccupancy,
	type WorktreeOwner,
	type WorktreeOwnerKind,
	type WorktreeVerdict,
	worktreesDir,
} from '@cyberuni/agent-harness/worktrees'

/**
 * Lift cyber-mux's synchronous `Exec` onto the library's async one, so a caller drives both halves
 * (git through the library, the multiplexer through cyber-mux) with the same runner — or the same
 * fake in a test.
 */
export function toHarnessExec(exec: Exec): HarnessExec {
	return async (cmd, args) => exec(cmd, [...args])
}

export interface MuxWorktreeCreatorOptions {
	/** Runs both the git and the multiplexer commands; defaults to `nodeExec`. */
	exec?: Exec | undefined
	/** Command line to launch in the bound workspace's root pane; omit for a blank pane. */
	launch?: string | undefined
	/** Environment for that root pane. herdr's worktree route sets it on the launch, not at birth. */
	env?: Record<string, string> | undefined
	/** Name for the bound workspace; omit for the backend's own default. */
	label?: string | undefined
	/** Receives the workspace the new worktree was bound to; never called on a backend that does not bind. */
	onBound?: ((bound: WorktreeWorkspace, request: CreateWorktreeRequest) => void) | undefined
}

/**
 * The library's injectable `WorktreeCreator`, made by cyber-mux so the multiplexer binding stays here
 * (agent-harness#62 scope 12). Pass it as `acquire({ create })`.
 *
 * It always creates the checkout with the library's own `gitWorktreeCreator`, so the library's
 * contract — its chosen path, an existing branch, a new one at `base`, or a detached HEAD — holds on
 * every backend. On a backend that binds worktrees to workspaces (herdr), it then opens the new
 * checkout through the backend's `openInWorkspace`, which is what records the binding; plain git plus
 * a workspace opened by path would leave herdr unaware it is a worktree. A backend with no binding
 * (tmux, or no multiplexer at all) gets the plain checkout and nothing opened.
 *
 * A failed bind throws after the checkout exists. `acquire` then holds no lease on it, and the library
 * classifies an unleased checkout at its slot path as its own idle worktree, so the next `acquire`
 * reuses it rather than leaking it.
 */
export function muxWorktreeCreator(
	adapter: MuxAdapter | undefined,
	options: MuxWorktreeCreatorOptions = {},
): WorktreeCreator {
	const exec = options.exec ?? nodeExec
	const create = gitWorktreeCreator(toHarnessExec(exec))
	return async (request) => {
		await create(request)
		const capability = adapter?.worktree
		if (!capability) return
		const bound = capability.openInWorkspace(exec, {
			primaryRoot: request.primaryRoot,
			path: request.path,
			launch: options.launch,
			env: options.env,
			label: options.label,
		})
		options.onBound?.(bound, request)
	}
}
