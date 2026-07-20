import { homedir } from 'node:os'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.ts'
import type { Exec } from './exec.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'
import type { PaneRect } from './session.ts'
import { collectPanes, resolveTree, type Template } from './template.ts'
import { captureWorkspaceTemplate } from './template-capture.ts'
import type { TemplateStore } from './template-store.ts'

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

/**
 * Every call EXCEPT the pane-resolution read. Addressing a pane by name costs one `listPanes` query
 * before the verb drives anything (tmux `list-panes -a`, herdr `pane list`), and that read is not part
 * of what a verb DRIVES — these assertions are about the primitives sent to the pane, so the lookup
 * that found the pane is filtered out rather than baked into every expectation.
 */
function drives(calls: string[][]): string[][] {
	return calls.filter((c) => !(c[0] === 'list-panes' && c[1] === '-a') && !(c[0] === 'pane' && c[1] === 'list'))
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
			// `read` writes the pane's captured bytes straight to stdout rather than through console.log —
			// axi's one raw-stream exception, so the spy above never catches it. Any test that drives
			// `read` would otherwise leak its fixture's fake output into the runner's own stdout. A test
			// asserting ON stdout still spies it locally; this only stops the spill.
			vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
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
				exec: fakeTmuxExec([], { 'new-window': '%20\t@1' }),
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
				exec: fakeTmuxExec([], { 'new-window': '%20\t@1' }),
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
			const exec = fakeTmuxExec(calls, { 'split-window': '%5\t@1' })
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
				exec: fakeTmuxExec(tmuxCalls, { 'split-window': '%9\t@1' }),
			})
			await run(tmuxProgram, ['open', '--at', 'pane:right'])
			expect(tmuxCalls[0]).toEqual([
				'split-window',
				'-h',
				'-t',
				'%3',
				'-c',
				process.cwd(),
				'-P',
				'-F',
				'#{pane_id}\t#{window_id}',
			])

			const herdrCalls: string[][] = []
			const herdrProgram = buildProgram({
				env: { CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w3:pA' },
				exec: fakeHerdrExec(herdrCalls, {
					'pane split': JSON.stringify({
						id: 'cli:pane:split',
						result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } },
					}),
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
				exec: fakeTmuxExec(calls, { 'split-window': '%9\t@1' }),
			})
			await run(program, ['open', '--at', 'pane:right'])
			expect(calls[0]).not.toContain('-t')
		})

		it("--at workspace opens the pane's own VISIBLE space on each backend", async () => {
			const tmuxCalls: string[][] = []
			const tmuxExec = fakeTmuxExec(tmuxCalls, { 'new-window': '%20\t@1' })
			const tmuxProgram = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: tmuxExec })
			await run(tmuxProgram, ['open', '--launch', 'claude', '--at', 'workspace'])
			expect(tmuxCalls[0]?.[0]).toBe('new-window') // a visible window, never new-session

			const herdrCalls: string[][] = []
			const createOut = JSON.stringify({
				id: 'cli:workspace:create',
				result: { root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1' }, workspace: { workspace_id: 'w7' } },
			})
			const herdrExec = fakeHerdrExec(herdrCalls, { 'workspace create': createOut })
			const herdrProgram = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec: herdrExec })
			await run(herdrProgram, ['open', '--launch', 'claude', '--at', 'workspace'])
			expect(herdrCalls[0]).toEqual(['workspace', 'create', '--cwd', process.cwd(), '--no-focus'])
		})

		it('--at tab opens a new tab in the current window, never a split pane', async () => {
			const tmuxCalls: string[][] = []
			const tmuxExec = fakeTmuxExec(tmuxCalls, { 'new-window': '%2\t@1' })
			const tmuxProgram = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: tmuxExec })
			await run(tmuxProgram, ['open', '--launch', 'claude', '--at', 'tab'])
			expect(tmuxCalls[0]?.[0]).toBe('new-window')
			expect(tmuxCalls.some((c) => c[0] === 'split-window')).toBe(false)

			const herdrCalls: string[][] = []
			const tabOut = JSON.stringify({
				result: { root_pane: { pane_id: 'w3:pT', tab_id: 'w3:t1' }, tab: { tab_id: 'w3:t2' }, type: 'tab_created' },
			})
			const herdrExec = fakeHerdrExec(herdrCalls, { 'tab create': tabOut })
			const herdrProgram = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec: herdrExec })
			await run(herdrProgram, ['open', '--launch', 'claude', '--at', 'tab'])
			expect(herdrCalls[0]?.slice(0, 2)).toEqual(['tab', 'create'])
			expect(herdrCalls.some((c) => c[0] === 'pane' && c[1] === 'split')).toBe(false)
		})

		it('the tab placement opens in the background without stealing focus', async () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-window': '%2\t@1' })
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
			await run(program, ['open', '--launch', 'claude', '--at', 'tab'])
			expect(calls[0]).toEqual(['new-window', '-d', '-c', process.cwd(), '-P', '-F', '#{pane_id}\t#{window_id}'])
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

		// Not bound to a scenario — no frozen scenario specifies which columns `list` prints; the field
		// budget is axi #2's, a reference bar with no suite. This pins the swap anyway, because the
		// column set is user-facing and nothing else fails when it changes.
		it('list spends its field budget on the label a caller types, not the mux every row shares', async () => {
			const listOut = JSON.stringify({
				result: { panes: [{ pane_id: 'w3:p1', label: 'worker', agent: 'claude', cwd: '/repo/a' }] },
			})
			const exec = fakeHerdrExec([], { 'pane list': listOut })
			const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
			await run(program, ['list'])
			const out = logs.join('\n')
			expect(out).toContain('worker')
			// One adapter is selected per session, so every row reports the same mux: a column that
			// discriminates nothing, spending a slot the label earns.
			expect(out).not.toContain('herdr')
		})

		it('open with no --launch creates a blank pane', async () => {
			const calls: string[][] = []
			const exec = fakeTmuxExec(calls, { 'new-window': '%2\t@1' })
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
					root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' },
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

			it('the lost-grouping note is a help entry on stdout, not a line on stderr', async () => {
				const stderr: string[] = []
				vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
					stderr.push(String(line))
					return true
				})
				const calls: string[][] = []
				const exec = fakeRepoExec(calls, { 'pane split': '{"result":{"pane":{"pane_id":"w3:pB","tab_id":"w3:t1"}}}' })
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
				await run(program, ['worktree', 'add', '--branch', 'my-feature', '--at', 'pane:right'])
				// It succeeded — a worktree in a split pane is a complete outcome...
				expect(calls.some((c) => c[0] === 'git' && c.includes('add'))).toBe(true)
				// ...and the note that the placement cost the grouping rides in the payload on stdout, as a
				// help entry naming --at workspace, per axi/'s #9 — never on stderr the agent does not read.
				expect(logs.join('\n')).toContain('--at workspace')
				expect(logs.join('\n')).toContain('cyber-mux worktree add --branch my-feature --at workspace')
				expect(stderr.join('')).toBe('')
			})

			it('--format json carries the lost-grouping note as a help entry, not just prose', async () => {
				const calls: string[][] = []
				const exec = fakeRepoExec(calls, { 'pane split': '{"result":{"pane":{"pane_id":"w3:pB","tab_id":"w3:t1"}}}' })
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
				await withArgv(['worktree', 'add', '--branch', 'my-feature', '--at', 'pane:right', '--format', 'json'], () =>
					run(program, ['worktree', 'add', '--branch', 'my-feature', '--at', 'pane:right', '--format', 'json']),
				)
				const payload = JSON.parse(logs.join('\n'))
				expect(Array.isArray(payload.help)).toBe(true)
				expect(payload.help[0].message).toContain('--at workspace')
				expect(payload.help[0].command).toBe('cyber-mux worktree add --branch my-feature --at workspace')
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

			it('worktree list marks the primary checkout in BRANCH instead of spending a column on it', async () => {
				const porcelain = [
					'worktree /repo',
					'branch refs/heads/main',
					'',
					'worktree /repo.worktrees/x',
					'branch refs/heads/feat/x',
					'',
				].join('\n')
				const exec: Exec = (_cmd, args) => (args[0] === 'rev-parse' ? '/repo/.git' : porcelain)
				const program = buildProgram({ env: {}, exec })
				await run(program, ['worktree', 'list'])
				const out = logs.join('\n')
				expect(out).toContain('main (*)')
				expect(out).not.toContain('feat/x (*)')
				expect(out).not.toContain('LINKED')
			})

			it('worktree list marks a vanished checkout `(gone)` on ROOT, and keeps `prunable` in JSON', async () => {
				const porcelain = [
					'worktree /repo',
					'branch refs/heads/main',
					'',
					'worktree /repo.worktrees/gone',
					'branch refs/heads/old',
					'prunable gitdir file points to non-existent location',
					'',
				].join('\n')
				const exec: Exec = (_cmd, args) => (args[0] === 'rev-parse' ? '/repo/.git' : porcelain)
				const program = buildProgram({ env: {}, exec })
				await run(program, ['worktree', 'list'])
				const out = logs.join('\n')
				expect(out).toContain('/repo.worktrees/gone (gone)')
				// The live checkout carries no marker — the cost is paid only by the row that earned it.
				expect(out).not.toContain('/repo (gone)')

				logs.length = 0
				await withArgv(['worktree', 'list', '--format', 'json'], () =>
					run(program, ['worktree', 'list', '--format', 'json']),
				)
				const payload = JSON.parse(logs.join('\n'))
				expect(payload.worktrees.map((w: { prunable: boolean }) => w.prunable)).toEqual([false, true])
				expect(payload.worktrees[1].root).toBe('/repo.worktrees/gone')
			})

			it('worktree list shortens a home-rooted ROOT to `~`, but never in JSON', async () => {
				const home = homedir()
				const porcelain = [`worktree ${home}/code/app`, 'branch refs/heads/main', ''].join('\n')
				const exec: Exec = (_cmd, args) => (args[0] === 'rev-parse' ? `${home}/code/app/.git` : porcelain)
				const program = buildProgram({ env: {}, exec })
				await run(program, ['worktree', 'list'])
				expect(logs.join('\n')).toContain('~/code/app')
				expect(logs.join('\n')).not.toContain(home)

				logs.length = 0
				await withArgv(['worktree', 'list', '--format', 'json'], () =>
					run(program, ['worktree', 'list', '--format', 'json']),
				)
				expect(JSON.parse(logs.join('\n')).worktrees[0].root).toBe(`${home}/code/app`)
			})

			it('worktree list keeps `linked` in JSON, where a consumer reads the boolean', async () => {
				const porcelain = [
					'worktree /repo',
					'branch refs/heads/main',
					'',
					'worktree /repo.worktrees/x',
					'branch refs/heads/feat/x',
					'',
				].join('\n')
				const exec: Exec = (_cmd, args) => (args[0] === 'rev-parse' ? '/repo/.git' : porcelain)
				const program = buildProgram({ env: {}, exec })
				await withArgv(['worktree', 'list', '--format', 'json'], () =>
					run(program, ['worktree', 'list', '--format', 'json']),
				)
				const payload = JSON.parse(logs.join('\n'))
				expect(payload.worktrees.map((w: { linked: boolean }) => w.linked)).toEqual([false, true])
				expect(payload.worktrees[0].branch).toBe('main')
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
			const exec = fakeTmuxExec(calls, { 'new-window': '%2\t@1' })
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
			expect(drives(calls)).toEqual([['send-keys', '-t', '%3', '-l', 'Up']])
		})

		it('send keys presses core-vocabulary keys and types nothing', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['send', 'keys', '%3', 'Escape', 'Up', 'C-c'])
			expect(drives(calls)).toEqual([['send-keys', '-t', '%3', 'Escape', 'Up', 'C-c']])
		})

		it('send keys Enter presses Enter and takes the turn, because the caller asked for it', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['send', 'keys', '%3', 'Enter'])
			expect(drives(calls)).toEqual([['send-keys', '-t', '%3', 'Enter']])
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
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const out: string[] = []
			vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
				out.push(String(line))
				return true
			})
			vi.spyOn(process, 'exit').mockImplementation((code) => {
				throw new Error(`exit:${code}`)
			})
			// Help naming text and keys as its subcommands is written to stdout, and it exits 2 — the status
			// that separates bad input from a failed operation.
			await expect(run(program, ['send'])).rejects.toThrow('exit:2')
			const help = out.join('')
			expect(help).toContain('text')
			expect(help).toContain('keys')
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
			expect(drives(calls)).toEqual(expected)
		})

		it('submit types its text literally, never interpreting it as a key', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['submit', '%3', 'Up'])
			// Never `send-keys -t %3 Up Enter`, which would recall and re-run the pane's last command.
			expect(calls).not.toContainEqual(['send-keys', '-t', '%3', 'Up', 'Enter'])
			expect(drives(calls)[0]).toEqual(['send-keys', '-t', '%3', '-l', 'Up'])
		})

		it('submit with no text presses a bare Enter and retypes nothing', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['submit', '%3'])
			expect(drives(calls)).toEqual([['send-keys', '-t', '%3', 'Enter']])
		})

		it('submit with empty text is the bare flush, not a second contract', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			await run(program, ['submit', '%3', ''])
			expect(drives(calls)).toEqual([['send-keys', '-t', '%3', 'Enter']])
		})

		it('submit with no pane is rejected', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
			vi.spyOn(process, 'exit').mockImplementation((code) => {
				throw new Error(`exit:${code}`)
			})
			// A missing required argument is a usage error (exit 2), naming the argument that is missing.
			await expect(run(program, ['submit'])).rejects.toThrow('exit:2')
			expect(logs.join('\n')).toContain('pane')
			expect(calls).toEqual([])
		})

		describe('template', () => {
			const REPO_DIR = '/repo/.cyber-mux/templates'
			const USER_DIR = '/home/u/.config/cyber-mux/templates'
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

			/** A `TemplateStore` over an in-memory file map — no templates on disk, ever. */
			function fakeStore(
				files: Record<string, unknown>,
			): TemplateStore & { reads: string[]; writes: Record<string, string> } {
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
						if (args[0] !== 'new-window' && args[0] !== 'split-window') return ''
						const id = n++
						// A grouping open asks for the new window's id beside the pane's, tab-separated, so it
						// can tag that window — answer the format tmux was actually asked for.
						return args.includes('#{pane_id}\t#{window_id}') ? `%${id}\t@${id}` : `%${id}`
					}
					const key = args.slice(0, 2).join(' ')
					if (key === 'pane split')
						return JSON.stringify({ result: { pane: { pane_id: `w9:p${n++}`, tab_id: 'w9:t1' } } })
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
				it('--file skips resolution entirely — neither templates directory is consulted', async () => {
					const store = fakeStore({ './scratch/pool.json': { name: 'pool', panes: [{ label: 'a' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'show', '--file', './scratch/pool.json'])
					expect(store.reads).toEqual(['./scratch/pool.json'])
					expect(logs.join('\n')).toContain('"name": "pool"')
				})

				it('a repo template shadows a user template of the same name', async () => {
					const store = fakeStore({
						[repo('pool-4')]: POOL_4,
						[user('pool-4')]: { name: 'pool-4', panes: [{ label: 'mine-only' }] },
					})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'show', 'pool-4'])
					// The repo's answer is the one shown — a personal template must not silently displace it.
					expect(logs.join('\n')).toContain('"w1"')
					expect(logs.join('\n')).not.toContain('mine-only')
				})

				it('template list reports the user template a repo template shadows', async () => {
					const store = fakeStore({ [repo('pool-4')]: POOL_4, [user('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'list'])
					const rows = logs.join('\n').split('\n')
					expect(rows.some((r) => r.includes('pool-4') && r.includes('repo') && !r.includes('yes'))).toBe(true)
					expect(rows.some((r) => r.includes('pool-4') && r.includes('user') && r.includes('yes'))).toBe(true)
				})

				it('a user template resolves when the repo has none of that name, and lists as user', async () => {
					const store = fakeStore({ [user('scratch')]: { name: 'scratch', panes: [{ label: 'a' }, { label: 'b' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'show', 'scratch'])
					expect(logs.join('\n')).toContain('"name": "scratch"')

					logs.length = 0
					await run(buildProgram({ env: XDG, exec: repoExec([]), store }), ['template', 'list'])
					expect(logs.join('\n')).toMatch(/scratch\s+user/)
				})

				it('the repo templates directory resolves through the primary checkout, not the caller’s cwd', async () => {
					// The template exists ONLY under the primary checkout — which is exactly the case of a
					// worktree whose branch predates it. Reading ./.cyber-mux would report not-found here.
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'show', 'pool-4'])
					expect(store.reads).toEqual([repo('pool-4')])
				})

				it('a name that resolves nowhere exits 1 naming both directories it searched', async () => {
					catchExit()
					captureStderr()
					const program = buildProgram({ env: XDG, exec: repoExec([]), store: fakeStore({}) })
					await expect(run(program, ['template', 'show', 'pool-9'])).rejects.toThrow('exit:1')
					// On stdout now — AXI reserves it for what the agent consumes, errors included.
					expect(logs.join('\n')).toContain(REPO_DIR)
					expect(logs.join('\n')).toContain(USER_DIR)
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
					const failure = await run(program, ['template', 'show', name]).catch((err: unknown) => err)
					expect(failure).toBeInstanceOf(Error)
					// A malformed name is a usage error now: the stem rule refuses most at exit 2
					// (invalid-template-name), while `-pool` is rejected by commander as an unknown option — also
					// exit 2, the usage-error family. Both exit 2 having read nothing.
					const code = (failure as { exitCode?: number }).exitCode ?? (failure as Error).message
					expect([2, 'exit:2']).toContain(code)
					expect(store.reads).toEqual([])
				})

				it('a name field that disagrees with the filename stem fails validation, naming both', async () => {
					// The redundancy is the point: a copied file that kept its old name fails loudly.
					catchExit()
					captureStderr()
					const store = fakeStore({ [repo('pool-4')]: { name: 'pool-3', panes: [{ label: 'w1' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['template', 'validate', 'pool-4'])).rejects.toThrow('exit:1')
					expect(logs.join('\n')).toContain('pool-4')
					expect(logs.join('\n')).toContain('pool-3')
				})
			})

			describe('validate', () => {
				it('a template that sets cwd fails, naming the JSON path, --cwd and dir', async () => {
					catchExit()
					captureStderr()
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
					await expect(run(program, ['template', 'validate', 'bad-pool'])).rejects.toThrow('exit:1')
					// On stdout now, the stream the agent reads.
					expect(logs.join('\n')).toContain('root.first.cwd')
					expect(logs.join('\n')).toContain('--cwd')
					expect(logs.join('\n')).toContain('dir')
				})

				it('reports every error at once, one per line, each naming its own JSON path', async () => {
					catchExit()
					captureStderr()
					const store = fakeStore({
						[repo('bad-pool')]: {
							name: 'bad-pool',
							root: {
								type: 'split',
								direction: 'right',
								ratio: 0,
								first: { type: 'pane', label: 'alpha', cwd: '/home/someone/proj' },
								second: { type: 'pane', label: 'beta', dir: '/var/log' },
							},
						},
					})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['template', 'validate', 'bad-pool'])).rejects.toThrow('exit:1')
					// Every error, one per line, each naming its own JSON path — the three path lines on stdout,
					// beside the surface's own `error:`/`help:` framing.
					const paths = logs
						.join('\n')
						.split('\n')
						.filter((l) => l.includes('root.'))
					expect(paths).toHaveLength(3)
					expect(paths.some((l) => l.includes('root.ratio'))).toBe(true)
					expect(paths.some((l) => l.includes('root.first.cwd'))).toBe(true)
					expect(paths.some((l) => l.includes('root.second.dir'))).toBe(true)
				})

				it('exits 0 on a valid template, saying nothing at all', async () => {
					// This is the CI hook, so silence is the pass signal.
					const exit = catchExit()
					const stderr = captureStderr()
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'validate', 'pool-4'])
					expect(exit).not.toHaveBeenCalled()
					expect(stderr).toEqual([])
				})
			})

			describe('show --desugar', () => {
				it('prints exactly the tree apply will build', async () => {
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'show', 'pool-4', '--desugar'])
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
					await run(program, ['template', 'show', 'pool-4'])
					expect(JSON.parse(logs.join('\n'))).toEqual(POOL_4)
				})
			})

			describe('managing templates needs no multiplexer', () => {
				it.each([
					['list', ['template', 'list']],
					['show pool-4', ['template', 'show', 'pool-4']],
					['validate pool-4', ['template', 'validate', 'pool-4']],
				])('%s answers without resolving a session backend', async (_name, argv) => {
					// Their subject is a FILE, the same way `worktree list`'s subject is git.
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					// No $TMUX, no $HERDR_ENV, no override at all.
					const program = buildProgram({ env: XDG, exec: repoExec(calls), store })
					await run(program, argv)
					expect(calls.every((c) => c[0] === 'git')).toBe(true)
				})

				it("an unknown flag is rejected against the SUBCOMMAND's flags, not the group's", async () => {
					// `--force` is a flag only `template save` defines; on `template list` it is unknown. Validating
					// against the GROUP's union would accept it here and silently drop it.
					catchExit()
					const store = fakeStore({})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['template', 'list', '--force'])).rejects.toThrow('exit:2')
					const out = logs.join('\n')
					// Names --force as unknown for template list, and the valid flags it lists are list's own...
					expect(out).toContain('--force')
					expect(out).toContain('--format')
					// ...never template save's.
					expect(out).not.toContain('--from')
					expect(out).not.toContain('--workspace')
				})
			})

			describe('--template, the exact sibling of --launch', () => {
				it('--template and --launch are mutually exclusive', async () => {
					catchExit()
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
					// Two flags that cannot both be given is malformed input — a usage error (exit 2).
					await expect(run(program, ['open', '--template', 'pool-4', '--launch', 'claude'])).rejects.toThrow('exit:2')
				})

				it('--at defaults to workspace when --template is given', async () => {
					// A fresh space is empty by construction.
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await run(program, ['open', '--template', 'pool-4'])
					// tmux collapses workspace to a window — the region is a new-window, not a split.
					expect(calls.find((c) => c[0] === 'tmux')?.[1]).toBe('new-window')
				})

				it('--label defaults to the template name', async () => {
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await run(program, ['open', '--template', 'pool-4'])
					expect(calls.find((c) => c[1] === 'new-window')).toEqual(expect.arrayContaining(['-n', 'pool-4']))
				})

				it('an explicit --label wins over the template name', async () => {
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await run(program, ['open', '--template', 'pool-4', '--label', 'my-pool'])
					expect(calls.find((c) => c[1] === 'new-window')).toEqual(expect.arrayContaining(['-n', 'my-pool']))
				})
			})

			describe('resolution precedes side effects', () => {
				it('open --template with an unresolvable name opens nothing', async () => {
					catchExit()
					const calls: string[][] = []
					const program = buildProgram({
						env: { ...XDG, CYBER_MUX: 'tmux' },
						exec: repoExec(calls),
						store: fakeStore({}),
					})
					await expect(run(program, ['open', '--template', 'pool-9'])).rejects.toThrow('exit:1')
					expect(calls.some((c) => c[0] === 'tmux')).toBe(false)
				})

				it('worktree add --template with a name that resolves nowhere leaves no worktree behind', async () => {
					catchExit()
					const calls: string[][] = []
					const program = buildProgram({
						env: { ...XDG, CYBER_MUX: 'tmux' },
						exec: repoExec(calls),
						store: fakeStore({}),
					})
					await expect(run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'pool-9'])).rejects.toThrow(
						'exit:1',
					)
					expect(calls.some((c) => c.includes('worktree') && c.includes('add'))).toBe(false)
				})

				it('worktree add --template with an invalid template leaves no worktree behind', async () => {
					catchExit()
					captureStderr()
					const calls: string[][] = []
					const store = fakeStore({
						[repo('bad-pool')]: { name: 'bad-pool', panes: [{ label: 'a', cwd: '/home/someone/proj' }] },
					})
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await expect(
						run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'bad-pool']),
					).rejects.toThrow('exit:1')
					expect(logs.join('\n')).toContain('panes[0].cwd')
					expect(calls.some((c) => c.includes('worktree') && c.includes('add'))).toBe(false)
				})

				it('applying with no multiplexer fails through the existing adapter path', async () => {
					catchExit()
					captureStderr()
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					// Neither $TMUX nor $HERDR_ENV — the template resolves and validates, then the backend does not.
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await expect(run(program, ['open', '--template', 'pool-4'])).rejects.toThrow('exit:1')
					// The no-mux error's help names both backends, on stdout.
					expect(logs.join('\n')).toContain('tmux')
					expect(logs.join('\n')).toContain('herdr')
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
						// Every open reports the window alongside the pane — the window IS the pane's tab, which
						// `OpenedPane.tab` always carries. A split lands in the caller's own window, hence @0.
						if (args[0] === 'new-window') return '%0\t@0'
						if (args[0] === 'split-window') return ++splits === 3 ? null : `%${splits}\t@0`
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
					await withArgv(['open', '--template', 'render-farm', '--format', 'json'], async () => {
						await expect(run(program, ['open', '--template', 'render-farm', '--format', 'json'])).rejects.toThrow(
							'exit:1',
						)
					})
					// The manifest still reports the panes that were built before the failure...
					const manifest = JSON.parse(logs.join('\n'))
					expect(manifest.panes.map((p: { label: string }) => p.label)).toEqual(['a', 'b', 'c'])
					// ...and nothing is killed: a kill is not obviously safer than a half-built template the
					// caller can see and finish.
					expect(calls.some((c) => c[1] === 'kill-pane')).toBe(false)
				})
			})

			describe('the manifest is the handoff', () => {
				it('--format json reports every pane apply created', async () => {
					const store = fakeStore({ [repo('agent-pool-3')]: AGENT_POOL_3 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
					await withArgv(['open', '--template', 'agent-pool-3', '--format', 'json'], () =>
						run(program, ['open', '--template', 'agent-pool-3', '--cwd', '/w/feat-x', '--format', 'json']),
					)
					const manifest = JSON.parse(logs.join('\n'))
					expect(manifest.template).toBe('agent-pool-3')
					expect(manifest.cwd).toBe('/w/feat-x')
					expect(manifest).toHaveProperty('workspace')
					// One entry per pane, each carrying its label, pane id, dir and command — plus the tab it
					// landed in, `null` here because a single-tab template names no tabs at all.
					expect(manifest.panes).toEqual([
						{ label: 'planner', pane: '%0', dir: '/w/feat-x', command: 'claude', tab: null },
						{ label: 'worker-a', pane: '%1', dir: '/w/feat-x', command: 'claude', tab: null },
						{ label: 'worker-b', pane: '%2', dir: '/w/feat-x', command: 'claude', tab: null },
					])
				})

				it('the manifest’s workspace is null on tmux', async () => {
					// Matching how reportOpenedWorktree already reports it.
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
					await withArgv(['open', '--template', 'pool-4', '--format', 'json'], () =>
						run(program, ['open', '--template', 'pool-4', '--format', 'json']),
					)
					expect(JSON.parse(logs.join('\n')).workspace).toBeNull()
				})
			})

			describe('worktree add --template', () => {
				const worktreeOut = JSON.stringify({
					result: {
						root_pane: { pane_id: 'w9:root', tab_id: 'w9:t1' },
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
						run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'agent-pool-3', '--format', 'json']),
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
					expect(out.template).toBe('agent-pool-3')
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
					await run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'render-farm'])

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
					await run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'render-farm'])
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
						run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'render-farm', '--format', 'json']),
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
						tab: null,
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
			expect(drives(calls)).toEqual([
				['pane', 'send-text', 'w1:p1', 'hello'],
				['pane', 'send-keys', 'w1:p1', 'Up'],
				['pane', 'run', 'w1:p1', 'echo hi'],
				['pane', 'send-keys', 'w1:p1', 'Enter'],
			])
		})

		describe('addressing a pane by name', () => {
			/** The hostname tmux hands an unnamed pane's title — the value the label rule must reject. */
			const HOST = 'zeta'

			interface FakePane {
				id: string
				label?: string
				cwd?: string
			}

			/**
			 * A tmux server holding `panes`, answering each `-F` format it is actually asked for. Keyed on
			 * the format rather than the verb because `list-panes -a` serves three different readers here
			 * (resolution, `paneExists`, `focus`), and handing each the same string would make the fake
			 * lie to two of them.
			 *
			 * A pane with no `label` gets its title set to the HOST — that is tmux's real behavior for a
			 * pane nobody named, not a stand-in for absence.
			 */
			function paneServer(calls: string[][], panes: FakePane[], responses: Record<string, string | null> = {}): Exec {
				return (_cmd, args) => {
					calls.push(args)
					if (args[0] === 'list-panes' && args[1] === '-a') {
						const fmt = args[args.indexOf('-F') + 1]
						if (fmt === '#{pane_id}') return panes.map((p) => p.id).join('\n')
						if (fmt === '#{pane_id} #{session_name} #{window_id}') return panes.map((p) => `${p.id} main @1`).join('\n')
						return panes.map((p) => [p.id, 'zsh', p.cwd ?? '/repo', p.label ?? HOST, HOST].join('\t')).join('\n')
					}
					// `list-panes -t <id>` is the REGION read `template save` runs after resolution — one pane,
					// with the geometry a capture needs. Keyed on `-t` so it never answers the `-a` readers.
					if (args[0] === 'list-panes' && args[1] === '-t') {
						const of = panes.find((p) => p.id === args[2])
						return of ? [of.id, '0', '0', '80', '24', of.cwd ?? '/repo', of.label ?? HOST, HOST].join('\t') : null
					}
					return responses[args[0]!] ?? null
				}
			}

			const TMUX = { CYBER_MUX: 'tmux' }
			/** Three panes, one of them the intended target — the other two are the ones nothing may touch. */
			const THREE: FakePane[] = [
				{ id: '%1', label: 'worker', cwd: '/repo/a' },
				{ id: '%2', label: 'sidebar', cwd: '/repo/b' },
				{ id: '%3', label: 'logs', cwd: '/repo/c' },
			]

			/** Which pane ids a run actually touched — the args of every call except the resolution read. */
			function touched(calls: string[][]): string[] {
				const ids = THREE.map((p) => p.id)
				return drives(calls)
					.flat()
					.filter((a) => ids.includes(a))
			}

			function catchExit() {
				return vi.spyOn(process, 'exit').mockImplementation((code) => {
					throw new Error(`exit:${code}`)
				})
			}

			function captureStderr(): string[] {
				const lines: string[] = []
				vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
					lines.push(String(line))
					return true
				})
				return lines
			}

			/** A store with no templates — enough for `template save`, which only ever writes. */
			function saveStore(): TemplateStore & { writes: Record<string, string> } {
				const writes: Record<string, string> = {}
				return {
					read: () => null,
					list: () => [],
					write: (path, body) => {
						writes[path] = body
					},
					dirExists: () => true,
					writes,
				}
			}

			/**
			 * Every verb the outline names, each with the argv that drives it. `template save --from` carries
			 * its own env/store because it is the one verb here that also touches the filesystem — and it is
			 * in this table precisely because it built its target inline and bypassed resolution entirely.
			 */
			const VERBS: { verb: string; argv: string[]; store?: boolean }[] = [
				{ verb: 'cyber-mux read', argv: ['read', 'worker'] },
				{ verb: 'cyber-mux submit', argv: ['submit', 'worker'] },
				{ verb: 'cyber-mux exists', argv: ['exists', 'worker'] },
				{ verb: 'cyber-mux focus', argv: ['focus', 'worker'] },
				{ verb: 'cyber-mux close', argv: ['close', 'worker'] },
				{ verb: 'cyber-mux send text', argv: ['send', 'text', 'worker', 'hi'] },
				{ verb: 'cyber-mux send keys', argv: ['send', 'keys', 'worker', 'Up'] },
				{
					verb: 'cyber-mux template save --from',
					argv: ['template', 'save', 'pool-3', '--from', 'worker'],
					store: true,
				},
			]

			// Both the Examples rows and the outline's two Thens: the verb reaches the pane labeled worker
			// exactly as if %1 had been passed, and the two panes it did not name are never touched.
			it.each(VERBS)('every pane verb addresses a pane by name as readily as by id', async ({ argv, store }) => {
				const calls: string[][] = []
				const program = buildProgram({
					env: store ? { ...TMUX, XDG_CONFIG_HOME: '/home/u/.config' } : TMUX,
					exec: paneServer(calls, THREE, { 'capture-pane': 'out', 'list-panes': '', 'rev-parse': '/repo/.git' }),
					store: store ? saveStore() : undefined,
				})
				await run(program, argv)
				// The verb reached worker's pane — by its id, which is the only thing an adapter ever sees.
				expect(touched(calls)).toContain('%1')
				// And neither of the other two panes was acted on.
				expect(touched(calls)).not.toContain('%2')
				expect(touched(calls)).not.toContain('%3')
			})

			/** The same three panes, all sharing one label — the ambiguity every verb must refuse. */
			const ALL_WORKER: FakePane[] = [
				{ id: '%1', label: 'worker', cwd: '/repo/a' },
				{ id: '%2', label: 'worker', cwd: '/repo/b' },
				{ id: '%3', label: 'worker', cwd: '/repo/c' },
			]

			it.each(VERBS)('an ambiguous name fails the same way on every pane verb', async ({ argv, store }) => {
				const calls: string[][] = []
				const exit = catchExit()
				captureStderr()
				const program = buildProgram({
					env: store ? { ...TMUX, XDG_CONFIG_HOME: '/home/u/.config' } : TMUX,
					exec: paneServer(calls, ALL_WORKER, { 'capture-pane': 'out', 'list-panes': '', 'rev-parse': '/repo/.git' }),
					store: store ? saveStore() : undefined,
				})
				await expect(run(program, argv)).rejects.toThrow('exit:2')
				// The candidates, under the stable code, on stdout — where the agent reads.
				expect(logs.join('\n')).toContain('ambiguous-pane')
				expect(exit).toHaveBeenCalledWith(2)
				// Having acted on none of the three: the only calls made were the resolution read itself.
				expect(touched(calls)).toEqual([])
			})

			// An id and a label are not peers, so this is not a 2-candidate ambiguity — the id wins outright.
			it('an id addresses the pane whose id it is, even when another pane is labeled with that id', async () => {
				const calls: string[][] = []
				const program = buildProgram({
					env: TMUX,
					exec: paneServer(calls, [
						{ id: '%1', cwd: '/repo/a' },
						{ id: '%2', label: '%1', cwd: '/repo/b' },
					]),
				})
				await run(program, ['close', '%1'])
				// The pane whose id it is — never the impostor that merely wears the string as a name.
				expect(drives(calls)).toEqual([['kill-pane', '-t', '%1']])
			})

			// The counter-case a syntax rule cannot survive: %9 is id-SHAPED, but no pane carries it as an id.
			it('an id is recognized by matching a live pane, never by the shape of the string', async () => {
				const calls: string[][] = []
				const program = buildProgram({
					env: TMUX,
					exec: paneServer(calls, [{ id: '%1', label: '%9', cwd: '/repo/a' }]),
				})
				await run(program, ['close', '%9'])
				// Resolved to the pane LABELED %9 — not refused for looking like an id, and not reported
				// missing by a resolver that sniffed the shape and never asked the live list.
				expect(drives(calls)).toEqual([['kill-pane', '-t', '%1']])
			})

			it('a name matching exactly one live pane resolves to it and the command proceeds', async () => {
				const calls: string[][] = []
				const program = buildProgram({ env: TMUX, exec: paneServer(calls, THREE) })
				await run(program, ['close', 'worker'])
				expect(drives(calls)).toEqual([['kill-pane', '-t', '%1']])
				expect(touched(calls)).not.toContain('%2')
				expect(touched(calls)).not.toContain('%3')
			})

			// Not-found and ambiguous are different outcomes with different codes — 1, not 2.
			it('a name matching no live pane is not found, rather than ambiguous', async () => {
				const calls: string[][] = []
				const exit = catchExit()
				const stderr = captureStderr()
				const program = buildProgram({
					env: TMUX,
					exec: paneServer(calls, [{ id: '%2', label: 'sidebar' }]),
				})
				await expect(run(program, ['exists', 'worker'])).rejects.toThrow('exit:1')
				expect(exit).toHaveBeenCalledWith(1)
				expect(stderr.join('')).not.toContain('ambiguous-pane')
			})

			it('a name matching two or more live panes fails rather than guessing which was meant', async () => {
				const calls: string[][] = []
				catchExit()
				captureStderr()
				const program = buildProgram({ env: TMUX, exec: paneServer(calls, ALL_WORKER) })
				await expect(run(program, ['close', 'worker'])).rejects.toThrow('exit:2')
				// Acted on none of them — no kill-pane reached any of the three.
				expect(touched(calls)).toEqual([])
				// The matching entries are reported on stdout, so the caller can choose between them.
				const err = logs.join('\n')
				for (const id of ['%1', '%2', '%3']) expect(err).toContain(id)
			})

			it('the ambiguity report carries what tells the candidates apart, and what retries them', async () => {
				catchExit()
				captureStderr()
				const program = buildProgram({ env: TMUX, exec: paneServer([], ALL_WORKER) })
				await expect(run(program, ['close', 'worker'])).rejects.toThrow('exit:2')
				const err = logs.join('\n')
				// Each candidate with its id, its label, and its working directory — the cwd being the only
				// one of the three that actually tells three panes all labeled `worker` apart.
				for (const c of ALL_WORKER) {
					expect(err).toContain(c.id)
					expect(err).toContain(c.cwd!)
				}
				expect(err).toContain('worker')
				// And each id is directly usable as the retry: feeding one back resolves, because an id
				// outranks every name. Proven by running it, not by asserting the string looks like an id.
				const retryCalls: string[][] = []
				const retry = buildProgram({ env: TMUX, exec: paneServer(retryCalls, ALL_WORKER) })
				await run(retry, ['close', '%2'])
				expect(drives(retryCalls)).toEqual([['kill-pane', '-t', '%2']])
			})

			it('the ambiguity report is a structured error on stdout, where the agent reads', async () => {
				const exit = catchExit()
				const stderr = captureStderr()
				const program = buildProgram({
					env: TMUX,
					exec: paneServer(
						[],
						[
							{ id: '%1', label: 'worker', cwd: '/repo/a' },
							{ id: '%2', label: 'worker', cwd: '/repo/b' },
						],
					),
				})
				await expect(run(program, ['close', 'worker'])).rejects.toThrow('exit:2')
				// The report is on stdout, under the stable code, where the agent reads.
				expect(logs.join('\n')).toContain('ambiguous-pane')
				// And stderr is left empty, carrying no part of the answer.
				expect(stderr.join('')).toBe('')
				expect(exit).toHaveBeenCalledWith(2)
			})

			it('--format json emits the ambiguity as a structured error carrying its candidates', async () => {
				catchExit()
				const stderr = captureStderr()
				const panes: FakePane[] = [
					{ id: '%1', label: 'worker', cwd: '/repo/a' },
					{ id: '%2', label: 'worker', cwd: '/repo/b' },
				]
				const program = buildProgram({ env: TMUX, exec: paneServer([], panes) })
				await withArgv(['close', 'worker', '--format', 'json'], () =>
					expect(run(program, ['close', 'worker', '--format', 'json'])).rejects.toThrow('exit:2'),
				)
				// Parsed, not string-matched: the contract is that the error IS JSON, carrying the code and
				// the candidate entries as data a caller can branch on.
				const parsed = JSON.parse(logs.join('\n'))
				expect(parsed.error.code).toBe('ambiguous-pane')
				expect(parsed.error.candidates).toEqual([
					{ id: '%1', label: 'worker', cwd: '/repo/a' },
					{ id: '%2', label: 'worker', cwd: '/repo/b' },
				])
				// Written to stdout, where a caller branching on exit 2 never mistakes it for a result;
				// stderr carries no part of it.
				expect(stderr.join('')).toBe('')
			})

			// The outcome rides the exit code, because three panes named worker is not an answer to
			// "is it live?" — and `gone` and ambiguous are not the same thing.
			it.each([
				{ world: 'exactly one live pane matches the locator', panes: THREE, stdout: 'live', code: 0 },
				{ world: 'no live pane matches the locator', panes: [{ id: '%2', label: 'sidebar' }], stdout: 'gone', code: 1 },
				{ world: 'two or more live panes match the locator', panes: ALL_WORKER, stdout: 'nothing', code: 2 },
			])('exists distinguishes its three outcomes by exit code, not by prose', async ({ panes, stdout, code }) => {
				const exit = catchExit()
				captureStderr()
				const program = buildProgram({ env: TMUX, exec: paneServer([], panes) })
				const running = run(program, ['exists', 'worker'])
				if (code === 0) {
					await running
					expect(exit).not.toHaveBeenCalled()
				} else {
					await expect(running).rejects.toThrow(`exit:${code}`)
					expect(exit).toHaveBeenCalledWith(code)
				}
				if (stdout === 'nothing') {
					// Neither live nor gone — the ambiguous-pane error takes stdout instead.
					expect(logs.join('\n')).toContain('ambiguous-pane')
					expect(logs).not.toContain('live')
					expect(logs).not.toContain('gone')
				} else {
					expect(logs).toEqual([stdout])
				}
			})

			it('an ambiguous exists reports its candidates rather than answering the question', async () => {
				catchExit()
				captureStderr()
				const program = buildProgram({
					env: TMUX,
					exec: paneServer(
						[],
						[
							{ id: '%1', label: 'worker', cwd: '/repo/a' },
							{ id: '%2', label: 'worker', cwd: '/repo/b' },
						],
					),
				})
				await expect(run(program, ['exists', 'worker'])).rejects.toThrow('exit:2')
				const err = logs.join('\n')
				expect(err).toContain('ambiguous-pane')
				expect(err).toContain('%1')
				expect(err).toContain('%2')
				// It answers neither live nor gone — there is no single pane the question is about.
				expect(err).not.toContain('live')
				expect(err).not.toContain('gone')
			})

			// ── The error surface — structured, coded, and on stdout ──

			/** A tmux whose list-panes reports `panes`, but whose every other command THROWS a backend
			 * diagnostic — the shape a bad target takes: resolution succeeds/empties, the verb's own call
			 * fails with the multiplexer's own words. */
			function throwingExec(panes: string, diagnostic: string): Exec {
				return (_cmd, args) => {
					if (args[0] === 'list-panes') return panes
					throw new Error(diagnostic)
				}
			}

			it.each([
				{
					world: 'no multiplexer this process is inside',
					make: () => buildProgram({ env: {}, exec: noAncestry }),
					argv: ['list'],
					code: 'no-mux',
					exit: 1,
				},
				{
					world: 'a locator matching no live pane',
					make: () => buildProgram({ env: TMUX, exec: throwingExec('', "can't find pane: %99") }),
					argv: ['focus', '%99'],
					code: 'pane-not-found',
					exit: 1,
				},
				{
					world: 'two live panes labeled worker',
					make: () => buildProgram({ env: TMUX, exec: paneServer([], ALL_WORKER) }),
					argv: ['read', 'worker'],
					code: 'ambiguous-pane',
					exit: 2,
				},
			])('a failure is a structured error on stdout, under the code for THAT failure', async ({
				make,
				argv,
				code,
				exit,
			}) => {
				const errExit = catchExit()
				const stderr = captureStderr()
				await expect(run(make(), argv)).rejects.toThrow(`exit:${exit}`)
				const out = logs.join('\n')
				// The report is on stdout, never stderr, under the stable code for THAT failure.
				expect(out).toContain(code)
				expect(stderr.join('')).toBe('')
				expect(errExit).toHaveBeenCalledWith(exit)
				// A help line naming the command that fixes it, never "see --help".
				expect(out).toContain('help:')
				expect(out).not.toContain('see --help')
			})

			it('two different failures never share one code', async () => {
				catchExit()
				captureStderr()
				await withArgv(['read', 'worker', '--format', 'json'], () =>
					expect(
						run(buildProgram({ env: TMUX, exec: paneServer([], ALL_WORKER) }), ['read', 'worker', '--format', 'json']),
					).rejects.toThrow('exit:2'),
				)
				const ambiguousCode = JSON.parse(logs.join('\n')).error.code
				logs.length = 0
				await withArgv(['list', '--format', 'json'], () =>
					expect(run(buildProgram({ env: {}, exec: noAncestry }), ['list', '--format', 'json'])).rejects.toThrow(
						'exit:1',
					),
				)
				const noMuxCode = JSON.parse(logs.join('\n')).error.code
				// The two codes discriminate — neither is a catch-all a third failure would also land under.
				expect(ambiguousCode).toBe('ambiguous-pane')
				expect(noMuxCode).toBe('no-mux')
				expect(ambiguousCode).not.toBe(noMuxCode)
			})

			it.each([
				['read'],
				['focus'],
				['send', 'text'],
			])('a missing required argument is a usage error, not a failed operation', async (...verb) => {
				const calls: string[][] = []
				const errExit = catchExit()
				await expect(run(buildProgram({ env: TMUX, exec: paneServer(calls, THREE) }), verb)).rejects.toThrow('exit:2')
				// Exits 2 rather than 1, having called no backend, and names the argument that is missing.
				expect(errExit).toHaveBeenCalledWith(2)
				expect(logs.join('\n')).toContain('pane')
				expect(drives(calls)).toEqual([])
			})

			it('an unknown flag is a usage error, and says what the valid flags are', async () => {
				const calls: string[][] = []
				const errExit = catchExit()
				await expect(
					run(buildProgram({ env: TMUX, exec: paneServer(calls, THREE) }), ['list', '--nope']),
				).rejects.toThrow('exit:2')
				expect(errExit).toHaveBeenCalledWith(2)
				const out = logs.join('\n')
				// Names the unrecognized flag, and lists that command's own valid flags so the agent
				// self-corrects without a second call.
				expect(out).toContain('--nope')
				expect(out).toContain('--format')
				// Called no backend and listed nothing.
				expect(drives(calls)).toEqual([])
			})

			it('--help is never an unknown flag', async () => {
				const errExit = catchExit()
				captureStderr()
				const out: string[] = []
				vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
					out.push(String(line))
					return true
				})
				// Help is written to stdout and it exits 0 — no flag validation rejects it.
				await expect(run(buildProgram({ env: TMUX, exec: paneServer([], THREE) }), ['list', '--help'])).rejects.toThrow(
					'exit:0',
				)
				expect(errExit).toHaveBeenCalledWith(0)
				expect(`${out.join('')}${logs.join('\n')}`).not.toContain('unknown')
			})

			it('a structured error honors --format json', async () => {
				catchExit()
				const stderr = captureStderr()
				await withArgv(['list', '--format', 'json'], () =>
					expect(run(buildProgram({ env: {}, exec: noAncestry }), ['list', '--format', 'json'])).rejects.toThrow(
						'exit:1',
					),
				)
				// Emitted as JSON on stdout carrying the same stable code the readable form uses, no prose beside it.
				const parsed = JSON.parse(logs.join('\n'))
				expect(parsed.error.code).toBe('no-mux')
				expect(stderr.join('')).toBe('')
			})

			it("a failed verb's stdout is its structured error alone, with no result before it", async () => {
				catchExit()
				captureStderr()
				const out: string[] = []
				vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
					out.push(String(line))
					return true
				})
				// A read whose capture fails: the backend throws, so there are no bytes for an error to land amid.
				await expect(
					run(buildProgram({ env: TMUX, exec: throwingExec('', 'capture-pane: no such pane') }), ['read', '%1']),
				).rejects.toThrow('exit:1')
				// read writes the pane's raw bytes through process.stdout.write — none were written here.
				expect(out).toEqual([])
				// The structured error is the whole of stdout (on console.log), with no partial pane output before it.
				expect(logs.join('\n')).toContain('pane-not-found')
			})

			it("an error never leaks the multiplexer's own output", async () => {
				catchExit()
				captureStderr()
				const diagnostic = "can't find pane: %99 — tmux server error 3"
				await expect(
					run(buildProgram({ env: TMUX, exec: throwingExec('', diagnostic) }), ['focus', '%99']),
				).rejects.toThrow('exit:1')
				const out = logs.join('\n')
				// Translated into this CLI's own code and help...
				expect(out).toContain('pane-not-found')
				expect(out).toContain('cyber-mux list')
				// ...and the backend's raw text is not passed through as the message.
				expect(out).not.toContain("can't find pane")
				expect(out).not.toContain('tmux server error')
			})

			it('the worktree catch-all never forwards the multiplexer raw diagnostic either', async () => {
				catchExit()
				captureStderr()
				const diagnostic = 'no server running on /tmp/tmux-501/default'
				// git succeeds (the checkout is made); the plain `open()` that places its pane is what fails,
				// the same shape `session.tmux.ts` throws for any backend command failure.
				const exec: Exec = (cmd, args) => {
					if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
					exec.lastError = diagnostic
					return null
				}
				await expect(
					run(buildProgram({ env: TMUX, exec }), ['worktree', 'add', '--branch', 'my-feature', '--at', 'pane:right']),
				).rejects.toThrow('exit:1')
				const out = logs.join('\n')
				expect(out).toContain('worktree-failed')
				// Neither the backend's name nor its raw diagnostic reaches stdout.
				expect(out).not.toContain('tmux')
				expect(out).not.toContain(diagnostic)
			})
		})

		describe('--env, the CLI surface for the seam’s env option', () => {
			/** git (rev-parse only), tmux (keyed by verb), herdr (keyed by first two args) on one fake. */
			function envExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
				return (cmd, args) => {
					calls.push([cmd, ...args])
					if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
					if (cmd === 'tmux') return responses[args[0]!] ?? null
					return responses[args.slice(0, 2).join(' ')] ?? null
				}
			}

			/** herdr's worktree create/open envelope — carries the bound workspace and the worktree record. */
			const herdrWorktreeOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' },
					workspace: { workspace_id: 'w9' },
					worktree: { path: '/repo.worktrees/x', branch: 'my-feature' },
				},
			})

			/** The tmux opens (new-window/split-window) a verb produced — where env rides as a native `-e`. */
			function tmuxOpens(calls: string[][]) {
				return calls.filter((c) => c[0] === 'tmux' && (c[1] === 'new-window' || c[1] === 'split-window'))
			}

			const TMUX_OPEN_RESPONSES = { 'new-window': '%20\t@1', 'split-window': '%9\t@1' }

			// tmux carries env natively on every route: `open` sets it on the window, and the two worktree
			// verbs have no herdr-style bind, so they fall back to `git worktree add` + a plain `open` that
			// sets it just the same. The native `-e KEY=VALUE` is the proof.
			it.each([
				['open', ['open', '--at', 'workspace', '--env', 'ROLE=worker']],
				['worktree add', ['worktree', 'add', '--branch', 'my-feature', '--env', 'ROLE=worker']],
				['worktree open', ['worktree', 'open', '/repo.worktrees/x', '--env', 'ROLE=worker']],
			])('--env sets the variable in the pane the verb opens, on every route that carries env', async (_verb, argv) => {
				const calls: string[][] = []
				const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: envExec(calls, TMUX_OPEN_RESPONSES) })
				await run(program, argv)
				const opens = tmuxOpens(calls)
				expect(opens.length).toBeGreaterThan(0)
				expect(opens.some((c) => c.includes('-e') && c.includes('ROLE=worker'))).toBe(true)
			})

			it.each([
				['open', ['open', '--at', 'workspace', '--env', 'ROLE=worker', '--env', 'TIER=gpu']],
				['worktree add', ['worktree', 'add', '--branch', 'my-feature', '--env', 'ROLE=worker', '--env', 'TIER=gpu']],
				['worktree open', ['worktree', 'open', '/repo.worktrees/x', '--env', 'ROLE=worker', '--env', 'TIER=gpu']],
			])('--env is repeatable, one variable per flag, on every verb that has it', async (_verb, argv) => {
				const calls: string[][] = []
				const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: envExec(calls, TMUX_OPEN_RESPONSES) })
				await run(program, argv)
				const opens = tmuxOpens(calls)
				expect(opens.some((c) => c.includes('ROLE=worker'))).toBe(true)
				expect(opens.some((c) => c.includes('TIER=gpu'))).toBe(true)
			})

			it.each([
				['open', ['open', '--at', 'workspace', '--env', 'ROLE=']],
				['worktree add', ['worktree', 'add', '--branch', 'my-feature', '--env', 'ROLE=']],
				['worktree open', ['worktree', 'open', '/repo.worktrees/x', '--env', 'ROLE=']],
			])('--env with an empty value sets the variable empty, rather than rejecting', async (_verb, argv) => {
				const calls: string[][] = []
				const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: envExec(calls, TMUX_OPEN_RESPONSES) })
				await run(program, argv)
				// `${k}=${v}` with an empty value is exactly `ROLE=` — set, not rejected, not dropped.
				expect(tmuxOpens(calls).some((c) => c.includes('ROLE='))).toBe(true)
			})

			// The split point is OBSERVABLE only where key and value are emitted separately — the shell
			// prefix on herdr's worktree bind route, which quotes the VALUE alone: `env URL='k=v'` (first
			// split) vs `env URL=k='v'` (last split) differ, so the two worktree rows pin the split. `open`
			// never takes that route: on the native `-e KEY=VALUE` / `--env KEY=VALUE` flag the adapter
			// emits `${key}=${value}`, which reassembles to `URL=k=v` whatever the split, and the OS
			// re-splits on the first `=` regardless — so the pane carries URL=k=v either way. That is not a
			// coverage hole but a property: for `open` the split is behaviorally invariant, so its row
			// verifies its actual oracle — the =-bearing value reaches the pane intact — which a resolver
			// that dropped the value or truncated at the first `=` would fail.
			it.each<{ verb: string; drive: () => Promise<string[][]>; check: (calls: string[][]) => void }>([
				{
					verb: 'open',
					drive: async () => {
						const calls: string[][] = []
						const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: envExec(calls, TMUX_OPEN_RESPONSES) })
						await run(program, ['open', '--at', 'workspace', '--env', 'URL=k=v'])
						return calls
					},
					check: (calls) => expect(tmuxOpens(calls).some((c) => c.includes('-e') && c.includes('URL=k=v'))).toBe(true),
				},
				{
					verb: 'worktree add',
					drive: async () => {
						const calls: string[][] = []
						const program = buildProgram({
							env: { CYBER_MUX: 'herdr' },
							exec: envExec(calls, { 'worktree create': herdrWorktreeOut }),
						})
						await run(program, ['worktree', 'add', '--branch', 'my-feature', '--env', 'URL=k=v', '--launch', 'claude'])
						return calls
					},
					check: (calls) =>
						expect(calls.find((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'run')?.[4]).toBe(
							"env URL='k=v' claude",
						),
				},
				{
					verb: 'worktree open',
					drive: async () => {
						const calls: string[][] = []
						const program = buildProgram({
							env: { CYBER_MUX: 'herdr' },
							exec: envExec(calls, { 'worktree open': herdrWorktreeOut }),
						})
						await run(program, ['worktree', 'open', '/repo.worktrees/x', '--env', 'URL=k=v', '--launch', 'claude'])
						return calls
					},
					check: (calls) =>
						expect(calls.find((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'run')?.[4]).toBe(
							"env URL='k=v' claude",
						),
				},
			])('an env value containing = splits on the first = only', async ({ drive, check }) => {
				check(await drive())
			})

			// herdr's worktree bind is the one route that cannot set env at birth, so `--env` with a command
			// to ride on rides in as an `env KEY=VALUE` prefix on the `pane run` the launch lowers to.
			it.each([
				[
					'worktree add',
					['worktree', 'add', '--branch', 'my-feature', '--env', 'ROLE=worker', '--launch', 'claude'],
					'worktree create',
				],
				[
					'worktree open',
					['worktree', 'open', '/repo.worktrees/x', '--env', 'ROLE=worker', '--launch', 'claude'],
					'worktree open',
				],
			])('--env on the one route that cannot carry it rides in on --launch', async (_verb, argv, key) => {
				const calls: string[][] = []
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec: envExec(calls, { [key]: herdrWorktreeOut }) })
				await run(program, argv)
				const paneRun = calls.find((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'run')
				expect(paneRun?.[4]).toBe("env ROLE='worker' claude")
			})

			it.each([
				['worktree add', ['worktree', 'add', '--branch', 'my-feature', '--env', 'ROLE=worker'], 'worktree create'],
				['worktree open', ['worktree', 'open', '/repo.worktrees/x', '--env', 'ROLE=worker'], 'worktree open'],
			])('--env on the one route that cannot carry it, with no command to ride, warns', async (_verb, argv, key) => {
				const stderr: string[] = []
				vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
					stderr.push(String(line))
					return true
				})
				const calls: string[][] = []
				const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec: envExec(calls, { [key]: herdrWorktreeOut }) })
				await run(program, argv)
				// The variable genuinely did not land, and the caller is told which one — not left to guess.
				expect(stderr.join('')).toContain('ROLE')
				expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'run')).toBe(false)
			})

			it.each([
				['open', ['open', '--template', 'pool-4', '--env', 'ROLE=worker']],
				['worktree add', ['worktree', 'add', '--branch', 'my-feature', '--template', 'pool-4', '--env', 'ROLE=worker']],
			])("--env is refused alongside --template, which owns its own panes' env", async (_verb, argv) => {
				const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
				await expect(run(program, argv)).rejects.toThrow()
			})

			it.each([
				['open', 'ROLE'],
				['open', '=worker'],
				['worktree add', 'ROLE'],
				['worktree add', '=worker'],
				['worktree open', 'ROLE'],
				['worktree open', '=worker'],
			])('--env without a KEY=VALUE pair is rejected before any side effect', async (verb, bad) => {
				const argv =
					verb === 'open'
						? ['open', '--env', bad]
						: verb === 'worktree add'
							? ['worktree', 'add', '--branch', 'my-feature', '--env', bad]
							: ['worktree', 'open', '/repo.worktrees/x', '--env', bad]
				const calls: string[][] = []
				const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: envExec(calls) })
				await expect(run(program, argv)).rejects.toThrow()
				// Rejected in the arg parser, before the action runs — so no checkout, no pane, no exec at all.
				expect(calls).toEqual([])
			})

			it("worktree add --env defaults the placement to workspace, for --launch's reason", async () => {
				const calls: string[][] = []
				const program = buildProgram({
					env: { CYBER_MUX: 'herdr' },
					exec: envExec(calls, { 'worktree create': herdrWorktreeOut }),
				})
				await run(program, ['worktree', 'add', '--branch', 'my-feature', '--env', 'ROLE=worker'])
				// A bind route ran — a workspace opened, not the bare-git path an add with no pane request takes.
				expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'create')).toBe(true)
			})
		})
	})
})

