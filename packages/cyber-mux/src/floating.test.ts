import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.ts'
import type { Exec } from './exec.ts'
import { canFloatPanes, FloatingPanesUnsupportedError } from './floating.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { MuxAdapter } from './mux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { createZellijAdapter, zellijMuxAdapter } from './mux.zellij.ts'

/**
 * The `'pane:float'` placement — the seam's one NON-universal placement, and so the one whose whole
 * story is worth reading in a single file: the two backends that realize it natively, the two that
 * refuse it by name, and the CLI surface of that refusal.
 *
 * Every adapter is driven with a mocked `Exec`, so no multiplexer is required — including tmux 3.7,
 * which is not installed anywhere this suite runs. What is asserted is the ARGV each adapter emits,
 * which is exactly the part a live binary would confirm.
 */

/** tmux replies keyed by the command name (args[0]). */
function fakeTmuxExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[0]!] ?? null
	}
}

/** zellij replies keyed by the verb (args[1]) — every call is `zellij action <verb> …`. */
function fakeZellijExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[1]!] ?? null
	}
}

const ZELLIJ_LIST_ONE = JSON.stringify([
	{ id: 'terminal_9', tab_id: 2, title: 'zsh', terminal_command: 'zsh', is_focused: true },
])

describe('spec:cyber-mux/mux/placement', () => {
	describe('pane:float — the capability declaration', () => {
		// The declaration is what a caller reads BEFORE opening, so the split it encodes is the whole
		// contract: two backends with a native floating pane, two with no such concept at all.
		it.each<{ adapter: MuxAdapter; floats: boolean }>([
			{ adapter: tmuxMuxAdapter, floats: true },
			{ adapter: zellijMuxAdapter, floats: true },
			{ adapter: weztermMuxAdapter, floats: false },
			{ adapter: herdrMuxAdapter, floats: false },
		])('@id:placement-float-declared — $adapter.name declares whether it can open a floating pane', ({
			adapter,
			floats,
		}) => {
			expect(canFloatPanes(adapter)).toBe(floats)
		})

		it('the refusal names the backend it refused', () => {
			const err = new FloatingPanesUnsupportedError('herdr')
			expect(err.backend).toBe('herdr')
			expect(err.name).toBe('FloatingPanesUnsupportedError')
			expect(err.message).toContain('herdr')
		})
	})

	describe('pane:float on tmux — the 3.7 new-pane command', () => {
		it('@id:placement-float-tmux-new-pane', () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-pane': '%9\t@1' })
			const opened = tmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float' })
			// A float lands in a window it did not open — the caller's own, exactly as a split does.
			expect(opened).toEqual({ id: '%9', tab: '@1' })
			expect(calls[0]).toEqual(['new-pane', '-c', '/unit', '-P', '-F', '#{pane_id}\t#{window_id}'])
		})

		it('@id:placement-float-tmux-anchored-and-named — anchored on from with -t', () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-pane': '%9\t@1' })
			tmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float', from: { id: '%3' } })
			expect(calls[0]?.slice(0, 3)).toEqual(['new-pane', '-t', '%3'])
		})

		it('carries env natively — `new-pane` takes -e exactly as split-window does', () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-pane': '%9\t@1' })
			tmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float', env: { A: '1' } })
			expect(calls[0]).toEqual(['new-pane', '-e', 'A=1', '-c', '/unit', '-P', '-F', '#{pane_id}\t#{window_id}'])
			// No launch given, so nothing is submitted — the env rode in on the open itself.
			expect(calls).toHaveLength(1)
		})

		it('@id:placement-float-ratio-dropped', () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-pane': '%9\t@1' })
			tmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float', ratio: 0.25 })
			// tmux is the backend that CAN size a split (`canSizeSplits`), which is what makes this a real
			// claim rather than a restatement: the ratio is dropped because a float has no original pane,
			// not because tmux cannot size.
			//
			// BOTH flags, and this is the whole point of the row. `new-pane` is not missing a sizing flag —
			// `-l` and `-p` are both in its synopsis, identical to `split-window`, and it accepts them and
			// silently ignores them (verified on 3.7c). So the argv is the only place the drop is visible:
			// a float built with `-l 30%` measures exactly like this one, which is why the live row in
			// `mux.tmux.integration.test.ts` cannot stand in for this check.
			expect(calls[0]).not.toContain('-l')
			expect(calls[0]).not.toContain('-p')
		})

		it('@id:placement-float-tmux-anchored-and-named — named by the post-birth rename', () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-pane': '%9\t@1' })
			tmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float', label: 'notes' })
			// `-n` is the WINDOW flag and a float opens no window; `-T` on new-pane is 3.8's, while the
			// floating pane itself is 3.7's — so the label rides `select-pane -T`, which works on both.
			expect(calls[0]).not.toContain('-n')
			expect(calls[1]).toEqual(['select-pane', '-t', '%9', '-T', 'notes'])
		})

		it('never tags a float as a workspace group — it opens no window to tag', () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-pane': '%9\t@1' })
			tmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float', workspaceGroup: 'pool' })
			// Tagging the window the float landed IN would group a space the caller never opened.
			expect(calls.some((c) => c[0] === 'set-option')).toBe(false)
		})
	})

	describe('pane:float on zellij — new-pane --floating', () => {
		it('@id:placement-float-zellij-floating-flag', () => {
			const calls: string[][] = []
			const exec = fakeZellijExec(calls, { 'new-pane': 'terminal_9', 'list-panes': ZELLIJ_LIST_ONE })
			const opened = zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float' })
			expect(opened).toEqual({ id: 'terminal_9', tab: '2' })
			expect(calls[0]).toEqual(['action', 'new-pane', '--floating', '--cwd', '/unit'])
			expect(calls[0]).not.toContain('--direction')
		})

		it('focuses `from` first, so the float lands over the caller’s tab', () => {
			const calls: string[][] = []
			const exec = fakeZellijExec(calls, { 'new-pane': 'terminal_9', 'list-panes': ZELLIJ_LIST_ONE })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float', from: { id: 'terminal_3' } })
			// `new-pane` has no target flag beyond `--tab-id`, so focusing is the only anchor available.
			expect(calls[0]).toEqual(['action', 'focus-pane-id', 'terminal_3'])
			expect(calls[1]).toEqual(['action', 'new-pane', '--floating', '--cwd', '/unit'])
		})

		it('names the float at birth with --name, and reports the ambient session as its workspace', () => {
			const calls: string[][] = []
			const exec = fakeZellijExec(calls, { 'new-pane': 'terminal_9', 'list-panes': ZELLIJ_LIST_ONE })
			const opened = createZellijAdapter({ session: 'my-session' }).open(exec, {
				cwd: '/unit',
				at: 'pane:float',
				label: 'notes',
			})
			expect(calls[0]).toEqual(['action', 'new-pane', '--floating', '--cwd', '/unit', '--name', 'notes'])
			// A float lives in the ambient session as much as any other pane does.
			expect(opened.workspace).toBe('my-session')
		})
	})

	describe('pane:float on a backend with no floating pane — refused by name, never emulated', () => {
		it.each<{ adapter: MuxAdapter }>([
			{ adapter: weztermMuxAdapter },
			{ adapter: herdrMuxAdapter },
		])('@id:placement-float-refused-by-name — $adapter.name refuses before any exec', ({ adapter }) => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return null
			}
			expect(() => adapter.open(exec, { cwd: '/unit', at: 'pane:float' })).toThrow(FloatingPanesUnsupportedError)
			// The refusal costs nothing and opens nothing: no split was substituted, and no command ran.
			expect(calls).toEqual([])
		})

		it.each<{ adapter: MuxAdapter }>([
			{ adapter: weztermMuxAdapter },
			{ adapter: herdrMuxAdapter },
		])('@id:placement-float-refused-by-name — $adapter.name names itself', ({ adapter }) => {
			try {
				adapter.open(() => null, { cwd: '/unit', at: 'pane:float' })
				expect.unreachable('the open must refuse')
			} catch (err) {
				expect((err as FloatingPanesUnsupportedError).backend).toBe(adapter.name)
			}
		})
	})
})

