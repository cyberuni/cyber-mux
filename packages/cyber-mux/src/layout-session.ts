import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Exec } from './exec.ts'
import {
	collectPanes,
	firstPane,
	type LayoutNode,
	type LayoutTemplate,
	type PaneNode,
	resolveTree,
	type TabNode,
} from './layout.ts'
import type { OpenedPane, SessionAdapter, SessionPlacement, SessionTarget } from './session.ts'

/**
 * Layouts × sessions — the walk, and the only module that knows both halves. `layout.ts` stays pure
 * and owes nothing to the mux; `session.ts` stays a pure mux seam that owes nothing to layouts.
 * Compiling one into the other is a third concern, and it lives here — exactly what
 * `worktree-session.ts` is to `worktree.ts` + `session.ts`.
 *
 * The engine is cyber-mux's own: a tree-walk emitting `open`/`submit` against the PORTABLE
 * `SessionAdapter` verbs, never a backend's native layout primitive. herdr's `layout.apply` drops
 * out entirely rather than being deferred — it is a socket verb (this codebase speaks herdr's CLI,
 * synchronously, on purpose) and, more importantly, it is unique in the field: tmux, cmux, WezTerm
 * and screen have nothing equivalent. Leaning on it would mean the good path existing on exactly one
 * backend while every other backend needs this walk anyway. The capability a multiplexer must supply
 * is "split THIS pane, that way" — that is the whole ask, and it is `SessionOpenOptions.from`.
 */

/** One pane the apply created — `label` is the key a higher layer addresses it by. */
export interface LayoutPaneReport {
	label: string | null
	pane: string
	/** The pane's resolved working directory: the apply-time cwd joined with the node's `dir`. */
	dir: string
	command: string | null
	/**
	 * Which tab of the template this pane landed in, by its INDEX — the same argument `workspace` makes
	 * one level down: a consumer grouping a tabs template's panes by tab needs something to group on.
	 * `null` from a single-tab (`root`/`panes`) template — absent rather than an invented tab, since
	 * such a template said nothing about tabs at all.
	 *
	 * The index rather than the tab's `label`, because a label is OPTIONAL (a tab may leave its name to
	 * the backend) and a grouping key that is sometimes absent cannot group. The index is total and
	 * collision-free, and it cannot be confused with the `null` a single-tab template reports, which a
	 * label could be (a tab labeled `"1"` and a tab at index 1 would read alike). The label stays
	 * recoverable from the template the manifest already names.
	 */
	tab: number | null
}

/**
 * The whole handoff. `--format json` emits this, and it is the complete machine-readable answer to
 * "which panes exist and what are they for" — a dispatcher built on it needs NO new cyber-mux
 * surface, since it addresses panes through `read`/`submit`/`exists`/`focus`/`list`, which all
 * already exist.
 */
export interface LayoutManifest {
	layout: string
	/** The injected target — the apply-time cwd. Never anything the template said. */
	cwd: string
	/** `null` on tmux, matching how `reportOpenedWorktree` already reports it. */
	workspace: string | null
	panes: LayoutPaneReport[]
}

/**
 * A walk that threw partway. Carries the manifest of what WAS built, because apply does not roll
 * back: rolling back would mean killing panes, and a kill is not obviously safer than a half-built
 * layout the caller can see and finish. This is the price of owning the engine rather than
 * delegating to an atomic tree-apply, and it is paid uniformly — a guarantee only herdr could make
 * is not a guarantee cyber-mux can offer.
 */
export class LayoutApplyError extends Error {
	constructor(
		message: string,
		readonly manifest: LayoutManifest,
	) {
		super(message)
		this.name = 'LayoutApplyError'
	}
}

interface WalkContext {
	exec: Exec
	adapter: SessionAdapter
	cwd: string
	name: string
	workspace: string | null
	dirExists: (path: string) => boolean
	/**
	 * Whether the "this backend cannot size a split" warning has already been written. Shared across
	 * every tab of an apply rather than per tab: the warning is about the BACKEND, so one apply says it
	 * once however many tabs it opens.
	 */
	warnedRatio: boolean
}

/**
 * One tab of an apply, with everything the report needs about it. A single-tab template is ONE of
 * these with a `null` index — the multi-tab walk is the same walk, run per tab, rather than a second
 * engine that could drift from it.
 */
