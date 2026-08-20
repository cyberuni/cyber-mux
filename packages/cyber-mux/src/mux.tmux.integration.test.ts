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
 * harness only guarantees the first. A float test that assumed 3.7 on an older binary would fail the
 * job while proving nothing about the adapter — `canFloatPanes` is declared unconditionally BY DESIGN
 * (see the `mux.tmux.ts` header) and an older tmux refusing `new-pane` with its own `unknown command`
 * is that contract working, not breaking. So the float rows SKIP below 3.7 rather than fail.
 *
 * The gate is kept even though CI is no longer one of the places it fires: `pull-request.yml` used to
 * install tmux with `apt-get install -y tmux` (Ubuntu's 3.4), which skipped every float row and so
 * covered nothing; it now builds a pinned 3.7c from source, and the step verifies `tmux -V` rather
 * than trusting the build. What the gate still protects is the contributor whose distro tmux is
 * older — for them a skip is the honest report, not a failure.
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
		// `true`. The CREATE path is pinned by the rows below.
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

		// The CREATE side of `pane:float`. Everything below it was written from tmux's CHANGES file
		// against a 3.6b binary that has no `new-pane` at all, so until 3.7 was installable the whole
		// branch rested on a document. These rows are what pays for it.

		it.skipIf(!tmuxHasFloatingPanes())('open({ at: pane:float }) creates a real float the binary reports back', () => {
			const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float' })
			expect(float.id).toMatch(/^%\d+$/)
			// The pane and the window it landed in come back from ONE `new-pane -P -F` — the same format
			// the split path sends, so the float owes no second lookup for its tab.
			expect(float.tab).toMatch(/^@\d+$/)
			expect(tmuxMuxAdapter.paneExists(exec, float)).toBe(true)
			// `teardown` needs no float-specific spelling: `kill-pane` kills a float exactly as it kills a
			// tiled pane.
			tmuxMuxAdapter.teardown(exec, float)
			expect(tmuxMuxAdapter.paneExists(exec, float)).toBe(false)
		})

		// The anchor claim, at the boundary that can actually falsify it: with a mocked Exec `-t %3` only
		// proves we spelled a flag. Live, it decides WHICH WINDOW the float lands in — and the harness is
		// arranged so the two candidate answers differ. Every `at: 'tab'` open above uses `new-window -d`,
		// so the attached client is still looking at the session's first window; the float is anchored on
		// a pane in a different one. Without `-t` tmux resolves the ACTIVE pane's window, which is the
		// user's and only coincidentally the caller's.
		it.skipIf(!tmuxHasFloatingPanes())('a float is anchored into the TARGET pane’s window, not the active one', () => {
			const tiled = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const activeWindow = exec('tmux', ['display-message', '-p', '#{window_id}'])
			// The premise the assertion rests on: the anchor is somewhere the client is NOT looking.
			expect(tiled.tab).not.toBe(activeWindow)
			const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled })
			expect(float.tab).toBe(tiled.tab)
			expect(float.tab).not.toBe(activeWindow)
			tmuxMuxAdapter.teardown(exec, float)
			tmuxMuxAdapter.teardown(exec, tiled)
		})

		// `ratio` is dropped on a float — the observable half of the claim, and it is deliberately paired
		// with the argv-level row in `floating.test.ts` rather than replacing it. What this row can see is
		// that a float asked for a ratio comes out the SIZE of one that asked for nothing, and that the
		// size is `new-pane`'s documented default: half the window's width by a quarter its height.
		//
		// What it CANNOT see is a regression that starts passing `-l`, because `new-pane` accepts `-l`
		// and `-p` and ignores them (see the `mux.tmux.ts` float branch) — a float built with `-l 30%`
		// measures the same as this one. That is exactly why the "no sizing flag is emitted" claim is
		// pinned on the argv and this row is pinned on the geometry: neither check subsumes the other.
		it.skipIf(!tmuxHasFloatingPanes())('a float takes tmux’s own default size, whatever ratio was asked for', () => {
			const tiled = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const size = (pane: { id: string }) =>
				exec('tmux', ['display-message', '-p', '-t', pane.id, '#{pane_width}x#{pane_height}'])
			const plain = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled })
			const asked = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled, ratio: 0.3 })
			expect(size(asked)).toBe(size(plain))
			const [width, height] = (
				exec('tmux', ['display-message', '-p', '-t', tiled.id, '#{window_width}\t#{window_height}']) ?? ''
			)
				.split('\t')
				.map(Number)
			expect(size(plain)).toBe(`${Math.floor(width! / 2)}x${Math.floor(height! / 4)}`)
			tmuxMuxAdapter.teardown(exec, asked)
			tmuxMuxAdapter.teardown(exec, plain)
			tmuxMuxAdapter.teardown(exec, tiled)
		})

		// Recorded rather than defended against, because the failure is the behavior we want. `new-pane`
		// makes the float the ACTIVE pane of the window it landed in, and tmux refuses to split a float
		// ("size or position can't split a floating pane"). So a target-less split issued while the
		// client is looking at that window does not silently split the wrong pane — it fails loudly,
		// through the `withReason` throw `open` already carries. No adapter change; this row is here so
		// the property cannot quietly stop holding.
		//
		// The float is opened with no `from` ON PURPOSE: that is what puts it in the window the client is
		// attached to, which is the only arrangement where a target-less split resolves to it at all. A
		// float anchored elsewhere leaves the active pane untouched, and the split lands where it always
		// did.
		it.skipIf(!tmuxHasFloatingPanes())(
			'a target-less split right after a float fails loudly instead of splitting the wrong pane',
			() => {
				const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float' })
				expect(exec('tmux', ['display-message', '-p', '#{pane_id}'])).toBe(float.id)
				expect(() => tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right' })).toThrow(
					'tmux split-window failed',
				)
				tmuxMuxAdapter.teardown(exec, float)
			},
		)

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
