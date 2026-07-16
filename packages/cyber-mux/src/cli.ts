import { join } from 'node:path'
import { Command, CommanderError, Option } from 'commander'
import { callerPane, selectSessionAdapter } from './backend.ts'
import { AT_OPTION, FORMAT_OPTION, LABEL_OPTION } from './cli-options.ts'
import { type Exec, realExec } from './exec.ts'
import {
	collectPanes,
	isValidLayoutName,
	type LayoutTemplate,
	parseLayout,
	resolveTree,
	validateLayout,
} from './layout.ts'
import { captureLayout } from './layout-capture.ts'
import {
	applyLayoutToRegion,
	LayoutApplyError,
	type LayoutManifest,
	layoutRootPane,
	openLayout,
} from './layout-session.ts'
import {
	type LayoutStore,
	layoutDirs,
	listLayouts,
	type ResolvedLayout,
	realLayoutStore,
	resolveLayout,
} from './layout-store.ts'
import { currentPane, probeMultiplexer } from './mux-probe.ts'
import { output, printFields, printTable } from './output.ts'
import type { SessionAdapter, SessionPlacement, SessionTarget } from './session.ts'
import { gitWorktreeAdapter, resolvePrimaryRoot, resolveWorktreePath } from './worktree.ts'
import {
	addAndOpenWorktree,
	listWorktrees,
	type OpenedWorktree,
	openExistingWorktree,
	removeWorktree,
} from './worktree-session.ts'

// NOTE: the verb surface below is provisional — the behavior spec is the next milestone and may
// rename verbs, adjust flags, or split concerns (e.g. move `nudge` behind its own group).

/** The env/exec pair every command resolves the backend and multiplexer through — injected so the
 * CLI can be driven deterministically in tests, the same seam every adapter already takes. */
export interface CliDeps {
	env: NodeJS.ProcessEnv
	exec: Exec
	/** The filesystem half, for the `layout` group — injected for the same reason `exec` is: it is the
	 * only way `layout` can be driven hermetically in tests, with no real templates on disk. Optional
	 * at this boundary so a caller that drives no layout command need not know the seam exists. */
	store?: LayoutStore
}

/** `CliDeps` with every optional dep resolved — what each command is actually handed. */
interface Deps {
	env: NodeJS.ProcessEnv
	exec: Exec
	store: LayoutStore
}

const REAL_DEPS: CliDeps = { env: process.env, exec: realExec, store: realLayoutStore }

function fail(message: string): never {
	process.stderr.write(`${message}\n`)
	process.exit(1)
}

/** Resolve the adapter for the multiplexer this process is inside, failing cleanly when there is none. */
function adapter(deps: Deps) {
	try {
		return selectSessionAdapter(deps.env, deps.exec)
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
	}
}

function target(pane: string): SessionTarget {
	return { id: pane }
}

/**
 * The backend when there is one, `undefined` when there is not — unlike `adapter`, which fails. For
 * verbs whose subject is git (`worktree list`/`remove`): a multiplexer can only ever add to the
 * answer, so its absence must not deny one.
 */
function optionalAdapter(deps: Deps): SessionAdapter | undefined {
	try {
		return selectSessionAdapter(deps.env, deps.exec)
	} catch {
		return undefined
	}
}

/**
 * One shape for every verb that opens a worktree. `printFields` drops nullish entries, so a bare
 * `worktree add` — which opens nothing — prints exactly what it always did.
 */
function reportOpenedWorktree(opened: OpenedWorktree): void {
	output(
		{
			root: opened.worktree.root,
			branch: opened.worktree.branch,
			pane: opened.target.id,
			workspace: opened.workspace ?? null,
		},
		() =>
			printFields({
				root: opened.worktree.root,
				branch: opened.worktree.branch,
				pane: opened.target.id,
				workspace: opened.workspace,
			}),
	)
	// The backend could have grouped this worktree and the placement is what cost it — worth saying
	// out loud, on stderr so `--format json` stays clean on stdout. `workspace: null` is the
	// machine-readable half of the same report.
	if (opened.degraded) {
		process.stderr.write('opened ungrouped — pass --at workspace to group it with the repo\n')
	}
}