interface TabState {
	tree: LayoutNode
	/** The tab's index in the template; `null` for a single-tab template, which has no tab tier. */
	index: number | null
	/** The pane the tab's tree is built AGAINST — its own root region, never another tab's pane. */
	root: SessionTarget
	/**
	 * Where the root pane ACTUALLY sits. Not derived — supplied by whoever opened the region, because
	 * only they know. The root leaf is the one pane no split ever births, so `open --layout` can place
	 * it at `cwd + dir` while `worktree add --layout` cannot: the worktree's workspace must open at the
	 * worktree root, which is what the binding pins. Reporting `cwd + dir` regardless would make the
	 * manifest claim a location nothing ever opened.
	 */
	rootDir: string
	/**
	 * Whether the root pane's `env` was already set natively when the region was opened. Supplied by
	 * whoever opened it, never inferred: it is true at every tier of `open` on both backends, and
	 * false on exactly one route — herdr's `worktree create`, whose params carry no `env` at all. Only
	 * the false case is prefixed, so the native routes can never double-apply.
	 */
	rootEnvHonored: boolean
	/** Template order — `first` before `second`; the order the manifest reports and commands submit in. */
	ordered: PaneNode[]
	/** The leaf riding the region's own pane — the one leaf no split ever births. */
	rootLeaf: PaneNode
	/** Recorded at each pane's BIRTH, so a throw later still reports every pane that actually exists. */
	paneOf: Map<PaneNode, string>
}

/** A tab's bookkeeping, with its root pane already open and its root leaf pinned to that pane. */
function tabState(
	tree: LayoutNode,
	index: number | null,
	root: SessionTarget,
	rootDir: string,
	rootEnvHonored: boolean,
): TabState {
	const rootLeaf = firstPane(tree)
	return {
		tree,
		index,
		root,
		rootDir,
		rootEnvHonored,
		ordered: collectPanes(tree),
		rootLeaf,
		// The root leaf rides the region's own pane; every other leaf is born by exactly one split.
		paneOf: new Map([[rootLeaf, root.id]]),
	}
}

/**
 * Single-quote a value for a shell command line. Everything is literal inside single quotes, so the
 * only escape needed is for a single quote itself: end the quoting, emit an escaped `'`, reopen.
 * Without this a value carrying a space or a quote would split into extra words, or unbalance the
 * line outright.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The env-prefix fallback (design §7.3 Gap C) — `env K=V command`, which works anywhere because it
 * is just a command line. It is a LAST resort, and its costs are why: the values land in `ps` output
 * and the pane's shell history, and it can only serve a pane that has a command to prefix.
 *
 * The design recorded this as having "no customer" while every backend's env looked native. herdr's
 * worktree route is its first real one.
 */
function envPrefix(env: Record<string, string>): string {
	return `env ${Object.entries(env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(' ')} `
}

/** A pane's resolved cwd: the apply-time target, joined with the node's relative `dir`. */
function resolveDir(cwd: string, dir: string | undefined): string {
	return dir ? join(cwd, dir) : cwd
}

/**
 * Every `dir` the template names, checked against the REAL target before anything is opened. A
 * branch that predates a directory is a real case, so the error names the pane and the resolved path
 * rather than just failing a mkdir somewhere.
 *
 * Up front, not per-pane-at-birth: a predictable error should not cost a half-built pool.
 */
export function assertLayoutDirs(tree: LayoutNode, cwd: string, dirExists: (path: string) => boolean): void {
	for (const pane of collectPanes(tree)) {
		if (pane.dir === undefined) continue
		const resolved = resolveDir(cwd, pane.dir)
		if (!dirExists(resolved)) {
			throw new Error(`layout pane "${pane.label ?? '(unlabeled)'}": directory does not exist — ${resolved}`)
		}
	}
}

export interface OpenLayoutOptions {
	/** The injected target directory. */
	cwd: string
	/** Defaults to `workspace` — a fresh space is empty by construction. */
	at?: SessionPlacement
	label?: string
	dirExists: (path: string) => boolean
	/** Passed to the region's own `open` for a `pane:*` placement; see `SessionOpenOptions.from`. */
	from?: SessionTarget
}

/**
 * Open a region and build the template inside it — `open --layout`.
 *
 * The region opens BLANK (no `launch`) and its pane becomes the tree's root region: not a wasted
 * pane to close, but the pane the walk splits INTO. That is why nothing is launched here — the
 * template owns what runs.
 *
 * The manifest's `workspace` is whatever the region's own `open` landed in — the workspace it
 * created at the default `workspace` placement, or the one it landed inside at a `tab`/`pane:*`
 * placement. `null` only when the backend has no workspace tier (tmux) and so had nothing to report.
 * This is occupancy, not a worktree binding: `open` groups no repo, and a caller must not read a
 * workspace here as evidence that it did.
 */
