import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.ts'
import type { Exec } from './exec.ts'

/** No ancestry available — forces every probe onto the env fast-path/hint, deterministic in CI. */
const noAncestry: Exec = () => null

function run(program: Command, args: string[]) {
	return program.parseAsync(args, { from: 'user' })
}

/** Records every call; tmux replies are keyed by the command name (args[0]). */
function fakeTmuxExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[0]!] ?? null
	}
}

/** Records every call; herdr replies are keyed by the first two args ("pane split", "tab create", …). */
function fakeHerdrExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		const key = args.slice(0, 2).join(' ')
		return responses[key] ?? null
	}
}

describe('spec:cyber-mux/mux', () => {
	describe('cli', () => {
		let logs: string[]

		beforeEach(() => {
			logs = []
			vi.spyOn(console, 'log').mockImplementation((line: string) => {
				logs.push(line)
			})
			// commander writes its own error text to stderr even with exitOverride() — silence it here so
			// the deliberate --at rejection test doesn't spam the runner's real stderr.
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		})

		afterEach(() => {
			vi.restoreAllMocks()
		})

		it('doctor reports the detected mux and prints a pin hint', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%3' }, exec: noAncestry })
			await run(program, ['doctor'])
			const out = logs.join('\n')
			expect(out).toContain('tmux')
			expect(out).toContain('%3')
			expect(out).toContain('backend')
			expect(out).toContain('export CYBER_MUX=tmux CYBER_MUX_PANE=%3')
		})

		it('mode reports the detected session backend', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
			await run(program, ['mode'])
			expect(logs).toEqual(['tmux'])
		})

		it('mode reports none when no backend is selectable', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'none' }, exec: noAncestry })
			await expect(run(program, ['mode'])).resolves.toBeDefined()
			expect(logs).toEqual(['none'])
		})

		it('--at accepts only pane:right, pane:down, tab, and workspace', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
			await expect(run(program, ['open', '--launch', 'claude', '--at', 'bogus'])).rejects.toThrow()
		})

		it('--at chooses where the new pane opens', async () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'split-window': '%5' })
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
			await run(program, ['open', '--launch', 'claude', '--at', 'pane:down'])
			expect(calls[0]?.[0]).toBe('split-window')
			expect(calls[0]?.[1]).toBe('-v') // pane:down maps to a vertical split
		})

		it("--at workspace opens the pane's own VISIBLE space on each backend", async () => {
			const tmuxCalls: string[][] = []
			const tmuxExec = fakeTmuxExec(tmuxCalls, { 'new-window': '%20' })
			const tmuxProgram = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: tmuxExec })
			await run(tmuxProgram, ['open', '--launch', 'claude', '--at', 'workspace'])
			expect(tmuxCalls[0]?.[0]).toBe('new-window') // a visible window, never new-session

			const herdrCalls: string[][] = []
			const createOut = JSON.stringify({
				id: 'cli:workspace:create',
				result: { root_pane: { pane_id: 'w7:p1' }, workspace: { workspace_id: 'w7' } },
			})
			const herdrExec = fakeHerdrExec(herdrCalls, { 'workspace create': createOut })
			const herdrProgram = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec: herdrExec })
			await run(herdrProgram, ['open', '--launch', 'claude', '--at', 'workspace'])
			expect(herdrCalls[0]).toEqual(['workspace', 'create', '--cwd', process.cwd(), '--no-focus'])
		})

		it('--at tab opens a new tab in the current window, never a split pane', async () => {
			const tmuxCalls: string[][] = []
			const tmuxExec = fakeTmuxExec(tmuxCalls, { 'new-window': '%2' })
			const tmuxProgram = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: tmuxExec })
			await run(tmuxProgram, ['open', '--launch', 'claude', '--at', 'tab'])
			expect(tmuxCalls[0]?.[0]).toBe('new-window')
			expect(tmuxCalls.some((c) => c[0] === 'split-window')).toBe(false)

			const herdrCalls: string[][] = []
			const tabOut = JSON.stringify({
				result: { root_pane: { pane_id: 'w3:pT' }, tab: { tab_id: 'w3:t2' }, type: 'tab_created' },
			})
			const herdrExec = fakeHerdrExec(herdrCalls, { 'tab create': tabOut })
			const herdrProgram = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec: herdrExec })
			await run(herdrProgram, ['open', '--launch', 'claude', '--at', 'tab'])
			expect(herdrCalls[0]?.slice(0, 2)).toEqual(['tab', 'create'])
			expect(herdrCalls.some((c) => c[0] === 'pane' && c[1] === 'split')).toBe(false)
		})

		it('the tab placement opens in the background without stealing focus', async () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-window': '%2' })
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
			await run(program, ['open', '--launch', 'claude', '--at', 'tab'])
			expect(calls[0]).toEqual(['new-window', '-d', '-c', process.cwd(), '-P', '-F', '#{pane_id}'])
		})
	})
})
