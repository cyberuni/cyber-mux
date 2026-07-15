import type { Exec } from './exec.ts'
import type { Worktree } from './worktree.ts'

/** Generic multiplexer seam — no host-specific concepts, so this composes with any caller. */

/** Where a new pane/window/session should be placed relative to the caller's current one.
 * `'workspace'` opens a genuinely separate workspace/session (herdr: `workspace create`; tmux: a
 * new detached session) — the caller's current workspace/session is left untouched, unlike every
 * other placement, which adds a pane/window inside it. */
export type SessionPlacement = 'pane:right' | 'pane:down' | 'tab' | 'workspace'

interface SessionOpenOptions {
	/** Working directory the new pane/window/session should start in. */
	cwd: string
	/** Command line to launch inside the new pane once it is open; omit for a blank pane. */
	launch?: string
	/** Placement relative to the caller; defaults to 'tab'. */
	at?: SessionPlacement
	/**
	 * Name for the space this opens, at whatever tier `at` opens it — every backend can name every
	 * tier, so this is host-neutral: on herdr a workspace/tab/pane label, on tmux a window name
	 * (`workspace` and `tab` both collapse to a Window there) or a pane title. Omit for the backend's
	 * own default.
	 */
	label?: string
}

/** Opaque handle to an open pane/window/session; backend-specific id lives in `id`. */
export interface SessionTarget {
	id: string
}

/** A pane the backend can currently see, as reported by `listPanes` (bulk enumeration). */
export interface LivePane {
	/** Backend-native pane id. */
	id: string
	/** Which multiplexer this pane belongs to. */
	mux: 'tmux' | 'herdr'
	/** The harness running in this pane, when the backend can report it (herdr only). */
	harness?: string
	/** The pane's working directory, when the backend reports it. */
	cwd?: string
}

export interface SessionReadOptions {
	/** How many trailing lines of output to capture; omit for the backend's default. */
	lines?: number
}

export interface CreateWorktreeWorkspaceOptions {
	/** The primary checkout's root — the repo the new worktree branches from. */
	primaryRoot: string
	/** Branch to create the worktree on. */
	branch: string
	/** Where the new worktree should be checked out. */
	path: string
	/** Start point for the new branch; omit for the backend's own default (the current HEAD). */
	base?: string
	/** Command line to launch inside the new workspace's root pane; omit for a blank pane. */
	launch?: string
	/** Name for the bound workspace; omit for the backend's own default. */
	label?: string
}

export interface OpenWorktreeWorkspaceOptions {
	/** The primary checkout's root — the repo the worktree belongs to. */
	primaryRoot: string
	/** An EXISTING worktree's checkout path. */
	path: string
	/** Command line to launch inside the new workspace's root pane; omit for a blank pane. */
	launch?: string
	/** Name for the bound workspace; omit for the backend's own default. */
	label?: string
}

/** A worktree open in a workspace bound to it — the capability's whole product. */
export interface WorktreeWorkspace {
	target: SessionTarget
	worktree: Worktree
	/** The backend workspace now bound to the worktree. */
	workspace: string
}

/**
 * The optional capability a backend implements when it binds a git worktree to a workspace as a
 * FIRST-CLASS RECORD — the binding a multiplexer's UI groups a repo's primary checkout and its
 * worktrees by.
 *
 * That binding — NOT "understands git worktrees" — is the all-or-nothing property, which is why
 * these members ship as one object rather than as separate optional methods. Established
 * empirically against herdr: `git worktree add` followed by `workspace create --cwd <checkout>`
 * yields a workspace with no worktree record at all — herdr does not know it is a worktree and
 * leaves it out of the repo's group. Only routing through herdr's own `worktree create`/`open`
 * produces the binding. tmux has no workspace tier and never binds, so it omits this entirely;
 * callers fall back to plain git plus a placement-appropriate `open()`.
 *
 * Two things this deliberately does NOT own:
 *
 * - **The worktree facts.** Path, branch, linked, prunable are git's, read from git on every
 *   backend (`listWorktreesFromGit`). A backend that also enumerates worktrees is only re-reading
 *   git; letting it answer would let two backends disagree about the same worktree's branch. The
 *   backend contributes `bindings` alone — the one fact git cannot know.
 * - **Removal.** herdr's `worktree remove` takes a workspace id, so it cannot even address an
 *   unbound worktree, and whether it dirty-checks is unknown — delegating would make a destructive
 *   operation's safety depend on whether a workspace happened to be open. Removal is always
 *   cyber-mux's own gates plus `git worktree remove`; a backend only releases its binding.
 *
 * NOTE: every member here OPENS a workspace — herdr has no "create a worktree without a workspace"
 * primitive. This is never the route for a bare worktree add; that is always plain git.
 */