export function openLayout(
	exec: Exec,
	adapter: SessionAdapter,
	template: LayoutTemplate,
	opts: OpenLayoutOptions,
): LayoutManifest {
	if (template.tabs) return openTabsLayout(exec, adapter, template, template.tabs, opts)
	const tree = resolveTree(template)
	// Before the region is opened, so a missing dir opens nothing at all.
	assertLayoutDirs(tree, opts.cwd, opts.dirExists)
	// The root leaf sits on the region's OWN pane — no split ever births it — so its dir and env have
	// to ride in on this open or they are lost. Both are native at every tier on both backends, so
	// this route honors them exactly. No `launch`: commands are submitted last, together.
	const rootLeaf = firstPane(tree)
	const rootDir = resolveDir(opts.cwd, rootLeaf.dir)
	const root = adapter.open(exec, {
		cwd: rootDir,
		at: opts.at ?? 'workspace',
		label: opts.label,
		env: rootLeaf.env,
		from: opts.from,
	})
	return walk(tabState(tree, null, root, rootDir, true), {
		exec,
		adapter,
		cwd: opts.cwd,
		name: template.name,
		// The whole point of widening `open`'s return: before it carried a workspace, this was a
		// hardcoded null and the manifest could never report one, even on a backend that had just
		// opened a real workspace.
		workspace: root.workspace ?? null,
		dirExists: opts.dirExists,
		warnedRatio: false,
	})
}

/**
 * The workspace label a tabs apply groups under: what the caller asked for, or the template's own
 * name. Never shortened, anywhere — it is the label the caller already chose, so the caller owns its
 * length, and not shortening is what makes a collision between two workspaces that shorten alike
 * impossible rather than merely handled.
 */
function workspaceLabelOf(template: LayoutTemplate, label: string | undefined): string {
	return label ?? template.name
}

/** The first tab's region, however the route in question came by it. */
interface FirstTab {
	/**
	 * An `OpenedPane`, not a bare handle: the walk groups this tab like every other, and grouping
	 * addresses the TAB. Both routes already hold it — `open --layout` from the open it just ran,
	 * `worktree add --layout` from the one the worktree verbs ran — so requiring it here takes nothing
	 * from either and is what lets the first tab be grouped rather than left out.
	 */
	root: OpenedPane
	rootDir: string
	rootEnvHonored: boolean
}

/**
 * A workspace of N tabs — the single-tab walk, wrapped, with the inner walk unchanged and run once
 * per tab. Every later tab opens INSIDE the workspace at the `tab` placement; no tab is ever a split
 * of another tab's pane, which is the whole difference between a workspace of tabs and one tab of
 * panes.
 *
 * `firstTab` is the ONE thing the two routes differ in, and the reason they share this walk rather
 * than owning two that could drift: `open --layout` opens the workspace and hands back its region,
 * while `worktree add --layout` already HAS one — the worktree's own workspace, which that route
 * forced the placement for — so the first tab builds into it rather than opening a second.
 *
 * Every tab is opened and every split built BEFORE the first command is submitted — the single-tab
 * ordering, scaled: a split lands mid-render if it targets a pane already running an interactive
 * agent, and a tab is opened blank for exactly the reason a region is.
 */
