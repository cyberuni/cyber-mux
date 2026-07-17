import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.ts'
import type { Exec } from './exec.ts'
import type { LayoutStore } from './layout-store.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'

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

/** `output()` reads the real process.argv to pick a format, so a json test must supply one. */
async function withArgv<T>(argv: string[], fn: () => Promise<T>): Promise<T> {
	const original = process.argv
	process.argv = ['node', 'cyber-mux', ...argv]
	try {
		return await fn()
	} finally {
		process.argv = original
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

		// Nothing is looked up to answer this: the backend said so when the pane was born and the seam
		// carries it, so a report that omitted it would be discarding a fact already in hand. That is
		// what makes a caller able to group the panes it holds by the space they occupy.
		it('open reports the workspace alongside the pane it opened', async () => {
			const calls: string[][] = []
			// CYBER_MUX pins the fast-path, so no ancestry walk pollutes the call count below.
			const program = buildProgram({
				env: { CYBER_MUX: 'herdr', HERDR_ENV: '1' },
				exec: fakeHerdrExec(calls, {
					'workspace create': JSON.stringify({
						result: { root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1', workspace_id: 'w7' } },
					}),
				}),
			})
			await withArgv(['open', '--at', 'workspace', '--format', 'json'], () =>
				run(program, ['open', '--at', 'workspace', '--format', 'json']),
			)
			expect(JSON.parse(logs.join('\n'))).toEqual({ pane: 'w7:p1', workspace: 'w7' })
			// The report is free: opening the pane is the ONLY backend call — the workspace rode in on it,
			// with no `pane get`/`workspace list` follow-up to resolve it.
			expect(calls).toHaveLength(1)
			expect(calls[0]?.slice(0, 2)).toEqual(['workspace', 'create'])
		})

		// tmux has no workspace tier, so there is nothing to report. `null` is absent's spelling at the
		// machine-readable boundary — the key is present so a consumer never has to guess whether the
		// field was omitted or the backend said nothing.
		it('open reports a null workspace on a backend with no workspace tier', async () => {
			const program = buildProgram({
				env: { TMUX: '/tmp/tmux-1000/default,1,0' },
				exec: fakeTmuxExec([], { 'new-window': '%20' }),
			})
			await withArgv(['open', '--at', 'workspace', '--format', 'json'], () =>
				run(program, ['open', '--at', 'workspace', '--format', 'json']),
			)
			expect(JSON.parse(logs.join('\n'))).toEqual({ pane: '%20', workspace: null })
		})

		// Text is human-facing, so an absent workspace prints nothing rather than a bare "null" line.
		it('open’s text report omits the workspace line where the backend has none', async () => {
			const program = buildProgram({
				env: { TMUX: '/tmp/tmux-1000/default,1,0' },
				exec: fakeTmuxExec([], { 'new-window': '%20' }),
			})
			await run(program, ['open', '--at', 'workspace'])
			const out = logs.join('\n')
			expect(out).toContain('%20')
			expect(out).not.toContain('workspace')
			expect(out).not.toContain('null')
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

			it('a bare worktree add opens nothing, so there is nothing to group', async () => {
				const calls: string[][] = []
				// env: {} — no backend at all. A bare add must still work; it is a git operation.
				const program = buildProgram({ env: {}, exec: fakeGitExec(calls) })
				await run(program, ['worktree', 'add', '--branch', 'my-feature'])
				expect(calls.every((c) => c.includes('worktree') || c[0] === 'rev-parse')).toBe(true)
				// Reports NEITHER a pane nor a workspace — with nothing opened there is nothing to group,
				// so a workspace line would be claiming a binding that was never made.
				expect(logs.join('\n')).not.toContain('pane')
				expect(logs.join('\n')).not.toContain('workspace')
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

			it('worktree add --launch defaults the placement to workspace', async () => {
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

		it('send keys with no key tokens is rejected', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await expect(run(program, ['send', 'keys', '%3'])).rejects.toThrow()
			expect(calls).toEqual([])
		})

		it('send text with no text argument is rejected', async () => {
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

		// Both Examples rows fold under one static title — the outline is a single key, and a
		// tmux-only body would claim the herdr row it never runs.
		it.each([
			{
				backend: 'tmux',
				pane: '%3',
				makeExec: fakeTmuxExec,
				// tmux has no atomic primitive: type literally, then press Enter.
				expected: [
					['send-keys', '-t', '%3', '-l', 'echo hi'],
					['send-keys', '-t', '%3', 'Enter'],
				],
			},
			{
				backend: 'herdr',
				pane: 'w1:p1',
				makeExec: fakeHerdrExec,
				// `pane run` IS herdr's atomic text-plus-Enter primitive.
				expected: [['pane', 'run', 'w1:p1', 'echo hi']],
			},
		])("submit with text types the text and presses Enter, taking the pane's turn", async ({
			backend,
			pane,
			makeExec,
			expected,
		}) => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: backend }, exec: makeExec(calls) })
			await run(program, ['submit', pane, 'echo hi'])
			expect(calls).toEqual(expected)
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

		it('submit with no pane is rejected', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await expect(run(program, ['submit'])).rejects.toThrow(/pane/)
			expect(calls).toEqual([])
		})

		describe('layout', () => {
			const REPO_DIR = '/repo/.cyber-mux/layouts'
			const USER_DIR = '/home/u/.config/cyber-mux/layouts'
			/** Pinned, so the user directory is never the runner's real ~/.config. */
			const XDG = { XDG_CONFIG_HOME: '/home/u/.config' }

			const POOL_4 = { name: 'pool-4', arrange: 'tiled', panes: [{ label: 'w1' }, { label: 'w2' }] }
			const AGENT_POOL_3 = {
				name: 'agent-pool-3',
				root: {
					type: 'split',
					direction: 'right',
					ratio: 0.5,
					first: { type: 'pane', label: 'planner', command: 'claude' },
					second: {
						type: 'split',
						direction: 'down',
						ratio: 0.5,
						first: { type: 'pane', label: 'worker-a', command: 'claude' },
						second: { type: 'pane', label: 'worker-b', command: 'claude' },
					},
				},
			}

			/** A `LayoutStore` over an in-memory file map — no templates on disk, ever. */
			function fakeStore(
				files: Record<string, unknown>,
			): LayoutStore & { reads: string[]; writes: Record<string, string> } {
				const raw: Record<string, string> = {}
				for (const [path, body] of Object.entries(files)) {
					raw[path] = typeof body === 'string' ? body : JSON.stringify(body)
				}
				const reads: string[] = []
				const writes: Record<string, string> = {}
				return {
					reads,
					writes,
					read(path) {
						reads.push(path)
						return raw[path] ?? null
					},
					list(dir) {
						return Object.keys(raw)
							.filter((p) => p.startsWith(`${dir}/`))
							.map((p) => p.slice(dir.length + 1, -'.json'.length))
							.sort()
					},
					dirExists: () => true,
					// Writes land in `raw` too, so a `save` followed by a `read` sees the file — which is what
					// makes the overwrite guard testable without a real filesystem.
					write(path, contents) {
						writes[path] = contents
						raw[path] = contents
					},
				}
			}

			function repo(name: string): string {
				return `${REPO_DIR}/${name}.json`
			}
			function user(name: string): string {
				return `${USER_DIR}/${name}.json`
			}

			/** git (rev-parse + worktree) and tmux on one fake, each call recorded as [cmd, ...args]. */
			function repoExec(calls: string[][], responses: Record<string, string> = {}): Exec {
				let n = 0
				return (cmd, args) => {
					calls.push([cmd, ...args])
					if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
					if (cmd === 'tmux') {
						return args[0] === 'new-window' || args[0] === 'split-window' ? `%${n++}` : ''
					}
					const key = args.slice(0, 2).join(' ')
					if (key === 'pane split') return JSON.stringify({ result: { pane: { pane_id: `w9:p${n++}` } } })
					return responses[key] ?? ''
				}
			}

			/** `fail()` exits the process; make that observable instead of fatal to the runner. */
			function catchExit() {
				return vi.spyOn(process, 'exit').mockImplementation((code) => {
					throw new Error(`exit:${code}`)
				})
			}

			/** Capture stderr rather than swallowing it, for the tests that assert on an error's text. */
			function captureStderr(): string[] {
				const lines: string[] = []
				vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
					lines.push(String(line))
					return true
				})
				return lines
			}

			describe('resolving a template by name', () => {
				it('--file skips resolution entirely — neither layouts directory is consulted', async () => {
					const store = fakeStore({ './scratch/pool.json': { name: 'pool', panes: [{ label: 'a' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'show', '--file', './scratch/pool.json'])
					expect(store.reads).toEqual(['./scratch/pool.json'])
					expect(logs.join('\n')).toContain('"name": "pool"')
				})

				it('a repo template shadows a user template of the same name', async () => {
					const store = fakeStore({
						[repo('pool-4')]: POOL_4,
						[user('pool-4')]: { name: 'pool-4', panes: [{ label: 'mine-only' }] },
					})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'show', 'pool-4'])
					// The repo's answer is the one shown — a personal template must not silently displace it.
					expect(logs.join('\n')).toContain('"w1"')
					expect(logs.join('\n')).not.toContain('mine-only')
				})

				it('layout list reports the user template a repo template shadows', async () => {
					const store = fakeStore({ [repo('pool-4')]: POOL_4, [user('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'list'])
					const rows = logs.join('\n').split('\n')
					expect(rows.some((r) => r.includes('pool-4') && r.includes('repo') && !r.includes('yes'))).toBe(true)
					expect(rows.some((r) => r.includes('pool-4') && r.includes('user') && r.includes('yes'))).toBe(true)
				})

				it('a user template resolves when the repo has none of that name, and lists as user', async () => {
					const store = fakeStore({ [user('scratch')]: { name: 'scratch', panes: [{ label: 'a' }, { label: 'b' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'show', 'scratch'])
					expect(logs.join('\n')).toContain('"name": "scratch"')

					logs.length = 0
					await run(buildProgram({ env: XDG, exec: repoExec([]), store }), ['layout', 'list'])
					expect(logs.join('\n')).toMatch(/scratch\s+user/)
				})

				it('the repo layouts directory resolves through the primary checkout, not the caller’s cwd', async () => {
					// The template exists ONLY under the primary checkout — which is exactly the case of a
					// worktree whose branch predates it. Reading ./.cyber-mux would report not-found here.
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'show', 'pool-4'])
					expect(store.reads).toEqual([repo('pool-4')])
				})

				it('a name that resolves nowhere exits 1 naming both directories it searched', async () => {
					catchExit()
					const stderr = captureStderr()
					const program = buildProgram({ env: XDG, exec: repoExec([]), store: fakeStore({}) })
					await expect(run(program, ['layout', 'show', 'pool-9'])).rejects.toThrow('exit:1')
					expect(stderr.join('')).toContain(REPO_DIR)
					expect(stderr.join('')).toContain(USER_DIR)
				})

				// Two roads to the same exit-1: the stem rule refuses most of these, while `-pool` never
				// reaches it — commander rejects it as an unknown option first. Both exit 1 having read
				// nothing, which is the property that matters: a name is a lookup key, never a path.
				it.each([
					'../../../etc/pwd',
					'pool/../../out',
					'Pool-4',
					'-pool',
					'pool_4',
				])('refuses the name "%s" before any file is read', async (name) => {
					catchExit()
					const store = fakeStore({})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					const failure = await run(program, ['layout', 'show', name]).catch((err: unknown) => err)
					expect(failure).toBeInstanceOf(Error)
					// `fail()` exits 1; commander's own rejection carries exitCode 1.
					const code = (failure as { exitCode?: number }).exitCode ?? (failure as Error).message
					expect([1, 'exit:1']).toContain(code)
					expect(store.reads).toEqual([])
				})

				it('a name field that disagrees with the filename stem fails validation, naming both', async () => {
					// The redundancy is the point: a copied file that kept its old name fails loudly.
					catchExit()
					const stderr = captureStderr()
					const store = fakeStore({ [repo('pool-4')]: { name: 'pool-3', panes: [{ label: 'w1' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['layout', 'validate', 'pool-4'])).rejects.toThrow('exit:1')
					expect(stderr.join('')).toContain('pool-4')
					expect(stderr.join('')).toContain('pool-3')
				})
			})

			describe('validate', () => {
				it('a template that sets cwd fails, naming the JSON path, --cwd and dir', async () => {
					catchExit()
					const stderr = captureStderr()
					const store = fakeStore({
						[repo('bad-pool')]: {
							name: 'bad-pool',
							root: {
								type: 'split',
								direction: 'right',
								first: { type: 'pane', label: 'a', cwd: '/home/someone/proj' },
								second: { type: 'pane', label: 'b' },
							},
						},
					})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['layout', 'validate', 'bad-pool'])).rejects.toThrow('exit:1')
					expect(stderr.join('')).toContain('root.first.cwd')
					expect(stderr.join('')).toContain('--cwd')
					expect(stderr.join('')).toContain('dir')
				})

				it('reports every error at once, one per line, each naming its own JSON path', async () => {
					catchExit()
					const stderr = captureStderr()
					const store = fakeStore({
						[repo('bad-pool')]: {
							name: 'bad-pool',
							root: {
								type: 'split',
								direction: 'right',
								ratio: 0,
								first: { type: 'pane', label: 'dup', cwd: '/home/someone/proj' },
								second: { type: 'pane', label: 'dup' },
							},
						},
					})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['layout', 'validate', 'bad-pool'])).rejects.toThrow('exit:1')
					const lines = stderr.join('').trim().split('\n')
					expect(lines).toHaveLength(3)
					expect(lines.some((l) => l.includes('root.ratio'))).toBe(true)
					expect(lines.some((l) => l.includes('root.first.cwd'))).toBe(true)
					expect(lines.some((l) => l.includes('label "dup"'))).toBe(true)
				})

				it('exits 0 on a valid template, saying nothing at all', async () => {
					// This is the CI hook, so silence is the pass signal.
					const exit = catchExit()
					const stderr = captureStderr()
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'validate', 'pool-4'])
					expect(exit).not.toHaveBeenCalled()
					expect(stderr).toEqual([])
				})
			})

			describe('show --desugar', () => {
				it('prints exactly the tree apply will build', async () => {
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'show', 'pool-4', '--desugar'])
					// The canonical tree the sugar expands to — one right split over the two panes, which is
					// the same tree the walk splits from (both go through `resolveTree`).
					expect(JSON.parse(logs.join('\n'))).toEqual({
						type: 'split',
						direction: 'right',
						ratio: 0.5,
						first: { type: 'pane', label: 'w1' },
						second: { type: 'pane', label: 'w2' },
					})
				})

				it('without --desugar prints the template as written, sugar and all', async () => {
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['layout', 'show', 'pool-4'])
					expect(JSON.parse(logs.join('\n'))).toEqual(POOL_4)
				})
			})

			describe('managing templates needs no multiplexer', () => {
				it.each([
					['list', ['layout', 'list']],
					['show pool-4', ['layout', 'show', 'pool-4']],
					['validate pool-4', ['layout', 'validate', 'pool-4']],
				])('%s answers without resolving a session backend', async (_name, argv) => {
					// Their subject is a FILE, the same way `worktree list`'s subject is git.
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					// No $TMUX, no $HERDR_ENV, no override at all.
					const program = buildProgram({ env: XDG, exec: repoExec(calls), store })
					await run(program, argv)
					expect(calls.every((c) => c[0] === 'git')).toBe(true)
				})
			})

			describe('--layout, the exact sibling of --launch', () => {
				it('--layout and --launch are mutually exclusive', async () => {
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
					await expect(run(program, ['open', '--layout', 'pool-4', '--launch', 'claude'])).rejects.toThrow()
				})

				it('--at defaults to workspace when --layout is given', async () => {
					// A fresh space is empty by construction.
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await run(program, ['open', '--layout', 'pool-4'])
					// tmux collapses workspace to a window — the region is a new-window, not a split.
					expect(calls.find((c) => c[0] === 'tmux')?.[1]).toBe('new-window')
				})

				it('--label defaults to the template name', async () => {
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await run(program, ['open', '--layout', 'pool-4'])
					expect(calls.find((c) => c[1] === 'new-window')).toEqual(expect.arrayContaining(['-n', 'pool-4']))
				})

				it('an explicit --label wins over the template name', async () => {
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await run(program, ['open', '--layout', 'pool-4', '--label', 'my-pool'])
					expect(calls.find((c) => c[1] === 'new-window')).toEqual(expect.arrayContaining(['-n', 'my-pool']))
				})
			})

			describe('resolution precedes side effects', () => {
				it('open --layout with an unresolvable name opens nothing', async () => {
					catchExit()
					const calls: string[][] = []
					const program = buildProgram({
						env: { ...XDG, CYBER_MUX: 'tmux' },
						exec: repoExec(calls),
						store: fakeStore({}),
					})
					await expect(run(program, ['open', '--layout', 'pool-9'])).rejects.toThrow('exit:1')
					expect(calls.some((c) => c[0] === 'tmux')).toBe(false)
				})

				it('worktree add --layout with a name that resolves nowhere leaves no worktree behind', async () => {
					catchExit()
					const calls: string[][] = []
					const program = buildProgram({
						env: { ...XDG, CYBER_MUX: 'tmux' },
						exec: repoExec(calls),
						store: fakeStore({}),
					})
					await expect(run(program, ['worktree', 'add', '--branch', 'feat-x', '--layout', 'pool-9'])).rejects.toThrow(
						'exit:1',
					)
					expect(calls.some((c) => c.includes('worktree') && c.includes('add'))).toBe(false)
				})

				it('worktree add --layout with an invalid template leaves no worktree behind', async () => {
					catchExit()
					const stderr = captureStderr()
					const calls: string[][] = []
					const store = fakeStore({
						[repo('bad-pool')]: { name: 'bad-pool', panes: [{ label: 'a', cwd: '/home/someone/proj' }] },
					})
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await expect(run(program, ['worktree', 'add', '--branch', 'feat-x', '--layout', 'bad-pool'])).rejects.toThrow(
						'exit:1',
					)
					expect(stderr.join('')).toContain('panes[0].cwd')
					expect(calls.some((c) => c.includes('worktree') && c.includes('add'))).toBe(false)
				})

				it('applying with no multiplexer fails through the existing adapter path', async () => {
					catchExit()
					const stderr = captureStderr()
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					// Neither $TMUX nor $HERDR_ENV — the template resolves and validates, then the backend does not.
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['open', '--layout', 'pool-4'])).rejects.toThrow('exit:1')
					expect(stderr.join('')).toContain('tmux')
					expect(stderr.join('')).toContain('herdr')
				})
			})

			describe('apply does not roll back', () => {
				it('a throw mid-walk reports what was built, exits 1, and kills nothing', async () => {
					catchExit()
					const calls: string[][] = []
					// A 4-pane comb: the region, then three splits. The THIRD split is refused.
					let splits = 0
					const exec: Exec = (cmd, args) => {
						calls.push([cmd, ...args])
						if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
						if (args[0] === 'new-window') return '%0'
						if (args[0] === 'split-window') return ++splits === 3 ? null : `%${splits}`
						return ''
					}
					const store = fakeStore({
						[repo('render-farm')]: {
							name: 'render-farm',
							arrange: 'even-horizontal',
							panes: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
						},
					})
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec, store })
					await withArgv(['open', '--layout', 'render-farm', '--format', 'json'], async () => {
						await expect(run(program, ['open', '--layout', 'render-farm', '--format', 'json'])).rejects.toThrow(
							'exit:1',
						)
					})
					// The manifest still reports the panes that were built before the failure...
					const manifest = JSON.parse(logs.join('\n'))
					expect(manifest.panes.map((p: { label: string }) => p.label)).toEqual(['a', 'b', 'c'])
					// ...and nothing is killed: a kill is not obviously safer than a half-built layout the
					// caller can see and finish.
					expect(calls.some((c) => c[1] === 'kill-pane')).toBe(false)
				})
			})

			describe('the manifest is the handoff', () => {
				it('--format json reports every pane apply created', async () => {
					const store = fakeStore({ [repo('agent-pool-3')]: AGENT_POOL_3 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
					await withArgv(['open', '--layout', 'agent-pool-3', '--format', 'json'], () =>
						run(program, ['open', '--layout', 'agent-pool-3', '--cwd', '/w/feat-x', '--format', 'json']),
					)
					const manifest = JSON.parse(logs.join('\n'))
					expect(manifest.layout).toBe('agent-pool-3')
					expect(manifest.cwd).toBe('/w/feat-x')
					expect(manifest).toHaveProperty('workspace')
					// One entry per pane, each carrying its label, pane id, dir and command.
					expect(manifest.panes).toEqual([
						{ label: 'planner', pane: '%0', dir: '/w/feat-x', command: 'claude' },
						{ label: 'worker-a', pane: '%1', dir: '/w/feat-x', command: 'claude' },
						{ label: 'worker-b', pane: '%2', dir: '/w/feat-x', command: 'claude' },
					])
				})

				it('the manifest’s workspace is null on tmux', async () => {
					// Matching how reportOpenedWorktree already reports it.
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
					await withArgv(['open', '--layout', 'pool-4', '--format', 'json'], () =>
						run(program, ['open', '--layout', 'pool-4', '--format', 'json']),
					)
					expect(JSON.parse(logs.join('\n')).workspace).toBeNull()
				})
			})

			describe('worktree add --layout', () => {
				const worktreeOut = JSON.stringify({
					result: {
						root_pane: { pane_id: 'w9:root' },
						workspace: { workspace_id: 'w9' },
						worktree: { path: '/repo.worktrees/feat-x', branch: 'feat-x' },
					},
				})

				it('applies the template against the worktree root, reporting the manifest alongside root and branch', async () => {
					const calls: string[][] = []
					const store = fakeStore({ [repo('agent-pool-3')]: AGENT_POOL_3 })
					const exec = repoExec(calls, { 'worktree create': worktreeOut })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'herdr' }, exec, store })
					await withArgv(['worktree', 'add', '--format', 'json'], () =>
						run(program, ['worktree', 'add', '--branch', 'feat-x', '--layout', 'agent-pool-3', '--format', 'json']),
					)
					const created = calls.find((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'create')!
					expect(created).toBeDefined()
					// The workspace opens with NO launch: the template owns what runs, and its root pane
					// becomes the tree's root region rather than a pane to close.
					expect(created).not.toContain('--launch')
					const splits = calls.filter((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'split')
					expect(splits).toHaveLength(2)
					// The walk's cwd is the worktree root...
					for (const split of splits) expect(split[split.indexOf('--cwd') + 1]).toBe('/repo.worktrees/feat-x')
					// ...and the first split targets the workspace's own root pane.
					expect(splits[0]).toContain('w9:root')

					const out = JSON.parse(logs.join('\n'))
					expect(out.root).toBe('/repo.worktrees/feat-x')
					expect(out.branch).toBe('feat-x')
					expect(out.layout).toBe('agent-pool-3')
					expect(out.workspace).toBe('w9')
					expect(out.panes.map((p: { label: string }) => p.label)).toEqual(['planner', 'worker-a', 'worker-b'])
				})

				it('honors the root pane’s env by prefixing its command — herdr’s worktree create takes no env', async () => {
					// The tree's root pane is the workspace's root pane, and no split ever births it. herdr's
					// `worktree create` has no `env` param and rejects the flag, so the env rides on the
					// command line instead (design §7.3 Gap C's first real customer).
					const calls: string[][] = []
					const store = fakeStore({
						[repo('render-farm')]: {
							name: 'render-farm',
							root: {
								type: 'split',
								direction: 'right',
								first: { type: 'pane', label: 'dispatcher', env: { TIER: 'gpu' }, command: 'render' },
								second: { type: 'pane', label: 'encoder', env: { TIER: 'cpu' }, command: 'encode' },
							},
						},
					})
					const exec = repoExec(calls, { 'worktree create': worktreeOut })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'herdr' }, exec, store })
					await run(program, ['worktree', 'add', '--branch', 'feat-x', '--layout', 'render-farm'])

					// The flag is never emitted — that would throw on a live herdr.
					const created = calls.find((c) => c[1] === 'worktree' && c[2] === 'create')!
					expect(created).not.toContain('--env')
					// The root pane's env reaches it via the prefix on its own command.
					const rootRun = calls.find((c) => c[1] === 'pane' && c[2] === 'run' && c[3] === 'w9:root')!
					expect(rootRun[4]).toBe("env TIER='gpu' render")
					// The split-born pane still gets its env NATIVELY, and is never prefixed on top of it.
					expect(calls.find((c) => c[1] === 'pane' && c[2] === 'split')!.join(' ')).toContain('--env TIER=cpu')
					const childRun = calls.find((c) => c[1] === 'pane' && c[2] === 'run' && c[3] !== 'w9:root')!
					expect(childRun[4]).toBe('encode')
				})

				it('warns once when the root pane has env but no command to carry it', async () => {
					const stderr = captureStderr()
					const calls: string[][] = []
					const store = fakeStore({
						[repo('render-farm')]: {
							name: 'render-farm',
							panes: [{ label: 'dispatcher', env: { TIER: 'gpu' } }, { label: 'encoder' }],
						},
					})
					const exec = repoExec(calls, { 'worktree create': worktreeOut })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'herdr' }, exec, store })
					await run(program, ['worktree', 'add', '--branch', 'feat-x', '--layout', 'render-farm'])
					// Nothing to prefix, so nothing is run — and the loss is reported rather than silent.
					expect(calls.some((c) => c[1] === 'pane' && c[2] === 'run')).toBe(false)
					const warnings = stderr.filter((line) => line.includes('dispatcher'))
					expect(warnings).toHaveLength(1)
					expect(warnings[0]).toContain('TIER')
				})

				it('reports the root pane’s actual dir and warns that its dir could not be honored', async () => {
					const stderr = captureStderr()
					const calls: string[][] = []
					const store = fakeStore({
						[repo('render-farm')]: {
							name: 'render-farm',
							panes: [{ label: 'dispatcher', dir: 'apps/render' }, { label: 'encoder' }],
						},
					})
					const exec = repoExec(calls, { 'worktree create': worktreeOut })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'herdr' }, exec, store })
					await withArgv(['worktree', 'add', '--format', 'json'], () =>
						run(program, ['worktree', 'add', '--branch', 'feat-x', '--layout', 'render-farm', '--format', 'json']),
					)
					// The workspace opens at the worktree root — that is what the binding pins...
					const created = calls.find((c) => c[1] === 'worktree' && c[2] === 'create')!
					expect(created).not.toContain('apps/render')
					// ...so the manifest reports where the pane really is, rather than a place nothing opened.
					const out = JSON.parse(logs.join('\n'))
					expect(out.panes[0]).toEqual({
						label: 'dispatcher',
						pane: 'w9:root',
						dir: '/repo.worktrees/feat-x',
						command: null,
					})
					// Degraded loudly, on stderr, so stdout stays machine-readable.
					expect(stderr.join('')).toContain('dispatcher')
					expect(stderr.join('')).toContain('apps/render')
				})
			})
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