describe('spec:cyber-mux/template', () => {
	const REPO_DIR = '/repo/.cyber-mux/templates'
	const USER_DIR = '/home/u/.config/cyber-mux/templates'
	/** Pinned, so the user directory is never the runner's real ~/.config. */
	const XDG = { XDG_CONFIG_HOME: '/home/u/.config' }

	const POOL_4 = { name: 'pool-4', arrange: 'tiled', panes: [{ label: 'w1' }, { label: 'w2' }] }

	/** The two-level form: a workspace of tabs, each carrying its own tree. */
	const POOL_TABS = {
		name: 'pool',
		tabs: [
			{ label: 'editor', panes: [{ label: 'edit' }] },
			{ label: 'logs', panes: [{ label: 'tail' }] },
		],
	}

	/** Three tabs — enough that a group which omits the first round-trips as a visibly wrong COUNT. */
	const POOL_TABS_3 = {
		name: 'pool',
		tabs: [
			{ label: 'editor', panes: [{ label: 'edit' }] },
			{ label: 'logs', panes: [{ label: 'tail' }] },
			{ label: 'shell', panes: [{ label: 'sh' }] },
		],
	}

	/**
	 * tmux with REAL window state — names, user options, and which window each pane sits in.
	 *
	 * Stateful on purpose: this scenario's second claim is that the workspace CAPTURES BACK, and a
	 * capture fed hand-written fixtures would assert what the fixture author already believed. Here
	 * the read side sees only what the walk actually wrote, so a tab the walk failed to tag is a tab
	 * the capture genuinely cannot find.
	 */
	function tmuxState() {
		const calls: string[][] = []
		const windows = new Map<string, { name: string; opts: Record<string, string> }>()
		const paneWindow = new Map<string, string>()
		let n = 0
		const exec: Exec = (cmd, args) => {
			calls.push([cmd, ...args])
			if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
			const [verb] = args
			if (verb === 'new-window') {
				const id = `@${n}`
				const pane = `%${n++}`
				const named = args.indexOf('-n')
				windows.set(id, { name: named === -1 ? 'zsh' : args[named + 1]!, opts: {} })
				paneWindow.set(pane, id)
				return `${pane}\t${id}`
			}
			if (verb === 'split-window') {
				// A split opens no window of its own — it lands in the window its target pane sits in.
				const at = args.indexOf('-t')
				const host = paneWindow.get(args[at + 1]!)!
				const pane = `%${n++}`
				paneWindow.set(pane, host)
				return `${pane}\t${host}`
			}
			if (verb === 'set-option') {
				windows.get(args[3]!)!.opts[args[4]!] = args[5]!
				return ''
			}
			if (verb === 'rename-window') {
				windows.get(args[2]!)!.name = args[3]!
				return ''
			}
			if (verb === 'display-message') {
				const id = paneWindow.get(args[3]!)!
				const w = windows.get(id)!
				return [id, w.opts['@cm_ws'] ?? '', w.opts['@cm_tab'] ?? '', w.name].join('\t')
			}
			if (verb === 'list-windows') {
				// `-f '#{==:#{@cm_ws},<group>}'` — the server-side filter, modeled as the filter it is.
				const group = args[args.indexOf('-f') + 1]!.replace(/^#\{==:#\{@cm_ws\},/, '').replace(/\}$/, '')
				return [...windows]
					.filter(([, w]) => w.opts['@cm_ws'] === group)
					.map(([id, w]) => [id, w.opts['@cm_tab'] ?? '', w.name].join('\t'))
					.join('\n')
			}
			if (verb === 'list-panes') {
				const id = args[2]!
				return [...paneWindow]
					.filter(([, w]) => w === id)
					.map(([p]) => `${p}\t0\t0\t200\t50\t/repo.worktrees/feat-x\tzeta\tzeta`)
					.join('\n')
			}
			return ''
		}
		return { exec, calls, windows }
	}

	/** The same, with a SPLIT in the first tab — so "built into the region" is observable in the argv. */
	const POOL_TABS_SPLIT = {
		name: 'pool',
		tabs: [
			{ label: 'editor', arrange: 'even-horizontal', panes: [{ label: 'edit' }, { label: 'test' }] },
			{ label: 'logs', panes: [{ label: 'tail' }] },
		],
	}

	/** A `TemplateStore` over an in-memory file map — no templates on disk, ever. */
	function fakeStore(
		files: Record<string, unknown>,
	): TemplateStore & { reads: string[]; writes: Record<string, string> } {
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

	describe('the walk, across tabs', () => {
		/**
		 * herdr, and herdr DELIBERATELY rather than tmux: the placement is the whole claim here, and tmux
		 * collapses `workspace` and `tab` onto the same Window — so `new-window` is what tmux emits at
		 * EITHER placement and could never tell the two apart. herdr has a real workspace tier and spells
		 * the tiers as different verbs (`workspace create` vs `tab create`), which is what makes the
		 * default observable at all.
		 */
		function tabsExec(calls: string[][], responses: Record<string, string> = {}): Exec {
			let n = 0
			let tab = 0
			return (cmd, args) => {
				calls.push([cmd, ...args])
				if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
				const key = args.slice(0, 2).join(' ')
				if (responses[key]) return responses[key]
				if (key === 'workspace create' || key === 'tab create') {
					tab++
					return JSON.stringify({
						result: { root_pane: { pane_id: `w1:p${n++}`, tab_id: `w1:t${tab}`, workspace_id: 'w1' } },
					})
				}
				// A split reports the tab it landed IN, never a new one.
				if (key === 'pane split') {
					return JSON.stringify({
						result: { pane: { pane_id: `w1:p${n++}`, tab_id: `w1:t${tab}`, workspace_id: 'w1' } },
					})
				}
				return ''
			}
		}

		it('a tabs template still defaults --at to workspace', async () => {
			// A fresh space is empty by construction, and a workspace is what a set of tabs needs to live
			// in — so the default does not change because the template grew a level.
			const calls: string[][] = []
			const store = fakeStore({ [repo('pool')]: POOL_TABS })
			const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'herdr' }, exec: tabsExec(calls), store })
			await run(program, ['open', '--template', 'pool'])
			const opens = calls.filter((c) => c[0] === 'herdr' && c[2] === 'create')
			// The FIRST tab lands at the workspace placement — a real `workspace create`, not a tab in
			// whatever workspace the caller happened to be sitting in.
			expect(opens[0]?.slice(1, 3)).toEqual(['workspace', 'create'])
			// ...and the second tab lands inside it.
			expect(opens[1]?.slice(1, 3)).toEqual(['tab', 'create'])
			// Nothing is ever split: a tab is not a split of another tab's pane.
			expect(calls.some((c) => c[1] === 'pane' && c[2] === 'split')).toBe(false)
		})

		// The route that opened the region cannot change what the template means. `worktree add --template`
		// has its region opened by the worktree verbs BEFORE the walk runs, so an option on `open` could
		// only ever have covered tabs 2..N — and a group missing the workspace's own first tab is worse
		// than no group, because the capture would confidently round-trip a 3-tab workspace as 2.
		it('a tabs template groups the same way whichever verb opened the workspace', async () => {
			const { exec, calls, windows } = tmuxState()
			const store = fakeStore({ [repo('pool')]: POOL_TABS_3 })
			// tmux: no worktree capability, so this route is plain git plus an `open` at the workspace
			// placement — the region exists before the walk ever sees it.
			const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec, store })
			await withArgv(['worktree', 'add', '--format', 'json'], () =>
				run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'pool', '--format', 'json']),
			)

			// Three tabs, three windows, and EVERY one of them carries a group — the first included.
			const tagged = [...windows.values()].map((w) => w.opts['@cm_ws'])
			expect(tagged).toHaveLength(3)
			expect(tagged.every(Boolean)).toBe(true)
			// The SAME group, not three groups that each happen to exist: a per-tab id would tag every
			// window and still split the workspace into three workspaces of one.
			expect(new Set(tagged).size).toBe(1)
			// The first tab is tagged by the same verb as the rest — one `set-option @cm_ws` per window,
			// nothing threaded through the worktree verbs to make it happen.
			expect(calls.filter((c) => c[1] === 'set-option' && c[5] === '@cm_ws')).toHaveLength(3)

			// And the workspace CAPTURES BACK with every tab it was built with. This is the claim the
			// bug broke: with the first tab left ungrouped, its window reads as an untagged workspace of
			// ONE and a 3-tab workspace round-trips as 1.
			// Captured from the region's own root pane — the pane the worktree open returned, exactly what
			// a caller sitting in that workspace would run `template save --workspace` from.
			const tabs = tmuxSessionAdapter.describeWorkspace!(exec, { id: '%0' })
			expect(tabs).toHaveLength(3)
			// Each tab's OWN name comes back, in template order — every tab it was built with.
			expect(captureWorkspaceTemplate(tabs, { name: 'captured' }).template.tabs?.map((t) => t.label)).toEqual([
				'editor',
				'logs',
				'shell',
			])
		})

		it("worktree add --template builds a tabs template into the worktree's own workspace", async () => {
			// This route already forces the workspace placement, so the tabs have a workspace to live in and
			// need no second one. It differs from `open --template` in exactly one way: the region already
			// exists, so the first tab builds INTO it rather than opening it.
			const calls: string[][] = []
			const store = fakeStore({ [repo('pool')]: POOL_TABS_SPLIT })
			const worktreeOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w9:root', tab_id: 'w9:t1', workspace_id: 'w9' },
					workspace: { workspace_id: 'w9' },
					worktree: { path: '/repo.worktrees/feat-x', branch: 'feat-x' },
				},
			})
			const program = buildProgram({
				env: { ...XDG, CYBER_MUX: 'herdr' },
				exec: tabsExec(calls, { 'worktree create': worktreeOut }),
				store,
			})
			await withArgv(['worktree', 'add', '--format', 'json'], () =>
				run(program, ['worktree', 'add', '--branch', 'feat-x', '--template', 'pool', '--format', 'json']),
			)

			// The worktree's own workspace is the ONLY workspace: no second one is opened for the tabs.
			expect(calls.find((c) => c[1] === 'worktree' && c[2] === 'create')).toBeDefined()
			expect(calls.filter((c) => c[1] === 'workspace' && c[2] === 'create')).toEqual([])
			// The first tab is built INTO that region: its split targets the workspace's own root pane.
			const splits = calls.filter((c) => c[1] === 'pane' && c[2] === 'split')
			expect(splits).toHaveLength(1)
			expect(splits[0]).toContain('w9:root')
			// Every later tab opens as a tab in it — one `tab create` for the one later tab.
			const tabs = calls.filter((c) => c[1] === 'tab' && c[2] === 'create')
			expect(tabs).toHaveLength(1)
			expect(tabs[0]).toEqual(expect.arrayContaining(['--label', 'logs']))

			// And the manifest is the whole workspace: both tabs' panes, one flat list, against the
			// worktree root.
			const out = JSON.parse(logs.join('\n'))
			expect(out.root).toBe('/repo.worktrees/feat-x')
			expect(out.workspace).toBe('w9')
			expect(out.panes.map((p: { label: string; tab: number }) => [p.label, p.tab])).toEqual([
				['edit', 0],
				['test', 0],
				['tail', 1],
			])
		})
	})

	describe('template save', () => {
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

		it('save writes to the repo templates directory and reports the path on stdout', async () => {
			const calls: string[][] = []
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
			await run(program, ['template', 'save', 'pool-3'])
			// stdout carries the written path as a structured payload — a `path` field, and NO help block,
			// because the caller's region is the whole workspace so nothing was left out. Programmatic
			// composition reads the path from `--format json | jq -r .path`, not this bare line.
			expect(logs).toEqual([`path  ${repo('pool-3')}`])
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
			// untouched pane. The hostname is checked against the whole written template below, so a broken
			// filter cannot hide anywhere.
			expect(written.root.first.first).toEqual({ type: 'pane' })
			expect(JSON.stringify(written)).not.toContain('zeta')
			// cwd is never in a template — it comes back as a relative dir under the captured root.
			expect(written.root.first.second).toEqual({ type: 'pane', label: 'watcher', dir: 'api' })
			expect(JSON.stringify(written)).not.toContain('/repo')
		})

		it('save captures the region around the calling pane, not the one the user is looking at', async () => {
			// The same reason `open`'s split names its pane: tmux's default is the ACTIVE pane, which
			// tracks the user rather than us. A bare `template save` must mean "the region I am in".
			const calls: string[][] = []
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store: fakeStore({}) })
			await run(program, ['template', 'save', 'pool-3'])
			expect(calls.find((c) => c[1] === 'list-panes')?.[2]).toBe('-t')
			expect(calls.find((c) => c[1] === 'list-panes')?.[3]).toBe('%0')
		})

		it('--from captures the region around a named pane', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store: fakeStore({}) })
			await run(program, ['template', 'save', 'pool-3', '--from', '%7'])
			// The REGION read (`list-panes -t <pane>`), not the `-a` server-wide lookup that resolves the
			// locator first — the region around %7 is what the capture is asserted to be about.
			expect(calls.find((c) => c[1] === 'list-panes' && c[2] === '-t')?.[3]).toBe('%7')
		})

		it('a captured template records in its own description that it is geometry only', async () => {
			// The honest limit of the verb. A saved template is a DRAFT, and the file says so itself,
			// since `template list` will show it beside finished ones.
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await run(program, ['template', 'save', 'pool-3'])
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
			await run(program, ['template', 'save', 'pool-3', '--description', 'the review pool'])
			expect(JSON.parse(store.writes[repo('pool-3')]!).description).toBe('the review pool')
		})

		it('--to user writes to the user templates directory instead', async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await run(program, ['template', 'save', 'pool-3', '--to', 'user'])
			expect(Object.keys(store.writes)).toEqual([user('pool-3')])
		})

		it('save refuses to overwrite an existing template, and reads no region finding out', async () => {
			// A saved template is hand-edited afterwards (the commands are added by hand), so silently
			// overwriting one would throw that work away. Checked BEFORE the capture, so the refusal
			// is free.
			catchExit()
			captureStderr()
			const calls: string[][] = []
			const store = fakeStore({ [repo('pool-3')]: POOL_4 })
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
			await expect(run(program, ['template', 'save', 'pool-3'])).rejects.toThrow('exit:1')
			expect(logs.join('\n')).toContain('--force to overwrite')
			expect(store.writes).toEqual({})
			expect(calls.some((c) => c[1] === 'list-panes')).toBe(false)
		})

		it('--force overwrites an existing template', async () => {
			const store = fakeStore({ [repo('pool-3')]: POOL_4 })
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await run(program, ['template', 'save', 'pool-3', '--force'])
			expect(JSON.parse(store.writes[repo('pool-3')]!).root).toBeDefined()
		})

		it('save validates the name before touching the filesystem or the multiplexer', async () => {
			// A name is a lookup key that must also be a filename — `../../etc/passwd` must never get
			// as far as being a path.
			catchExit()
			captureStderr()
			const calls: string[][] = []
			const store = fakeStore({})
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
			// A usage error now — the same malformed-name family show refuses at 2.
			await expect(run(program, ['template', 'save', '../escape'])).rejects.toThrow('exit:2')
			expect(logs.join('\n')).toContain('invalid template name')
			expect(store.writes).toEqual({})
			expect(calls).toEqual([])
		})

		it('save with no pane to capture around refuses rather than guessing', async () => {
			// No CYBER_MUX_PANE and no --from: this process is in no pane it can name. Falling back to the
			// backend's own default would capture whichever region the USER happens to be looking at and
			// save it under the name the caller asked for — a confident wrong answer, worse than none.
			catchExit()
			captureStderr()
			const calls: string[][] = []
			const store = fakeStore({})
			const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: saveExec(calls), store })
			// A required parameter is missing, not an operation that failed — a usage error (exit 2).
			await expect(run(program, ['template', 'save', 'pool-3'])).rejects.toThrow('exit:2')
			expect(logs.join('\n')).toContain('--from')
			expect(store.writes).toEqual({})
			// It never asked the backend for a region either — the refusal precedes the read.
			expect(calls.some((c) => c[1] === 'list-panes')).toBe(false)
		})

		it('a pane outside the captured root loses its dir and says so', async () => {
			// Bound at CLI level, not on the pure module: the scenario's Then names stderr and "the
			// template is still written", and neither is visible from captureTemplate's return value.
			const stderr = captureStderr()
			const store = fakeStore({})
			// The right-hand pane runs somewhere else entirely — a template cannot pin an absolute path.
			const exec = saveExec(
				[],
				['%0\t0\t0\t119\t50\t/repo\tzeta\tzeta', '%1\t120\t0\t80\t50\t/elsewhere\tzeta\tzeta'].join('\n'),
			)
			const program = buildProgram({ env: SAVE_ENV, exec, store })
			await run(program, ['template', 'save', 'pool-2'])
			expect(stderr.join('')).toContain('/elsewhere')
			expect(stderr.join('')).toContain('not under the captured root')
			// Still written, and that pane simply has no dir — the geometry is the verbose part.
			expect(JSON.parse(store.writes[repo('pool-2')]!).root.second).toEqual({ type: 'pane' })
			// The warning never reaches stdout: stdout carries only the structured payload (the `path`
			// field), so a diagnostic stays on stderr where it cannot corrupt `--format json | jq`.
			expect(logs).toEqual([`path  ${repo('pool-2')}`])
		})

		it('a label two panes share is captured onto both, because a human chose it', async () => {
			// Bound at CLI level for the same reason: the Then names what stderr does NOT carry.
			const stderr = captureStderr()
			const store = fakeStore({})
			// Both panes deliberately titled `worker` — neither is tmux's hostname default, so both are
			// labels a human set by hand, which is the exact fact the capture exists to preserve.
			const exec = saveExec(
				[],
				['%0\t0\t0\t119\t50\t/repo\tworker\tzeta', '%1\t120\t0\t80\t50\t/repo\tworker\tzeta'].join('\n'),
			)
			const program = buildProgram({ env: SAVE_ENV, exec, store })
			await run(program, ['template', 'save', 'pool-2'])
			const written = JSON.parse(store.writes[repo('pool-2')]!)
			// BOTH carry it — dropping either would report "no label" where there is one.
			expect(written.root.first).toEqual({ type: 'pane', label: 'worker' })
			expect(written.root.second).toEqual({ type: 'pane', label: 'worker' })
			// And nothing is said about it: a shared name is not a problem to warn a caller about.
			expect(stderr.join('')).toBe('')
			expect(logs).toEqual([`path  ${repo('pool-2')}`])
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
			await expect(run(program, ['template', 'save', 'pool-5'])).rejects.toThrow('exit:1')
			// Nothing written — a refusal must not leave a half-truth on disk.
			expect(store.writes).toEqual({})
		})

		it("a backend that cannot report its region's geometry refuses save cleanly", async () => {
			// describeRegion is OPTIONAL on the seam. Both real backends implement it, so the only way to
			// reach this branch is to take it away: stand in for a backend that never had it (a future
			// screen adapter, which fails the template floor on three other counts too). Restored in
			// `finally`, since the adapter is a module singleton every other test shares.
			catchExit()
			captureStderr()
			const store = fakeStore({})
			const original = tmuxSessionAdapter.describeRegion
			try {
				delete (tmuxSessionAdapter as { describeRegion?: unknown }).describeRegion
				const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
				await expect(run(program, ['template', 'save', 'pool-3'])).rejects.toThrow('exit:1')
			} finally {
				tmuxSessionAdapter.describeRegion = original
			}
			// Names the backend on stdout, so the reader knows WHICH mux cannot do this rather than that save broke.
			expect(logs.join('\n')).toContain('tmux')
			// Refuses rather than degrading: there is no half-geometry to fall back to.
			expect(store.writes).toEqual({})
		})
	})

	describe('capturing a whole workspace', () => {
		/**
		 * herdr, and herdr DELIBERATELY rather than tmux: every claim below turns on the workspace tier
		 * being real — "every tab of the caller's WORKSPACE", "the label its TAB carries" — and tmux
		 * collapses workspace and tab onto the same Window. A tmux binding would pass without ever
		 * exercising the distinction, which is a false green rather than a weaker one. The two scenarios
		 * that are ABOUT a backend with no workspace tier are bound on tmux below, where they belong.
		 *
		 * A live workspace `w1` of three tabs, shaped so each tab's tree is distinguishable from the
		 * others': a right split, a lone pane, and a down split. A capture that reused one tab's tree for
		 * every tab could not pass this fixture.
		 */
		const TABS_3 = [
			{ tab_id: 'w1:t1', label: 'editor' },
			{ tab_id: 'w1:t2', label: 'logs' },
			{ tab_id: 'w1:t3', label: 'shell' },
		]
		const PANES_3 = [
			{ pane_id: 'w1:p1', tab_id: 'w1:t1', cwd: '/repo', label: 'edit' },
			{ pane_id: 'w1:p2', tab_id: 'w1:t1', cwd: '/repo/api', label: 'api' },
			{ pane_id: 'w1:p3', tab_id: 'w1:t2', cwd: '/repo/logs' },
			{ pane_id: 'w1:p4', tab_id: 'w1:t3', cwd: '/repo' },
			{ pane_id: 'w1:p5', tab_id: 'w1:t3', cwd: '/repo' },
		]
		/** Rects as herdr reports them: screen-absolute, and no divider between panes. */
		const LAYOUT_OF: Record<string, Array<{ pane_id: string; rect: PaneRect }>> = {
			'w1:t1': [
				{ pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 120, height: 50 } },
				{ pane_id: 'w1:p2', rect: { x: 120, y: 0, width: 80, height: 50 } },
			],
			'w1:t2': [{ pane_id: 'w1:p3', rect: { x: 0, y: 0, width: 200, height: 50 } }],
			'w1:t3': [
				{ pane_id: 'w1:p4', rect: { x: 0, y: 0, width: 200, height: 30 } },
				{ pane_id: 'w1:p5', rect: { x: 0, y: 30, width: 200, height: 20 } },
			],
		}

		/** The two-tab cut of the same workspace, for the claims that are about two named tabs. */
		const TABS_2 = TABS_3.slice(0, 2)
		const PANES_2 = PANES_3.filter((p) => p.tab_id !== 'w1:t3')

		type HerdrTab = { tab_id: string; label?: string }
		type HerdrPane = { pane_id: string; tab_id: string; cwd?: string; label?: string }

		/** git, plus a herdr that answers the four verbs a workspace read walks. */
		function herdrWorkspaceExec(calls: string[][], workspace: { tabs: HerdrTab[]; panes: HerdrPane[] }): Exec {
			return (cmd, args) => {
				calls.push([cmd, ...args])
				if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
				const verb = args.slice(0, 2).join(' ')
				if (verb === 'pane get') {
					const pane = workspace.panes.find((p) => p.pane_id === args[2])
					return JSON.stringify({ result: { pane: { ...pane, workspace_id: 'w1' } } })
				}
				if (verb === 'tab list') return JSON.stringify({ result: { tabs: workspace.tabs } })
				if (verb === 'pane list') return JSON.stringify({ result: { panes: workspace.panes } })
				if (verb === 'pane layout') {
					// Geometry is per-PANE on herdr, so the answer is the region the named pane sits in.
					const tab = workspace.panes.find((p) => p.pane_id === args[3])?.tab_id
					return JSON.stringify({ result: { layout: { panes: tab ? LAYOUT_OF[tab] : [] } } })
				}
				return ''
			}
		}

		const WS_3 = { tabs: TABS_3, panes: PANES_3 }
		const WS_2 = { tabs: TABS_2, panes: PANES_2 }
		/** In herdr's workspace w1, in tab t1 — the caller of every test below. */
		const HERDR_ENV = { ...XDG, CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w1:p1' }

		/** The tree each tab of the fixture must capture back as — its own, not its neighbour's. */
		const TAB_1_TREE = {
			type: 'split',
			direction: 'right',
			ratio: 0.6,
			first: { type: 'pane', label: 'edit' },
			second: { type: 'pane', label: 'api', dir: 'api' },
		}
		const TAB_2_TREE = { type: 'pane', dir: 'logs' }
		const TAB_3_TREE = {
			type: 'split',
			direction: 'down',
			ratio: 0.6,
			first: { type: 'pane' },
			second: { type: 'pane' },
		}

		it("save --workspace captures every tab of the caller's workspace", async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
			await run(program, ['template', 'save', 'pool', '--workspace'])
			const written = JSON.parse(store.writes[repo('pool')]!)
			// The two-level form, not the one-level one — a workspace is tabs of panes.
			expect(written.tabs).toHaveLength(3)
			expect(written.root).toBeUndefined()
			// One tab per LIVE tab, EACH WITH THAT TAB'S OWN TREE. Asserted per tab rather than by count:
			// a capture that read the caller's region three times would have the right number of tabs and
			// the wrong contents, which is the failure worth catching.
			expect(written.tabs.map((t: { root: unknown }) => t.root)).toEqual([TAB_1_TREE, TAB_2_TREE, TAB_3_TREE])
		})

		it("save without --workspace captures only the caller's own region", async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
			await run(program, ['template', 'save', 'pool'])
			const written = JSON.parse(store.writes[repo('pool')]!)
			// The default subject is UNCHANGED — the caller sits in t1, and t1 is all that is captured.
			// Widening it silently would rewrite what `save` has always meant for every existing caller.
			expect(written.root).toEqual(TAB_1_TREE)
			expect(written.tabs).toBeUndefined()
		})

		it('a bare save in a multi-tab workspace says what it left out, in a help block on stdout', async () => {
			const stderr = captureStderr()
			const store = fakeStore({})
			const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
			await run(program, ['template', 'save', 'pool'])
			// stdout is a structured payload: the `path` field, then a help entry naming the tabs left out
			// and the command that captures them. Per axi/'s #9 the reveal rides on STDOUT in the payload,
			// not stderr the agent never reads — so a caller cannot believe a 3-tab workspace round-trips
			// from the 1-tab template they just saved.
			expect(logs[0]).toBe(`path  ${repo('pool')}`)
			const out = logs.join('\n')
			expect(out).toContain('3 tabs')
			expect(out).toContain('help[0]:')
			expect(out).toContain('cyber-mux template save pool --workspace')
			// Nothing on stderr — the note is load-bearing scope information, not a diagnostic.
			expect(stderr.join('')).toBe('')
		})

		it('--format json reports the saved path and any help as one structured object', async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
			await withArgv(['template', 'save', 'pool', '--format', 'json'], () =>
				run(program, ['template', 'save', 'pool', '--format', 'json']),
			)
			// The machine-readable half of the same payload: one JSON object carrying the path and a help
			// array, so a consumer reads `.path` and the next move from `.help` rather than parsing prose.
			const payload = JSON.parse(logs.join('\n'))
			expect(payload.path).toBe(repo('pool'))
			expect(Array.isArray(payload.help)).toBe(true)
			expect(payload.help[0].message).toContain('3 tabs')
			expect(payload.help[0].command).toBe('cyber-mux template save pool --workspace')
		})

		it('a captured tab keeps the label its tab carries', async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_2), store })
			await run(program, ['template', 'save', 'pool', '--workspace'])
			const written = JSON.parse(store.writes[repo('pool')]!)
			// The TAB's labels, not its panes' — the panes are labeled `edit`/`api`, so a capture reaching
			// for the wrong level cannot pass by coincidence.
			expect(written.tabs.map((t: { label?: string }) => t.label)).toEqual(['editor', 'logs'])
		})

		// The inverse property, on the backend that actually composes: tmux has ONE name field, so the
		// walk's `pool - editor` DESTROYED `editor`. Capture must read the own name back from where the
		// walk stored it — never by splitting the display name (unsound: the separator is ambiguous) and
		// never by taking it verbatim (which re-prefixes on every round trip).
		it("a captured tab's label is the tab's own name, never the composed one", async () => {
			const { exec, windows } = tmuxState()
			const store = fakeStore({ [repo('pool')]: POOL_TABS })
			const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec, store })
			// A workspace labeled pool, applied on tmux — so its tab DISPLAYS as "pool - editor".
			await run(program, ['open', '--template', 'pool'])
			const displayed = [...windows.values()].map((w) => w.name)
			expect(displayed).toEqual(['pool - editor', 'pool - logs'])

			// Captured with --workspace, from a pane in that workspace.
			const captured = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%0' }, exec, store })
			await run(captured, ['template', 'save', 'pool-copy', '--workspace'])
			const written: Template = JSON.parse(store.writes[repo('pool-copy')]!)
			// The captured tab is labeled `editor` — the tab's OWN name. Not "pool - editor", which is
			// what reading the window name verbatim would give.
			expect(written.tabs?.map((t) => t.label)).toEqual(['editor', 'logs'])

			// And re-applying the capture displays "pool - editor" AGAIN rather than compounding the
			// prefix. This is the assertion that matters: a capture that took the display name verbatim
			// would still round-trip a label, and would name this window "pool - pool - editor".
			const { exec: exec2, windows: windows2 } = tmuxState()
			const replay = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: exec2, store })
			await run(replay, ['open', '--template', 'pool-copy', '--label', 'pool'])
			expect([...windows2.values()].map((w) => w.name)).toEqual(['pool - editor', 'pool - logs'])
			// Said outright, because the compounding is the whole failure mode.
			expect([...windows2.values()].some((w) => w.name.includes('pool - pool'))).toBe(false)
		})

		it('a captured workspace is still a draft carrying no command', async () => {
			const store = fakeStore({})
			const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_2), store })
			await run(program, ['template', 'save', 'pool', '--workspace'])
			const written: Template = JSON.parse(store.writes[repo('pool')]!)
			// EVERY pane of EVERY tab — adding a level does not add a fact no multiplexer reports.
			const panes = (written.tabs ?? []).flatMap((tab) => collectPanes(resolveTree(tab)))
			expect(panes).not.toHaveLength(0)
			for (const pane of panes) expect(pane.command).toBeUndefined()
			// And the file says so ITSELF: `template list` shows this beside finished templates, so a note
			// that only reached the terminal that ran `save` would be gone by the time anyone read it.
			expect(written.description).toMatch(/geometry only/)
			expect(written.description).toMatch(/command/)
		})

		/**
		 * tmux, and tmux DELIBERATELY: this scenario is ABOUT a backend with no workspace tier. A window
		 * carrying no grouping tag is a workspace of one — the honest answer for a window nobody grouped.
		 */
		function untaggedTmuxExec(calls: string[][]): Exec {
			return (cmd, args) => {
				calls.push([cmd, ...args])
				if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
				// The tag field comes back EMPTY — tmux prints an unset user option as nothing at all.
				if (args[0] === 'display-message') return '@1\t\tzsh'
				if (args[0] === 'list-panes') {
					return ['%0\t0\t0\t119\t50\t/repo\tzeta\tzeta', '%1\t120\t0\t80\t50\t/repo/api\tzeta\tzeta'].join('\n')
				}
				return ''
			}
		}

		it('on a backend with no workspace tier, an untagged region captures as a single-tab workspace', async () => {
			const calls: string[][] = []
			const store = fakeStore({})
			const program = buildProgram({
				env: { ...XDG, CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%0' },
				exec: untaggedTmuxExec(calls),
				store,
			})
			await run(program, ['template', 'save', 'pool', '--workspace'])
			const written = JSON.parse(store.writes[repo('pool')]!)
			// Exactly one tab — not a refusal, and not an empty template. The caller's own window IS the
			// workspace, and it carries the region the caller is in.
			expect(written.tabs).toHaveLength(1)
			expect(written.tabs[0].root.type).toBe('split')
			// No window is grouped, so there is no group to enumerate — asked for, `list-windows` could
			// only over-collect every window on the server.
			expect(calls.some((c) => c[1] === 'list-windows')).toBe(false)
		})

		it("a backend that cannot enumerate a workspace's tabs refuses save --workspace cleanly", async () => {
			// describeWorkspace is OPTIONAL on the seam, exactly as describeRegion is. Both real backends
			// implement it, so the only way to reach this branch is to take it away: stand in for a backend
			// that never had it. Restored in `finally` — the adapter is a module singleton every other test
			// shares.
			catchExit()
			captureStderr()
			const store = fakeStore({})
			const original = tmuxSessionAdapter.describeWorkspace
			try {
				delete (tmuxSessionAdapter as { describeWorkspace?: unknown }).describeWorkspace
				const program = buildProgram({
					env: { ...XDG, CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%0' },
					exec: untaggedTmuxExec([]),
					store,
				})
				await expect(run(program, ['template', 'save', 'pool', '--workspace'])).rejects.toThrow('exit:1')
			} finally {
				tmuxSessionAdapter.describeWorkspace = original
			}
			// Names the backend on stdout, so the reader learns WHICH mux cannot do this rather than that save broke.
			expect(logs.join('\n')).toContain('tmux')
			// An absent optional member is a refusal, never a guess — so nothing lands on disk.
			expect(store.writes).toEqual({})
		})
	})
})