function walkTabs(
	ctx: WalkContext,
	tabs: TabNode[],
	trees: LayoutNode[],
	workspaceLabel: string,
	group: string,
	firstTab: () => FirstTab,
): LayoutManifest {
	const built: TabState[] = []
	try {
		trees.forEach((tree, index) => {
			let opened: OpenedPane
			if (index === 0) {
				const first = firstTab()
				opened = first.root
				built.push(tabState(tree, 0, first.root, first.rootDir, first.rootEnvHonored))
				// The one tab no backend can name at birth, named HERE — in the walk both routes share —
				// rather than in either route's own `firstTab`. The scenarios this serves say "when it is
				// applied", naming no route, so a route that could forget this is a scenario that is
				// silently false on it. Only the shared path makes forgetting impossible.
				//
				// Runs AFTER `firstTab()` because that is what settles the tier signal: `open --layout`
				// learns it from the open it just ran, and `tabLabelFor` reads it to decide whether the
				// workspace is carried into the name.
				//
				// `opened.tab`, NEVER `opened.id`: the pane id would be green on tmux (which resolves a
				// pane in a window target) and silently broken on herdr (`tab_not_found`, discarded),
				// leaving the root tab named `1` with nothing raised.
				const name = tabLabelFor(ctx, tabs[0]!, workspaceLabel)
				if (name !== undefined) ctx.adapter.rename(ctx.exec, { id: opened.tab }, 'tab', name)
			} else {
				const rootLeaf = firstPane(tree)
				const rootDir = resolveDir(ctx.cwd, rootLeaf.dir)
				opened = ctx.adapter.open(ctx.exec, {
					cwd: rootDir,
					// A real tab in the workspace the first tab established — never a `pane:*` placement,
					// which would make this tab a split of the tab before it.
					at: 'tab',
					// Named at BIRTH: every tab but a new workspace's root can be, on both backends.
					label: tabLabelFor(ctx, tabs[index]!, workspaceLabel),
					env: rootLeaf.env,
				})
				// `open` sets env natively at every tier on both backends, so no tab ever needs the prefix.
				built.push(tabState(tree, index, opened, rootDir, true))
			}
			// EVERY tab, the first one included, and through the verb rather than `open`'s option — which
			// is the whole reason grouping is a verb. The first tab's region may have been opened before
			// this walk ever ran (`worktree add --layout`), so an option on `open` could only ever have
			// covered tabs 2..N, and a group missing the workspace's own first tab is worse than no
			// group: `save --workspace` would confidently round-trip a 3-tab workspace as 2. Grouping
			// here means the route that opened the region cannot change what the template means.
			//
			// The tab's OWN name, never `tabLabelFor`'s composed display name: where the backend has no
			// workspace tier the display name is `<workspace> - <tab>`, so the backend's single name
			// field no longer holds the original. Handing the composed one here would re-prefix it on
			// every round trip. `undefined` when the tab left its name to the backend — nothing to store.
			ctx.adapter.group(ctx.exec, { id: opened.tab }, group, tabs[index]!.label)
			// Against THIS tab's own root pane — the id threaded through every split of this tree.
			buildGeometry(built[index]!, ctx)
		})
	} catch (err) {
		// Unchanged, one level up: apply does not roll back, so the tabs already built are reported and
		// nothing is killed. Adding a level does not buy an atomicity the node never offered.
		throw new LayoutApplyError(err instanceof Error ? err.message : String(err), report(ctx, built))
	}

	submitCommands(built, ctx)
	return report(ctx, built)
}

/** `open --layout` with a tabs template: the first tab opens the workspace the rest live in. */
function openTabsLayout(
	exec: Exec,
	adapter: SessionAdapter,
	template: LayoutTemplate,
	tabs: TabNode[],
	opts: OpenLayoutOptions,
): LayoutManifest {
	const trees = tabs.map((tab) => resolveTree(tab))
	// Every tab's dirs, before ANY tab is opened — a predictable error must not cost a half-built
	// workspace any more than it costs a half-built region.
	for (const tree of trees) assertLayoutDirs(tree, opts.cwd, opts.dirExists)

	// The machine's carrier for the grouping, and the reason the label never has to be parsed back:
	// an opaque id no one reads FOR its content. A backend with a real workspace tier ignores it, that
	// tier already being the group.
	const group = randomUUID()
	const workspaceLabel = workspaceLabelOf(template, opts.label)
	const ctx: WalkContext = {
		exec,
		adapter,
		cwd: opts.cwd,
		name: template.name,
		// Set from the first tab's own open, below — whatever the backend says it landed in.
		workspace: null,
		dirExists: opts.dirExists,
		warnedRatio: false,
	}

	return walkTabs(ctx, tabs, trees, workspaceLabel, group, () => {
		const rootLeaf = firstPane(trees[0]!)
		const rootDir = resolveDir(opts.cwd, rootLeaf.dir)
		const opened = adapter.open(exec, {
			cwd: rootDir,
			at: opts.at ?? 'workspace',
			// The WORKSPACE's name, not this tab's: at the `workspace` placement `label` names the space
			// being opened, and on a backend with a real tier that is the workspace itself. The tab under
			// it is named just below, once the backend has told us which kind of backend it is.
			label: workspaceLabel,
			env: rootLeaf.env,
			from: opts.from,
		})
		// The tier signal, read from what the backend ACTUALLY reported rather than from its name: a
		// workspace on the open means this backend has a tier to have landed in; absent means it has
		// none (tmux). Set here because only this route can learn it — the worktree route is TOLD its
		// workspace by the caller that opened the region. Either way it is settled before `walkTabs`
		// names this tab, which is what turns on exactly this.
		ctx.workspace = opened.workspace ?? null
		return { root: opened, rootDir, rootEnvHonored: true }
	})
}

