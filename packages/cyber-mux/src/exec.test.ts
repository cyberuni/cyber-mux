import { describe, expect, it } from 'vitest'
import { type Exec, nodeExec, withReason } from './exec.ts'

/**
 * `nodeExec` is the one place the seam meets a real process, so it is the one place a fake cannot
 * stand in. These drive actual subprocesses — `node` itself, which is by definition present and is
 * not a multiplexer, so the suite stays hermetic and needs no tmux/herdr (`AGENTS.md`).
 */
const node = process.execPath

describe('spec:cyber-mux/mux', () => {
	describe('nodeExec', () => {
		it('returns trimmed stdout and reports no reason on success', () => {
			expect(nodeExec(node, ['-e', 'console.log("  hi  ")'])).toBe('hi')
			expect(nodeExec.lastError).toBeUndefined()
		})

		it('returns null and records the command’s own stderr when it fails', () => {
			expect(nodeExec(node, ['-e', 'console.error("no space for new pane"); process.exit(1)'])).toBeNull()
			// Verbatim, and trimmed the same way stdout is — the caller reports the backend's words.
			expect(nodeExec.lastError).toBe('no space for new pane')
		})

		it('clears the reason on the next success, so it can never outlive its command', () => {
			// THE regression guard. `exists` and the mux probe run commands that fail ROUTINELY, so a
			// reason left lying around would be attributed to whatever failed next — a confident,
			// plausible, wrong diagnosis, which is the exact failure the reason exists to prevent.
			expect(nodeExec(node, ['-e', 'console.error("stale"); process.exit(1)'])).toBeNull()
			expect(nodeExec.lastError).toBe('stale')

			expect(nodeExec(node, ['-e', 'console.log("fine")'])).toBe('fine')
			expect(nodeExec.lastError).toBeUndefined()

			// And the bare message is what a throw site would now build — never "stale".
			expect(withReason(nodeExec, 'some later unrelated failure')).toBe('some later unrelated failure')
		})

		it('records no reason when the command fails silently', () => {
			expect(nodeExec(node, ['-e', 'console.error("first"); process.exit(1)'])).toBeNull()
			// A failure with nothing on stderr must clear the previous reason rather than keep it, and
			// must not record an empty string — `undefined` is "no reason", `''` would be a reason that
			// renders as a dangling em-dash.
			expect(nodeExec(node, ['-e', 'process.exit(1)'])).toBeNull()
			expect(nodeExec.lastError).toBeUndefined()
		})

		it('returns null without a reason when the command does not exist', () => {
			expect(nodeExec('cyber-mux-no-such-binary', ['--version'])).toBeNull()
			// ENOENT is the runner's failure, not the backend's — there is no backend output to quote.
			expect(nodeExec.lastError).toBeUndefined()
		})
	})

	describe('withReason', () => {
		it('appends the runner’s reason when it has one', () => {
			const exec: Exec = () => null
			exec.lastError = 'no space for new pane'
			expect(withReason(exec, 'tmux split-window failed')).toBe('tmux split-window failed — no space for new pane')
		})

		it('returns the bare message for a runner that cannot say why', () => {
			// Every existing fake in this suite is a plain arrow function that sets nothing. That is the
			// whole point of the optional field: no call site changes and no message moves.
			const exec: Exec = () => null
			expect(withReason(exec, 'tmux split-window failed')).toBe('tmux split-window failed')
		})
	})
})