/**
 * `--layout`, the exact sibling of `--launch`: both answer "what runs in the space you are opening",
 * one for a single pane and one for a pool. Mutually exclusive by construction — commander rejects
 * the pair rather than picking a winner.
 */
function layoutOption(): Option {
	return new Option('--layout <name>', 'Named layout template to build in the opened space').conflicts('launch')
}

/**
 * Resolve, parse and validate a template — the whole answer BEFORE any side effect. A typo in a
 * layout name must never leave a worktree behind, and an invalid template must not either, so every
 * caller runs this before it opens or creates anything.
 */
function resolveTemplate(
	deps: Deps,
	opts: { name?: string; file?: string },
): ResolvedLayout & { template: LayoutTemplate } {
	let resolved: ResolvedLayout
	try {
		resolved = resolveLayout({ name: opts.name, file: opts.file, store: deps.store, exec: deps.exec, env: deps.env })
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
	}
	let parsed: unknown
	try {
		parsed = parseLayout(resolved.raw)
	} catch (err) {
		return fail(`${resolved.path}: ${err instanceof Error ? err.message : String(err)}`)
	}
	// Every error at once, one per line, each naming its own JSON path — first-only would make a
	// template with three mistakes take three runs to fix.
	const errors = validateLayout(parsed, resolved.stem)
	if (errors.length > 0) fail(errors.join('\n'))
	return { ...resolved, template: parsed as LayoutTemplate }
}

/** The apply manifest — the handoff. `printFields`/`printTable` for humans, the raw object for json. */
function reportManifest(manifest: LayoutManifest, extra: Record<string, string | null> = {}): void {
	output({ ...extra, ...manifest }, () => {
		printFields({ ...extra, layout: manifest.layout, cwd: manifest.cwd, workspace: manifest.workspace })
		printTable(manifest.panes, [
			{ label: 'label', get: (p) => p.label ?? '' },
			{ label: 'pane', get: (p) => p.pane },
			{ label: 'dir', get: (p) => p.dir },
			{ label: 'command', get: (p) => p.command ?? '' },
		])
	})
}

/**
 * A walk that threw reports what it BUILT and exits 1, killing nothing. Rolling back would mean
 * killing panes, and a kill is not obviously safer than a half-built layout the caller can see and
 * finish.
 */
function reportApplyFailure(err: unknown, extra: Record<string, string | null> = {}): never {
	if (err instanceof LayoutApplyError) {
		reportManifest(err.manifest, extra)
		return fail(err.message)
	}
	return fail(err instanceof Error ? err.message : String(err))
}