/**
 * A tab's label, as a human reads it.
 *
 * Where the backend has no workspace tier (tmux, which collapses workspace and tab onto one Window),
 * the workspace is carried into the label — `<workspace> - <tab>` — because the template's tabs would
 * otherwise land as an unlabeled pile with nothing marking them as one pool. Where the backend HAS the
 * tier (herdr), its UI already groups by the real workspace label, so a prefix would be redundant
 * noise and the tab carries its own label alone. The concept maps onto what the backend actually has.
 *
 * The workspace label goes in whole — never shortened. It is the label the caller already chose, so
 * the caller owns its length, and not shortening is what makes a collision between two workspaces that
 * shorten alike impossible rather than merely handled.
 *
 * This is the human's carrier only. The machine reads `workspaceGroup`, never this — the label is
 * ambiguous under every split rule ("acme - beta - main"), so it is written and never parsed back.
 */
function tabLabelFor(ctx: WalkContext, tab: TabNode, workspaceLabel: string): string | undefined {
	// A tab may leave its name to the backend — matching `--label` omitted everywhere else, the
	// backend's own default then stands, and there is nothing to prefix.
	if (tab.label === undefined) return undefined
	if (ctx.workspace !== null) return tab.label
	return `${workspaceLabel} - ${tab.label}`
}

/**
 * The pane that will sit on a region's own root pane — whoever opens that region must carry this
 * pane's `env` (and, where it can, its `dir`), because no split ever births it.
 *
 * For a tabs template that is the FIRST tab's root leaf: the first tab is the one built into the
 * region the caller opens, and every later tab opens its own space (carrying its own root leaf's env
 * at that open). Resolving the template itself here would desugar a `panes` list a tabs template does
 * not have.
 */
export function layoutRootPane(template: LayoutTemplate): PaneNode {
	return firstPane(resolveTree(template.tabs ? template.tabs[0]! : template))
}

export interface ApplyLayoutOptions {
	/**
	 * An ALREADY-OPEN blank region whose pane is the tree's root — e.g. a worktree's workspace.
	 *
	 * An `OpenedPane` rather than a bare handle, because a tabs template groups this region's tab like
	 * every other tab it builds, and grouping addresses the tab. The caller that opened the region
	 * already holds it — every backend reports the tab an open landed in — so requiring it costs
	 * nothing and is what keeps the workspace's own first tab inside the group.
	 */
	root: OpenedPane
	cwd: string
	/** The backend workspace the region lives in, when the backend binds one; `null` on tmux. */
	workspace: string | null
	/**
	 * Whether the root pane's `env` was already set when this region was opened. Required rather than
	 * defaulted: only the caller that opened the region knows, and guessing wrong either drops the env
	 * silently or applies it twice.
	 */
	rootEnvHonored: boolean
	dirExists: (path: string) => boolean
	/**
	 * The label the region was opened under — the workspace's name, which a tabs template carries into
	 * each later tab's label on a backend with no workspace tier. Only the caller that opened the region
	 * knows what it named it; omitted, the template's own name stands, matching `open --layout`'s
	 * default.
	 */
	label?: string
}

/**
 * Build a template inside a region someone else already opened — `worktree add --layout`, where the
 * worktree's own workspace IS the region and its root pane is the tree's root.
 */
