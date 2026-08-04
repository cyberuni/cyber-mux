import type { Exec } from './exec.ts'
import type { Worktree } from './worktree.ts'

/** Generic multiplexer seam — no host-specific concepts, so this composes with any caller. */

/** Where a new pane/window/session should be placed relative to the caller's current one.
 * `'workspace'` opens a genuinely separate workspace/session (herdr: `workspace create`; tmux: a
 * new detached session) — the caller's current workspace/session is left untouched, unlike every
 * other placement, which adds a pane/window inside it.
 *
 * `'pane:float'` opens a FLOATING pane — one that sits above the tiled layout rather than taking a
 * share of it, so it displaces nothing and no existing pane is resized. It is a PLACEMENT rather
 * than a `floating?: boolean` modifier because placements are mutually exclusive and this one is
 * too: a pane either takes a share of the region (`pane:right`/`pane:down`), opens its own space
 * (`tab`/`workspace`), or floats above one. A boolean would additionally have to answer what
 * `{ at: 'workspace', floating: true }` means, which is a question no caller asked.
 *
 * A floating pane is an ORDINARY pane in every other respect — `OpenedPane` with a real id, so
 * `read`/`sendText`/`submit`/`waitForOutput`/`teardown` drive it unchanged. That is the whole reason
 * it fits this seam at all; a popup, which is modal and has no pane id, would not.
 *
 * **Real on some backends, REFUSED on the rest** — the one placement that is not universal. tmux
 * (≥ 3.7, `new-pane`) and zellij (`new-pane --floating`) realize it natively; wezterm and herdr have
 * no floating-pane concept at all, and their adapters refuse by NAME
 * (`FloatingPanesUnsupportedError`) rather than emulate. There is nothing to emulate it WITH: a
 * tiled split is a different thing on screen (it resizes the region's other panes), so silently
 * substituting one would hand back a pane that satisfies the caller's id and violates the only
 * property they asked for. `MuxAdapter.canFloatPanes` is how a caller asks BEFORE opening. */
export type MuxPlacement = 'pane:right' | 'pane:down' | 'pane:float' | 'tab' | 'workspace'

/**
 * The tier a `rename` names — which SPACE is being named, not where one is opened, so this is its
 * own vocabulary rather than a reuse of `MuxPlacement`. The caller must say, because the two
 * tiers are different commands on both backends (tmux `rename-window` vs `select-pane -T`; herdr
 * `tab rename` vs `pane rename`) and neither backend can infer one from the other's id.
 *
 * `pane` collapses `MuxPlacement`'s two split directions — a direction is how a pane is BORN and
 * says nothing about naming one that already exists. There is no `workspace` member: renaming exists
 * for the one tier birth cannot name (a new workspace's root tab, which is a `tab`), and every
 * backend that has a workspace tier already takes its label at birth (`workspace create --label`).
 */
export type MuxSpaceTier = 'pane' | 'tab'