function layoutListCommand(deps: Deps): Command {
	return new Command('list')
		.description('Every layout template resolvable from here, with its source and pane count')
		.addOption(FORMAT_OPTION)
		.action(() => {
			try {
				const dirs = layoutDirs(deps.exec, deps.env)
				const layouts = listLayouts(deps.store, dirs).map((entry) => {
					// A template that does not parse still LISTS — `list` answers "what is here", and
					// `validate` answers "is it any good". Conflating them would hide a broken file entirely.
					let panes = 0
					try {
						const raw = deps.store.read(entry.path)
						if (raw) panes = collectPanes(resolveTree(parseLayout(raw) as LayoutTemplate)).length
					} catch {
						panes = 0
					}
					return { ...entry, panes }
				})
				output({ layouts }, () =>
					printTable(layouts, [
						{ label: 'name', get: (l) => l.name },
						{ label: 'source', get: (l) => l.source },
						{ label: 'panes', get: (l) => String(l.panes) },
						{ label: 'shadowed', get: (l) => (l.shadowed ? 'yes' : '') },
					]),
				)
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

function layoutShowCommand(deps: Deps): Command {
	return new Command('show')
		.description('Print a resolved template as JSON')
		.argument('[name]', 'Template name')
		.option('--file <path>', 'Read this path instead, skipping resolution entirely')
		.option('--desugar', 'Print the canonical tree panes/arrange expands to — exactly what apply builds')
		.action((name: string | undefined, opts: { file?: string; desugar?: boolean }) => {
			if (!name && !opts.file) fail('layout show needs a template name or --file <path>')
			const { template } = resolveTemplate(deps, { name, file: opts.file })
			// One desugarer, so `--desugar` and the walk can never disagree about what a flat template means.
			console.log(JSON.stringify(opts.desugar ? resolveTree(template) : template, null, 2))
		})
}

function layoutValidateCommand(deps: Deps): Command {
	return new Command('validate')
		.description('Validate a template — exit 0 valid, 1 invalid, every error at once with a JSON path')
		.argument('[name]', 'Template name')
		.option('--file <path>', 'Validate this path instead, skipping resolution entirely')
		.action((name: string | undefined, opts: { file?: string }) => {
			if (!name && !opts.file) fail('layout validate needs a template name or --file <path>')
			// resolveTemplate already fails with every error, one per line. Reaching here means valid, and
			// a valid template says nothing at all — this is the CI hook, so silence is the pass signal.
			resolveTemplate(deps, { name, file: opts.file })
		})
}

/**
 * `save` is the one verb here that reads a multiplexer rather than a file, and the only one that
 * WRITES: it captures a live region into a named template, so a pool built by hand once can be named
 * rather than hand-written. That is the schema's one real authoring cost — a 4+ pane grid needs
 * nested `split` nodes nobody wants to type.
 *
 * **What it saves is a draft, and the file says so.** A capture recovers geometry, labels and dirs;
 * it can never recover commands, because no multiplexer reports the command a pane was launched with
 * (`layout-capture.ts` has the why). A saved template therefore lands with no `command` on any pane
 * and is immediately listed by `layout list` alongside finished ones, so the draft has to announce
 * itself IN the file — hence the `description` default. Saying it only on stderr would put the
 * warning everywhere except where the reader is.
 *
 * `--to` defaults to `repo`, matching resolution's own precedence: a template is a statement about
 * how the PROJECT is worked on, and that is the copy worth having by default.
 */
function layoutSaveCommand(deps: Deps): Command {
	return new Command('save')
		.description('Capture the live region around a pane into a named template')
		.argument('<name>', 'Name for the captured template')
		.option('--from <pane>', "Pane whose region to capture; defaults to this process's own pane")
		.option('--description <text>', 'Description to record in the template')
		.addOption(
			new Option('--to <source>', 'Which layouts directory to write to').choices(['repo', 'user']).default('repo'),
		)
		.option('--force', 'Overwrite an existing template of this name')
		.addHelpText(
			'after',
			'\nA capture recovers geometry, labels and dirs — NOT commands: no multiplexer can report the\n' +
				'command a pane was launched with, so every pane is saved without one. Fill them in before\n' +
				'the template is worth applying.',
		)
		.action((name: string, opts: { from?: string; description?: string; to: 'repo' | 'user'; force?: boolean }) => {
			// Before the multiplexer is touched: a name is a lookup key that must also be a filename, so an
			// unusable one should not cost a region read to find out.
			if (!isValidLayoutName(name)) {
				fail(`invalid layout name "${name}" — a name must match [a-z0-9][a-z0-9-]* and be a plain filename stem`)
			}
			try {
				const path = join(layoutDirs(deps.exec, deps.env)[opts.to], `${name}.json`)
				// Checked BEFORE the capture, so a refusal costs nothing — and refused by default, because a
				// template is hand-edited after it is saved (the commands are added by hand) and silently
				// overwriting one would throw that work away.
				if (!opts.force && deps.store.read(path) !== null) {
					fail(`layout "${name}" already exists at ${path} — pass --force to overwrite it`)
				}
				const adapter = selectSessionAdapter(deps.env, deps.exec)
				// Geometry reporting is an optional capability, exactly as the worktree binding is. A
				// backend that cannot describe its own region cannot be captured and there is nothing to
				// degrade to — so this refuses, naming the backend, rather than guessing a tree.
				const describeRegion = adapter.describeRegion
				if (!describeRegion) {
					fail(`${adapter.name} cannot report a region's geometry — layout save needs a backend that can`)
				}
				// `--from` names a pane explicitly; otherwise capture the region THIS process sits in, which
				// is what makes a bare `layout save pool-4` mean "the screen I am looking at".
				const target = opts.from ? { id: opts.from } : callerPane(adapter, deps.env)
				if (!target) {
					fail('layout save needs a pane to capture the region around — pass --from <pane>, or run it inside one')
				}
				const { template, warnings } = captureLayout(describeRegion(deps.exec, target), {
					name,
					description: opts.description ?? CAPTURED_DESCRIPTION,
				})
				deps.store.write(path, `${JSON.stringify(template, null, 2)}\n`)
				// stderr, so stdout stays the path alone — `cyber-mux layout save x` composes into `$(...)`.
				for (const warning of warnings) process.stderr.write(`${warning}\n`)
				console.log(path)
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

/**
 * The default `description` on a captured template — the draft warning, written where the reader
 * actually is. A saved capture is listed by `layout list` next to finished templates and shows up in
 * `layout show`, so a note that only ever reached the terminal that ran `save` would be gone by the
 * time anyone reads the file. Overridden by `--description`, since an author who names the template's
 * purpose has said something more useful than this.
 */
const CAPTURED_DESCRIPTION = 'Captured from a live region — geometry only; add a command to each pane.'

/**
 * The `layout` group manages templates — there is deliberately no `layout apply`. Applying is what
 * `open` and `worktree add` already do, told to build N panes instead of one, so it is `--layout` on
 * those verbs.
 *
 * `list` / `show` / `validate` take a FILE as their subject and touch no multiplexer. `save` is the
 * exception in both respects — it reads a live region and writes a file — and it belongs here anyway:
 * it AUTHORS a template, which is what this group is for.
 */
function layoutCommand(deps: Deps): Command {
	const cmd = new Command('layout').description('Manage named layout templates (apply one with open/worktree --layout)')
	cmd.addCommand(layoutListCommand(deps))
	cmd.addCommand(layoutShowCommand(deps))
	cmd.addCommand(layoutValidateCommand(deps))
	cmd.addCommand(layoutSaveCommand(deps))
	return cmd
}

function doctorCommand(deps: Deps): Command {
	return new Command('doctor')
		.description('Probe the multiplexer, self pane, and backend; print fast-path pins')
		.addOption(FORMAT_OPTION)
		.action(() => {
			const probe = probeMultiplexer(deps.exec, deps.env)
			const self = currentPane(deps.env)
			let backend = 'none'
			try {
				backend = selectSessionAdapter(deps.env, deps.exec).name
			} catch {
				// no backend — reported as 'none'
			}
			const data = {
				mux: probe.mux,
				via: probe.via,
				pane: self?.pane ?? probe.pane ?? null,
				backend,
			}
			output(data, () => {
				printFields({
					multiplexer: data.mux,
					'detected via': data.via,
					pane: data.pane ?? '(none)',
					backend: data.backend,
				})
				if (self) {
					console.log('')
					console.log('Pin the fast-path to skip detection:')
					console.log(`  export CYBER_MUX=${self.mux} CYBER_MUX_PANE=${self.pane}`)
				}
			})
		})
}

function modeCommand(deps: Deps): Command {
	return new Command('mode')
		.description('Report the detected session backend (tmux / herdr / none)')
		.addOption(FORMAT_OPTION)
		.action(() => {
			let name = 'none'
			try {
				name = selectSessionAdapter(deps.env, deps.exec).name
			} catch {
				// no backend — reported as 'none'
			}
			output({ backend: name }, () => console.log(name))
		})
}

function openCommand(deps: Deps): Command {
	return new Command('open')
		.description('Open a new pane/tab/workspace, optionally launching a command in it')
		.option('--launch <command>', 'Command line to run in the new pane')
		.addOption(layoutOption())
		.option('--cwd <path>', 'Working directory for the new pane', process.cwd())
		.addOption(AT_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action((opts: { launch?: string; layout?: string; cwd: string; at?: SessionPlacement; label?: string }) => {
			if (opts.layout) {
				// Resolve and validate BEFORE touching a backend, so an unresolvable name opens nothing.
				const { template } = resolveTemplate(deps, { name: opts.layout })
				const a = adapter(deps)
				try {
					reportManifest(
						openLayout(deps.exec, a, template, {
							cwd: opts.cwd,
							// A fresh space is empty by construction, which is why the pool defaults there.
							at: opts.at ?? 'workspace',
							label: opts.label ?? template.name,
							dirExists: deps.store.dirExists,
							from: callerPane(a, deps.env),
						}),
					)
				} catch (err) {
					reportApplyFailure(err)
				}
				return
			}
			const a = adapter(deps)
			const t = a.open(deps.exec, {
				cwd: opts.cwd,
				launch: opts.launch,
				at: opts.at,
				label: opts.label,
				from: callerPane(a, deps.env),
			})
			output({ pane: t.id }, () => printFields({ pane: t.id }))
		})
}

/** The `send` group: drive a pane's input WITHOUT taking its turn. Neither subcommand presses an
 * Enter the caller did not write — supplying one is `submit`'s job. Bare `cyber-mux send` is
 * incomplete input, not a content request: commander answers it with help on stderr and exit 1
 * (see the AXI content-first note in `.agents/spec/axi/README.md`). */
function sendCommand(deps: Deps): Command {
	const send = new Command('send').description('Drive a pane without taking its turn (text | keys)')
	send.addCommand(
		new Command('text')
			.description('Type literal text into a pane, pressing no Enter (a key-named word is typed, not pressed)')
			.argument('<pane>', 'Target pane id')
			.argument('<text>', 'Literal text to type')
			.action((pane: string, text: string) => {
				adapter(deps).sendText(deps.exec, target(pane), text)
			}),
	)
	send.addCommand(
		new Command('keys')
			.description('Press named keys in a pane, typing nothing (Up, Enter, Escape, C-c, F1 …)')
			.argument('<pane>', 'Target pane id')
			.argument(
				'<keys...>',
				'Key names, in order — core vocabulary is portable, anything else is passed to the backend as-is',
			)
			.action((pane: string, keys: string[]) => {
				adapter(deps).sendKeys(deps.exec, target(pane), keys)
			}),
	)
	return send
}

function submitCommand(deps: Deps): Command {
	return new Command('submit')
		.description("Take a pane's turn: type the text if given, then always press Enter (no text = bare-Enter flush)")
		.argument('<pane>', 'Target pane id')
		.argument('[text]', 'Text to type before Enter; omit to flush an already-staged buffer without retyping it')
		.action((pane: string, text: string | undefined) => {
			adapter(deps).submit(deps.exec, target(pane), text)
		})
}

function readCommand(deps: Deps): Command {
	return new Command('read')
		.description("Capture a pane's output")
		.argument('<pane>', 'Target pane id')
		.option('--lines <n>', 'Trailing lines to capture', (v) => Number.parseInt(v, 10))
		.action((pane: string, opts: { lines?: number }) => {
			const out = adapter(deps).read(deps.exec, target(pane), opts.lines != null ? { lines: opts.lines } : undefined)
			process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
		})
}

function focusCommand(deps: Deps): Command {
	return new Command('focus')
		.description('Beam the attached client to a pane')
		.argument('<pane>', 'Target pane id')
		.action((pane: string) => {
			try {
				adapter(deps).focus(deps.exec, target(pane))
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

function closeCommand(deps: Deps): Command {
	return new Command('close')
		.description('Close a pane')
		.argument('<pane>', 'Target pane id')
		.action((pane: string) => {
			adapter(deps).teardown(deps.exec, target(pane))
		})
}

function listCommand(deps: Deps): Command {
	return new Command('list')
		.description('Enumerate every live pane the current backend can see')
		.addOption(FORMAT_OPTION)
		.action(() => {
			const panes = adapter(deps).listPanes(deps.exec)
			output({ panes }, () =>
				printTable(panes, [
					{ label: 'pane', get: (p) => p.id },
					{ label: 'mux', get: (p) => p.mux },
					{ label: 'harness', get: (p) => p.harness ?? '' },
					{ label: 'cwd', get: (p) => p.cwd ?? '' },
				]),
			)
		})
}

function existsCommand(deps: Deps): Command {
	return new Command('exists')
		.description('Probe whether a single pane is still live (exit 0 = live, 1 = gone)')
		.argument('<pane>', 'Target pane id')
		.addOption(FORMAT_OPTION)
		.action((pane: string) => {
			const live = adapter(deps).paneExists(deps.exec, target(pane))
			output({ pane, live }, () => console.log(live ? 'live' : 'gone'))
			if (!live) process.exit(1)
		})
}

function worktreeAddCommand(deps: Deps): Command {
	return new Command('add')
		.description('Create a git worktree, and open it when given a placement — grouped where the backend can')
		.requiredOption('--branch <branch>', 'Branch to create the worktree on')
		.option('--path <path>', 'Where to check out the worktree (default: a sibling of the primary checkout)')
		.option('--base <ref>', 'Start point for the new branch (default: the current HEAD)')
		.option('--launch <command>', 'Command to run in the opened pane; implies --at workspace')
		.addOption(layoutOption())
		.addOption(AT_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action(
			(opts: {
				branch: string
				path?: string
				base?: string
				launch?: string
				layout?: string
				at?: SessionPlacement
				label?: string
			}) => {
				try {
					const primaryRoot = resolvePrimaryRoot(deps.exec)
					// The primary flow this feature exists for. Resolve and validate FIRST: a typo in a
					// layout name, or a template that sets a cwd, must not leave a worktree behind.
					if (opts.layout) {
						const { template } = resolveTemplate(deps, { name: opts.layout })
						const path = opts.path ?? resolveWorktreePath(primaryRoot, opts.branch)
						const a = adapter(deps)
						// No `launch`: the worktree's workspace opens blank and its root pane becomes the
						// tree's root region — not a wasted pane, the one the walk splits into. Its `env`
						// must ride in HERE, though: no split ever births that pane, so this is the only
						// call that can set it.
						const opened = addAndOpenWorktree(deps.exec, a, {
							primaryRoot,
							branch: opts.branch,
							path,
							base: opts.base,
							env: layoutRootPane(template).env,
							at: 'workspace',
							label: opts.label ?? template.name,
							from: callerPane(a, deps.env),
						})
						const extra = { root: opened.worktree.root, branch: opened.worktree.branch }
						try {
							reportManifest(
								applyLayoutToRegion(deps.exec, a, template, {
									root: opened.target,
									cwd: opened.worktree.root,
									workspace: opened.workspace ?? null,
									// The route that opened the region is the only thing that knows whether it
									// could carry the root pane's env; the walk falls back to a prefix when not.
									rootEnvHonored: opened.envHonored,
									dirExists: deps.store.dirExists,
								}),
								extra,
							)
						} catch (err) {
							reportApplyFailure(err, extra)
						}
						return
					}
					const path = opts.path ?? resolveWorktreePath(primaryRoot, opts.branch)
					// With no placement asked for, this IS a git operation: it creates a checkout, opens
					// nothing, and needs no multiplexer to be inside of. There is nothing to group because
					// nothing was opened — `worktree open` is how that checkout gets grouped later.
					if (!opts.at && !opts.launch) {
						const wt = gitWorktreeAdapter.add(deps.exec, { primaryRoot, path, branch: opts.branch, base: opts.base })
						output({ root: wt.root, branch: wt.branch, pane: null, workspace: null }, () =>
							printFields({ root: wt.root, branch: wt.branch }),
						)
						return
					}
					// A launch with no placement wants its own space, not a pane crowding the caller's — and
					// `workspace` is the only placement a backend can bind a worktree to.
					const at = opts.at ?? 'workspace'
					const a = adapter(deps)
					reportOpenedWorktree(
						addAndOpenWorktree(deps.exec, a, {
							primaryRoot,
							branch: opts.branch,
							path,
							base: opts.base,
							launch: opts.launch,
							at,
							label: opts.label,
							from: callerPane(a, deps.env),
						}),
					)
				} catch (err) {
					fail(err instanceof Error ? err.message : String(err))
				}
			},
		)
}

function worktreeOpenCommand(deps: Deps): Command {
	return new Command('open')
		.description('Open an existing git worktree — groups it with the repo where the backend can bind')
		.argument('<path>', 'Worktree path to open')
		.option('--launch <command>', 'Command to run in the opened pane')
		.addOption(AT_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action((path: string, opts: { launch?: string; at?: SessionPlacement; label?: string }) => {
			try {
				const primaryRoot = resolvePrimaryRoot(deps.exec)
				const a = adapter(deps)
				reportOpenedWorktree(
					openExistingWorktree(deps.exec, a, {
						primaryRoot,
						path,
						launch: opts.launch,
						at: opts.at,
						label: opts.label,
						from: callerPane(a, deps.env),
					}),
				)
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

function worktreeListCommand(deps: Deps): Command {
	return new Command('list')
		.description('Every worktree of the repo, and the workspace each is open in')
		.addOption(FORMAT_OPTION)
		.action(() => {
			try {
				const primaryRoot = resolvePrimaryRoot(deps.exec)
				const worktrees = listWorktrees(deps.exec, optionalAdapter(deps), { primaryRoot })
				output({ worktrees }, () =>
					printTable(worktrees, [
						{ label: 'branch', get: (w) => w.branch ?? '(detached)' },
						{ label: 'root', get: (w) => w.root },
						{ label: 'linked', get: (w) => String(w.linked) },
						{ label: 'workspace', get: (w) => w.workspace ?? '' },
					]),
				)
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

function worktreeRemoveCommand(deps: Deps): Command {
	return new Command('remove')
		.description('Remove a git worktree — refuses the primary checkout and uncommitted changes unless --force')
		.argument('<path>', 'Worktree path to remove')
		.option('--force', 'Discard uncommitted changes in the worktree')
		.action((path: string, opts: { force?: boolean }) => {
			try {
				const primaryRoot = resolvePrimaryRoot(deps.exec)
				removeWorktree(deps.exec, optionalAdapter(deps), path, { primaryRoot, force: opts.force })
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

function worktreeCommand(deps: Deps): Command {
	const cmd = new Command('worktree').description('Git worktree helpers for spawning/tearing down a session')
	cmd.addCommand(worktreeAddCommand(deps))
	cmd.addCommand(worktreeOpenCommand(deps))
	cmd.addCommand(worktreeListCommand(deps))
	cmd.addCommand(worktreeRemoveCommand(deps))
	return cmd
}

/** `exitOverride()` binds to one command only — it is NOT inherited by subcommands. With a flat verb
 * surface that was invisible, but `send` is a group: without this walk, `cyber-mux send` with no
 * subcommand would call `process.exit(1)` straight from the group and kill the caller's process
 * (in tests, the runner itself) instead of throwing a catchable `CommanderError`. */
function exitOverrideTree(command: Command): Command {
	command.exitOverride()
	for (const sub of command.commands) exitOverrideTree(sub)
	return command
}

/** Assembles the full command tree against the given deps (real env/exec in production, fakes in
 * tests). Every command in the tree gets `exitOverride()`, so commander throws a `CommanderError`
 * instead of calling `process.exit` directly and a rejection (an invalid `--at` choice, a missing
 * argument, a bare `send`) is catchable both here and in tests, rather than killing the test
 * runner's own process. */
export function buildProgram(cliDeps: CliDeps = REAL_DEPS): Command {
	const deps: Deps = { env: cliDeps.env, exec: cliDeps.exec, store: cliDeps.store ?? realLayoutStore }
	const program = new Command()
		.name('cyber-mux')
		.description('Cross-multiplexer pane control — one contract over tmux and herdr')
		.version('0.0.0')

	program.addCommand(doctorCommand(deps))
	program.addCommand(modeCommand(deps))
	program.addCommand(openCommand(deps))
	program.addCommand(sendCommand(deps))
	program.addCommand(submitCommand(deps))
	program.addCommand(readCommand(deps))
	program.addCommand(focusCommand(deps))
	program.addCommand(closeCommand(deps))
	program.addCommand(listCommand(deps))
	program.addCommand(existsCommand(deps))
	program.addCommand(worktreeCommand(deps))
	program.addCommand(layoutCommand(deps))

	return exitOverrideTree(program)
}

/** The real CLI entry point — called explicitly by `bin/cyber-mux.mjs`, never as an import-time
 * side effect, so importing this module (e.g. from tests) never runs the real CLI. */
export async function main(): Promise<void> {
	try {
		await buildProgram().parseAsync(process.argv)
	} catch (err) {
		// commander has already written its own text to stderr (the help for a bare group, the
		// `error: missing required argument` line) before throwing, so re-printing its internal message
		// would double it — and for help that message is the literal placeholder "(outputHelp)". Honor
		// the exit code it chose and add nothing.
		if (err instanceof CommanderError) process.exit(err.exitCode)
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
		process.exit(1)
	}
}