export function applyLayoutToRegion(
	exec: Exec,
	adapter: SessionAdapter,
	template: LayoutTemplate,
	opts: ApplyLayoutOptions,
): LayoutManifest {
	if (template.tabs) return applyTabsToRegion(exec, adapter, template, template.tabs, opts)
	const tree = resolveTree(template)
	assertLayoutDirs(tree, opts.cwd, opts.dirExists)
	// The region was opened by someone whose own contract fixed its cwd — a worktree's workspace opens
	// at the worktree root, because that is what the binding pins. So a root leaf's `dir` genuinely
	// cannot be honored on this route. Degrade and warn, never silently drop: the caller is told which
	// pane lost its dir, and the manifest below reports where that pane REALLY is. stderr, so stdout
	// stays machine-readable.
	const rootLeaf = firstPane(tree)
	if (rootLeaf.dir !== undefined) {
		process.stderr.write(
			`the layout's root pane "${rootLeaf.label ?? '(unlabeled)'}" cannot start in "${rootLeaf.dir}" — ` +
				`the region opens at ${opts.cwd}\n`,
		)
	}
	// Where it actually is, not where the template asked for.
	return walk(tabState(tree, null, opts.root, opts.cwd, opts.rootEnvHonored), {
		exec,
		adapter,
		cwd: opts.cwd,
		name: template.name,
		workspace: opts.workspace,
		dirExists: opts.dirExists,
		warnedRatio: false,
	})
}

/**
 * `worktree add --layout` with a tabs template: the workspace already EXISTS — that route forces the
 * `workspace` placement and opened one for the worktree — so a set of tabs has somewhere to live and
 * needs no second workspace. The first tab is built INTO that region; every later tab opens as a tab
 * in it. That one difference is the whole of what separates this route from `open --layout`.
 */
function applyTabsToRegion(
	exec: Exec,
	adapter: SessionAdapter,
	template: LayoutTemplate,
	tabs: TabNode[],
	opts: ApplyLayoutOptions,
): LayoutManifest {
	const trees = tabs.map((tab) => resolveTree(tab))
	for (const tree of trees) assertLayoutDirs(tree, opts.cwd, opts.dirExists)

	const ctx: WalkContext = {
		exec,
		adapter,
		cwd: opts.cwd,
		name: template.name,
		// Already known on this route, from the caller that opened the region — no first open has to
		// report it, and it is the same tier signal the tab labels turn on.
		workspace: opts.workspace,
		dirExists: opts.dirExists,
		warnedRatio: false,
	}

	// The first tab's root leaf rides a region whose cwd another contract already fixed — the worktree
	// root, which the binding pins — so its `dir` cannot be honored, exactly as on the single-tab
	// route. Same degrade, same warning, for the same reason.
	const rootLeaf = firstPane(trees[0]!)
	if (rootLeaf.dir !== undefined) {
		process.stderr.write(
			`the layout's root pane "${rootLeaf.label ?? '(unlabeled)'}" cannot start in "${rootLeaf.dir}" — ` +
				`the region opens at ${opts.cwd}\n`,
		)
	}

	// Grouped exactly as `open --layout` is, and by the same walk: the route that opened the region
	// cannot change what the template means. Nothing has to be threaded through the worktree verbs to
	// make this work — `opts.root` is the region they opened, and it carries its own tab, which is all
	// grouping an already-open space needs.
	return walkTabs(ctx, tabs, trees, workspaceLabelOf(template, opts.label), randomUUID(), () => ({
		// The region that already exists. Where it actually is, not where the template asked for.
		root: opts.root,
		rootDir: opts.cwd,
		rootEnvHonored: opts.rootEnvHonored,
	}))
}

/**
 * The walk: geometry depth-first against NAMED panes, then every command, last.
 *
 * **Geometry before commands is deliberate ordering, not incidental.** `open`'s `launch` couples
 * creation to launching, so reusing it would mean splitting a pane already running an interactive
 * agent — the split lands mid-render, and the ratio is computed against a pane whose child is
 * reflowing. Opening every pane blank first makes the whole geometry phase side-effect-free from the
 * agent's point of view.
 */
function walk(tab: TabState, ctx: WalkContext): LayoutManifest {
	const tabs = [tab]
	try {
		buildGeometry(tab, ctx)
	} catch (err) {
		// No rollback, no kill — report what was built and let the caller finish or close it.
		throw new LayoutApplyError(err instanceof Error ? err.message : String(err), report(ctx, tabs))
	}
	submitCommands(tabs, ctx)
	return report(ctx, tabs)
}

/**
 * One tab's geometry: depth-first against NAMED panes, opening every pane blank. Submits nothing —
 * the caller does that once EVERY tab is built, which is what lets the multi-tab walk hold the same
 * "no split ever lands on a pane mid-render" guarantee the single-tab walk holds.
 */
