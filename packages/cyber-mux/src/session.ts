import type { Exec } from './exec.ts'
import type { Worktree } from './worktree.ts'

/** Generic multiplexer seam — no host-specific concepts, so this composes with any caller. */

/** Where a new pane/window/session should be placed relative to the caller's current one.
 * `'workspace'` opens a genuinely separate workspace/session (herdr: `workspace create`; tmux: a
 * new detached session) — the caller's current workspace/session is left untouched, unlike every
 * other placement, which adds a pane/window inside it. */
export type SessionPlacement = 'pane:right' | 'pane:down' | 'tab' | 'workspace'

/**
 * The tier a `rename` names — which SPACE is being named, not where one is opened, so this is its
 * own vocabulary rather than a reuse of `SessionPlacement`. The caller must say, because the two
 * tiers are different commands on both backends (tmux `rename-window` vs `select-pane -T`; herdr
 * `tab rename` vs `pane rename`) and neither backend can infer one from the other's id.
 *
 * `pane` collapses `SessionPlacement`'s two split directions — a direction is how a pane is BORN and
 * says nothing about naming one that already exists. There is no `workspace` member: renaming exists
 * for the one tier birth cannot name (a new workspace's root tab, which is a `tab`), and every
 * backend that has a workspace tier already takes its label at birth (`workspace create --label`).
 */
export type SessionSpaceTier = 'pane' | 'tab'

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
	 * Environment variables set at the birth of whatever tier `at` opens — NOT just a split. Native
	 * on both real backends, which take a repeatable flag on every space-creating command (herdr
	 * `--env KEY=VALUE` on `workspace create`/`tab create`/`pane split`, tmux `-e KEY=VALUE` on
	 * `new-window`/`split-window`), one per variable.
	 *
	 * That breadth is load-bearing, not incidental: a pane pool's root pane is born by the region
	 * open and never by a split, so scoping env to `pane:*` would drop it silently exactly where a
	 * caller needs it. Valid with or without `launch` — a pane with env and no command is a blank
	 * shell with that env set.
	 *
	 * The one exception among herdr's own routes is its WORKTREE one: `worktree create`/`worktree
	 * open` take no env param (0.7.4 answers `--env` with `unknown option`), so env is dropped there
	 * rather than failing the checkout — see `WorktreeWorkspaceCapability`. WezTerm has no `--env` on
	 * ANY route at all (`session.wezterm.ts`), so every one of its opens takes this same fallback path
	 * rather than just the one.
	 */
	env?: Record<string, string>
	/**
	 * Name for the space this opens, at whatever tier `at` opens it — every backend can name every
	 * tier, so this is host-neutral: on herdr a workspace/tab/pane label, on tmux a window name
	 * (`workspace` and `tab` both collapse to a Window there) or a pane title. Omit for the backend's
	 * own default.
	 */
	label?: string
	/**
	 * An OPAQUE id grouping the spaces one caller opens, for a backend with no workspace tier to group
	 * them in. A caller opening several tabs as one workspace needs them recognizable as a group
	 * afterwards; where a real Workspace tier exists the tier IS the group, so this is ignored (herdr
	 * already stamps every pane and tab record with its `workspace_id` — a second grouping would
	 * duplicate a fact the backend never reads). Where there is none, the adapter stores it in the
	 * backend's own native mechanism (tmux: a window option it can filter on server-side, surviving a
	 * window rename).
	 *
	 * Opaque means opaque: an adapter stores and forwards the value and never parses, splits, or
	 * derives it. It is deliberately NOT the `label`, and that separation is the whole point — a label
	 * is chosen by a human and may contain anything, so recovering a grouping by parsing one is
	 * unsound (`acme - beta - main` reads as group `acme` with tab `beta - main` exactly as well as
	 * group `acme - beta` with tab `main`). The label is what a human reads; this is what a machine
	 * reads.
	 *
	 * NEW OPTIONAL member: an adapter that ignores it still satisfies the contract. Omit it and
	 * nothing is grouped — no adapter invents one, and a space nobody grouped stays ungrouped.
	 *
	 * A group id is NOT a workspace: `open` still reports `OpenedPane.workspace` absent on a backend
	 * with no workspace tier, tag or no tag. A tag cyber-mux wrote is its own bookkeeping, not a tier
	 * the backend gained.
	 *
	 * This option is a CONVENIENCE over `group`, never a second implementation of it: every adapter
	 * routes it through that member rather than spelling the grouping twice, exactly as `open`'s
	 * pane-`label` routes through `rename`. It costs nothing to route — tmux has no birth flag for a
	 * window option, so the grouping was always a second call after the space exists. A caller that
	 * did not open the space calls `group` directly; this option is only the shorthand for a caller
	 * that did.
	 */
	workspaceGroup?: string
}

/** Opaque handle to an open pane/window/session; backend-specific id lives in `id`. */
export interface SessionTarget {
	id: string
}

/**
 * A pane `open` just created: its handle, plus the workspace it landed in.
 *
 * `workspace` is OCCUPANCY — which workspace the new pane LIVES IN — and it is deliberately not the
 * worktree binding. A worktree opened at a `pane:right` placement lives in the caller's workspace
 * while being bound to none: the pane has a workspace, the worktree is still ungrouped. The two are
 * reported by separate outputs and neither answers for the other, so a caller must never read this
 * as evidence that a worktree was grouped — that fact is `WorktreeWorkspaceCapability`'s alone.
 *
 * Widened from a bare `SessionTarget` because `open` returning only a pane id left nothing
 * downstream able to report a workspace: the template manifest is framed as the complete
 * machine-readable answer to "which panes exist and what are they for", and a consumer grouping
 * panes by workspace had nothing to group on.
 */
export interface OpenedPane extends SessionTarget {
	/**
	 * The tab the new pane landed in — a tab id, addressable by `rename(exec, { id: tab }, 'tab', …)`.
	 *
	 * REQUIRED, and the contrast with `workspace` below is the whole point: only SOME multiplexers
	 * have a Workspace level, so that field is absent where the tier is; EVERY multiplexer has the Tab
	 * level, so every backend answers this and none reports it absent. tmux's Tab is its Window, which
	 * is also why `workspace` and `tab` placements both collapse onto `new-window` there — a tmux open
	 * has no workspace to report and always has a window.
	 *
	 * Per route: a new tab reports itself, a created workspace reports its ROOT tab, and a split
	 * reports the tab it landed in — the caller's own, since a split opens no tab of its own.
	 *
	 * This is what makes naming a new workspace's root tab portable, and it is not a convenience: a
	 * caller reaching for `id` (the pane) instead would be green on tmux, which resolves a pane id in
	 * a window target and succeeds, and silently broken on herdr, which refuses it outright
	 * (`tab_not_found`) — and since a failed command's output is discarded, the root tab would just
	 * stay named `1` with nothing raised.
	 *
	 * Costs no extra call on either backend — the same argument `workspace` is already reported on:
	 * the backend answered when the pane was opened (herdr carries `tab_id` in the create envelope;
	 * tmux reports `#{window_id}` from the same `-F` the pane id rides out on), so a surface that hid
	 * it would be discarding a fact it already held.
	 */
	tab: string
	/**
	 * The workspace the new pane landed in; `undefined` when the backend has no workspace tier —
	 * ABSENT rather than a false "none", the same convention `isPaneFocused`'s `undefined` follows.
	 * tmux, where `workspace` and `tab` both collapse to a Window, has nothing to report here, which
	 * is not the same as reporting that nothing is there.
	 */
	workspace?: string
}

