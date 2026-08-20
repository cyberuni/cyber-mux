import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'

function hasTmux(): boolean {
	try {
		execFileSync('tmux', ['-V'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * Whether the tmux on PATH is new enough to HAVE a floating pane — `new-pane` landed in 3.7, and on
 * anything older it is simply not a command.
 *
 * A second gate on top of `hasTmux()`, because the two questions are genuinely different and the
 * harness only guarantees the first: CI installs tmux with `apt-get install -y tmux`, which is
 * Ubuntu's packaged 3.4. A float test that assumed 3.7 there failed the job while proving nothing
 * about the adapter — `canFloatPanes` is declared unconditionally BY DESIGN (see the `mux.tmux.ts`
 * header) and an older tmux refusing `new-pane` with its own `unknown command` is that contract
 * working, not breaking.
 *
 * So the float rows SKIP below 3.7 rather than fail. Making CI actually cover them means installing a
 * 3.7+ tmux in the workflow, which is a harness change and belongs with issue #113's real-boundary
 * pass over the float CREATE path — not here.
 *
 * Parsed off the leading `<major>.<minor>`, which covers every spelling tmux ships: `3.4`, `3.7c`
 * (the letter is a patch suffix, never a version bump) and `next-3.8`.
 */
function tmuxHasFloatingPanes(): boolean {
	try {
		const version = execFileSync('tmux', ['-V'], { encoding: 'utf8' })
		const parts = /(\d+)\.(\d+)/.exec(version)
		if (!parts) return false
		const major = Number(parts[1])
		const minor = Number(parts[2])
		return major > 3 || (major === 3 && minor >= 7)
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
	describe('tmuxMuxAdapter — real tmux boundary', () => {
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
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right' })
			expect(target.id).toMatch(/^%\d+$/)
			expect(tmuxMuxAdapter.paneExists(exec, target)).toBe(true)
		})

		it('listPanes() sees the real pane, cwd and all', () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const panes = tmuxMuxAdapter.listPanes(exec)
			expect(panes.some((p) => p.id === target.id && p.cwd === cwd)).toBe(true)
		})

		// The READ side of `pane:float`, at the boundary that owns the answer: `#{pane_floating_flag}` is
		// a tmux format variable, so a mocked exec only ever proves we can parse our own fixture. Live on
		// 3.7c it reports `1` for a `new-pane` float and `0` for a tiled pane. Opened both ways in one
		// test on purpose — a suite that only ever saw a float could pass on an adapter hardcoding
		// `true`. (Pinning the float CREATE path itself is issue #113, not this.)
		it.skipIf(!tmuxHasFloatingPanes())('listPanes() tells a real float from a real tiled pane', () => {
			// A window of its own, so the pair is not competing for room with whatever earlier tests left
			// behind, and the float is anchored on the tiled pane rather than on the ambient active one.
			const tiled = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled })
			const panes = tmuxMuxAdapter.listPanes(exec)
			expect(panes.find((p) => p.id === float.id)?.floating).toBe(true)
			expect(panes.find((p) => p.id === tiled.id)?.floating).toBe(false)
			// `list-panes -a` really does enumerate the float alongside the tiled panes — the field would
			// be unreachable if it did not.
			expect(panes.map((p) => p.id)).toEqual(expect.arrayContaining([float.id, tiled.id]))
			tmuxMuxAdapter.teardown(exec, float)
			tmuxMuxAdapter.teardown(exec, tiled)
		})

		it('teardown() actually kills the real pane', () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(tmuxMuxAdapter.paneExists(exec, target)).toBe(true)
			tmuxMuxAdapter.teardown(exec, target)
			expect(tmuxMuxAdapter.paneExists(exec, target)).toBe(false)
		})

		it('submit()/read() actually run a command in and capture from a real pane', async () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			// submit, not sendText: the marker has to RUN, which needs the Enter submit supplies.
			tmuxMuxAdapter.submit(exec, target, 'echo cyber-mux-itest-marker')
			const output = await pollUntil(
				() => tmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('cyber-mux-itest-marker'),
			)
			expect(output).toContain('cyber-mux-itest-marker')
		})

		// The truncation rule against the REAL binary — the one claim that cannot be proven with a mocked
		// Exec, since it rests on what tmux itself does with `-S -(N+1)` (clamping at the top of the
		// history rather than failing, and returning the older rows when they exist).
		it('read({ truncation }) tells a window that dropped rows from one that reached the top', async () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			// Enough rows to overflow the pane's 24-row viewport and push real content into the scrollback —
			// without that, nothing has been omitted from ANY window and `false` is the right answer.
			tmuxMuxAdapter.submit(exec, target, 'i=1; while [ $i -le 60 ]; do echo row-$i; i=$((i+1)); done')
			await pollUntil(
				() => tmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('row-60'),
			)
			// A window that starts 3 rows into the history leaves the rest of that history behind.
			const scoped = tmuxMuxAdapter.read(exec, target, { lines: 3, truncation: true })
			expect(scoped.truncated).toBe(true)
			// The same pane read with a window wider than everything it holds reaches the top of the
			// history, so nothing was omitted — the answer is `false`, not "I did not check".
			const whole = tmuxMuxAdapter.read(exec, target, { lines: 10_000, truncation: true })
			expect(whole.truncated).toBe(false)
			expect(whole.text).toContain('row-1')
			// Unasked stays unanswered, on the real binary too.
			expect(tmuxMuxAdapter.read(exec, target, { lines: 3 }).truncated).toBeUndefined()
		})

		// The unbounded window against the real binary — `-S -` is the escape hatch a truncated capture
		// points at, so it has to actually reach past the viewport that dropped those rows.
		it("read({ lines: 'all' }) captures the whole history a bounded window left behind", async () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			tmuxMuxAdapter.submit(exec, target, 'i=1; while [ $i -le 60 ]; do echo row-$i; i=$((i+1)); done')
			await pollUntil(
				() => tmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('row-60'),
			)
			// The default window is the 24-row viewport: row-1 scrolled off it long ago.
			const viewport = tmuxMuxAdapter.read(exec, target, { truncation: true })
			expect(viewport.truncated).toBe(true)
			expect(viewport.text).not.toContain('row-1\n')
			// `-S -` reaches the start of the history and brings those rows back — and reports itself
			// complete without spending a probe on it.
			const whole = tmuxMuxAdapter.read(exec, target, { lines: 'all', truncation: true })
			expect(whole.text).toContain('row-1\n')
			expect(whole.truncated).toBe(false)
		})
	})
})