function buildGeometry(tab: TabState, ctx: WalkContext): void {
	// A backend that cannot size a split takes its own default and we say so ONCE — a wrong-looking
	// split is not worth failing an otherwise-correct pool over, and the schema is backend-agnostic,
	// so a template's validity cannot depend on which multiplexer happens to be running.
	const sizeSplit = (ratio: number | undefined): number | undefined => {
		if (ratio == null) return undefined
		if (ctx.adapter.canSizeSplits) return ratio
		if (!ctx.warnedRatio) {
			ctx.warnedRatio = true
			process.stderr.write(`${ctx.adapter.name} cannot size a split — every ratio in this layout takes its default\n`)
		}
		return undefined
	}

	const build = (node: LayoutNode, paneId: string): void => {
		if (node.type === 'pane') return
		// The new pane becomes `second`'s region, and the leaf that ends up sitting on it is
		// `firstPane(second)` — so THAT leaf's dir and env are what this split must carry, since a
		// pane's cwd and env can only be set at its birth.
		const born = firstPane(node.second)
		const created = ctx.adapter.open(ctx.exec, {
			cwd: resolveDir(ctx.cwd, born.dir),
			at: node.direction === 'down' ? 'pane:down' : 'pane:right',
			// Always named. Neither backend's default splits the CALLER: herdr's `--current` falls back
			// to the UI-focused pane, and tmux always splits the session's active pane. Both track the
			// user, not us — and a tree walk must split a pane created three steps ago regardless.
			// In a tabs walk this is also what keeps a tab's splits inside THAT tab: the id threaded from
			// here is the tab's own root pane, so no split can wander into the tab opened before it.
			from: { id: paneId },
			ratio: sizeSplit(node.ratio),
			env: born.env,
			label: born.label,
		})
		// Recorded at BIRTH, so a throw later still reports every pane that actually exists.
		tab.paneOf.set(born, created.id)
		build(node.first, paneId)
		build(node.second, created.id)
	}

	build(tab.tree, tab.root.id)
}

/**
 * The manifest, across every tab built so far. ONE FLAT pane list — the tabs are a field on each pane
 * rather than a second nesting a consumer has to walk, which is also why a pane `label` is unique
 * across the whole template rather than per tab: the keys are global.
 */
function report(ctx: WalkContext, tabs: TabState[]): LayoutManifest {
	return {
		layout: ctx.name,
		cwd: ctx.cwd,
		workspace: ctx.workspace,
		panes: tabs.flatMap((tab) =>
			tab.ordered
				.filter((pane) => tab.paneOf.has(pane))
				.map((pane) => ({
					label: pane.label ?? null,
					pane: tab.paneOf.get(pane)!,
					// The root pane reports where it WAS opened, which is not always where its `dir` asked
					// for; every other pane was born by a split that took its resolved dir verbatim. The
					// manifest is the answer to "which panes exist and what are they for", so a claim it
					// cannot back is worse than a feature it does not have.
					dir: pane === tab.rootLeaf ? tab.rootDir : resolveDir(ctx.cwd, pane.dir),
					command: pane.command ?? null,
					tab: tab.index,
				})),
		),
	}
}

/**
 * Every command, last — and across every tab, in template order, tab by tab. Only reachable once all
 * geometry is built: a split lands mid-render if it targets a pane already running an interactive
 * agent, and that reason does not weaken because the pane sits in another tab.
 */
function submitCommands(tabs: TabState[], ctx: WalkContext): void {
	for (const tab of tabs) {
		// The root pane's env, when the region open could not carry it natively. Only reachable on herdr's
		// worktree route; every other route set it at birth and must NOT be prefixed on top of that.
		const rootEnv = tab.rootLeaf.env
		const needsEnvPrefix = !tab.rootEnvHonored && rootEnv !== undefined && Object.keys(rootEnv).length > 0
		if (needsEnvPrefix && !tab.rootLeaf.command) {
			// Nothing to prefix — the fallback only works by riding on a command line. Degrade and warn,
			// never silently drop; stderr, so stdout stays machine-readable.
			process.stderr.write(
				`the layout's root pane "${tab.rootLeaf.label ?? '(unlabeled)'}" has env (${Object.keys(rootEnv).join(', ')}) ` +
					'but no command to carry it — this backend cannot set env on the region it opens\n',
			)
		}

		for (const pane of tab.ordered) {
			if (!pane.command) continue
			const command = needsEnvPrefix && pane === tab.rootLeaf ? `${envPrefix(rootEnv)}${pane.command}` : pane.command
			ctx.adapter.submit(ctx.exec, { id: tab.paneOf.get(pane)! }, command)
		}
	}
}
