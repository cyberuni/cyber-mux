import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'

function hasTmux(): boolean {
	try {
		execFileSync('tmux', ['-V'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

async function pollUntil(read: () => string, done: (out: string) => boolean, timeoutMs = 2000): Promise<string> {
	const start = Date.now()
	let out = read()
	while (!done(out) && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 50))
		out = read()
	}
	return out
}

// A throwaway, isolated tmux server on its own socket (`-L`) — never the ambient session this
// process (or this very test runner) might itself be running inside.
const SOCKET = `cyber-mux-itest-${process.pid}`

describe.skipIf(!hasTmux())('spec:cyber-mux/mux', () => {
	describe('tmuxSessionAdapter — real tmux boundary', () => {
		let cwd: string
		let exec: Exec

		beforeAll(() => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-itest-'))
			execFileSync('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'main', '-c', cwd])
			// Reproduce the $TMUX env var a real caller running inside this session would carry, so the
			// adapter's target-less commands (split-window, new-window, …) resolve "current" correctly.
			const [socketPath, pid, sessionId] = execFileSync(
				'tmux',
				['-L', SOCKET, 'display-message', '-p', '-t', 'main', '#{socket_path},#{pid},#{session_id}'],
				{ encoding: 'utf8' },
			)
				.trim()
				.split(',')
			const env = { ...process.env, TMUX: `${socketPath},${pid},${sessionId?.replace(/^\$/, '')}` }
			exec = (cmd, args) => {
				try {
					const fullArgs = cmd === 'tmux' ? ['-L', SOCKET, ...args] : args
					return execFileSync(cmd, fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim()
				} catch {
					return null
				}
			}
		})

		afterAll(() => {
			try {
				execFileSync('tmux', ['-L', SOCKET, 'kill-server'])
			} catch {
				// already gone
			}
			rmSync(cwd, { recursive: true, force: true })
		})

		it('open() actually creates a real pane the real tmux binary reports back', () => {
			const target = tmuxSessionAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right' })
			expect(target.id).toMatch(/^%\d+$/)
			expect(tmuxSessionAdapter.paneExists(exec, target)).toBe(true)
		})

		it('listPanes() sees the real pane, cwd and all', () => {
			const target = tmuxSessionAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const panes = tmuxSessionAdapter.listPanes(exec)
			expect(panes.some((p) => p.id === target.id && p.cwd === cwd)).toBe(true)
		})

		it('teardown() actually kills the real pane', () => {
			const target = tmuxSessionAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(tmuxSessionAdapter.paneExists(exec, target)).toBe(true)
			tmuxSessionAdapter.teardown(exec, target)
			expect(tmuxSessionAdapter.paneExists(exec, target)).toBe(false)
		})

		it('send()/read() actually type into and capture from a real pane', async () => {
			const target = tmuxSessionAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			tmuxSessionAdapter.send(exec, target, 'echo cyber-mux-itest-marker')
			const output = await pollUntil(
				() => tmuxSessionAdapter.read(exec, target),
				(out) => out.includes('cyber-mux-itest-marker'),
			)
			expect(output).toContain('cyber-mux-itest-marker')
		})
	})
})