describe('spec:cyber-mux/cli/placement', () => {
	let logs: string[]

	beforeEach(() => {
		logs = []
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			logs.push(line)
		})
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function catchExit() {
		return vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`)
		})
	}

	/** No ancestry available — forces the probe onto the env fast-path, deterministic in CI. */
	const noAncestry: Exec = () => null

	it('@id:placement-at-float-valid-everywhere', async () => {
		const calls: string[][] = []
		const exec = fakeTmuxExec(calls, { 'new-pane': '%9\t@1' })
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
		await program.parseAsync(['open', '--at', 'pane:float'], { from: 'user' })
		expect(calls[0]?.[0]).toBe('new-pane')
	})

	it('@id:placement-at-float-backend-refusal', async () => {
		for (const backend of ['wezterm', 'herdr']) {
			logs.length = 0
			catchExit()
			const program = buildProgram({ env: { CYBER_MUX: backend }, exec: noAncestry })
			await expect(program.parseAsync(['open', '--at', 'pane:float'], { from: 'user' })).rejects.toThrow('exit:1')
			const out = logs.join('\n')
			// A genuine operation failure (exit 1), not a usage error: `pane:float` is legal input here.
			expect(out).toContain('backend-unsupported')
			expect(out).toContain(backend)
			// The fix hint names the two backends that CAN, so the caller is not left guessing.
			expect(out).toContain('tmux')
			expect(out).toContain('zellij')
		}
	})

	it('@id:placement-at-float-backend-refusal — refused before touching the backend', async () => {
		const calls: string[][] = []
		catchExit()
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return null
		}
		const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
		await expect(program.parseAsync(['open', '--at', 'pane:float'], { from: 'user' })).rejects.toThrow('exit:1')
		expect(calls).toEqual([])
	})

	it('@id:placement-at-restricted-values — the choice list is still closed', async () => {
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
		await expect(program.parseAsync(['open', '--at', 'pane:floating'], { from: 'user' })).rejects.toThrow()
	})
})
