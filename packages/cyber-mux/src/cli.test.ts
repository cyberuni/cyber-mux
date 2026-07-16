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

		// The regression this fix exists for. `--at pane:*` is documented as placement "relative to the
		// caller", but each backend's own default resolves a DIFFERENT pane, and neither is reliably
		// the caller: tmux splits its session's ACTIVE pane (ignoring $TMUX_PANE), while herdr's
		// `--current` falls back to the UI-FOCUSED pane when it cannot identify the caller. The same
		// command therefore targeted two different panes depending on the backend, silently. Asserting
		// the caller's pane id reaches the argv on BOTH backends is what pins them back together.
		it('--at pane:* splits the CALLING pane on both backends, not whichever pane is focused', async () => {
			const tmuxCalls: string[][] = []
			const tmuxProgram = buildProgram({
				env: { CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%3' },
				exec: fakeTmuxExec(tmuxCalls, { 'split-window': '%9' }),
			})
			await run(tmuxProgram, ['open', '--at', 'pane:right'])
			expect(tmuxCalls[0]).toEqual(['split-window', '-h', '-t', '%3', '-c', process.cwd(), '-P', '-F', '#{pane_id}'])

			const herdrCalls: string[][] = []
			const herdrProgram = buildProgram({
				env: { CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w3:pA' },
				exec: fakeHerdrExec(herdrCalls, {
					'pane split': JSON.stringify({ id: 'cli:pane:split', result: { pane: { pane_id: 'w3:pB' } } }),
				}),
			})
			await run(herdrProgram, ['open', '--at', 'pane:right'])
			expect(herdrCalls[0]).toEqual(['pane', 'split', 'w3:pA', '--direction', 'right', '--cwd', process.cwd()])
			expect(herdrCalls[0]).not.toContain('--current')
		})

		it('--at pane:* with no caller identity still opens, on the backend’s own default', async () => {
			// Degrade, never refuse: an unidentified caller (no pane env at all — a cron job, a shell
			// outside any pane) still gets a pane. The backend's guess is worse than naming the pane
			// but better than failing, and it is the pre-`from` behavior unchanged.
			const calls: string[][] = []
			const program = buildProgram({
				env: { CYBER_MUX: 'tmux' },
				exec: fakeTmuxExec(calls, { 'split-window': '%9' }),
			})
			await run(program, ['open', '--at', 'pane:right'])
			expect(calls[0]).not.toContain('-t')
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

		it('list enumerates every live pane, including one running no agent/harness', async () => {
			const listOut = JSON.stringify({
				result: {
					panes: [
						{ pane_id: 'w3:p1', agent: 'claude', cwd: '/repo/a' },
						{ pane_id: 'w3:p2', cwd: '/repo/b' },
					],
				},
			})
			const exec = fakeHerdrExec([], { 'pane list': listOut })
			const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
			await run(program, ['list'])
			expect(logs.some((l) => l.includes('w3:p1'))).toBe(true)
			expect(logs.some((l) => l.includes('w3:p2'))).toBe(true)
		})

		it('open with no --launch creates a blank pane', async () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-window': '%2' })
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
			await run(program, ['open'])
			expect(calls).toHaveLength(1)
			expect(calls.some((c) => c[0] === 'send-keys')).toBe(false)
		})

		describe('worktree', () => {
			/** git replies keyed by the sub-command word (rev-parse, add, remove); every call is recorded. */
			function fakeGitExec(
				calls: string[][],
				responses: Record<string, string | null> = { 'rev-parse': '/repo/.git' },
			): Exec {
				return (_cmd, args) => {
					calls.push(args)
					const key = args.includes('worktree') ? args[args.indexOf('worktree') + 1]! : args[0]!
					return responses[key] ?? ''
				}
			}

			it('worktree add defaults the path to a sibling of the primary checkout', async () => {
				const calls: string[][] = []
				const exec = fakeGitExec(calls)
				const program = buildProgram({ env: {}, exec })
				await run(program, ['worktree', 'add', '--branch', 'my-feature'])
				expect(calls.at(-1)).toEqual([
					'-C',
					'/repo',
					'worktree',
					'add',
					'-b',
					'my-feature',
					'/repo.worktrees/my-feature',
				])
				expect(logs.join('\n')).toContain('/repo.worktrees/my-feature')
			})

			it('worktree add honors an explicit --path', async () => {
				const calls: string[][] = []
				const exec = fakeGitExec(calls)
				const program = buildProgram({ env: {}, exec })
				await run(program, ['worktree', 'add', '--branch', 'my-feature', '--path', '/elsewhere/x'])
				expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'my-feature', '/elsewhere/x'])
			})

			it('worktree remove refuses the primary checkout', async () => {
				vi.spyOn(process, 'exit').mockImplementation(() => {
					throw new Error('exit')
				})
				const exec = fakeGitExec([])
				const program = buildProgram({ env: {}, exec })
				await expect(run(program, ['worktree', 'remove', '/repo'])).rejects.toThrow()
			})

			it('worktree add opens nothing and needs no multiplexer when given no placement', async () => {
				const calls: string[][] = []
				// env: {} — no backend at all. A bare add must still work; it is a git operation.
				const program = buildProgram({ env: {}, exec: fakeGitExec(calls) })
				await run(program, ['worktree', 'add', '--branch', 'my-feature'])
				expect(calls.every((c) => c.includes('worktree') || c[0] === 'rev-parse')).toBe(true)
				expect(logs.join('\n')).not.toContain('pane')
			})

			it('worktree add passes --base as the branch start-point', async () => {
				const calls: string[][] = []
				const program = buildProgram({ env: {}, exec: fakeGitExec(calls) })
				await run(program, ['worktree', 'add', '--branch', 'b', '--path', '/x', '--base', 'origin/main'])
				expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'b', '/x', 'origin/main'])
			})

			/** herdr replies keyed by the first two args; git is answered on the same fake, by binary. */
			function fakeRepoExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
				return (cmd, args) => {
					calls.push([cmd, ...args])
					if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
					return responses[args.slice(0, 2).join(' ')] ?? ''
				}
			}

			const worktreeOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w9:p1' },
					workspace: { workspace_id: 'w9' },
					worktree: { path: '/repo.worktrees/my-feature', branch: 'my-feature' },
				},
			})

			it('worktree add --at workspace groups the worktree through a backend that binds', async () => {
				const calls: string[][] = []
				const exec = fakeRepoExec(calls, { 'worktree create': worktreeOut })
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
				await run(program, ['worktree', 'add', '--branch', 'my-feature', '--at', 'workspace'])
				expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'create')).toBe(true)
				expect(logs.join('\n')).toContain('w9')
			})

			it('worktree add --launch implies the workspace placement — the only one that can bind', async () => {
				const calls: string[][] = []
				const exec = fakeRepoExec(calls, { 'worktree create': worktreeOut })
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
				await run(program, ['worktree', 'add', '--branch', 'my-feature', '--launch', 'claude'])
				expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'create')).toBe(true)
				expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'run')).toBe(true)
			})

			it('worktree add reports an ungrouped placement on stderr rather than failing', async () => {
				const stderr: string[] = []
				vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
					stderr.push(String(line))
					return true
				})
				const calls: string[][] = []
				const exec = fakeRepoExec(calls, { 'pane split': '{"result":{"pane":{"pane_id":"w3:pB"}}}' })
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
				await run(program, ['worktree', 'add', '--branch', 'my-feature', '--at', 'pane:right'])
				// It succeeded — a worktree in a split pane is a complete outcome...
				expect(calls.some((c) => c[0] === 'git' && c.includes('add'))).toBe(true)
				// ...and the caller is told what the placement cost.
				expect(stderr.join('')).toContain('--at workspace')
			})

			it('worktree open groups an existing checkout', async () => {
				const calls: string[][] = []
				const exec = fakeRepoExec(calls, { 'worktree open': worktreeOut })
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
				await run(program, ['worktree', 'open', '/repo.worktrees/my-feature'])
				expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'open')).toBe(true)
				expect(logs.join('\n')).toContain('w9')
			})

			it('worktree list reports every worktree and the workspace each is open in', async () => {
				const porcelain = [
					'worktree /repo',
					'branch refs/heads/main',
					'',
					'worktree /repo.worktrees/x',
					'branch refs/heads/feat/x',
					'',
				].join('\n')
				const bindings = JSON.stringify({
					result: { worktrees: [{ path: '/repo.worktrees/x', open_workspace_id: 'w21' }] },
				})
				const exec: Exec = (cmd, args) => {
					if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : porcelain
					return args.slice(0, 2).join(' ') === 'worktree list' ? bindings : ''
				}
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
				await run(program, ['worktree', 'list'])
				const out = logs.join('\n')
				expect(out).toContain('main')
				expect(out).toContain('feat/x')
				expect(out).toContain('w21')
			})

			it('worktree list answers outside a multiplexer — listing is a git question', async () => {
				const porcelain = ['worktree /repo', 'branch refs/heads/main', ''].join('\n')
				const exec: Exec = (_cmd, args) => (args[0] === 'rev-parse' ? '/repo/.git' : porcelain)
				const program = buildProgram({ env: {}, exec })
				await run(program, ['worktree', 'list'])
				expect(logs.join('\n')).toContain('main')
			})
		})

		it('open --launch submits the command, so it actually runs', async () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-window': '%2' })
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
			await run(program, ['open', '--launch', 'claude'])
			// Typed literally, then Enter — not left staged unsent.
			expect(calls[1]).toEqual(['send-keys', '-t', '%2', '-l', 'claude'])
			expect(calls[2]).toEqual(['send-keys', '-t', '%2', 'Enter'])
		})

		it('send text types literal text and presses no Enter', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['send', 'text', '%3', 'Up'])
			// The key-named word is typed, not interpreted; no Enter is appended.
			expect(calls).toEqual([['send-keys', '-t', '%3', '-l', 'Up']])
		})

		it('send keys presses core-vocabulary keys and types nothing', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['send', 'keys', '%3', 'Escape', 'Up', 'C-c'])
			expect(calls).toEqual([['send-keys', '-t', '%3', 'Escape', 'Up', 'C-c']])
		})

		it('send keys Enter presses Enter and takes the turn, because the caller asked for it', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['send', 'keys', '%3', 'Enter'])
			expect(calls).toEqual([['send-keys', '-t', '%3', 'Enter']])
		})

		it('send keys with no key tokens is rejected before anything is sent', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await expect(run(program, ['send', 'keys', '%3'])).rejects.toThrow()
			expect(calls).toEqual([])
		})

		it('send text with no text argument is rejected before anything is sent', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await expect(run(program, ['send', 'text', '%3'])).rejects.toThrow()
			expect(calls).toEqual([])
		})

		it('bare send is incomplete input, so it fails loud with help rather than acting', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
			try {
				await expect(run(program, ['send'])).rejects.toMatchObject({ exitCode: 1 })
				const help = stderr.mock.calls.map((c) => String(c[0])).join('')
				expect(help).toContain('text')
				expect(help).toContain('keys')
				expect(stdout).not.toHaveBeenCalled()
			} finally {
				stderr.mockRestore()
				stdout.mockRestore()
			}
			expect(calls).toEqual([])
		})

		it('submit with text types the text and presses Enter, taking the pane’s turn', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['submit', '%3', 'echo hi'])
			expect(calls).toEqual([
				['send-keys', '-t', '%3', '-l', 'echo hi'],
				['send-keys', '-t', '%3', 'Enter'],
			])
		})

		it('submit types its text literally, never interpreting it as a key', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['submit', '%3', 'Up'])
			// Never `send-keys -t %3 Up Enter`, which would recall and re-run the pane's last command.
			expect(calls).not.toContainEqual(['send-keys', '-t', '%3', 'Up', 'Enter'])
			expect(calls[0]).toEqual(['send-keys', '-t', '%3', '-l', 'Up'])
		})

		it('submit with no text presses a bare Enter and retypes nothing', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['submit', '%3'])
			expect(calls).toEqual([['send-keys', '-t', '%3', 'Enter']])
		})

		it('submit with empty text is the bare flush, not a second contract', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['submit', '%3', ''])
			expect(calls).toEqual([['send-keys', '-t', '%3', 'Enter']])
		})

		it('submit with no pane is rejected, naming pane as the missing argument', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await expect(run(program, ['submit'])).rejects.toThrow(/pane/)
			expect(calls).toEqual([])
		})

		it('herdr: send text / send keys / submit map onto herdr’s own three primitives', async () => {
			const calls: string[][] = []
			const env = { CYBER_MUX: 'herdr' }
			await run(buildProgram({ env, exec: fakeHerdrExec(calls) }), ['send', 'text', 'w1:p1', 'hello'])
			await run(buildProgram({ env, exec: fakeHerdrExec(calls) }), ['send', 'keys', 'w1:p1', 'Up'])
			await run(buildProgram({ env, exec: fakeHerdrExec(calls) }), ['submit', 'w1:p1', 'echo hi'])
			await run(buildProgram({ env, exec: fakeHerdrExec(calls) }), ['submit', 'w1:p1'])
			expect(calls).toEqual([
				['pane', 'send-text', 'w1:p1', 'hello'],
				['pane', 'send-keys', 'w1:p1', 'Up'],
				['pane', 'run', 'w1:p1', 'echo hi'],
				['pane', 'send-keys', 'w1:p1', 'Enter'],
			])
		})
	})
})
