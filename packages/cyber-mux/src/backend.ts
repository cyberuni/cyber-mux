import { type Exec, nodeExec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type {
	CreateWorktreeWorkspaceOptions,
	LivePane,
	MuxAdapter,
	MuxOpenOptions,
	MuxReadOptions,
	MuxSpaceTier,
	MuxTarget,
	OpenedPane,
	OpenWorktreeWorkspaceOptions,
	RegionPane,
	WorkspaceTab,
	WorktreeWorkspace,
} from './mux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { createZellijAdapter } from './mux.zellij.ts'
import { currentPane, probeMultiplexer } from './mux-probe.ts'
import { type NudgeOptions, type NudgeResult, nudge } from './nudge.ts'

/**
 * Resolve the raw backend for the multiplexer this process is inside, via the two-mode mux probe
 * (`$CYBER_MUX` fast-path/override, else ancestry discovery from `$$` falling back to the
 * `$TMUX`/`$HERDR_ENV`/`$WEZTERM_PANE`/`$ZELLIJ` hint when the walk is inconclusive) —
 * tmux/herdr/wezterm/zellij map to their adapters; anything else throws, because a caller asking to
 * drive panes with no multiplexer has an unmet precondition, and a loud, actionable failure beats a
 * silent no-op.
 *
 * The zellij adapter is bound to the ambient session name (`$ZELLIJ_SESSION_NAME`) at resolution — it
 * reports that as `OpenedPane.workspace`, so the session name has to come from the SAME `env` the
 * probe reads. A missing name simply omits `workspace`; see `createZellijAdapter`.
 *
 * `screen` is a KNOWN mux — the probe detects it (ancestry) and honors it as an override (fast-path)
 * — but it is NOT a drivable backend, so it throws its OWN message naming the reason rather than the
 * generic "no multiplexer" one. That distinction is the whole point of issue #45: a caller who
 * pinned `CYBER_MUX=screen` declared a real multiplexer, and telling them "run inside a multiplexer"
 * would be a lie. The empirical probe behind the rejection is recorded in the ADR log
 * (`.agents/spec/design/decisions`): GNU Screen addresses its split regions POSITIONALLY (no
 * per-pane id), and `$WINDOW` is left unset in panes opened via `screen -X`, so a driver-created
 * pane has no stable identity to send to, read from, self-identify by, or enumerate — the exact
 * affordance `SessionTarget.id`/`currentPane`/`LivePane.id` are load-bearing on, and the exact one
 * wezterm (#47) had and screen lacks. Keeping the value KNOWN-but-rejected honors the override's
 * whole reason to exist: pinning it tells the caller the truth immediately instead of silently
 * discovering something else.
 *
 * Returns the PURE, exec-injected `MuxAdapter` seam — the one whose methods each take an `Exec`.
 * `resolveMux` binds one of these into a `MuxSession`; this is the lower layer, exported for a caller
 * that wants to thread its own runner per call rather than bind one. Not in a multiplexer? Gate on
 * `probeMultiplexer(env).mux !== 'none'` first — that answer never throws.
 */
export function resolveMuxAdapter(env: NodeJS.ProcessEnv, exec: Exec = nodeExec): MuxAdapter {
	const probe = probeMultiplexer(exec, env)
	if (probe.mux === 'tmux') return tmuxMuxAdapter
	if (probe.mux === 'herdr') return herdrMuxAdapter
	if (probe.mux === 'wezterm') return weztermMuxAdapter
	if (probe.mux === 'zellij') return createZellijAdapter({ session: env['ZELLIJ_SESSION_NAME'] })
	if (probe.mux === 'screen') {
		throw new Error(
			'cyber-mux detected GNU Screen, which it cannot drive: Screen addresses its split regions ' +
				'positionally (no per-pane id) and leaves $WINDOW unset in panes opened via `screen -X`, so a ' +
				'pane has no stable identity to send to, read from, or self-identify by. Run inside tmux ' +
				'($TMUX), herdr ($HERDR_ENV=1), wezterm ($WEZTERM_PANE set), or zellij ($ZELLIJ set) instead.',
		)
	}
	throw new Error(
		'cyber-mux requires a session backend — run inside tmux ($TMUX), herdr ($HERDR_ENV=1), wezterm ($WEZTERM_PANE set), or zellij ($ZELLIJ set)',
	)
}

/**
 * The seams a `MuxSession` call may override. Every member is optional: an omitted member falls back
 * to whatever the session was bound with at `resolveMux` (which in turn defaults to `nodeExec`).
 *
 * This is the "uniform" trailing parameter every session method carries — pass nothing in the common
 * case, pass `{ exec }` for a one-off override (a recording fake in a test, a decorated runner).
 */
export interface MuxDeps {
	exec?: Exec | undefined
}

/** The worktree capability with its `Exec` bound — see `MuxSession`. */
export interface BoundWorktreeWorkspaceCapability {
	createInWorkspace(opts: CreateWorktreeWorkspaceOptions, deps?: MuxDeps | undefined): WorktreeWorkspace
	openInWorkspace(opts: OpenWorktreeWorkspaceOptions, deps?: MuxDeps | undefined): WorktreeWorkspace
	bindings(opts: { primaryRoot: string }, deps?: MuxDeps | undefined): Map<string, string>
	releaseWorkspace(workspace: string, deps?: MuxDeps | undefined): void
}

/** The region-inspection capability with its `Exec` bound — see `MuxSession`. */
export interface BoundRegionInspector {
	describeRegion(target: MuxTarget, deps?: MuxDeps | undefined): RegionPane[]
	describeWorkspace(target: MuxTarget, deps?: MuxDeps | undefined): WorkspaceTab[]
}

/**
 * A `MuxAdapter` with its `Exec` BOUND — the consumer-facing surface `resolveMux` returns.
 *
 * Every method mirrors `MuxAdapter` but drops the leading `exec` (bound once, at resolution) and gains
 * a trailing optional `deps?` for a per-call override. `callerPane` and `nudge` are folded in as
 * methods so a caller never re-plumbs the adapter or an exec into them: `mux.open(opts)` in the common
 * case, `mux.open(opts, { exec })` to override, and a test binds its fake once with
 * `resolveMux(env, { exec: fake })`.
 *
 * The raw `MuxAdapter` stays the pure, exec-injected seam underneath — and stays exported — for a
 * caller threading its own runner. Binding lives here at the composition layer, not inside each
 * adapter, so a driven adapter is never coupled to a concrete `nodeExec`.
 */
export interface MuxSession {
	readonly name: string
	readonly canSizeSplits?: boolean | undefined
	callerPane(): MuxTarget | undefined
	open(opts: MuxOpenOptions, deps?: MuxDeps | undefined): OpenedPane
	rename(target: MuxTarget, tier: MuxSpaceTier, name: string, deps?: MuxDeps | undefined): void
	group(target: MuxTarget, group: string, name?: string | undefined, deps?: MuxDeps | undefined): void
	sendText(target: MuxTarget, text: string, deps?: MuxDeps | undefined): void
	sendKeys(target: MuxTarget, keys: string[], deps?: MuxDeps | undefined): void
	submit(target: MuxTarget, text?: string | undefined, deps?: MuxDeps | undefined): void
	read(target: MuxTarget, opts?: MuxReadOptions | undefined, deps?: MuxDeps | undefined): string
	focus(target: MuxTarget, deps?: MuxDeps | undefined): void
	teardown(target: MuxTarget, deps?: MuxDeps | undefined): void
	paneExists(target: MuxTarget, deps?: MuxDeps | undefined): boolean
	isPaneFocused(target: MuxTarget, deps?: MuxDeps | undefined): boolean | undefined
	listPanes(deps?: MuxDeps | undefined): LivePane[]
	nudge(
		target: MuxTarget,
		message: string,
		opts?: NudgeOptions | undefined,
		deps?: MuxDeps | undefined,
	): Promise<NudgeResult>
	readonly worktree?: BoundWorktreeWorkspaceCapability | undefined
	readonly regions?: BoundRegionInspector | undefined
}

/**
 * Resolve the multiplexer this process is inside and return it as a `MuxSession` with `exec` BOUND —
 * the ergonomic entry point. `deps.exec` (default `nodeExec`) runs the detection probe AND is the
 * default runner every method binds; a per-call `deps` overrides it.
 *
 * Throws when no supported multiplexer is detected (see `resolveMuxAdapter`); gate on
 * `probeMultiplexer(env).mux !== 'none'` first if a caller runs with-or-without one. For the pure
 * exec-injected seam, reach for `resolveMuxAdapter` instead.
 */
export function resolveMux(env: NodeJS.ProcessEnv, deps?: MuxDeps | undefined): MuxSession {
	const boundExec = deps?.exec ?? nodeExec
	const raw = resolveMuxAdapter(env, boundExec)
	// The resolved runner for a call: its own `deps.exec` override, else the exec bound at resolution.
	const pick = (d?: MuxDeps | undefined): Exec => d?.exec ?? boundExec
	return {
		name: raw.name,
		...(raw.canSizeSplits !== undefined ? { canSizeSplits: raw.canSizeSplits } : {}),
		callerPane: () => callerPane(raw, env),
		open: (opts, d) => raw.open(pick(d), opts),
		rename: (target, tier, name, d) => raw.rename(pick(d), target, tier, name),
		group: (target, group, name, d) => raw.group(pick(d), target, group, name),
		sendText: (target, text, d) => raw.sendText(pick(d), target, text),
		sendKeys: (target, keys, d) => raw.sendKeys(pick(d), target, keys),
		submit: (target, text, d) => raw.submit(pick(d), target, text),
		read: (target, opts, d) => raw.read(pick(d), target, opts),
		focus: (target, d) => raw.focus(pick(d), target),
		teardown: (target, d) => raw.teardown(pick(d), target),
		paneExists: (target, d) => raw.paneExists(pick(d), target),
		isPaneFocused: (target, d) => raw.isPaneFocused(pick(d), target),
		listPanes: (d) => raw.listPanes(pick(d)),
		nudge: (target, message, opts, d) => nudge(raw, pick(d), target, message, opts),
		...(raw.worktree ? { worktree: bindWorktree(raw.worktree, pick) } : {}),
		...(raw.regions ? { regions: bindRegions(raw.regions, pick) } : {}),
	}
}

function bindWorktree(
	wt: NonNullable<MuxAdapter['worktree']>,
	pick: (d?: MuxDeps | undefined) => Exec,
): BoundWorktreeWorkspaceCapability {
	return {
		createInWorkspace: (opts, d) => wt.createInWorkspace(pick(d), opts),
		openInWorkspace: (opts, d) => wt.openInWorkspace(pick(d), opts),
		bindings: (opts, d) => wt.bindings(pick(d), opts),
		releaseWorkspace: (workspace, d) => wt.releaseWorkspace(pick(d), workspace),
	}
}

function bindRegions(
	regions: NonNullable<MuxAdapter['regions']>,
	pick: (d?: MuxDeps | undefined) => Exec,
): BoundRegionInspector {
	return {
		describeRegion: (target, d) => regions.describeRegion(pick(d), target),
		describeWorkspace: (target, d) => regions.describeWorkspace(pick(d), target),
	}
}

/**
 * This process's own pane, as something `adapter` can address — `MuxOpenOptions.from`'s intended
 * argument for a `pane:*` open, so a split lands on the caller rather than on whichever pane the
 * user is looking at (see `from`'s note for why each backend's default gets that wrong).
 *
 * `undefined` when this session is in no pane, or in a pane belonging to a *different* multiplexer
 * than `adapter` drives — that mismatch is reachable (a `$TMUX_PANE` inherited into a herdr pane,
 * `$CYBER_MUX` overridden to the other backend), and handing one backend the other's pane id would
 * turn a self-identity mixup into a split of some unrelated pane. Falling back to the backend's own
 * default is the conservative answer: still possibly the wrong pane, but never a foreign id.
 *
 * A `MuxSession` exposes this bound as `mux.callerPane()`; this free form is for the raw seam.
 */
export function callerPane(adapter: MuxAdapter, env: NodeJS.ProcessEnv): MuxTarget | undefined {
	const self = currentPane(env)
	return self && self.mux === adapter.name ? { id: self.pane } : undefined
}
