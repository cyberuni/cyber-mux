import { Command, CommanderError } from 'commander'
import { selectSessionAdapter } from './backend.ts'
import { AT_OPTION, FORMAT_OPTION, LABEL_OPTION } from './cli-options.ts'
import { type Exec, realExec } from './exec.ts'
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
}

const REAL_DEPS: CliDeps = { env: process.env, exec: realExec }

function fail(message: string): never {
	process.stderr.write(`${message}\n`)
	process.exit(1)
}

/** Resolve the adapter for the multiplexer this process is inside, failing cleanly when there is none. */
function adapter(deps: CliDeps) {
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
function optionalAdapter(deps: CliDeps): SessionAdapter | undefined {
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

function doctorCommand(deps: CliDeps): Command {
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

function modeCommand(deps: CliDeps): Command {
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

function openCommand(deps: CliDeps): Command {
	return new Command('open')
		.description('Open a new pane/tab/workspace, optionally launching a command in it')
		.option('--launch <command>', 'Command line to run in the new pane')
		.option('--cwd <path>', 'Working directory for the new pane', process.cwd())
		.addOption(AT_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action((opts: { launch?: string; cwd: string; at?: SessionPlacement; label?: string }) => {
			const t = adapter(deps).open(deps.exec, { cwd: opts.cwd, launch: opts.launch, at: opts.at, label: opts.label })
			output({ pane: t.id }, () => printFields({ pane: t.id }))
		})
}

/** The `send` group: drive a pane's input WITHOUT taking its turn. Neither subcommand presses an
 * Enter the caller did not write — supplying one is `submit`'s job. Bare `cyber-mux send` is
 * incomplete input, not a content request: commander answers it with help on stderr and exit 1
 * (see the AXI content-first note in `.agents/spec/axi/README.md`). */
function sendCommand(deps: CliDeps): Command {
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

function submitCommand(deps: CliDeps): Command {
	return new Command('submit')
		.description("Take a pane's turn: type the text if given, then always press Enter (no text = bare-Enter flush)")
		.argument('<pane>', 'Target pane id')
		.argument('[text]', 'Text to type before Enter; omit to flush an already-staged buffer without retyping it')
		.action((pane: string, text: string | undefined) => {
			adapter(deps).submit(deps.exec, target(pane), text)
		})
}

function readCommand(deps: CliDeps): Command {
	return new Command('read')
		.description("Capture a pane's output")
		.argument('<pane>', 'Target pane id')
		.option('--lines <n>', 'Trailing lines to capture', (v) => Number.parseInt(v, 10))
		.action((pane: string, opts: { lines?: number }) => {
			const out = adapter(deps).read(deps.exec, target(pane), opts.lines != null ? { lines: opts.lines } : undefined)
			process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
		})
}

function focusCommand(deps: CliDeps): Command {
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

function closeCommand(deps: CliDeps): Command {
	return new Command('close')
		.description('Close a pane')
		.argument('<pane>', 'Target pane id')
		.action((pane: string) => {
			adapter(deps).teardown(deps.exec, target(pane))
		})
}

function listCommand(deps: CliDeps): Command {
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

function existsCommand(deps: CliDeps): Command {
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

function worktreeAddCommand(deps: CliDeps): Command {
	return new Command('add')
		.description('Create a git worktree, and open it when given a placement — grouped where the backend can')
		.requiredOption('--branch <branch>', 'Branch to create the worktree on')
		.option('--path <path>', 'Where to check out the worktree (default: a sibling of the primary checkout)')
		.option('--base <ref>', 'Start point for the new branch (default: the current HEAD)')
		.option('--launch <command>', 'Command to run in the opened pane; implies --at workspace')
		.addOption(AT_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action(
			(opts: {
				branch: string
				path?: string
				base?: string
				launch?: string
				at?: SessionPlacement
				label?: string
			}) => {
				try {
					const primaryRoot = resolvePrimaryRoot(deps.exec)
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
					reportOpenedWorktree(
						addAndOpenWorktree(deps.exec, adapter(deps), {
							primaryRoot,
							branch: opts.branch,
							path,
							base: opts.base,
							launch: opts.launch,
							at,
							label: opts.label,
						}),
					)
				} catch (err) {
					fail(err instanceof Error ? err.message : String(err))
				}
			},
		)
}

function worktreeOpenCommand(deps: CliDeps): Command {
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
				reportOpenedWorktree(
					openExistingWorktree(deps.exec, adapter(deps), {
						primaryRoot,
						path,
						launch: opts.launch,
						at: opts.at,
						label: opts.label,
					}),
				)
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

function worktreeListCommand(deps: CliDeps): Command {
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

function worktreeRemoveCommand(deps: CliDeps): Command {
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

function worktreeCommand(deps: CliDeps): Command {
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
export function buildProgram(deps: CliDeps = REAL_DEPS): Command {
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
