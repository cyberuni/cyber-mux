import { join } from 'node:path'
import type { Exec } from './exec.ts'
import { collectPanes, firstPane, type LayoutNode, type LayoutTemplate, type PaneNode, resolveTree } from './layout.ts'
import type { SessionAdapter, SessionPlacement, SessionTarget } from './session.ts'

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
	dirExists: (path: string) => boolean
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
	return walk(tree, root, {
		exec,
		adapter,
		cwd: opts.cwd,
		name: template.name,
		// The whole point of widening `open`'s return: before it carried a workspace, this was a
		// hardcoded null and the manifest could never report one, even on a backend that had just
		// opened a real workspace.
		workspace: root.workspace ?? null,
		rootDir,
		// `open` sets env natively at every tier on both backends, so it never needs the prefix.
		rootEnvHonored: true,
		dirExists: opts.dirExists,
	})
}

/**
 * The pane that will sit on a region's own root pane — whoever opens that region must carry this
 * pane's `env` (and, where it can, its `dir`), because no split ever births it.
 */
export function layoutRootPane(template: LayoutTemplate): PaneNode {
	return firstPane(resolveTree(template))
}

export interface ApplyLayoutOptions {
	/** An ALREADY-OPEN blank region whose pane is the tree's root — e.g. a worktree's workspace. */
	root: SessionTarget
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
	return walk(tree, opts.root, {
		exec,
		adapter,
		cwd: opts.cwd,
		name: template.name,
		workspace: opts.workspace,
		// Where it actually is, not where the template asked for.
		rootDir: opts.cwd,
		rootEnvHonored: opts.rootEnvHonored,
		dirExists: opts.dirExists,
	})
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
function walk(tree: LayoutNode, root: SessionTarget, ctx: WalkContext): LayoutManifest {
	// Template order — `first` before `second` — is the order the manifest reports and commands are
	// submitted in, so both match the order the panes are written in the file.
	const ordered = collectPanes(tree)
	const paneOf = new Map<PaneNode, string>()
	// The root leaf rides the region's own pane; every other leaf is born by exactly one split.
	const rootLeaf = firstPane(tree)
	paneOf.set(rootLeaf, root.id)

	// A backend that cannot size a split takes its own default and we say so ONCE — a wrong-looking
	// split is not worth failing an otherwise-correct pool over, and the schema is backend-agnostic,
	// so a template's validity cannot depend on which multiplexer happens to be running.
	let warnedRatio = false
	const sizeSplit = (ratio: number | undefined): number | undefined => {
		if (ratio == null) return undefined
		if (ctx.adapter.canSizeSplits) return ratio
		if (!warnedRatio) {
			warnedRatio = true
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
			from: { id: paneId },
			ratio: sizeSplit(node.ratio),
			env: born.env,
			label: born.label,
		})
		// Recorded at BIRTH, so a throw later still reports every pane that actually exists.
		paneOf.set(born, created.id)
		build(node.first, paneId)
		build(node.second, created.id)
	}

	const report = (): LayoutManifest => ({
		layout: ctx.name,
		cwd: ctx.cwd,
		workspace: ctx.workspace,
		panes: ordered
			.filter((pane) => paneOf.has(pane))
			.map((pane) => ({
				label: pane.label ?? null,
				pane: paneOf.get(pane)!,
				// The root pane reports where it WAS opened, which is not always where its `dir` asked
				// for; every other pane was born by a split that took its resolved dir verbatim. The
				// manifest is the answer to "which panes exist and what are they for", so a claim it
				// cannot back is worse than a feature it does not have.
				dir: pane === rootLeaf ? ctx.rootDir : resolveDir(ctx.cwd, pane.dir),
				command: pane.command ?? null,
			})),
	})

	try {
		build(tree, root.id)
	} catch (err) {
		// No rollback, no kill — report what was built and let the caller finish or close it.
		throw new LayoutApplyError(err instanceof Error ? err.message : String(err), report())
	}

	// The root pane's env, when the region open could not carry it natively. Only reachable on herdr's
	// worktree route; every other route set it at birth and must NOT be prefixed on top of that.
	const rootEnv = rootLeaf.env
	const needsEnvPrefix = !ctx.rootEnvHonored && rootEnv !== undefined && Object.keys(rootEnv).length > 0
	if (needsEnvPrefix && !rootLeaf.command) {
		// Nothing to prefix — the fallback only works by riding on a command line. Degrade and warn,
		// never silently drop; stderr, so stdout stays machine-readable.
		process.stderr.write(
			`the layout's root pane "${rootLeaf.label ?? '(unlabeled)'}" has env (${Object.keys(rootEnv).join(', ')}) ` +
				'but no command to carry it — this backend cannot set env on the region it opens\n',
		)
	}

	// Last, and only now: every pane exists, so no split ever lands on a pane mid-render.
	for (const pane of ordered) {
		if (!pane.command) continue
		const command = needsEnvPrefix && pane === rootLeaf ? `${envPrefix(rootEnv)}${pane.command}` : pane.command
		ctx.adapter.submit(ctx.exec, { id: paneOf.get(pane)! }, command)
	}
	return report()
}
