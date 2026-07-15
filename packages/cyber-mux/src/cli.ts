import { Command } from 'commander'
import { selectSessionAdapter } from './backend.ts'
import { AT_OPTION, FORMAT_OPTION } from './cli-options.ts'
import { realExec } from './exec.ts'
import { currentPane, probeMultiplexer } from './mux-probe.ts'
import { output, printFields, printTable } from './output.ts'
import type { SessionPlacement, SessionTarget } from './session.ts'

// NOTE: the verb surface below is provisional — the behavior spec is the next milestone and may
// rename verbs, adjust flags, or split concerns (e.g. move `nudge`/`worktree` behind their own group).

function fail(message: string): never {
	process.stderr.write(`${message}\n`)
	process.exit(1)
}

/** Resolve the adapter for the multiplexer this process is inside, failing cleanly when there is none. */
function adapter() {
	try {
		return selectSessionAdapter(process.env, realExec)
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
	}
}

function target(pane: string): SessionTarget {
	return { id: pane }
}

function doctorCommand(): Command {
	return new Command('doctor')
		.description('Probe the multiplexer, self pane, and backend; print fast-path pins')
		.addOption(FORMAT_OPTION)
		.action(() => {
			const probe = probeMultiplexer(realExec, process.env)
			const self = currentPane(process.env)
			let backend = 'none'
			try {
				backend = selectSessionAdapter(process.env, realExec).name
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

function modeCommand(): Command {
	return new Command('mode')
		.description('Report the detected session backend (tmux / herdr / none)')
		.addOption(FORMAT_OPTION)
		.action(() => {
			let name = 'none'
			try {
				name = selectSessionAdapter(process.env, realExec).name
			} catch {
				// no backend — reported as 'none'
			}
			output({ backend: name }, () => console.log(name))
		})
}

function openCommand(): Command {
	return new Command('open')
		.description('Open a new pane/tab/workspace and launch a command in it')
		.requiredOption('--launch <command>', 'Command line to run in the new pane')
		.option('--cwd <path>', 'Working directory for the new pane', process.cwd())
		.addOption(AT_OPTION)
		.addOption(FORMAT_OPTION)
		.action((opts: { launch: string; cwd: string; at?: SessionPlacement }) => {
			const t = adapter().open(realExec, { cwd: opts.cwd, launch: opts.launch, at: opts.at })
			output({ pane: t.id }, () => printFields({ pane: t.id }))
		})
}

function sendCommand(): Command {
	return new Command('send')
		.description('Type text into a pane and submit it')
		.argument('<pane>', 'Target pane id')
		.argument('<text>', 'Text to send')
		.action((pane: string, text: string) => {
			adapter().send(realExec, target(pane), text)
		})
}

function submitCommand(): Command {
	return new Command('submit')
		.description("Flush a pane's already-staged buffer with a bare Enter")
		.argument('<pane>', 'Target pane id')
		.action((pane: string) => {
			adapter().submit(realExec, target(pane))
		})
}

function readCommand(): Command {
	return new Command('read')
		.description("Capture a pane's output")
		.argument('<pane>', 'Target pane id')
		.option('--lines <n>', 'Trailing lines to capture', (v) => Number.parseInt(v, 10))
		.action((pane: string, opts: { lines?: number }) => {
			const out = adapter().read(realExec, target(pane), opts.lines != null ? { lines: opts.lines } : undefined)
			process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
		})
}

function focusCommand(): Command {
	return new Command('focus')
		.description('Beam the attached client to a pane')
		.argument('<pane>', 'Target pane id')
		.action((pane: string) => {
			try {
				adapter().focus(realExec, target(pane))
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err))
			}
		})
}

function closeCommand(): Command {
	return new Command('close')
		.description('Close a pane')
		.argument('<pane>', 'Target pane id')
		.action((pane: string) => {
			adapter().teardown(realExec, target(pane))
		})
}

function listCommand(): Command {
	return new Command('list')
		.description('Enumerate every live pane the current backend can see')
		.addOption(FORMAT_OPTION)
		.action(() => {
			const panes = adapter().listPanes(realExec)
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

function existsCommand(): Command {
	return new Command('exists')
		.description('Probe whether a single pane is still live (exit 0 = live, 1 = gone)')
		.argument('<pane>', 'Target pane id')
		.addOption(FORMAT_OPTION)
		.action((pane: string) => {
			const live = adapter().paneExists(realExec, target(pane))
			output({ pane, live }, () => console.log(live ? 'live' : 'gone'))
			if (!live) process.exit(1)
		})
}

const program = new Command()
	.name('cyber-mux')
	.description('Cross-multiplexer pane control — one contract over tmux and herdr')
	.version('0.0.0')

program.addCommand(doctorCommand())
program.addCommand(modeCommand())
program.addCommand(openCommand())
program.addCommand(sendCommand())
program.addCommand(submitCommand())
program.addCommand(readCommand())
program.addCommand(focusCommand())
program.addCommand(closeCommand())
program.addCommand(listCommand())
program.addCommand(existsCommand())

program.parseAsync(process.argv).catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(1)
})