describe('spec:cyber-mux/layout', () => {
	const REPO_DIR = '/repo/.cyber-mux/layouts'
	const USER_DIR = '/home/u/.config/cyber-mux/layouts'
	/** Pinned, so the user directory is never the runner's real ~/.config. */
	const XDG = { XDG_CONFIG_HOME: '/home/u/.config' }

	const POOL_4 = { name: 'pool-4', arrange: 'tiled', panes: [{ label: 'w1' }, { label: 'w2' }] }

	/** A `LayoutStore` over an in-memory file map — no templates on disk, ever. */
	function fakeStore(
		files: Record<string, unknown>,
	): LayoutStore & { reads: string[]; writes: Record<string, string> } {
		const raw: Record<string, string> = {}
		for (const [path, body] of Object.entries(files)) {
			raw[path] = typeof body === 'string' ? body : JSON.stringify(body)
		}
		const reads: string[] = []
		const writes: Record<string, string> = {}
		return {
			reads,
			writes,
			read(path) {
				reads.push(path)
				return raw[path] ?? null
			},
			list(dir) {
				return Object.keys(raw)
					.filter((p) => p.startsWith(`${dir}/`))
					.map((p) => p.slice(dir.length + 1, -'.json'.length))
					.sort()
			},
			dirExists: () => true,
			write(path, contents) {
				writes[path] = contents
				raw[path] = contents
			},
		}
	}

	function repo(name: string): string {
		return `${REPO_DIR}/${name}.json`
	}
	function user(name: string): string {
		return `${USER_DIR}/${name}.json`
	}

	/** `fail()` exits the process; make that observable instead of fatal to the runner. */
	function catchExit() {
		return vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`)
		})
	}

	/** Capture stderr rather than swallowing it, for the tests that assert on an error's text. */
	function captureStderr(): string[] {
		const lines: string[] = []
		vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
			lines.push(String(line))
			return true
		})
		return lines
	}

	let logs: string[]

	beforeEach(() => {
		logs = []
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			logs.push(line)
		})
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('layout save', () => {
		/**
		 * tmux, plus a region of three panes around `%1` — a live capture from tmux 3.6b, so the
		 * divider column that makes the ratio arithmetic interesting is really there.
		 */
		function saveExec(calls: string[][], panes?: string): Exec {
			return (cmd, args) => {
				calls.push([cmd, ...args])
				if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
				if (args[0] === 'list-panes') {
					return (
						panes ??
						[
							'%0\t0\t0\t119\t34\t/repo\tzeta\tzeta',
							'%2\t0\t35\t119\t15\t/repo/api\twatcher\tzeta',
							'%1\t120\t0\t80\t50\t/repo\teditor\tzeta',
						].join('\n')
					)
				}
				return ''
			}
		}

		const SAVE_ENV = { ...XDG, CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%0' }

		it('save writes to the repo layouts directory and prints the path', async () => {
			const calls: string[][] = []
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
			await run(program, ['layout', 'save', 'pool-3'])
			// The path is stdout's whole content, so `$(cyber-mux layout save x)` composes.
			expect(logs).toEqual([repo('pool-3')])
			const written = JSON.parse(store.writes[repo('pool-3')]!)
			expect(written.name).toBe('pool-3')
			// The geometry survives: a 0.6 split right, with a 0.7 split down inside it.
			expect(written.root.direction).toBe('right')
			expect(written.root.ratio).toBe(0.6)
			expect(written.root.first.ratio).toBe(0.7)
			// The label someone set survives...
			expect(written.root.second).toEqual({ type: 'pane', label: 'editor' })
			// ...while the ONE pane whose title is merely the hostname gets no label at all. tmux defaults
			// `pane_title` to the host, so capturing it blindly would hang `label: "zeta"` on every
			// untouched pane. Exactly one pane carries the default on purpose: with two, a broken filter
			// would label both `zeta`, and the duplicate-label drop would hide it by producing the right
			// answer for the wrong reason.
			expect(written.root.first.first).toEqual({ type: 'pane' })
			expect(JSON.stringify(written)).not.toContain('zeta')
			// cwd is never in a template — it comes back as a relative dir under the captured root.
			expect(written.root.first.second).toEqual({ type: 'pane', label: 'watcher', dir: 'api' })
			expect(JSON.stringify(written)).not.toContain('/repo')
		})

		it('save captures the region around the calling pane, not the one the user is looking at', async () => {
			// The same reason `open`'s split names its pane: tmux's default is the ACTIVE pane, which
			// tracks the user rather than us. A bare `layout save` must mean "the region I am in".
			const calls: string[][] = []
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store: fakeStore({}) })
			await run(program, ['layout', 'save', 'pool-3'])
			expect(calls.find((c) => c[1] === 'list-panes')?.[2]).toBe('-t')
			expect(calls.find((c) => c[1] === 'list-panes')?.[3]).toBe('%0')
		})

		it('--from captures the region around a named pane', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store: fakeStore({}) })
			await run(program, ['layout', 'save', 'pool-3', '--from', '%7'])
			expect(calls.find((c) => c[1] === 'list-panes')?.[3]).toBe('%7')
		})

		it('a captured template records in its own description that it is geometry only', async () => {
			// The honest limit of the verb. A saved template is a DRAFT, and the file says so itself,
			// since `layout list` will show it beside finished ones.
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await run(program, ['layout', 'save', 'pool-3'])
			const written = JSON.parse(store.writes[repo('pool-3')]!)
			// Both clauses of the scenario's Then. The note has to say what the capture IS...
			expect(written.description).toMatch(/geometry only/)
			// ...and what the author still owes it — the half that makes the note actionable rather than
			// just a disclaimer.
			expect(written.description).toMatch(/command/)
		})

		it('--description replaces the draft note', async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await run(program, ['layout', 'save', 'pool-3', '--description', 'the review pool'])
			expect(JSON.parse(store.writes[repo('pool-3')]!).description).toBe('the review pool')
		})

		it('--to user writes to the user layouts directory instead', async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await run(program, ['layout', 'save', 'pool-3', '--to', 'user'])
			expect(Object.keys(store.writes)).toEqual([user('pool-3')])
		})

		it('save refuses to overwrite an existing template, and reads no region finding out', async () => {
			// A saved template is hand-edited afterwards (the commands are added by hand), so silently
			// overwriting one would throw that work away. Checked BEFORE the capture, so the refusal
			// is free.
			catchExit()
			const stderr = captureStderr()
			const calls: string[][] = []
			const store = fakeStore({ [repo('pool-3')]: POOL_4 })
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
			await expect(run(program, ['layout', 'save', 'pool-3'])).rejects.toThrow('exit:1')
			expect(stderr.join('')).toContain('--force to overwrite')
			expect(store.writes).toEqual({})
			expect(calls.some((c) => c[1] === 'list-panes')).toBe(false)
		})

		it('--force overwrites an existing template', async () => {
			const store = fakeStore({ [repo('pool-3')]: POOL_4 })
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await run(program, ['layout', 'save', 'pool-3', '--force'])
			expect(JSON.parse(store.writes[repo('pool-3')]!).root).toBeDefined()
		})

		it('save validates the name before touching the filesystem or the multiplexer', async () => {
			// A name is a lookup key that must also be a filename — `../../etc/passwd` must never get
			// as far as being a path.
			catchExit()
			const stderr = captureStderr()
			const calls: string[][] = []
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
			await expect(run(program, ['layout', 'save', '../escape'])).rejects.toThrow('exit:1')
			expect(stderr.join('')).toContain('invalid layout name')
			expect(store.writes).toEqual({})
			expect(calls).toEqual([])
		})

		it('save with no pane to capture around refuses rather than guessing', async () => {
			// No CYBER_MUX_PANE and no --from: this process is in no pane it can name. Falling back to the
			// backend's own default would capture whichever region the USER happens to be looking at and
			// save it under the name the caller asked for — a confident wrong answer, worse than none.
			catchExit()
			const stderr = captureStderr()
			const calls: string[][] = []
			const store = fakeStore({})
			const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: saveExec(calls), store })
			await expect(run(program, ['layout', 'save', 'pool-3'])).rejects.toThrow('exit:1')
			expect(stderr.join('')).toContain('--from')
			expect(store.writes).toEqual({})
			// It never asked the backend for a region either — the refusal precedes the read.
			expect(calls.some((c) => c[1] === 'list-panes')).toBe(false)
		})

		it('a pane outside the captured root loses its dir and says so', async () => {
			// Bound at CLI level, not on the pure module: the scenario's Then names stderr and "the
			// template is still written", and neither is visible from captureLayout's return value.
			const stderr = captureStderr()
			const store = fakeStore({})
			// The right-hand pane runs somewhere else entirely — a template cannot pin an absolute path.
			const exec = saveExec(
				[],
				['%0\t0\t0\t119\t50\t/repo\tzeta\tzeta', '%1\t120\t0\t80\t50\t/elsewhere\tzeta\tzeta'].join('\n'),
			)
			const program = buildProgram({ env: SAVE_ENV, exec, store })
			await run(program, ['layout', 'save', 'pool-2'])
			expect(stderr.join('')).toContain('/elsewhere')
			expect(stderr.join('')).toContain('not under the captured root')
			// Still written, and that pane simply has no dir — the geometry is the verbose part.
			expect(JSON.parse(store.writes[repo('pool-2')]!).root.second).toEqual({ type: 'pane' })
			// The warning never reaches stdout: the path alone must stay there so `$(...)` composes.
			expect(logs).toEqual([repo('pool-2')])
		})

		it("a label two panes share is dropped from both, because a template's labels must be unique", async () => {
			// Bound at CLI level for the same reason: the Then names a warning on stderr.
			const stderr = captureStderr()
			const store = fakeStore({})
			// Both panes deliberately titled `worker` — neither is tmux's hostname default, so both are real
			// labels, and they collide.
			const exec = saveExec(
				[],
				['%0\t0\t0\t119\t50\t/repo\tworker\tzeta', '%1\t120\t0\t80\t50\t/repo\tworker\tzeta'].join('\n'),
			)
			const program = buildProgram({ env: SAVE_ENV, exec, store })
			await run(program, ['layout', 'save', 'pool-2'])
			const written = JSON.parse(store.writes[repo('pool-2')]!)
			expect(written.root.first).toEqual({ type: 'pane' })
			expect(written.root.second).toEqual({ type: 'pane' })
			expect(stderr.join('')).toContain('worker')
			expect(logs).toEqual([repo('pool-2')])
		})

		it('a region no sequence of splits could have produced is refused', async () => {
			// Bound at CLI level: the Then names an exit code and that nothing is written — neither is
			// observable from the pure module, which only throws.
			catchExit()
			const store = fakeStore({})
			// A true pinwheel: four panes wound around a fifth, no straight cut separating them.
			const exec = saveExec(
				[],
				[
					'%0\t0\t0\t150\t12\t/repo\tzeta\tzeta',
					'%1\t150\t0\t50\t37\t/repo\tzeta\tzeta',
					'%2\t50\t37\t150\t13\t/repo\tzeta\tzeta',
					'%3\t0\t12\t50\t38\t/repo\tzeta\tzeta',
					'%4\t50\t12\t100\t25\t/repo\tzeta\tzeta',
				].join('\n'),
			)
			const program = buildProgram({ env: SAVE_ENV, exec, store })
			await expect(run(program, ['layout', 'save', 'pool-5'])).rejects.toThrow('exit:1')
			// Nothing written — a refusal must not leave a half-truth on disk.
			expect(store.writes).toEqual({})
		})

		it("a backend that cannot report its region's geometry refuses save cleanly", async () => {
			// describeRegion is OPTIONAL on the seam. Both real backends implement it, so the only way to
			// reach this branch is to take it away: stand in for a backend that never had it (a future
			// screen adapter, which fails the layout floor on three other counts too). Restored in
			// `finally`, since the adapter is a module singleton every other test shares.
			catchExit()
			const stderr = captureStderr()
			const store = fakeStore({})
			const original = tmuxSessionAdapter.describeRegion
			try {
				delete (tmuxSessionAdapter as { describeRegion?: unknown }).describeRegion
				const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
				await expect(run(program, ['layout', 'save', 'pool-3'])).rejects.toThrow('exit:1')
			} finally {
				tmuxSessionAdapter.describeRegion = original
			}
			// Names the backend, so the reader knows WHICH mux cannot do this rather than that save broke.
			expect(stderr.join('')).toContain('tmux')
			// Refuses rather than degrading: there is no half-geometry to fall back to.
			expect(store.writes).toEqual({})
		})
	})
})