export interface MuxOpenOptions {
	/** Working directory the new pane/window/session should start in. */
	cwd: string
	/** Command line to launch inside the new pane once it is open; omit for a blank pane. */
	launch?: string | undefined
	/** Placement relative to the caller; defaults to 'tab'. */
	at?: MuxPlacement | undefined
	/**
	 * The pane a `pane:right`/`pane:down` placement splits. Ignored by `tab`/`workspace`, which split
	 * nothing.
	 *
	 * `pane:float` splits nothing either, but it still reads this — as the pane whose REGION the float
	 * is opened over, which is the same trap one tier up: a float given no anchor lands over whatever
	 * region the backend defaults to, and every backend defaults to the one the USER is looking at.
	 *
	 * Pass it. Omitting it does **not** mean "the calling pane" — it means "whatever this backend
	 * defaults to", and the two backends default to opposite things: herdr resolves `--current` from
	 * `$HERDR_PANE_ID`, silently falling back to the UI-focused pane when that is unset; tmux ignores
	 * `$TMUX_PANE` entirely and always splits the session's ACTIVE pane. Both defaults track the pane
	 * the *user* is looking at, which is only coincidentally the caller's — they agree whenever a
	 * human is typing and diverge exactly when a program is driving. Naming the pane is the only way
	 * `pane:right` means the same thing on both backends.
	 */
	from?: MuxTarget | undefined
	/**
	 * The workspace a `tab` placement opens INSIDE — a backend workspace id, exactly the value
	 * `OpenedPane.workspace` reports. Ignored by `pane:*` (a split lands in its pane's own space) and
	 * by `workspace` (which creates the space it opens in).
	 *
	 * This is `from`'s counterpart one tier up, and it exists for the same reason: omitting it does
	 * NOT mean "the caller's workspace", it means "whatever this backend defaults to", and every
	 * backend defaults to the workspace the USER is looking at (herdr's `tab create` without
	 * `--workspace`, WezTerm's `spawn` without `--window-id`). That default is only coincidentally the
	 * caller's, and it diverges exactly when a program is driving — a walk that opens a workspace and
	 * then fills it with tabs must name the workspace it just opened, or every tab after the first
	 * lands beside the pane the command was RUN from.
	 *
	 * Absent on a backend with no workspace tier (tmux, where `workspace` and `tab` both collapse onto
	 * a Window): an adapter with nothing to resolve it against ignores it, which still satisfies the
	 * contract — there is no second space for a tab to land in the wrong one of.
	 */
	within?: string | undefined
	/**
	 * Fraction of the split region kept by `first` — the ORIGINAL pane, not the new one. Only
	 * meaningful for a `pane:right`/`pane:down` placement; `0 < ratio < 1`, and omitting it takes the
	 * backend's own even (50/50) default.
	 *
	 * Meaningless for `pane:float` and DROPPED there on every backend, including the two that can size
	 * a split: a float takes no share of the region, so there is no original pane whose fraction this
	 * could be. A float's size is the backend's own default (tmux: half the window's width by a
	 * quarter its height), and sizing one would need absolute cells rather than a fraction of a split
	 * that never happened — a separate option, not this one wearing a second meaning.
	 *
	 * The range is a PRECONDITION the seam enforces, not a hint: a sizing backend rejects a ratio
	 * outside `0 < ratio < 1` (it would render a negative or whole-region split) rather than pass it
	 * through — see `assertRatioInRange` (`ratio.ts`). A backend that cannot size a split renders no
	 * ratio and so never checks one; callers degrade to the even default there. `template`'s schema
	 * refuses a degenerate ratio earlier, per node, so the two layers do different jobs.
	 *
	 * The sign convention is the trap, and the two real backends convert in OPPOSITE directions:
	 * herdr's `--ratio` sizes the original pane, so it is exactly this value and passes through
	 * unconverted; tmux's `-l` sizes the NEW pane, so it takes `1 - ratio`. Applying the inversion to
	 * both, or to neither, is the single most likely way to get a split backwards.
	 */
	ratio?: number | undefined
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
	env?: Record<string, string> | undefined
	/**
	 * Name for the space this opens, at whatever tier `at` opens it — every backend can name every
	 * tier, so this is host-neutral: on herdr a workspace/tab/pane label, on tmux a window name
	 * (`workspace` and `tab` both collapse to a Window there) or a pane title. Omit for the backend's
	 * own default.
	 */
	label?: string | undefined
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
	workspaceGroup?: string | undefined
}

