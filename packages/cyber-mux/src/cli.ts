import { Command } from 'commander'
import { selectSessionAdapter } from './backend.ts'
import { AT_OPTION, FORMAT_OPTION } from './cli-options.ts'
import { type Exec, realExec } from './exec.ts'
import { currentPane, probeMultiplexer } from './mux-probe.ts'
import { output, printFields, printTable } from './output.ts'
import type { SessionPlacement, SessionTarget } from './session.ts'

// NOTE: the verb surface below is provisional — the behavior spec is the next milestone and may
// rename verbs, adjust flags, or split concerns (e.g. move `nudge`/`worktree` behind their own group).

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
		.addOption(FORMAT_OPTION)
		.action((opts: { launch?: string; cwd: string; at?: SessionPlacement }) => {
			const t = adapter(deps).open(deps.exec, { cwd: opts.cwd, launch: opts.launch, at: opts.at })
			output({ pane: t.id }, () => printFields({ pane: t.id }))
		})
}

function sendCommand(deps: CliDeps): Command {
	return new Command('send')
		.description('Type text into a pane and submit it')
		.argument('<pane>', 'Target pane id')
		.argument('<text>', 'Text to send')
		.action((pane: string, text: string) => {
			adapter(deps).send(deps.exec, target(pane), text)
		})
}

function submitCommand(deps: CliDeps): Command {
	return new Command('submit')
		.description("Flush a pane's already-staged buffer with a bare Enter")
		.argument('<pane>', 'Target pane id')
		.action((pane: string) => {
			adapter(deps).submit(deps.exec, target(pane))
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

/** Assembles the full command tree against the given deps (real env/exec in production, fakes in
 * tests). `exitOverride()` makes commander throw a `CommanderError` instead of calling
 * `process.exit` directly, so a rejection (e.g. an invalid `--at` choice) is catchable both here and
 * in tests, rather than killing the test runner's own process. */
export function buildProgram(deps: CliDeps = REAL_DEPS): Command {
	const program = new Command()
		.name('cyber-mux')
		.description('Cross-multiplexer pane control — one contract over tmux and herdr')
		.version('0.0.0')
		.exitOverride()

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

	return program
}

/** The real CLI entry point — called explicitly by `bin/cyber-mux.mjs`, never as an import-time
 * side effect, so importing this module (e.g. from tests) never runs the real CLI. */
export async function main(): Promise<void> {
	try {
		await buildProgram().parseAsync(process.argv)
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
		process.exit(1)
	}
}