/** A pane the backend can currently see, as reported by `listPanes` (bulk enumeration). */
export interface LivePane {
	/** Backend-native pane id. */
	id: string
	/** Which multiplexer this pane belongs to. */
	mux: 'tmux' | 'herdr' | 'wezterm'
	/** The harness running in this pane, when the backend can report it (herdr only). */
	harness?: string
	/** The pane's working directory, when the backend reports it. */
	cwd?: string
	/**
	 * The human name a person gave this pane, when there is one — what lets a caller address the pane
	 * by name instead of by id.
	 *
	 * **Absent means nobody named it**, and that is the whole point of the field being optional. A
	 * backend never invents one: herdr omits the key until `pane rename`, and tmux — which has no
	 * unset title and defaults `pane_title` to the hostname — reports a label only for a title that
	 * differs from the host (`paneLabel` in `session.tmux.ts` carries the rule). Exporting tmux's
	 * default would put the same label on every pane in the session, and that name would then resolve
	 * to all of them: ambiguity manufactured out of a name nobody chose.
	 *
	 * **A name, not a key.** Neither backend requires one unique, so duplicates are ordinary and are
	 * resolved where the caller is — at lookup — rather than refused at authoring time.
	 */
	label?: string
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

/**
 * One tab of a workspace, as `describeWorkspace` reports it — a tab's identity, its own name, and the
 * region inside it.
 *
 * `panes` is exactly what `describeRegion` reports for that tab, and deliberately so: a tab IS a
 * region, so a workspace-wide read is the region read repeated rather than a second geometry
 * vocabulary. Everything `RegionPane` documents — the rects' incomparable origin, `label` being the
 * author's or absent — holds here unchanged.
 */
export interface WorkspaceTab {
	/** Backend-native tab id (herdr `tab_id`; tmux `#{window_id}`, its Tab being its Window). */
	id: string
	/**
	 * The tab's OWN name, when the backend reports one — the name a caller gave the tab, never the
	 * display name composed out of it.
	 *
	 * Where the two differ they are stored separately and this reports the stored original: on a
	 * backend with no workspace tier the display name is the composed `<workspace> - <tab>`, so `group`
	 * stored `editor` beside the tag and the read takes it from THERE. Never split back out of the
	 * display name — `acme - beta - main` is ambiguous under every split rule, which is the whole
	 * reason the option exists — and never taken from the display name verbatim, which would compound
	 * the prefix on every round trip (`pool - pool - editor`). Capture is the inverse of apply or it is
	 * a lie about the user's screen.
	 *
	 * Where no own name was stored, the backend's own name for the space stands: nobody composed it, so
	 * it already IS the tab's own name. A backend whose label is never composed (herdr) reports that
	 * label unchanged and stores nothing.
	 */
	label?: string
	/** Every pane in this tab, with its rectangle — `describeRegion`'s answer for this tab. */
	panes: RegionPane[]
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
	/**
	 * The workspace's root pane, and the ROOT TAB it sits in — an `OpenedPane` rather than a bare pane
	 * handle for the reason that field is required everywhere else: every multiplexer has the Tab
	 * level, and this route already holds the answer (herdr's worktree envelope carries `tab_id` in the
	 * same `root_pane` record `workspace create` reports it in). A caller handed only the pane could
	 * not address the region's tab — it could not group it, and it could not rename it — and reaching
	 * for `id` instead would be green on tmux (which resolves a pane id in a window target) and
	 * silently broken on herdr (`tab_not_found`, discarded). Reporting it costs nothing; hiding it
	 * would discard a fact this route already held.
	 */
	target: OpenedPane
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
	/**
	 * Create a new pane/window in `opts.cwd`, running `opts.launch` if given; returns its handle plus
	 * the workspace it landed in (absent on a backend with no workspace tier — see `OpenedPane`).
	 */
	open(exec: Exec, opts: SessionOpenOptions): OpenedPane
	/**
	 * Name an ALREADY-OPEN space at `tier`, addressed by that tier's own id (`target.id` is a tab id
	 * for `'tab'`, a pane id for `'pane'`).
	 *
	 * This is the naming route for the one case birth cannot serve, NOT a second way to do what
	 * `SessionOpenOptions.label` does: `label` names a space at birth wherever the backend's CLI
	 * allows, and exactly one tier does not allow it — herdr labels a new workspace's ROOT TAB `1` and
	 * offers no flag to change it, only `tab rename` afterwards. Every later tab takes `label` at birth
	 * like any other space, so the whole cost of this member is one rename on herdr's first tab.
	 *
	 * REQUIRED rather than optional, unlike `describeRegion`/`worktree`. Those are optional because a
	 * backend may genuinely lack the concept, leaving a caller something to do about it (refuse, or
	 * fall back to plain git). Naming has neither property: every backend names every tier — the same
	 * breadth `label` already relies on at birth (tmux a window name or a pane title, herdr a tab or a
	 * pane rename) — and a caller that found this missing could not degrade, because a rename is the
	 * ONLY way to name a root tab. An optional member here would buy a branch every caller must write
	 * and no caller could ever take. Declaring it required is the adapter author's debt instead, which
	 * is the honest place for it. (`canSizeSplits` is the other precedent, and the contrast holds: a
	 * ratio has a real degrade — the backend's own even default — so it is DECLARED; a name has none.)
	 *
	 * As read-only in its side effects as `isPaneFocused` is: it moves no focus and opens nothing.
	 * Naming a space is not visiting it.
	 */
	rename(exec: Exec, target: SessionTarget, tier: SessionSpaceTier, name: string): void
	/**
	 * Group an ALREADY-OPEN space into `group`, and store the space's own `name` beside it.
	 * `target.id` is a TAB id — the tier a workspace groups, which is why this takes no
	 * `SessionSpaceTier`: `rename` needs one because both its tiers are nameable and neither can be
	 * inferred, while grouping has exactly one meaningful tier. A `pane` is not a member of a
	 * workspace; the tab it sits in is. A tier parameter here would buy a branch every caller must
	 * write and no caller could ever take — the same argument `SessionSpaceTier` itself makes for
	 * having no `workspace` member.
	 *
	 * **`open` cannot be the only way in.** A caller that did not open the space still has to group it
	 * — `worktree add --template` has its region opened by the worktree verbs before the walk ever runs
	 * — and it holds that space's own id the moment the open returns. So this is its own member acting
	 * on an already-open space, exactly as `rename` does, and `SessionOpenOptions.workspaceGroup`
	 * ROUTES THROUGH it, so there is one spelling per backend rather than two that can drift. Routing
	 * costs no call: tmux has no birth flag for a window option, so grouping was ALREADY a second call
	 * after the window exists.
	 *
	 * **`name` is the space's OWN name, never its display name**, and storing it is not optional
	 * bookkeeping — it is the same rule the group id follows, one tier down. A backend with one name
	 * field per space (tmux) whose caller composes a display name out of the tab's name has DESTROYED
	 * the original: the field holds `pool - editor`, and `editor` is gone. Recovering it would mean
	 * splitting on a separator already proven ambiguous (`acme - beta - main` splits two legal ways),
	 * and taking the display name verbatim would re-prefix it on every round trip
	 * (`pool - pool - editor`). So the caller that composed the name stores the original here, and a
	 * reader takes it from there. The display name is a human's to read; an opaque option carries what
	 * a machine reads back. Omit it when the caller named nothing — there is no own name to store, and
	 * no adapter invents one.
	 *
	 * **A backend with a real workspace tier stores NEITHER**, and that is a complete answer rather
	 * than a stub: its tier IS the group (herdr stamps every pane and tab record with its
	 * `workspace_id`), and its tab label IS the tab's own name, never composed — so both are facts the
	 * backend already holds, and storing them again would duplicate what it never reads.
	 *
	 * REQUIRED, for `rename`'s reason: a caller finding this missing could not degrade, because there
	 * is no other way to group a space it did not open. As read-only in its side effects as `rename`
	 * is — it moves no focus and opens nothing.
	 */
	group(exec: Exec, target: SessionTarget, group: string, name?: string): void
	/**
	 * Whether this backend can size a split — i.e. whether it honors `SessionOpenOptions.ratio`. Both
	 * real backends can (herdr `--ratio`, tmux `-l`), so both declare it. Absent/`false` means a
	 * caller asking for a ratio gets the backend's own even default instead, which callers DEGRADE to
	 * (with one warning) rather than reject: the template schema is backend-agnostic, so a template's
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
	 * its rectangle. `template save` runs this backwards into a template.
	 *
	 * **Optional, exactly as `worktree` is** — present on a backend that can describe its own region,
	 * absent on one that cannot. Both real backends can, so both declare it; a caller that finds it
	 * missing refuses (`template save` exits naming the backend) rather than degrading, because there is
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
	 * *derived* from them by recursive guillotine cuts (`template-capture.ts`), which is sound because a
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
	/**
	 * Report every tab of the workspace the target pane sits in, each with its own region's geometry —
	 * the workspace-wide read beside `describeRegion`'s one-region read. `template save --workspace` runs
	 * this backwards into a `tabs` template, and it is the exact inverse of the tabs walk.
	 *
	 * **Optional, exactly as `describeRegion` is**, and for the same reason: a backend that cannot
	 * enumerate a workspace's tabs leaves a caller something to DO about it — `template save --workspace`
	 * exits naming the backend and writes nothing. An absent optional member is a refusal, never a
	 * guess. (Contrast `rename`, which is required precisely because a caller finding it missing could
	 * not degrade.) `save`'s default subject is unaffected: a bare `save` reads `describeRegion` and
	 * captures one region, whatever this member does or does not do.
	 *
	 * **The grouping is read from the tag, never off the label.** On a backend with a real workspace
	 * tier the tier IS the answer (herdr: the caller's `workspace_id`, whose tabs and panes the backend
	 * already stamps). On one without, the workspace is not a fact the backend holds at all, so the
	 * read is *"which spaces carry this group id"* — the tag `SessionOpenOptions.workspaceGroup` wrote,
	 * which is opaque and survives a rename. Parsing `<workspace> - <tab>` back apart is unsound
	 * (`acme - beta - main` splits two ways, both legal), which is the whole reason the tag exists.
	 *
	 * **A space carrying no tag is a workspace of ONE.** That is the honest answer for a space nobody
	 * grouped, not an error and not an empty list: the caller's own region is a workspace of one tab.
	 *
	 * Throws rather than returning empty when the workspace cannot be read, matching `describeRegion`:
	 * a template built from a workspace the backend could not describe would be a confident lie about
	 * the user's screen.
	 */
	describeWorkspace?(exec: Exec, target: SessionTarget): WorkspaceTab[]
}