/** Opaque handle to an open pane/window/session; backend-specific id lives in `id`. */
export interface MuxTarget {
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
 * Widened from a bare `MuxTarget` because `open` returning only a pane id left nothing
 * downstream able to report a workspace: the template manifest is framed as the complete
 * machine-readable answer to "which panes exist and what are they for", and a consumer grouping
 * panes by workspace had nothing to group on.
 */
export interface OpenedPane extends MuxTarget {
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
	workspace?: string | undefined
}

/**
 * The lifecycle state a per-pane agent-state feed reports — herdr's native `agent_status`
 * (`herdr` 0.7.5). `unknown` is herdr's OWN value for a pane whose agent it cannot classify, NOT a
 * cyber-mux stand-in for "no feed": a backend with no feed at all reports no `agentStatus` field on
 * `LivePane` rather than `'unknown'`, the same absent-not-false convention `harness` and `label`
 * follow.
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

/** A pane the backend can currently see, as reported by `listPanes` (bulk enumeration). */
export interface LivePane {
	/** Backend-native pane id. */
	id: string
	/** Which multiplexer this pane belongs to. */
	mux: 'tmux' | 'herdr' | 'wezterm' | 'zellij'
	/** The harness running in this pane, when the backend can report it (herdr only). */
	harness?: string | undefined
	/** The pane's working directory, when the backend reports it. */
	cwd?: string | undefined
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
	label?: string | undefined
	/**
	 * The pane's agent-lifecycle state, when the backend has a per-pane agent-state feed (herdr only —
	 * herdr 0.7.5's `agent_status`).
	 *
	 * **Absent means the backend has no agent-state feed**, exactly as `harness` means "the backend
	 * cannot report a harness" — NOT `'unknown'`, which is herdr's own value for a pane whose agent it
	 * genuinely cannot classify. tmux, wezterm and zellij carry no such feed at all, so this field is
	 * simply not present on their panes; a caller must never read its absence as `'unknown'`. The
	 * blocking wait built on this feed is the separate, herdr-only `AgentLifecycle` capability.
	 */
	agentStatus?: AgentStatus | undefined
}

export interface MuxReadOptions {
	/**
	 * The read WINDOW: how many trailing lines of output to capture, `'all'` for the backend's whole
	 * scrollback, or omitted for the backend's own default (the visible viewport, on all four).
	 *
	 * `'all'` is the same knob at its limit, deliberately, rather than a second `full?: boolean` option:
	 * a window and an unbounded window are answers to one question, and two options would let a caller
	 * spell a contradiction (`{ lines: 20, full: true }`) that this seam would then need a precedence
	 * rule for. It is also what makes `truncated` free at the top end — an unbounded window omitted
	 * nothing by construction, so an adapter answers `false` without spending its probe.
	 *
	 * tmux (`-S -`) and Zellij (`--full`) have an all-history spelling of their own; WezTerm and herdr
	 * take a number, so `'all'` reaches them as `FULL_SCROLLBACK_LINES`, which both clamp (see
	 * `read-window.ts`). "Everything the backend holds" is the ceiling of the honest answer either way:
	 * rows a multiplexer dropped from its OWN history long ago are gone, and no read reports them.
	 */
	lines?: number | 'all' | undefined
	/**
	 * Also determine whether older rows above the captured window were omitted — `MuxReadResult.truncated`.
	 *
	 * OPT-IN, because the answer is not free: every backend captures a bounded window and none of them
	 * says, in the capture itself, whether anything sat above it, so an adapter has to look one row
	 * deeper (one extra backend query on every backend but Zellij, whose `lines` read already holds the
	 * whole scrollback). `read` is the seam's hottest verb — `pollForOutput` runs it once per poll tick
	 * and `nudge` twice per attempt — so paying that query on every read would double the query load of
	 * every caller for a fact most of them never look at. Omit it and the argv is byte-identical to the
	 * read that has always been issued.
	 *
	 * Omitting it leaves `truncated` ABSENT rather than `false`, which is the whole point of the
	 * spelling: a `false` that means "I did not check" is indistinguishable from "you have everything",
	 * and that exact conflation is the bug herdr shipped a fix for (herdrdev/herdr#1717).
	 *
	 * Free at one end: with `lines: 'all'` the window is unbounded, so the answer is `false` by
	 * construction and no adapter spends a query on it.
	 */
	truncation?: boolean | undefined
}

/**
 * What `read` answers with: the captured text, plus — when the caller asked for it — whether the
 * capture dropped older rows.
 *
 * A RECORD rather than a bare string, and the widening is deliberate. The alternative — an out-param
 * or a second `wasTruncated(target)` verb — lets the fact travel separately from the text it is about,
 * so a caller can hold a snapshot whose provenance it can no longer ask for, and a second call answers
 * for a pane that has printed more since. Truncation is a property OF this capture, so it rides with
 * it. It is also the shape this seam already uses for the sibling verb that reads terminal text
 * (`MuxWaitResult`), which returns its snapshot inside a record for the same reason.
 */
export interface MuxReadResult {
	/** The captured output — exactly the bytes `read` has always returned. */
	text: string
	/**
	 * Whether rows ABOVE the captured window were omitted: `true` = there is older output the caller did
	 * not receive, `false` = the window reached the top of what the backend holds.
	 *
	 * **ABSENT means undetermined**, never "you have everything" — the same absent-not-false convention
	 * `isPaneFocused`'s `undefined` and `LivePane.agentStatus` follow. It is absent on exactly one
	 * condition: the caller did not pass `MuxReadOptions.truncation`, so no backend was asked. A caller
	 * that asked always gets a boolean, on every backend.
	 *
	 * **Rows, not bytes.** A row of the capture is a row of the terminal, so a wrapped long line counts
	 * as whatever the backend wrapped it into; the answer is about scrollback the caller did not see,
	 * not about a truncated line.
	 */
	truncated?: boolean | undefined
}

/**
 * What `waitForOutput` waits FOR, and how long it is willing to wait.
 *
 * **Exactly one of `match`/`regex`.** Neither leaves nothing to wait for; both would need a rule for
 * combining them that no caller asked for. The seam rejects both cases rather than picking a winner
 * (`assertWaitPattern`, `wait-output.ts`), so the refusal reads the same on every backend — herdr's own
 * CLI already refuses the same pair, and a polling backend has no CLI to refuse it for us.
 */
export interface MuxWaitOptions {
	/** A LITERAL substring to wait for — the portable form: no dialect, so it means the same on every
	 * backend. Mutually exclusive with `regex`. */
	match?: string | undefined
	/**
	 * A regular expression SOURCE to wait for (no delimiters, no flags). Mutually exclusive with `match`.
	 *
	 * **The dialect is the backend's own**, and that is the one place this primitive is not fully
	 * portable: herdr matches with Rust's `regex` crate (no backreferences, no lookaround), the polling
	 * backends with ECMAScript's `RegExp`. The portable subset is what both accept — character classes,
	 * quantifiers, alternation, anchors. The seam compiles the source as a `RegExp` up front on EVERY
	 * backend, so a *malformed* pattern is refused identically everywhere instead of only where a real
	 * poll happens to run it; a pattern that is merely *dialect-specific* compiles here and is then
	 * herdr's to accept or refuse. Reach for `match` whenever a literal will do.
	 */
	regex?: string | undefined
	/**
	 * Give up after this many ms. REQUIRED, deliberately: herdr's native wait blocks FOREVER without
	 * `--timeout` and a poll loop with no deadline spins forever, so an omitted bound is the one
	 * spelling whose failure mode is an agent that never returns. Making the caller name it is the whole
	 * difference between a wait and a hang.
	 */
	timeoutMs: number
	/** Restrict the searched snapshot to this many trailing lines — `MuxReadOptions.lines`, applied to
	 * the snapshot the match runs against. Omit to search the backend's default read. */
	lines?: number | undefined
	/** How long a POLLING backend sleeps between reads; ignored by a backend with a native wait, which
	 * has its own cadence. Defaults to `DEFAULT_WAIT_POLL_MS`. */
	pollMs?: number | undefined
	/** Test seam: the sleep between polls. Injected exactly as `NudgeOptions.sleep` is, and for the same
	 * reason — a real wall-clock wait in a test buys nothing but seconds. */
	sleep?: ((ms: number) => Promise<void>) | undefined
	/** Test seam: the clock the deadline is measured against; defaults to `Date.now`. Paired with
	 * `sleep` so an injected sleep can advance an injected clock and a timeout is reached deterministically. */
	now?: (() => number) | undefined
}

/** What `waitForOutput` answers with. */
export interface MuxWaitResult {
	/** `true` = the pattern was seen, `false` = the timeout elapsed without it. A pane that is GONE is
	 * neither: it throws, because reporting a dead pane as a timeout would bury the real cause behind a
	 * shape the caller reads as "still working" (the same rule `nudge` opens with). */
	matched: boolean
	/** The snapshot searched when the wait ended — the matching read on success, the last read before
	 * the deadline on a timeout. Always the caller's evidence for the verdict, never a second read. */
	output: string
	/** The first line of `output` that matches, when the match sits on ONE line. Absent when the match
	 * spans lines (nothing single-line to point at) or when a native backend reports none. */
	matchedLine?: string | undefined
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
	cwd?: string | undefined
	/** The pane's label, when it has one the AUTHOR set — see `describeRegion` on the tmux caveat. */
	label?: string | undefined
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
	label?: string | undefined
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
	base?: string | undefined
	/** Command line to launch inside the new workspace's root pane; omit for a blank pane. */
	launch?: string | undefined
	/** Environment variables set in the new workspace's root pane at birth. */
	env?: Record<string, string> | undefined
	/** Name for the bound workspace; omit for the backend's own default. */
	label?: string | undefined
}

export interface OpenWorktreeWorkspaceOptions {
	/** The primary checkout's root — the repo the worktree belongs to. */
	primaryRoot: string
	/** An EXISTING worktree's checkout path. */
	path: string
	/** Command line to launch inside the new workspace's root pane; omit for a blank pane. */
	launch?: string | undefined
	/** Environment variables set in the new workspace's root pane at birth. */
	env?: Record<string, string> | undefined
	/** Name for the bound workspace; omit for the backend's own default. */
	label?: string | undefined
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

/**
 * The optional capability a backend implements when its pane listing reports pane GEOMETRY —
 * position, not merely size. That one fact is what both members are derived from, and the single
 * all-or-nothing precondition that bundles them into ONE object rather than two separate optional
 * methods (mirroring `WorktreeWorkspaceCapability`): a backend either reports pane rects or it does
 * not, and neither read is possible without them. tmux (`#{window_layout}`) and herdr (`pane
 * layout`'s rects) both report position, so both ship this; WezTerm's `list` reports a pane's size
 * but no position — nothing to build a `PaneRect` from — so it omits this entirely. A caller that
 * finds this absent refuses (`template save` exits naming the backend) rather than guessing a tree.
 */
export interface RegionInspector {
	/**
	 * Report the geometry of the region (tab/window) the target pane sits in — every pane in it, with
	 * its rectangle. `template save` runs this backwards into a template.
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
	describeRegion(exec: Exec, target: MuxTarget): RegionPane[]
	/**
	 * Report every tab of the workspace the target pane sits in, each with its own region's geometry —
	 * the workspace-wide read beside `describeRegion`'s one-region read. `template save --workspace` runs
	 * this backwards into a `tabs` template, and it is the exact inverse of the tabs walk.
	 *
	 * `save`'s default subject is unaffected by this member: a bare `save` reads `describeRegion` and
	 * captures one region.
	 *
	 * **The grouping is read from the tag, never off the label.** On a backend with a real workspace
	 * tier the tier IS the answer (herdr: the caller's `workspace_id`, whose tabs and panes the backend
	 * already stamps). On one without, the workspace is not a fact the backend holds at all, so the
	 * read is *"which spaces carry this group id"* — the tag `MuxOpenOptions.workspaceGroup` wrote,
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
	describeWorkspace(exec: Exec, target: MuxTarget): WorkspaceTab[]
}

/** What a `waitForState` blocks on: the states that end the wait, and how long it may run. */
export interface AgentWaitOptions {
	/**
	 * The agent states any one of which ends the wait. Omit to let the backend apply its OWN default
	 * (herdr's is `idle|done|blocked`) — cyber-mux never restates that default in the command it runs,
	 * so a future change to herdr's default is not silently pinned by this binding.
	 */
	until?: AgentStatus[] | undefined
	/** Milliseconds before the wait gives up; omit for an indefinite wait (the backend's own default). */
	timeoutMs?: number | undefined
}

/**
 * The optional capability a backend implements when it has a NATIVE, blocking per-pane agent-state
 * wait (herdr's `agent wait`, built on the 0.7.5 `agent_status` feed) — present ONLY on a backend with
 * that primitive, absent on every backend without one.
 *
 * Absent rather than a degraded emulation, the same all-or-nothing convention `worktree` and `regions`
 * follow: a lookalike wait built from `read()` polling would silently disagree with herdr's own state
 * derivation on the same question, so a backend that lacks the primitive is not present here in a weak
 * form — it is not present at all, and the orchestrator (`deriveAgentWait`, `agent.ts`) refuses rather
 * than guesses. `waitForState` never sees the adapter: it only ever runs against the one backend that
 * has it, which is why the emulate-or-refuse decision lives one level up.
 */
export interface AgentLifecycle {
	/**
	 * Block until the target pane's agent reaches one of `opts.until` (or the backend's own default set
	 * when omitted), or `opts.timeoutMs` elapses. Returns the `AgentStatus` actually reached, so the
	 * caller learns WHICH requested state (or the timeout) ended the wait, not merely that it ended.
	 */
	waitForState(exec: Exec, target: MuxTarget, opts: AgentWaitOptions): AgentStatus
}

export interface MuxAdapter {
	/** Backend name, e.g. "tmux" or "herdr". */
	readonly name: string
	/**
	 * Create a new pane/window in `opts.cwd`, running `opts.launch` if given; returns its handle plus
	 * the workspace it landed in (absent on a backend with no workspace tier — see `OpenedPane`).
	 */
	open(exec: Exec, opts: MuxOpenOptions): OpenedPane
	/**
	 * Name an ALREADY-OPEN space at `tier`, addressed by that tier's own id (`target.id` is a tab id
	 * for `'tab'`, a pane id for `'pane'`).
	 *
	 * This is the naming route for the one case birth cannot serve, NOT a second way to do what
	 * `MuxOpenOptions.label` does: `label` names a space at birth wherever the backend's CLI
	 * allows, and exactly one tier does not allow it — herdr labels a new workspace's ROOT TAB `1` and
	 * offers no flag to change it, only `tab rename` afterwards. Every later tab takes `label` at birth
	 * like any other space, so the whole cost of this member is one rename on herdr's first tab.
	 *
	 * REQUIRED rather than optional, unlike `regions`/`worktree`. Those are optional because a
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
	rename(exec: Exec, target: MuxTarget, tier: MuxSpaceTier, name: string): void
	/**
	 * Group an ALREADY-OPEN space into `group`, and store the space's own `name` beside it.
	 * `target.id` is a TAB id — the tier a workspace groups, which is why this takes no
	 * `MuxSpaceTier`: `rename` needs one because both its tiers are nameable and neither can be
	 * inferred, while grouping has exactly one meaningful tier. A `pane` is not a member of a
	 * workspace; the tab it sits in is. A tier parameter here would buy a branch every caller must
	 * write and no caller could ever take — the same argument `MuxSpaceTier` itself makes for
	 * having no `workspace` member.
	 *
	 * **`open` cannot be the only way in.** A caller that did not open the space still has to group it
	 * — `worktree add --template` has its region opened by the worktree verbs before the walk ever runs
	 * — and it holds that space's own id the moment the open returns. So this is its own member acting
	 * on an already-open space, exactly as `rename` does, and `MuxOpenOptions.workspaceGroup`
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
	group(exec: Exec, target: MuxTarget, group: string, name?: string | undefined): void
	/**
	 * Whether this backend can size a split — i.e. whether it honors `MuxOpenOptions.ratio`. Both
	 * real backends can (herdr `--ratio`, tmux `-l`), so both declare it. Absent/`false` means a
	 * caller asking for a ratio gets the backend's own even default instead, which callers DEGRADE to
	 * (with one warning) rather than reject: the template schema is backend-agnostic, so a template's
	 * validity must never depend on which multiplexer happens to be running.
	 */
	readonly canSizeSplits?: boolean | undefined
	/**
	 * Whether this backend can open a FLOATING pane — i.e. whether it honors the `'pane:float'`
	 * placement. tmux (≥ 3.7's `new-pane`) and zellij (`new-pane --floating`) declare it; wezterm and
	 * herdr, which have no floating-pane concept, omit it.
	 *
	 * **A declaration, like `canSizeSplits` — but the absence means REFUSE, not degrade**, and that
	 * contrast is the whole reason both exist rather than one. A ratio has a truthful degrade (the
	 * backend's own even split), so a caller that asks for one on a backend that cannot size gets a
	 * pane that is merely the wrong SIZE, and one warning. A float has none: the nearest thing a
	 * floating-incapable backend could open is a tiled split, which resizes the region's other panes —
	 * exactly the property `pane:float` exists to avoid — so substituting one would hand back a pane
	 * that satisfies the caller's id and violates their only requirement. So `open` throws
	 * `FloatingPanesUnsupportedError` naming the backend (`floating.ts`) rather than opening something
	 * else, the same emulate-or-refuse split `agentLifecycle`'s absence makes.
	 *
	 * This is a DECLARATION and never the refusal itself: it lets a caller ask before opening (and the
	 * CLI refuse before touching a backend), while `open` re-checks as its own contract — the same
	 * belt-and-braces `agent wait` runs. A caller that never asks for a float never reads this.
	 */
	readonly canFloatPanes?: boolean | undefined
	/**
	 * Present only on a backend that binds a git worktree to a workspace (herdr); `undefined` on one
	 * with no such concept (tmux), where callers fall back to plain git plus `open()`.
	 */
	readonly worktree?: WorktreeWorkspaceCapability | undefined
	/**
	 * Type `text` into the target as literal characters, pressing **no** Enter — the text is left
	 * staged in the pane's input box. Literal means literal: text that happens to name a key
	 * (`Enter`, `Up`) is typed as those characters, never interpreted as that key. That guarantee is
	 * why this is its own method rather than a mode of `sendKeys` — tmux's `send-keys` resolves an
	 * ambiguous token by *guessing* which was meant ("if the string is not recognised as a key, it is
	 * sent as a series of characters"), so only the explicit literal form is safe.
	 */
	sendText(exec: Exec, target: MuxTarget, text: string): void
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
	sendKeys(exec: Exec, target: MuxTarget, keys: string[]): void
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
	submit(exec: Exec, target: MuxTarget, text?: string | undefined): void
	/**
	 * Capture the target session's current output, as `{ text }` — plus `truncated` when
	 * `opts.truncation` asked for it (see `MuxReadResult`).
	 *
	 * **Every capture is bounded**, which is why the truncation answer is portable rather than one
	 * backend's feature: a read takes either the caller's `lines` window or the backend's own default
	 * one (the viewport, on all four), and in both cases there may be scrollback above it that the
	 * caller never sees. The rule every adapter realizes is the same — *ask the backend for one row more
	 * than the window and compare the row counts* (`isReadTruncated`, `read-window.ts`): more rows
	 * came back means rows exist above the window, an identical count means the read reached the top of
	 * what the backend holds. Each adapter spells that probe in its own units (tmux `-S -(N+1)`, WezTerm
	 * `--start-line -(N+1)`, Zellij's full dump it already has, herdr `--source recent`), and none
	 * guesses: a backend that cannot be asked would report `truncated` absent, and none of the four is
	 * in that position.
	 *
	 * herdr is the one backend with a NATIVE answer — `pane.read` reports `truncated` on the socket API
	 * as of 0.8.0 (herdrdev/herdr#1717) — and it is still derived here, because its CLI prints
	 * `result.read.text` and nothing else (`print_read_response`, read from the 0.8.0 source) and this
	 * adapter talks to the CLI by construction. That is a transport gap, not a disagreement: if the CLI
	 * ever surfaces the field, the herdr adapter reads it instead and this contract does not move.
	 */
	read(exec: Exec, target: MuxTarget, opts?: MuxReadOptions | undefined): MuxReadResult
	/**
	 * Block until the target's output matches `match`/`regex`, or until `timeoutMs` elapses.
	 *
	 * REQUIRED on every backend, unlike `regions`/`worktree`, and that is the whole point of the member:
	 * what it waits on is RAW TERMINAL TEXT, which every multiplexer can already read (`read` is
	 * required too). A backend with a native wait drives it (herdr `pane wait-output`); one without
	 * realizes it by polling its own `read` until the deadline (`pollForOutput`, `wait-output.ts`). Both
	 * are real support, so no caller ever writes a branch for a backend that "cannot wait" — contrast a
	 * wait on a DERIVED agent state (idle/working/blocked), which only a backend that computes that
	 * state can answer at all and which therefore does not belong on this seam.
	 *
	 * **The searched snapshot is `read`'s snapshot**, on every backend, so a pattern that `read` would
	 * show is a pattern this can wait for — one definition of "the pane's output" seam-wide. herdr's own
	 * `--source` vocabulary (`visible`/`recent`/`recent-unwrapped`) is not exposed for that reason: it is
	 * one backend's snapshot dialect, and the adapter pins it to the same `visible` its `read` uses
	 * rather than letting the same wait mean different things per backend.
	 *
	 * **Existing output counts.** The snapshot is searched IMMEDIATELY, before any sleeping, so a pattern
	 * already on screen returns at once — a wait that could only see text arriving after the call would
	 * lose every race it exists to win.
	 *
	 * The only ASYNC member of this seam: waiting is the one verb whose whole job is the passage of time,
	 * and `Exec` is synchronous by construction. Everything else stays sync.
	 *
	 * Returns `{ matched: false }` on the timeout rather than throwing — a deadline that passed is an
	 * ANSWER, and the caller's own to act on. Throws when the pane is gone (see `MuxWaitResult.matched`)
	 * or when the pattern is unusable (`assertWaitPattern`).
	 */
	waitForOutput(exec: Exec, target: MuxTarget, opts: MuxWaitOptions): Promise<MuxWaitResult>
	/**
	 * Beam the attached client's view all the way to the target pane — across workspace and tab, not
	 * just within the current one. Resolves the pane's own workspace/tab from the backend and drives
	 * the full switch chain; best-effort within (the backend owns the actual move), but throws rather
	 * than reporting a false success when the recorded pane no longer resolves to a live pane.
	 */
	focus(exec: Exec, target: MuxTarget): void
	/** Close the target session. */
	teardown(exec: Exec, target: MuxTarget): void
	/**
	 * Whether the target pane still exists in this backend — the liveness check `prune` runs against a
	 * record's pane locator. Each backend answers with its own primitive so a herdr pane id is never
	 * probed with a tmux query (or vice versa).
	 */
	paneExists(exec: Exec, target: MuxTarget): boolean
	/**
	 * Whether the attached client is currently viewing this pane — a read-only focus probe. `true` =
	 * positively focused, `false` = positively not focused, `undefined` = the backend cannot report
	 * focus or the query could not be answered (callers FAIL OPEN on undefined). Read-only: moves no
	 * focus, opens nothing (unlike `focus`).
	 */
	isPaneFocused(exec: Exec, target: MuxTarget): boolean | undefined
	/**
	 * Enumerate every live pane this backend can currently see — the bulk counterpart to
	 * `paneExists`'s single targeted query. `reconcile` uses this to cull dead records in one pass
	 * against the mux the caller is actually inside; it never enumerates the other mux.
	 */
	listPanes(exec: Exec): LivePane[]
	/**
	 * The optional geometry-introspection capability — `describeRegion` and `describeWorkspace` bundled
	 * as one object (see `RegionInspector`), present on a backend whose pane listing reports pane
	 * POSITION and absent on one that cannot. `template save` gates on it — refusing by NAMING the
	 * backend rather than degrading, because a region the backend cannot describe has nothing to degrade
	 * to. Bundled rather than shipped as two loose optional methods for the same reason `worktree` is
	 * one object: the two reads share a single all-or-nothing precondition.
	 */
	readonly regions?: RegionInspector | undefined
	/**
	 * The optional native agent-lifecycle-wait capability (`AgentLifecycle`), present only on a backend
	 * with a blocking per-pane agent-state primitive (herdr) and absent on one without (tmux, wezterm,
	 * zellij). `agent wait` gates on it — refusing by NAMING the backend rather than emulating, because
	 * a wait has no truthful degrade. Its ABSENCE is the refusal; see `deriveAgentWait` in `agent.ts`,
	 * the single place that sees the adapter and so the single place the refusal can be made.
	 */
	readonly agentLifecycle?: AgentLifecycle | undefined
}
