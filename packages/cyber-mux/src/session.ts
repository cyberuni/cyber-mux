import type { Exec } from './exec.ts'
import type { Worktree } from './worktree.ts'

/** Generic multiplexer seam — no host-specific concepts, so this composes with any caller. */

/** Where a new pane/window/session should be placed relative to the caller's current one.
 * `'workspace'` opens a genuinely separate workspace/session (herdr: `workspace create`; tmux: a
 * new detached session) — the caller's current workspace/session is left untouched, unlike every
 * other placement, which adds a pane/window inside it. */
export type SessionPlacement = 'pane:right' | 'pane:down' | 'tab' | 'workspace'

export interface SessionOpenOptions {
	/** Working directory the new pane/window/session should start in. */
	cwd: string
	/** Command line to launch inside the new pane once it is open; omit for a blank pane. */
	launch?: string
	/** Placement relative to the caller; defaults to 'tab'. */
	at?: SessionPlacement
	/**
	 * The pane a `pane:*` placement splits. Ignored by `tab`/`workspace`, which split nothing.
	 *
	 * Pass it. Omitting it does **not** mean "the calling pane" — it means "whatever this backend
	 * defaults to", and the two backends default to opposite things: herdr resolves `--current` from
	 * `$HERDR_PANE_ID`, silently falling back to the UI-focused pane when that is unset; tmux ignores
	 * `$TMUX_PANE` entirely and always splits the session's ACTIVE pane. Both defaults track the pane
	 * the *user* is looking at, which is only coincidentally the caller's — they agree whenever a
	 * human is typing and diverge exactly when a program is driving. Naming the pane is the only way
	 * `pane:right` means the same thing on both backends.
	 */
	from?: SessionTarget
	/**
	 * Fraction of the split region kept by `first` — the ORIGINAL pane, not the new one. Only
	 * meaningful for a `pane:*` placement; `0 < ratio < 1`, and omitting it takes the backend's own
	 * even (50/50) default.
	 *
	 * The sign convention is the trap, and the two real backends convert in OPPOSITE directions:
	 * herdr's `--ratio` sizes the original pane, so it is exactly this value and passes through
	 * unconverted; tmux's `-l` sizes the NEW pane, so it takes `1 - ratio`. Applying the inversion to
	 * both, or to neither, is the single most likely way to get a split backwards.
	 */
	ratio?: number
	/**
	 * Environment variables set in the new pane at birth. Native on both real backends (herdr
	 * `--env KEY=VALUE`, tmux `-e KEY=VALUE`, each repeatable); only meaningful for a `pane:*`
	 * placement. Valid with or without `launch` — a pane with env and no command is a blank shell
	 * with that env set.
	 */
	env?: Record<string, string>
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

/**
 * A pane's rectangle, in whatever coordinate space the backend measures its region in. Only the
 * rects' relationship to EACH OTHER is meaningful — the origin is not comparable across backends
 * (tmux reports window-relative, so a region starts at 0,0; herdr reports screen-absolute, so the
 * same region starts wherever its workspace sits). Every consumer works off the panes' bounding box
 * rather than an assumed origin, which is what makes the two reports interchangeable.
 */
export interface PaneRect {
	x: number
	y: number
	/** In cells. Excludes the divider between this pane and the next, where the backend draws one. */
	width: number
	height: number
}

/** One pane of a region, as `describeRegion` reports it. */
export interface RegionPane {
	id: string
	rect: PaneRect
	/** The pane's working directory. */
	cwd?: string
	/** The pane's label, when it has one the AUTHOR set — see `describeRegion` on the tmux caveat. */
	label?: string
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
	/** Environment variables set in the new workspace's root pane at birth. */
	env?: Record<string, string>
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
	/** Environment variables set in the new workspace's root pane at birth. */
	env?: Record<string, string>
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
	 * Whether this backend can size a split — i.e. whether it honors `SessionOpenOptions.ratio`. Both
	 * real backends can (herdr `--ratio`, tmux `-l`), so both declare it. Absent/`false` means a
	 * caller asking for a ratio gets the backend's own even default instead, which callers DEGRADE to
	 * (with one warning) rather than reject: the layout schema is backend-agnostic, so a template's
	 * validity must never depend on which multiplexer happens to be running.
	 */
	readonly canSizeSplits?: boolean
	/**
	 * Present only on a backend that binds a git worktree to a workspace (herdr); `undefined` on one
	 * with no such concept (tmux), where callers fall back to plain git plus `open()`.
	 */
	readonly worktree?: WorktreeWorkspaceCapability
	/**
	 * Type `text` into the target as literal characters, pressing **no** Enter — the text is left
	 * staged in the pane's input box. Literal means literal: text that happens to name a key
	 * (`Enter`, `Up`) is typed as those characters, never interpreted as that key. That guarantee is
	 * why this is its own method rather than a mode of `sendKeys` — tmux's `send-keys` resolves an
	 * ambiguous token by *guessing* which was meant ("if the string is not recognised as a key, it is
	 * sent as a series of characters"), so only the explicit literal form is safe.
	 */
	sendText(exec: Exec, target: SessionTarget, text: string): void
	/**
	 * Press each named key in order, typing nothing. Keys are named in the portable core vocabulary —
	 * `Up` `Down` `Left` `Right` `Enter` `Escape` `Tab` `Space` `Backspace` `C-c` `F1`–`F12` — which
	 * each adapter maps onto whatever its backend calls them. A token *outside* the core is forwarded
	 * verbatim, reaching backend-specific keys at the cost of portability; whether it is honored or
	 * refused is then the backend's own answer, and the two differ (herdr refuses an unknown key;
	 * tmux cannot refuse one and types it instead).
	 *
	 * `Enter` is a key like any other here: `sendKeys(exec, t, ['Enter'])` presses it and takes the
	 * pane's turn — because the caller asked for it. What this method never does is *add* an Enter
	 * the caller did not write. Supplying one is `submit`'s job alone.
	 */
	sendKeys(exec: Exec, target: SessionTarget, keys: string[]): void
	/**
	 * Take the target's turn: type `text` if given, then **always** press Enter.
	 *
	 * With `text`, the guarantee is the observable outcome — the text typed *literally* (same bar as
	 * `sendText`), then Enter — never a particular backend command: a backend with a native
	 * text-plus-Enter primitive uses it, one without composes typing and Enter.
	 *
	 * Without `text` (or with an empty one), it sends a **bare Enter only**, flushing an
	 * already-staged input buffer without re-typing it. That is how a turn is completed when a
	 * booting harness swallowed the Enter of an earlier submit and left the text staged unsent;
	 * because flushing never re-types, a repeated flush cannot duplicate the message.
	 */
	submit(exec: Exec, target: SessionTarget, text?: string): void
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
	/**
	 * Report the geometry of the region (tab/window) the target pane sits in — every pane in it, with
	 * its rectangle. `layout save` runs this backwards into a template.
	 *
	 * **Optional, exactly as `worktree` is** — present on a backend that can describe its own region,
	 * absent on one that cannot. Both real backends can, so both declare it; a caller that finds it
	 * missing refuses (`layout save` exits naming the backend) rather than degrading, because there is
	 * nothing to degrade to: no geometry, no capture.
	 *
	 * **Rects, not a tree, and that is the whole design of this verb.** Both backends can answer
	 * "what does this region look like", and both answer in a DIFFERENT structure: tmux hands back a
	 * nested tree encoded in a string (`#{window_layout}` — `83ae,200x50,0,0{133x50,0,0[...],...}`,
	 * where `{}` is a side-by-side split and `[]` a stacked one), while herdr hands back a FLAT
	 * `splits[]` array whose parent/child links exist only inside an undocumented id convention
	 * (`split_1_0` meaning "split 1, child of split 0" — inferred from the shape, never specified).
	 * Neither structure survives being made portable: one needs a bespoke parser for a string format
	 * tmux does not promise to keep, and the other needs cyber-mux to bet on herdr's id spelling.
	 *
	 * Rects are the fact both report exactly and neither can spell differently. The tree is then
	 * *derived* from them by recursive guillotine cuts (`layout-capture.ts`), which is sound because a
	 * multiplexer region is built by splitting and therefore always guillotine-cuttable. That buys
	 * two things: the tricky half — n-ary rows, ratios, ambiguous grids — is a PURE function testable
	 * with no multiplexer at all, and a third backend owes this verb four numbers per pane rather
	 * than a tree in its own dialect.
	 *
	 * **`label` is the author's, or absent.** Only a label someone deliberately set is reported —
	 * herdr omits the field entirely until `pane rename`, and tmux defaults `pane_title` to the
	 * HOSTNAME, so the tmux adapter drops a title equal to `#{host}` rather than exporting `zeta` as
	 * every pane's name.
	 *
	 * Throws rather than returning empty when the region cannot be read: an export built from a
	 * region the backend could not describe would be a confident lie about the user's screen.
	 */
	describeRegion?(exec: Exec, target: SessionTarget): RegionPane[]
}