export interface WorktreeWorkspaceCapability {
	/**
	 * Create a worktree AND open it in a workspace bound to it, in one call (herdr `worktree
	 * create`). Always makes a workspace, so it cannot serve a pane or tab placement.
	 */
	createInWorkspace(exec: Exec, opts: CreateWorktreeWorkspaceOptions): WorktreeWorkspace
	/**
	 * Open an EXISTING worktree in a workspace bound to it (herdr `worktree open`) — the remedy that
	 * groups a worktree plain git created earlier.
	 */
	openInWorkspace(exec: Exec, opts: OpenWorktreeWorkspaceOptions): WorktreeWorkspace
	/**
	 * Which workspace each of the repo's worktrees is currently open in, keyed by normalized checkout
	 * path. A worktree with nothing open on it is absent from the map. The only fact git cannot answer.
	 */
	bindings(exec: Exec, opts: { primaryRoot: string }): Map<string, string>
	/**
	 * Close the workspace, releasing the binding WITHOUT touching the checkout on disk — the worktree
	 * is left for `git worktree remove` to take under cyber-mux's own gates.
	 */
	releaseWorkspace(exec: Exec, workspace: string): void
}

export interface SessionAdapter {
	/** Backend name, e.g. "tmux" or "herdr". */
	readonly name: string
	/** Create a new pane/window in `opts.cwd`, running `opts.launch` if given; returns its target handle. */
	open(exec: Exec, opts: SessionOpenOptions): SessionTarget
	/**
	 * Present only on a backend that binds a git worktree to a workspace (herdr); `undefined` on one
	 * with no such concept (tmux), where callers fall back to plain git plus `open()`.
	 */
	readonly worktree?: WorktreeWorkspaceCapability
	/** Type text into the target session (submitted, not queued). */
	send(exec: Exec, target: SessionTarget, text: string): void
	/**
	 * Submit the target's already-staged input buffer via a bare Enter keystroke — no new text is
	 * typed. Used to complete a turn whose atomic `send` was swallowed by a booting harness (the
	 * text staged in the input box, unsent); flushing never re-types the message, so a re-submit
	 * cannot duplicate it.
	 */
	submit(exec: Exec, target: SessionTarget): void
	/** Capture the target session's current output. */
	read(exec: Exec, target: SessionTarget, opts?: SessionReadOptions): string
	/**
	 * Beam the attached client's view all the way to the target pane — across workspace and tab, not
	 * just within the current one. Resolves the pane's own workspace/tab from the backend and drives
	 * the full switch chain; best-effort within (the backend owns the actual move), but throws rather
	 * than reporting a false success when the recorded pane no longer resolves to a live pane.
	 */
	focus(exec: Exec, target: SessionTarget): void
	/** Close the target session. */
	teardown(exec: Exec, target: SessionTarget): void
	/**
	 * Whether the target pane still exists in this backend — the liveness check `prune` runs against a
	 * record's pane locator. Each backend answers with its own primitive so a herdr pane id is never
	 * probed with a tmux query (or vice versa).
	 */
	paneExists(exec: Exec, target: SessionTarget): boolean
	/**
	 * Whether the attached client is currently viewing this pane — a read-only focus probe. `true` =
	 * positively focused, `false` = positively not focused, `undefined` = the backend cannot report
	 * focus or the query could not be answered (callers FAIL OPEN on undefined). Read-only: moves no
	 * focus, opens nothing (unlike `focus`).
	 */
	isPaneFocused(exec: Exec, target: SessionTarget): boolean | undefined
	/**
	 * Enumerate every live pane this backend can currently see — the bulk counterpart to
	 * `paneExists`'s single targeted query. `reconcile` uses this to cull dead records in one pass
	 * against the mux the caller is actually inside; it never enumerates the other mux.
	 */
	listPanes(exec: Exec): LivePane[]
}
