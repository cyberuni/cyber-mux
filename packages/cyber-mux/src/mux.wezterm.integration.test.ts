import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'

function hasWezterm(): boolean {
	try {
		execFileSync('wezterm', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * `wezterm cli` is a CLIENT. By default it connects to a running GUI instance, and `--prefer-mux`
 * points it at a background `wezterm-mux-server` instead — which it will start on demand. That
 * server's socket lives under `$XDG_RUNTIME_DIR`, so pointing that at a throwaway directory gives
 * this suite a PRIVATE wezterm to drive, never the operator's own GUI. It is the same isolation the
 * tmux suite gets from `-L <socket>`, supplied by the environment rather than by a flag.
 *
 * The adapter itself spells neither `--prefer-mux` nor a socket, exactly as the tmux adapter spells
 * no `-L`: connection targeting is the caller's business, and here the injected `Exec` supplies it —
 * the same seam, the same reason. Note what that implies for real use, which no mocked test can
 * show: driven from a plain shell with no GUI running and no `--prefer-mux`, every `wezterm cli`
 * call fails at the socket. In normal use the caller IS inside a wezterm GUI, so it connects; this
 * suite has to arrange the headless equivalent deliberately.
 */
function hasMuxServer(): boolean {
	try {
		execFileSync('wezterm-mux-server', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

async function pollUntil(read: () => string, done: (out: string) => boolean, timeoutMs = 5000): Promise<string> {
	const start = Date.now()
	let out = read()
	while (!done(out) && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 50))
		out = read()
	}
	return out
}

// A SHORT runtime dir, deliberately: a unix socket path must fit in `sun_path` (~108 bytes), and
// wezterm appends `wezterm/sock` to it. A long temp path makes the server bind silently fail and
// every command then reports "failed to connect", which reads like a wezterm problem and is not.
const RUNTIME_DIR = join(tmpdir(), `wz${process.pid}`)

describe.skipIf(!hasWezterm() || !hasMuxServer())('spec:cyber-mux/mux', () => {
	describe('weztermMuxAdapter — real wezterm boundary', () => {
		let cwd: string
		let exec: Exec
		let server: ReturnType<typeof spawn>

		beforeAll(async () => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-wz-'))
			const env = { ...process.env, XDG_RUNTIME_DIR: RUNTIME_DIR, WEZTERM_CONFIG_FILE: '/dev/null' }
			mkdirSync(RUNTIME_DIR, { recursive: true })
			// Started explicitly and held by PID, rather than letting `wezterm cli` auto-spawn it: the
			// teardown then kills exactly the process this suite owns. A pattern-matching kill
			// (`pkill -f wezterm-mux-server`) is the obvious alternative and is genuinely unsafe — it
			// matches any command line merely MENTIONING the name, up to and including the shell that
			// launched the test run.
			server = spawn('wezterm-mux-server', ['--skip-config'], { env, detached: true, stdio: 'ignore' })
			server.unref()
			exec = (cmd, args) => {
				try {
					// Inject the connection target the adapter deliberately does not spell, immediately after
					// the `cli` subcommand where wezterm accepts its options.
					const full = cmd === 'wezterm' && args[0] === 'cli' ? ['cli', '--prefer-mux', ...args.slice(1)] : args
					return execFileSync(cmd, full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim()
				} catch {
					return null
				}
			}
			// Wait for the socket to answer rather than sleeping a guessed interval — the first real
			// assertion must not race the server's startup.
			for (let i = 0; i < 60 && !exec('wezterm', ['cli', 'list']); i++) {
				await new Promise((r) => setTimeout(r, 100))
			}
		})

		afterAll(() => {
			try {
				if (server.pid) process.kill(-server.pid)
			} catch {
				try {
					if (server.pid) process.kill(server.pid)
				} catch {
					// already gone
				}
			}
			rmSync(cwd, { recursive: true, force: true })
			rmSync(RUNTIME_DIR, { recursive: true, force: true })
		})

		it('open() actually creates a real pane the real wezterm binary reports back', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			expect(base, 'the mux server should report at least one pane to split from').toBeDefined()
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			expect(target.id).toMatch(/^\d+$/)
			expect(weztermMuxAdapter.paneExists(exec, target)).toBe(true)
		})

		it('listPanes() sees the real pane, cwd and all', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:down', from: { id: base?.id ?? '0' } })
			const panes = weztermMuxAdapter.listPanes(exec)
			// `cwd` arrives as a `file://` URI that the adapter strips back to a bare path — a decode that
			// only a real listing exercises.
			expect(panes.some((p) => p.id === target.id && p.cwd === cwd)).toBe(true)
		})

		it('open({ at: workspace }) creates a real window in its own named workspace', () => {
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: `cm-itest-${process.pid}` })
			expect(target.workspace).toBe(`cm-itest-${process.pid}`)
			const panes = weztermMuxAdapter.listPanes(exec)
			expect(panes.some((p) => p.id === target.id)).toBe(true)
		})

		it('teardown() actually kills the real pane', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			expect(weztermMuxAdapter.paneExists(exec, target)).toBe(true)
			weztermMuxAdapter.teardown(exec, target)
			expect(weztermMuxAdapter.paneExists(exec, target)).toBe(false)
		})

		it('submit()/read() actually run a command in and capture from a real pane', async () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			weztermMuxAdapter.submit(exec, target, 'echo cyber-mux-wz-marker')
			const output = await pollUntil(
				() => weztermMuxAdapter.read(exec, target).text,
				(out) => out.includes('cyber-mux-wz-marker'),
			)
			expect(output).toContain('cyber-mux-wz-marker')
		})

		// The refusal, against the real binary. wezterm has no floating-pane concept at all, so the
		// adapter refuses by name rather than substituting a split — and it must refuse BEFORE running
		// anything, which a real boundary is what proves.
		it('open({ at: pane:float }) refuses rather than substituting a split', () => {
			const before = weztermMuxAdapter.listPanes(exec).length
			expect(() => weztermMuxAdapter.open(exec, { cwd, at: 'pane:float' })).toThrow()
			expect(weztermMuxAdapter.listPanes(exec)).toHaveLength(before)
		})

		// wezterm has `set-tab-title`/`set-window-title` and no pane equivalent, so naming a PANE is a
		// refusal, not a no-op. Proven here against the real CLI surface rather than a stub of it.
		it('rename() refuses at the pane tier, which wezterm genuinely cannot do', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			expect(() => weztermMuxAdapter.rename(exec, { id: base?.id ?? '0' }, 'pane', 'nope')).toThrow(
				/cannot name a pane/,
			)
		})
	})
})
