import { homedir } from 'node:os'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.ts'
import type { Exec } from './exec.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { PaneRect } from './mux.ts'
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

describe('spec:cyber-mux/cli/worktree', () => {
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

	it('worktree-add-default-path', async () => {
		const calls: string[][] = []
		const exec = fakeGitExec(calls)
		const program = buildProgram({ env: {}, exec })
		await run(program, ['worktree', 'add', '--branch', 'my-feature'])
		expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'my-feature', '/repo.worktrees/my-feature'])
		expect(logs.join('\n')).toContain('/repo.worktrees/my-feature')
	})

	it('worktree-add-explicit-path', async () => {
		const calls: string[][] = []
		const exec = fakeGitExec(calls)
		const program = buildProgram({ env: {}, exec })
		await run(program, ['worktree', 'add', '--branch', 'my-feature', '--path', '/elsewhere/x'])
		expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'my-feature', '/elsewhere/x'])
	})

	it('worktree-remove-refuses-primary', async () => {
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('exit')
		})
		const exec = fakeGitExec([])
		const program = buildProgram({ env: {}, exec })
		await expect(run(program, ['worktree', 'remove', '/repo'])).rejects.toThrow()
	})

	it('worktree-add-bare-opens-nothing', async () => {
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

	describe('worktree provision (the CLI verb over provisionWorktree, default gate only)', () => {
		// Primary on main + one landed (merged, clean) linked worktree — the pool the verb recycles
		// from. Routes by verb so the seam's internal list/merged/status reads and the recycle/add
		// writes each get their own answer, plus the CLI's own rev-parse for the primary root.
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/landed',
			'branch refs/heads/feat/landed',
			'',
		].join('\n')
		const provisionGit =
			(calls: string[][], merged: string): Exec =>
			(_cmd, args) => {
				calls.push(args)
				if (args[0] === 'rev-parse') return '/repo/.git'
				if (args.includes('symbolic-ref')) return 'origin/main'
				if (args.includes('--merged')) return merged
				if (args[2] === 'status') return ''
				if (args[2] === 'worktree' && args[3] === 'list') return porcelain
				return ''
			}

		it('worktree-provision-reuses-free', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: {}, exec: provisionGit(calls, 'main\nfeat/landed') })
			await withArgv(['worktree', 'provision', '--branch', 'feat/new', '--format', 'json'], () =>
				run(program, ['worktree', 'provision', '--branch', 'feat/new', '--format', 'json']),
			)
			const payload = JSON.parse(logs.join('\n'))
			expect(payload.action).toBe('reused')
			expect(payload.branch).toBe('feat/new')
			// The recycled entry in full: its prior branch and the workspace it was open in.
			expect(payload.reused).toMatchObject({ root: '/repo.worktrees/landed', branch: 'feat/landed' })
			expect(payload.reused).toHaveProperty('workspace')
			// Reuse means NO new checkout, and a pristine reset of the recycled one.
			expect(calls.some((c) => c[2] === 'worktree' && c[3] === 'add')).toBe(false)
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed', 'switch', '-c', 'feat/new', 'origin/main'])
		})

		it('worktree-provision-creates-fresh', async () => {
			const calls: string[][] = []
			// Only the primary's own branch is merged — no linked worktree qualifies, so it creates.
			const program = buildProgram({ env: {}, exec: provisionGit(calls, 'main') })
			await withArgv(['worktree', 'provision', '--branch', 'feat/new', '--format', 'json'], () =>
				run(program, ['worktree', 'provision', '--branch', 'feat/new', '--format', 'json']),
			)
			const payload = JSON.parse(logs.join('\n'))
			expect(payload.action).toBe('created')
			expect(payload.reused).toBeNull()
			// Created at the sibling default, with plain git, recycling nothing.
			expect(calls).toContainEqual(['-C', '/repo', 'worktree', 'add', '-b', 'feat/new', '/repo.worktrees/feat/new'])
			expect(calls.some((c) => c[2] === 'switch')).toBe(false)
		})

		it('worktree-provision-base', async () => {
			const calls: string[][] = []
			const program = buildProgram({ env: {}, exec: provisionGit(calls, 'main\nfeat/landed') })
			await run(program, ['worktree', 'provision', '--branch', 'feat/new', '--base', 'release/1.0'])
			expect(calls).toContainEqual(['-C', '/repo.worktrees/landed', 'switch', '-c', 'feat/new', 'release/1.0'])
		})

		it('worktree-provision-path', async () => {
			const calls: string[][] = []
			// Nothing merged among linked worktrees → create, at the explicit --path rather than the sibling.
			const program = buildProgram({ env: {}, exec: provisionGit(calls, 'main') })
			await run(program, ['worktree', 'provision', '--branch', 'feat/new', '--path', '/custom/spot'])
			// Create with no --base: git's own default (HEAD), no base arg — the resolved-default-branch
			// fallback is the REUSE path's, not create's (see the worktree-provision ADR).
			expect(calls).toContainEqual(['-C', '/repo', 'worktree', 'add', '-b', 'feat/new', '/custom/spot'])
		})

		it('worktree-provision-no-predicate-injection', () => {
			const program = buildProgram({ env: {}, exec: () => null })
			const worktree = program.commands.find((c) => c.name() === 'worktree')!
			const provision = worktree.commands.find((c) => c.name() === 'provision')!
			const flags = provision.options.map((o) => o.long)
			expect(flags).toEqual(['--branch', '--base', '--path', '--format'])
			// The surface divergence: no flag reaches the seam's injectable `available` predicate.
			expect(flags.some((f) => /avail|predicate|gate|exclude/i.test(f ?? ''))).toBe(false)
		})
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

	it('worktree-add-at-workspace-grouping', async () => {
		const calls: string[][] = []
		const exec = fakeRepoExec(calls, { 'worktree create': worktreeOut })
		const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
		await run(program, ['worktree', 'add', '--branch', 'my-feature', '--at', 'workspace'])
		expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'create')).toBe(true)
		expect(logs.join('\n')).toContain('w9')
	})

	it('worktree-add-launch-defaults-workspace', async () => {
		const calls: string[][] = []
		const exec = fakeRepoExec(calls, { 'worktree create': worktreeOut })
		const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
		await run(program, ['worktree', 'add', '--branch', 'my-feature', '--launch', 'claude'])
		expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'create')).toBe(true)
		expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'run')).toBe(true)
	})

	it('worktree-add-lost-grouping-note', async () => {
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

	it('worktree-add-lost-grouping-note', async () => {
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

	it('worktree-open-groups-existing', async () => {
		const calls: string[][] = []
		const exec = fakeRepoExec(calls, { 'worktree open': worktreeOut })
		const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
		await run(program, ['worktree', 'open', '/repo.worktrees/my-feature'])
		expect(calls.some((c) => c[0] === 'herdr' && c[1] === 'worktree' && c[2] === 'open')).toBe(true)
		expect(logs.join('\n')).toContain('w9')
	})

	/**
	 * `worktree list` makes four distinct git reads, so a fake that answers every git call with the
	 * porcelain dump would also hand it to `status` and read every checkout as dirty. Route by verb,
	 * and default the two signal reads to "git could not say" so a test opts into a signal it means
	 * to assert on.
	 */
	const gitListExec =
		(
			porcelain: string,
			signals: { commonDir?: string; originHead?: string; merged?: string; dirty?: (root: string) => string } = {},
		): Exec =>
		(_cmd, args) => {
			if (args[0] === 'rev-parse') return signals.commonDir ?? '/repo/.git'
			if (args.includes('symbolic-ref')) return signals.originHead ?? null
			if (args.includes('branch')) return signals.merged ?? null
			if (args.includes('status')) return signals.dirty?.(args[1]!) ?? null
			return porcelain
		}

	it('worktree-list-reports-workspace', async () => {
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
		const gitExec = gitListExec(porcelain)
		const exec: Exec = (cmd, args) =>
			cmd === 'git' ? gitExec(cmd, args) : args.slice(0, 2).join(' ') === 'worktree list' ? bindings : ''
		const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
		await run(program, ['worktree', 'list'])
		const out = logs.join('\n')
		expect(out).toContain('main')
		expect(out).toContain('feat/x')
		expect(out).toContain('w21')
	})

	it('worktree-list-marks-one-bit-facts', async () => {
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/x',
			'branch refs/heads/feat/x',
			'',
		].join('\n')
		const exec = gitListExec(porcelain)
		const program = buildProgram({ env: {}, exec })
		await run(program, ['worktree', 'list'])
		const out = logs.join('\n')
		expect(out).toContain('main (*)')
		expect(out).not.toContain('feat/x (*)')
		expect(out).not.toContain('LINKED')
	})

	it('worktree-list-marks-one-bit-facts', async () => {
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/gone',
			'branch refs/heads/old',
			'prunable gitdir file points to non-existent location',
			'',
		].join('\n')
		const exec = gitListExec(porcelain)
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

	it('worktree-list-home-shortened', async () => {
		const home = homedir()
		const porcelain = [`worktree ${home}/code/app`, 'branch refs/heads/main', ''].join('\n')
		const exec = gitListExec(porcelain, { commonDir: `${home}/code/app/.git` })
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

	it('worktree-list-marker-not-in-payload', async () => {
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/x',
			'branch refs/heads/feat/x',
			'',
		].join('\n')
		const exec = gitListExec(porcelain)
		const program = buildProgram({ env: {}, exec })
		await withArgv(['worktree', 'list', '--format', 'json'], () =>
			run(program, ['worktree', 'list', '--format', 'json']),
		)
		const payload = JSON.parse(logs.join('\n'))
		expect(payload.worktrees.map((w: { linked: boolean }) => w.linked)).toEqual([false, true])
		expect(payload.worktrees[0].branch).toBe('main')
	})

	// The disposability composite: `worktree list` answers "is this still NEEDED", not just
	// "is it OCCUPIED", and compresses merged AND clean AND unoccupied to one BRANCH marker.
	describe('worktree list marks a disposable worktree `(removable)`', () => {
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo.worktrees/landed',
			'branch refs/heads/feat/landed',
			'',
			'worktree /repo.worktrees/open',
			'branch refs/heads/feat/open',
			'',
		].join('\n')
		const disposable = { originHead: 'origin/main', merged: 'main\nfeat/landed', dirty: () => '' }

		it('worktree-list-marks-removable', async () => {
			const program = buildProgram({ env: {}, exec: gitListExec(porcelain, disposable) })
			await run(program, ['worktree', 'list'])
			const out = logs.join('\n')
			expect(out).toContain('feat/landed (removable)')
			// Unmerged work is not disposable, and the primary checkout is never disposable —
			// `(removable)` and `(*)` are mutually exclusive, so BRANCH never carries two markers.
			expect(out).not.toContain('feat/open (removable)')
			expect(out).toContain('main (*)')
			expect(out).not.toContain('main (removable)')
		})

		it('worktree-list-marks-removable', async () => {
			const bindings = JSON.stringify({
				result: { worktrees: [{ path: '/repo.worktrees/landed', open_workspace_id: 'w21' }] },
			})
			const gitExec = gitListExec(porcelain, disposable)
			const exec: Exec = (cmd, args) =>
				cmd === 'git' ? gitExec(cmd, args) : args.slice(0, 2).join(' ') === 'worktree list' ? bindings : ''
			const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec })
			await run(program, ['worktree', 'list'])
			expect(logs.join('\n')).not.toContain('(removable)')
		})

		it('worktree-list-marks-removable', async () => {
			const exec = gitListExec(porcelain, {
				...disposable,
				dirty: (root) => (root.endsWith('landed') ? ' M a.ts' : ''),
			})
			await run(buildProgram({ env: {}, exec }), ['worktree', 'list'])
			expect(logs.join('\n')).not.toContain('(removable)')
		})

		it('worktree-list-no-composite-field', async () => {
			const program = buildProgram({ env: {}, exec: gitListExec(porcelain, disposable) })
			await withArgv(['worktree', 'list', '--format', 'json'], () =>
				run(program, ['worktree', 'list', '--format', 'json']),
			)
			const payload = JSON.parse(logs.join('\n'))
			expect(payload.worktrees.map((w: { merged: boolean }) => w.merged)).toEqual([true, true, false])
			expect(payload.worktrees.map((w: { dirty: boolean }) => w.dirty)).toEqual([false, false, false])
			// The composite is the TABLE's compression, never a field — a consumer that wants a
			// different policy (ignore occupancy, say) must not inherit this one from the payload.
			expect(payload.worktrees.every((w: Record<string, unknown>) => !('removable' in w))).toBe(true)
			expect(logs.join('\n')).not.toContain('(removable)')
		})

		it('worktree-list-undeterminable-not-removable', async () => {
			// A detached HEAD, a prunable entry, and no origin/HEAD to measure against — the listing
			// still renders, with no field guessed and no row wrongly marked disposable.
			const awkward = [
				'worktree /repo',
				'detached',
				'',
				'worktree /repo.worktrees/spike',
				'detached',
				'',
				'worktree /repo.worktrees/gone',
				'branch refs/heads/old',
				'prunable gitdir file points to non-existent location',
				'',
			].join('\n')
			const program = buildProgram({ env: {}, exec: gitListExec(awkward) })
			await run(program, ['worktree', 'list'])
			const out = logs.join('\n')
			expect(out).toContain('(detached)')
			expect(out).toContain('/repo.worktrees/gone (gone)')
			expect(out).not.toContain('(removable)')

			logs.length = 0
			await withArgv(['worktree', 'list', '--format', 'json'], () =>
				run(program, ['worktree', 'list', '--format', 'json']),
			)
			const payload = JSON.parse(logs.join('\n'))
			expect(payload.worktrees).toHaveLength(3)
			expect(payload.worktrees.every((w: Record<string, unknown>) => w['merged'] === undefined)).toBe(true)
			// The prunable row has no working tree to read, so `dirty` is absent rather than false.
			expect(payload.worktrees[2].dirty).toBeUndefined()
		})
	})

	it('worktree-list-answers-outside-mux', async () => {
		const porcelain = ['worktree /repo', 'branch refs/heads/main', ''].join('\n')
		const exec = gitListExec(porcelain)
		const program = buildProgram({ env: {}, exec })
		await run(program, ['worktree', 'list'])
		expect(logs.join('\n')).toContain('main')
	})

	describe('worktree prune', () => {
		// This module's own directory stands in for "a worktree that exists on disk" — the CLI's
		// remove path checks existence for real (no injected fs at this boundary), so the removal
		// half needs a real path; the primary and every git answer are still fully faked.
		// realpathSync (which normalization runs through) strips the trailing slash `import.meta.url`
		// leaves on a directory, so the normalized form is the one every later comparison uses.
		const realExistingDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '')

		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			`worktree ${realExistingDir}`,
			'branch refs/heads/feat/landed',
			'',
			'worktree /repo.worktrees/open',
			'branch refs/heads/feat/open',
			'',
		].join('\n')
		const disposable = { originHead: 'origin/main', merged: 'main\nfeat/landed', dirty: () => '' }

		it('worktree-prune-preview', async () => {
			const calls: string[][] = []
			const gitExec = gitListExec(porcelain, disposable)
			const exec: Exec = (cmd, args) => {
				calls.push(args)
				return gitExec(cmd, args)
			}
			const program = buildProgram({ env: {}, exec })
			await run(program, ['worktree', 'prune'])
			expect(logs.join('\n')).toContain('feat/landed')
			expect(logs.join('\n')).not.toContain('feat/open')
			expect(calls.some((args) => args.includes('remove'))).toBe(false)
		})

		it('worktree-prune-force-removes', async () => {
			const calls: string[][] = []
			const gitExec = gitListExec(porcelain, disposable)
			const exec: Exec = (cmd, args) => {
				calls.push(args)
				return gitExec(cmd, args)
			}
			const program = buildProgram({ env: {}, exec })
			await run(program, ['worktree', 'prune', '--force'])
			expect(calls.at(-1)).toEqual(['-C', '/repo', 'worktree', 'remove', realExistingDir, '--force'])
		})

		it('worktree-prune-force-removes', async () => {
			const exec = gitListExec(porcelain, disposable)
			const program = buildProgram({ env: {}, exec })
			await withArgv(['worktree', 'prune', '--format', 'json'], () =>
				run(program, ['worktree', 'prune', '--format', 'json']),
			)
			const payload = JSON.parse(logs.join('\n'))
			expect(payload.applied).toBe(false)
			expect(payload.removed).toHaveLength(1)
			expect(payload.skipped).toHaveLength(1)
			expect(payload.skipped[0].root).toBe('/repo.worktrees/open')
			expect(payload.skipped[0].reason).toMatch(/not merged/)
		})
	})

	// ── worktree add --env (CLI surface) ──
	/** git (rev-parse only), tmux (keyed by verb), herdr (keyed by first two args) on one fake. */
	function envExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
		return (cmd, args) => {
			calls.push([cmd, ...args])
			if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
			if (cmd === 'tmux') return responses[args[0]!] ?? null
			return responses[args.slice(0, 2).join(' ')] ?? null
		}
	}
	const herdrWorktreeOut = JSON.stringify({
		result: {
			root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' },
			workspace: { workspace_id: 'w9' },
			worktree: { path: '/repo.worktrees/x', branch: 'my-feature' },
		},
	})
	it('worktree-add-env-defaults-workspace', async () => {
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

// Not a spec node itself — a grouping of cli-driven tests whose per-node spec wrappers live within,
// so the bridge attributes each to its leaf library node rather than being shadowed by a coarse `mux`.
describe('cyber-mux/mux — cli-driven library surface', () => {
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

		// Nothing is looked up to answer this: the backend said so when the pane was born and the seam
		// carries it, so a report that omitted it would be discarding a fact already in hand. That is
		// what makes a caller able to group the panes it holds by the space they occupy.
		describe('spec:cyber-mux/mux/placement', () => {
			it('placement-open-reports-workspace-with-pane', async () => {
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
			})

			describe('show --desugar', () => {
				it('without --desugar prints the template as written, sugar and all', async () => {
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store })
					await run(program, ['template', 'show', 'pool-4'])
					expect(JSON.parse(logs.join('\n'))).toEqual(POOL_4)
				})
			})

			describe('template edit', () => {
				/** A scripted human: hands back `lines` in order, then EOF. Records what it was asked. */
				function fakePrompt(lines: (string | undefined)[]) {
					const asked: { question: string; initial?: string | undefined }[] = []
					// A plain mutable object, never getters on the function itself: `Object.assign` would copy a
					// getter's VALUE at assign time and freeze both counters at zero.
					const count = { opened: 0, closed: 0 }
					const open = () => {
						count.opened++
						return {
							async ask(question: string, initial?: string) {
								asked.push({ question, initial })
								return lines.shift()
							},
							close() {
								count.closed++
							},
						}
					}
					return Object.assign(open, { asked, count })
				}

				/**
				 * `edit` refuses a non-tty, so every test here has to claim one.
				 *
				 * Defined rather than spied: under vitest `process.stdin.isTTY` is absent entirely (the runner
				 * has no terminal), and `vi.spyOn` cannot stub a property that does not exist. Deleted again in
				 * `afterEach` so the runner's own stdin is left exactly as it was found.
				 */
				function setTty(value: boolean) {
					Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
				}
				const withTty = () => setTty(true)

				afterEach(() => {
					delete (process.stdin as { isTTY?: boolean }).isTTY
				})

				const DRAFT = {
					name: 'draft',
					arrange: 'tiled',
					panes: [{ label: 'w1' }, { label: 'w2', dir: 'apps/web' }],
				}

				it('asks once per pane and writes the answers back', async () => {
					withTty()
					const prompt = fakePrompt(['claude', 'pnpm dev'])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive'])
					expect(prompt.asked).toHaveLength(2)
					expect(JSON.parse(store.writes[repo('draft')]!).panes).toEqual([
						{ label: 'w1', command: 'claude' },
						{ label: 'w2', dir: 'apps/web', command: 'pnpm dev' },
					])
				})

				it('pre-fills the current value, so a small change is an edit not a retype', async () => {
					withTty()
					const filled = { name: 'draft', panes: [{ label: 'w1', command: 'claude' }] }
					const prompt = fakePrompt(['claude --resume'])
					const store = fakeStore({ [repo('draft')]: filled })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive'])
					expect(prompt.asked[0]?.initial).toBe('claude')
				})

				it('names each pane by its ordinal and shows the fields that identify it', async () => {
					withTty()
					const prompt = fakePrompt(['a', 'b'])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive'])
					expect(prompt.asked[0]?.question).toContain('pane 1')
					expect(prompt.asked[1]?.question).toContain('pane 2')
					// The dir tells two otherwise identical panes apart; the field being asked for is named.
					expect(prompt.asked[1]?.question).toContain('dir: apps/web')
					expect(prompt.asked[1]?.question).toContain('command?')
				})

				it('writes NOTHING when every pane was kept', async () => {
					// A template is checked in; a walk the author pressed Enter through must not dirty it.
					withTty()
					const prompt = fakePrompt(['', ''])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive'])
					expect(store.writes).toEqual({})
					expect(logs.join('\n')).toMatch(/changed\s+0/)
				})

				it('Ctrl-D abandons the edit and writes nothing, even mid-walk', async () => {
					catchExit()
					withTty()
					const stderr = captureStderr()
					// Answered the first pane, then left.
					const prompt = fakePrompt(['claude', undefined])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await expect(run(program, ['template', 'edit', 'draft', '--interactive'])).rejects.toThrow('exit:1')
					expect(store.writes).toEqual({})
					expect(stderr.join('') + logs.join('\n')).toContain('edit-aborted')
				})

				it('releases the terminal even when the walk throws', async () => {
					// The prompt owns stdin — leaving it open would hang the process at exit with no output.
					catchExit()
					withTty()
					captureStderr()
					const prompt = fakePrompt([undefined])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await expect(run(program, ['template', 'edit', 'draft', '--interactive'])).rejects.toThrow('exit:1')
					expect(prompt.count).toEqual({ opened: 1, closed: 1 })
				})

				it('refuses a non-tty rather than blocking on a pipe forever', async () => {
					catchExit()
					setTty(false)
					const stderr = captureStderr()
					const prompt = fakePrompt([])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					// A usage error (exit 2): the invocation itself cannot work, nothing was attempted.
					await expect(run(program, ['template', 'edit', 'draft', '--interactive'])).rejects.toThrow('exit:2')
					expect(prompt.count.opened).toBe(0)
					expect(stderr.join('') + logs.join('\n')).toContain('not-interactive')
				})

				it('--dry-run prints the edited template and writes nothing', async () => {
					withTty()
					const prompt = fakePrompt(['claude', ''])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive', '--dry-run'])
					expect(store.writes).toEqual({})
					expect(JSON.parse(logs.join('\n')).panes[0]).toEqual({ label: 'w1', command: 'claude' })
				})

				it('--field label edits labels instead', async () => {
					withTty()
					const prompt = fakePrompt(['planner', 'runner'])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive', '--field', 'label'])
					expect(prompt.asked[0]?.question).toContain('label?')
					expect(JSON.parse(store.writes[repo('draft')]!).panes[0]).toEqual({ label: 'planner' })
				})

				it('keeps a flat template flat', async () => {
					// The spelling rule at the CLI seam: `panes`/`arrange` survive, no `root` appears.
					withTty()
					const prompt = fakePrompt(['claude', 'pnpm dev'])
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive'])
					const written = JSON.parse(store.writes[repo('draft')]!)
					expect(written.arrange).toBe('tiled')
					expect(written.root).toBeUndefined()
				})

				it('refuses an invalid template BEFORE asking anything', async () => {
					// Resolution validates on read, so a template that would not apply never reaches the walk —
					// which matters here more than elsewhere: the cost of finding out late is a human having
					// typed a command into every pane for nothing.
					catchExit()
					withTty()
					captureStderr()
					const prompt = fakePrompt(['claude'])
					// `cwd` is not in the schema — a template carrying one fails validation outright.
					const store = fakeStore({ [repo('draft')]: { name: 'draft', panes: [{ label: 'w1', cwd: '/tmp' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await expect(run(program, ['template', 'edit', 'draft', '--interactive'])).rejects.toThrow('exit:1')
					expect(prompt.count.opened).toBe(0)
					expect(store.writes).toEqual({})
				})

				it('needs a name or --file, like every other template verb', async () => {
					catchExit()
					withTty()
					captureStderr()
					const store = fakeStore({})
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
					await expect(run(program, ['template', 'edit'])).rejects.toThrow('exit:2')
				})

				it('groups a tabs template by tab, restarting the ordinal in each', async () => {
					withTty()
					const tabs = {
						name: 'two-tabs',
						tabs: [
							{ label: 'main', panes: [{ label: 'a' }] },
							{ label: 'docs', panes: [{ label: 'c' }] },
						],
					}
					const prompt = fakePrompt(['claude', 'pnpm docs'])
					const store = fakeStore({ [repo('two-tabs')]: tabs })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
					await run(program, ['template', 'edit', 'two-tabs', '--interactive'])
					expect(prompt.asked[0]?.question).toContain('pane 1')
					expect(prompt.asked[1]?.question).toContain('pane 1')
					const written = JSON.parse(store.writes[repo('two-tabs')]!)
					expect(written.tabs[0].panes[0].command).toBe('claude')
					expect(written.tabs[1].panes[0].command).toBe('pnpm docs')
				})

				describe('the bare form lists, and never mutates', () => {
					it('prints every pane with the identifier --set takes', async () => {
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await run(program, ['template', 'edit', 'draft'])
						const out = logs.join('\n')
						expect(out).toContain('PANE')
						expect(out).toContain('POSITION')
						// The listing writes nothing and asks nothing — an agent finding out what is there must
						// not change anything by looking.
						expect(store.writes).toEqual({})
					})

					it('the pane column is verbatim what --set accepts', async () => {
						// The whole point of the list-then-act loop: no derivation between the two calls.
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						const argv = ['template', 'edit', 'draft', '--format', 'json']
						await withArgv(argv, () => run(program, argv))
						const { panes } = JSON.parse(logs.join('\n'))
						expect(panes.map((p: { pane: string }) => p.pane)).toEqual(['1', '2'])
					})

					it('a tabs template addresses panes as tab.pane', async () => {
						const tabs = {
							name: 'two-tabs',
							tabs: [{ label: 'main', panes: [{ label: 'a' }, { label: 'b' }] }, { panes: [{ label: 'c' }] }],
						}
						const store = fakeStore({ [repo('two-tabs')]: tabs })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						const argv = ['template', 'edit', 'two-tabs', '--format', 'json']
						await withArgv(argv, () => run(program, argv))
						const { panes } = JSON.parse(logs.join('\n'))
						expect(panes.map((p: { pane: string }) => p.pane)).toEqual(['1.1', '1.2', '2.1'])
					})

					it('suggests what to do next, with a runnable command', async () => {
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						const argv = ['template', 'edit', 'draft', '--format', 'json']
						await withArgv(argv, () => run(program, argv))
						const { help } = JSON.parse(logs.join('\n'))
						// Both panes of DRAFT lack a command, and the fix names a real pane identifier.
						expect(help[0].message).toContain('2 of 2 panes have no command')
						expect(help[0].command).toBe('cyber-mux template edit draft --set 1=<command>')
						expect(help.some((h: { command: string }) => h.command.includes('--interactive'))).toBe(true)
					})
				})

				describe('--set, the non-interactive path', () => {
					it('sets a pane without asking anything', async () => {
						const prompt = fakePrompt([])
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt })
						await run(program, ['template', 'edit', 'draft', '--set', '1=claude'])
						expect(prompt.count.opened).toBe(0)
						expect(JSON.parse(store.writes[repo('draft')]!).panes[0]).toEqual({ label: 'w1', command: 'claude' })
					})

					it('is repeatable, and applies every one', async () => {
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await run(program, ['template', 'edit', 'draft', '--set', '1=claude', '--set', '2=pnpm dev'])
						const written = JSON.parse(store.writes[repo('draft')]!)
						expect(written.panes[0].command).toBe('claude')
						expect(written.panes[1].command).toBe('pnpm dev')
						expect(logs.join('\n')).toMatch(/changed\s+2/)
					})

					it('keeps an "=" inside the value', async () => {
						// Split on the FIRST "=" only — a command carrying one is ordinary.
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await run(program, ['template', 'edit', 'draft', '--set', '1=FOO=bar make'])
						expect(JSON.parse(store.writes[repo('draft')]!).panes[0].command).toBe('FOO=bar make')
					})

					it('an empty value clears the field', async () => {
						const filled = { name: 'draft', panes: [{ label: 'w1', command: 'claude' }] }
						const store = fakeStore({ [repo('draft')]: filled })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await run(program, ['template', 'edit', 'draft', '--set', '1='])
						expect(JSON.parse(store.writes[repo('draft')]!).panes[0]).toEqual({ label: 'w1' })
					})

					it('re-setting the same value is a no-op that still exits 0', async () => {
						// AXI's idempotent-mutation rule: the desired state already holds, so acknowledge and move on.
						const filled = { name: 'draft', panes: [{ label: 'w1', command: 'claude' }] }
						const store = fakeStore({ [repo('draft')]: filled })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await run(program, ['template', 'edit', 'draft', '--set', '1=claude'])
						expect(store.writes).toEqual({})
						expect(logs.join('\n')).toMatch(/changed\s+0/)
					})

					it('a batch naming one bad pane writes NONE of them', async () => {
						// A partial application is the worst outcome available: the caller cannot tell which half
						// landed without re-reading the file.
						catchExit()
						const stderr = captureStderr()
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await expect(
							run(program, ['template', 'edit', 'draft', '--set', '1=claude', '--set', '9=nope']),
						).rejects.toThrow('exit:2')
						expect(store.writes).toEqual({})
						// Self-correcting in one turn: the error names every identifier that WOULD have worked.
						const out = stderr.join('') + logs.join('\n')
						expect(out).toContain('no pane "9"')
						expect(out).toContain('1, 2')
					})

					it('a malformed --set is rejected by name', async () => {
						catchExit()
						const stderr = captureStderr()
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await expect(run(program, ['template', 'edit', 'draft', '--set', 'claude'])).rejects.toThrow('exit:2')
						expect(stderr.join('') + logs.join('\n')).toContain('<pane>=<value>')
					})

					it('--set with --interactive is refused as malformed input', async () => {
						catchExit()
						captureStderr()
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await expect(
							run(program, ['template', 'edit', 'draft', '--set', '1=claude', '--interactive']),
						).rejects.toThrow('exit:2')
					})

					it('--field label routes --set to the label', async () => {
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await run(program, ['template', 'edit', 'draft', '--field', 'label', '--set', '1=planner'])
						expect(JSON.parse(store.writes[repo('draft')]!).panes[0]).toEqual({ label: 'planner' })
					})

					it('needs no tty — the whole point', async () => {
						setTty(false)
						const store = fakeStore({ [repo('draft')]: DRAFT })
						const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
						await run(program, ['template', 'edit', 'draft', '--set', '1=claude'])
						expect(JSON.parse(store.writes[repo('draft')]!).panes[0].command).toBe('claude')
					})
				})

				it('--interactive refuses --format json even on a tty', async () => {
					// A caller asking for machine output has said it is not a human.
					catchExit()
					withTty()
					const stderr = captureStderr()
					const store = fakeStore({ [repo('draft')]: DRAFT })
					const program = buildProgram({ env: XDG, exec: repoExec([]), store, prompt: fakePrompt([]) })
					const argv = ['template', 'edit', 'draft', '--interactive', '--format', 'json']
					await withArgv(argv, async () => {
						await expect(run(program, argv)).rejects.toThrow('exit:2')
					})
					expect(stderr.join('') + logs.join('\n')).toContain('not-interactive')
				})

				it('needs no multiplexer — its subject is a FILE', async () => {
					withTty()
					const calls: string[][] = []
					const prompt = fakePrompt([''])
					const store = fakeStore({ [repo('draft')]: { name: 'draft', panes: [{ label: 'w1' }] } })
					const program = buildProgram({ env: XDG, exec: repoExec(calls), store, prompt })
					await run(program, ['template', 'edit', 'draft', '--interactive'])
					expect(calls.every((c) => c[0] === 'git')).toBe(true)
				})
			})

			describe('--template, the exact sibling of --launch', () => {
				it('an explicit --label wins over the template name', async () => {
					const calls: string[][] = []
					const store = fakeStore({ [repo('pool-4')]: POOL_4 })
					const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
					await run(program, ['open', '--template', 'pool-4', '--label', 'my-pool'])
					expect(calls.find((c) => c[1] === 'new-window')).toEqual(expect.arrayContaining(['-n', 'my-pool']))
				})
			})

			describe('spec:cyber-mux/template/apply', () => {
				it('apply-open-template-unresolvable-no-region', async () => {
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

				it('apply-unresolved-name-no-worktree', async () => {
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

				it('apply-invalid-template-no-worktree', async () => {
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

				it('apply-no-multiplexer-fails', async () => {
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

		describe('spec:cyber-mux/mux/lookup', () => {
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
			it.each(VERBS)('lookup-verb-resolves-by-name', async ({ argv, store }) => {
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

			// An id and a label are not peers, so this is not a 2-candidate ambiguity — the id wins outright.
			it('lookup-id-outranks-label-collision', async () => {
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
			it('lookup-id-matched-not-by-shape', async () => {
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

			it('lookup-name-matches-one-resolves', async () => {
				const calls: string[][] = []
				const program = buildProgram({ env: TMUX, exec: paneServer(calls, THREE) })
				await run(program, ['close', 'worker'])
				expect(drives(calls)).toEqual([['kill-pane', '-t', '%1']])
				expect(touched(calls)).not.toContain('%2')
				expect(touched(calls)).not.toContain('%3')
			})

			// Not-found and ambiguous are different outcomes with different codes — 1, not 2.
			it('lookup-name-matches-none-not-found', async () => {
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

			it('lookup-name-matches-many-fails', async () => {
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
		})
	})
})

// Not a spec node itself — a grouping of cli-driven tests whose per-node spec wrappers live within,
// so the bridge attributes each to its leaf library node rather than being shadowed by a coarse `template`.
describe('cyber-mux/template — cli-driven library surface', () => {
	const REPO_DIR = '/repo/.cyber-mux/templates'
	/** Pinned, so the user directory is never the runner's real ~/.config. */
	const XDG = { XDG_CONFIG_HOME: '/home/u/.config' }

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
			const tabs = tmuxMuxAdapter.regions!.describeWorkspace(exec, { id: '%0' })
			expect(tabs).toHaveLength(3)
			// Each tab's OWN name comes back, in template order — every tab it was built with.
			expect(captureWorkspaceTemplate(tabs, { name: 'captured' }).template.tabs?.map((t) => t.label)).toEqual([
				'editor',
				'logs',
				'shell',
			])
		})
	})

	describe('spec:cyber-mux/template/capture', () => {
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

		it('capture-region-around-calling-pane', async () => {
			// The same reason `open`'s split names its pane: tmux's default is the ACTIVE pane, which
			// tracks the user rather than us. A bare `template save` must mean "the region I am in".
			const calls: string[][] = []
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store: fakeStore({}) })
			await run(program, ['template', 'save', 'pool-3'])
			expect(calls.find((c) => c[1] === 'list-panes')?.[2]).toBe('-t')
			expect(calls.find((c) => c[1] === 'list-panes')?.[3]).toBe('%0')
		})

		it('capture-description-notes-geometry-only', async () => {
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

		it('capture-shared-label-onto-both', async () => {
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
	})

	describe('spec:cyber-mux/template/capture', () => {
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

		const WS_2 = { tabs: TABS_2, panes: PANES_2 }
		/** In herdr's workspace w1, in tab t1 — the caller of every test below. */
		const HERDR_ENV = { ...XDG, CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w1:p1' }

		it('capture-tab-keeps-own-label', async () => {
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

		it('capture-workspace-still-draft-no-command', async () => {
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

		it('capture-untagged-region-single-tab-workspace', async () => {
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
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// CLI-surface nodes, hoisted top-level so the scenario bridge binds them by the
// first spec: segment. Each carries its own logs/spies and the helpers its moved
// tests need; test bodies are verbatim, retitled to their @id: scenario slug.
// ─────────────────────────────────────────────────────────────────────────────

describe('spec:cyber-mux/cli/detection', () => {
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

	it('@id:detection-doctor-reports-pin-hint', async () => {
		const program = buildProgram({ env: { CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%3' }, exec: noAncestry })
		await run(program, ['doctor'])
		const out = logs.join('\n')
		expect(out).toContain('tmux')
		expect(out).toContain('%3')
		expect(out).toContain('backend')
		expect(out).toContain('export CYBER_MUX=tmux CYBER_MUX_PANE=%3')
	})

	it('@id:detection-mode-reports-backend', async () => {
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
		await run(program, ['mode'])
		expect(logs).toEqual(['tmux'])
	})

	it('@id:detection-mode-none', async () => {
		const program = buildProgram({ env: { CYBER_MUX: 'none' }, exec: noAncestry })
		await expect(run(program, ['mode'])).resolves.toBeDefined()
		expect(logs).toEqual(['none'])
	})
})

describe('spec:cyber-mux/cli/driving', () => {
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

	it('@id:driving-send-keys-no-tokens', async () => {
		const calls: string[][] = []
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
		await expect(run(program, ['send', 'keys', '%3'])).rejects.toThrow()
		expect(calls).toEqual([])
	})

	it('@id:driving-send-text-no-text', async () => {
		const calls: string[][] = []
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: fakeTmuxExec(calls) })
		await expect(run(program, ['send', 'text', '%3'])).rejects.toThrow()
		expect(calls).toEqual([])
	})

	it('@id:driving-send-bare-group', async () => {
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

	it('@id:driving-submit-no-pane', async () => {
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

	// ── --at / --launch flag surface ──

	it('@id:placement-at-restricted-values', async () => {
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
		await expect(run(program, ['open', '--launch', 'claude', '--at', 'bogus'])).rejects.toThrow()
	})

	it('@id:placement-at-chooses-location', async () => {
		const calls: string[][] = []
		const exec = fakeTmuxExec(calls, { 'split-window': '%5\t@1' })
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
		await run(program, ['open', '--launch', 'claude', '--at', 'pane:down'])
		expect(calls[0]?.[0]).toBe('split-window')
		expect(calls[0]?.[1]).toBe('-v') // pane:down maps to a vertical split
	})

	it('@id:placement-launch-optional', async () => {
		const calls: string[][] = []
		const exec = fakeTmuxExec(calls, { 'new-window': '%2\t@1' })
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
		await run(program, ['open'])
		expect(calls).toHaveLength(1)
		expect(calls.some((c) => c[0] === 'send-keys')).toBe(false)
	})

	it('@id:placement-launch-handoff', async () => {
		const calls: string[][] = []
		const exec = fakeTmuxExec(calls, { 'new-window': '%2\t@1' })
		const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec })
		await run(program, ['open', '--launch', 'claude'])
		// Typed literally, then Enter — not left staged unsent.
		expect(calls[1]).toEqual(['send-keys', '-t', '%2', '-l', 'claude'])
		expect(calls[2]).toEqual(['send-keys', '-t', '%2', 'Enter'])
	})

	// ── --env flag surface ──

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
	])('@id:placement-env-sets-variable', async (_verb, argv) => {
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
	])('@id:placement-env-repeatable', async (_verb, argv) => {
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
	])('@id:placement-env-empty-value-allowed', async (_verb, argv) => {
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
	])('@id:placement-env-value-splits-first-equals', async ({ drive, check }) => {
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
	])('@id:placement-env-rides-on-launch', async (_verb, argv, key) => {
		const calls: string[][] = []
		const program = buildProgram({ env: { CYBER_MUX: 'herdr' }, exec: envExec(calls, { [key]: herdrWorktreeOut }) })
		await run(program, argv)
		const paneRun = calls.find((c) => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'run')
		expect(paneRun?.[4]).toBe("env ROLE='worker' claude")
	})

	it.each([
		['worktree add', ['worktree', 'add', '--branch', 'my-feature', '--env', 'ROLE=worker'], 'worktree create'],
		['worktree open', ['worktree', 'open', '/repo.worktrees/x', '--env', 'ROLE=worker'], 'worktree open'],
	])('@id:placement-env-warns-no-launch', async (_verb, argv, key) => {
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
	])('@id:placement-env-refused-with-template', async (_verb, argv) => {
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
	])('@id:placement-env-malformed-rejected', async (verb, bad) => {
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
})

describe('spec:cyber-mux/cli/lookup', () => {
	const REPO_DIR = '/repo/.cyber-mux/templates'
	const XDG = { XDG_CONFIG_HOME: '/home/u/.config' }
	function repo(name: string): string {
		return `${REPO_DIR}/${name}.json`
	}

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

	function captureStderr(): string[] {
		const lines: string[] = []
		vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
			lines.push(String(line))
			return true
		})
		return lines
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

	/** git (rev-parse + worktree) and tmux on one fake, each call recorded as [cmd, ...args]. */
	function repoExec(calls: string[][], responses: Record<string, string> = {}): Exec {
		let n = 0
		return (cmd, args) => {
			calls.push([cmd, ...args])
			if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
			if (cmd === 'tmux') {
				if (args[0] !== 'new-window' && args[0] !== 'split-window') return ''
				const id = n++
				return args.includes('#{pane_id}\t#{window_id}') ? `%${id}\t@${id}` : `%${id}`
			}
			const key = args.slice(0, 2).join(' ')
			if (key === 'pane split') return JSON.stringify({ result: { pane: { pane_id: `w9:p${n++}`, tab_id: 'w9:t1' } } })
			return responses[key] ?? ''
		}
	}

	// ── unknown-flag scope + partial apply, driven at the CLI (template family) ──

	it('@id:lookup-unknown-flag-subcommand-scope', async () => {
		// `--force` is a flag only `template save` defines; on `template list` it is unknown. Validating
		// against the GROUP's union would accept it here and silently drop it.
		catchExit()
		const store = fakeStore({})
		const program = buildProgram({ env: XDG, exec: repoExec([]), store })
		await expect(run(program, ['template', 'list', '--force'])).rejects.toThrow('exit:2')
		const out = logs.join('\n')
		expect(out).toContain('--force')
		expect(out).toContain('--format')
		expect(out).not.toContain('--from')
		expect(out).not.toContain('--workspace')
	})

	it('@id:lookup-partial-apply-one-payload', async () => {
		catchExit()
		const calls: string[][] = []
		// A 4-pane comb: the region, then three splits. The THIRD split is refused.
		let splits = 0
		const exec: Exec = (cmd, args) => {
			calls.push([cmd, ...args])
			if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
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
			await expect(run(program, ['open', '--template', 'render-farm', '--format', 'json'])).rejects.toThrow('exit:1')
		})
		const manifest = JSON.parse(logs.join('\n'))
		expect(manifest.panes.map((p: { label: string }) => p.label)).toEqual(['a', 'b', 'c'])
		expect(calls.some((c) => c[1] === 'kill-pane')).toBe(false)
	})

	// ── the pane-addressing verbs and the shared error contract (pane-server family) ──

	/** The hostname tmux hands an unnamed pane's title — the value the label rule must reject. */
	const HOST = 'zeta'

	interface FakePane {
		id: string
		label?: string
		cwd?: string
	}

	function paneServer(calls: string[][], panes: FakePane[], responses: Record<string, string | null> = {}): Exec {
		return (_cmd, args) => {
			calls.push(args)
			if (args[0] === 'list-panes' && args[1] === '-a') {
				const fmt = args[args.indexOf('-F') + 1]
				if (fmt === '#{pane_id}') return panes.map((p) => p.id).join('\n')
				if (fmt === '#{pane_id} #{session_name} #{window_id}') return panes.map((p) => `${p.id} main @1`).join('\n')
				return panes.map((p) => [p.id, 'zsh', p.cwd ?? '/repo', p.label ?? HOST, HOST].join('\t')).join('\n')
			}
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

	/** The same three panes, all sharing one label — the ambiguity every verb must refuse. */
	const ALL_WORKER: FakePane[] = [
		{ id: '%1', label: 'worker', cwd: '/repo/a' },
		{ id: '%2', label: 'worker', cwd: '/repo/b' },
		{ id: '%3', label: 'worker', cwd: '/repo/c' },
	]

	it.each(VERBS)('@id:lookup-ambiguous-locator-every-verb', async ({ argv, store }) => {
		const calls: string[][] = []
		const exit = catchExit()
		captureStderr()
		const program = buildProgram({
			env: store ? { ...TMUX, XDG_CONFIG_HOME: '/home/u/.config' } : TMUX,
			exec: paneServer(calls, ALL_WORKER, { 'capture-pane': 'out', 'list-panes': '', 'rev-parse': '/repo/.git' }),
			store: store ? saveStore() : undefined,
		})
		await expect(run(program, argv)).rejects.toThrow('exit:2')
		expect(logs.join('\n')).toContain('ambiguous-pane')
		expect(exit).toHaveBeenCalledWith(2)
		expect(touched(calls)).toEqual([])
	})

	it('@id:lookup-ambiguity-report-candidate-details', async () => {
		catchExit()
		captureStderr()
		const program = buildProgram({ env: TMUX, exec: paneServer([], ALL_WORKER) })
		await expect(run(program, ['close', 'worker'])).rejects.toThrow('exit:2')
		const err = logs.join('\n')
		for (const c of ALL_WORKER) {
			expect(err).toContain(c.id)
			expect(err).toContain(c.cwd!)
		}
		expect(err).toContain('worker')
		const retryCalls: string[][] = []
		const retry = buildProgram({ env: TMUX, exec: paneServer(retryCalls, ALL_WORKER) })
		await run(retry, ['close', '%2'])
		expect(drives(retryCalls)).toEqual([['kill-pane', '-t', '%2']])
	})

	it('@id:lookup-ambiguity-report-stdout-only', async () => {
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
		expect(logs.join('\n')).toContain('ambiguous-pane')
		expect(stderr.join('')).toBe('')
		expect(exit).toHaveBeenCalledWith(2)
	})

	it('@id:lookup-ambiguity-json-format', async () => {
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
		const parsed = JSON.parse(logs.join('\n'))
		expect(parsed.error.code).toBe('ambiguous-pane')
		expect(parsed.error.candidates).toEqual([
			{ id: '%1', label: 'worker', cwd: '/repo/a' },
			{ id: '%2', label: 'worker', cwd: '/repo/b' },
		])
		expect(stderr.join('')).toBe('')
	})

	it.each([
		{ world: 'exactly one live pane matches the locator', panes: THREE, stdout: 'live', code: 0 },
		{ world: 'no live pane matches the locator', panes: [{ id: '%2', label: 'sidebar' }], stdout: 'gone', code: 1 },
		{ world: 'two or more live panes match the locator', panes: ALL_WORKER, stdout: 'nothing', code: 2 },
	])('@id:lookup-exists-outcomes-by-exit-code', async ({ panes, stdout, code }) => {
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
			expect(logs.join('\n')).toContain('ambiguous-pane')
			expect(logs).not.toContain('live')
			expect(logs).not.toContain('gone')
		} else {
			expect(logs).toEqual([stdout])
		}
	})

	it('@id:lookup-exists-ambiguous-reports-candidates', async () => {
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
		expect(err).not.toContain('live')
		expect(err).not.toContain('gone')
	})

	/** A tmux whose list-panes reports `panes`, but whose every other command THROWS a backend diagnostic. */
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
	])('@id:lookup-failure-structured-error-per-code', async ({ make, argv, code, exit }) => {
		const errExit = catchExit()
		const stderr = captureStderr()
		await expect(run(make(), argv)).rejects.toThrow(`exit:${exit}`)
		const out = logs.join('\n')
		expect(out).toContain(code)
		expect(stderr.join('')).toBe('')
		expect(errExit).toHaveBeenCalledWith(exit)
		expect(out).toContain('help:')
		expect(out).not.toContain('see --help')
	})

	it('@id:lookup-failure-codes-distinct', async () => {
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
			expect(run(buildProgram({ env: {}, exec: noAncestry }), ['list', '--format', 'json'])).rejects.toThrow('exit:1'),
		)
		const noMuxCode = JSON.parse(logs.join('\n')).error.code
		expect(ambiguousCode).toBe('ambiguous-pane')
		expect(noMuxCode).toBe('no-mux')
		expect(ambiguousCode).not.toBe(noMuxCode)
	})

	it.each([['read'], ['focus'], ['send', 'text']])('@id:lookup-missing-arg-usage-error', async (...verb) => {
		const calls: string[][] = []
		const errExit = catchExit()
		await expect(run(buildProgram({ env: TMUX, exec: paneServer(calls, THREE) }), verb)).rejects.toThrow('exit:2')
		expect(errExit).toHaveBeenCalledWith(2)
		expect(logs.join('\n')).toContain('pane')
		expect(drives(calls)).toEqual([])
	})

	it('@id:lookup-unknown-flag-lists-valid', async () => {
		const calls: string[][] = []
		const errExit = catchExit()
		await expect(run(buildProgram({ env: TMUX, exec: paneServer(calls, THREE) }), ['list', '--nope'])).rejects.toThrow(
			'exit:2',
		)
		expect(errExit).toHaveBeenCalledWith(2)
		const out = logs.join('\n')
		expect(out).toContain('--nope')
		expect(out).toContain('--format')
		expect(drives(calls)).toEqual([])
	})

	it('@id:lookup-help-never-unknown-flag', async () => {
		const errExit = catchExit()
		captureStderr()
		const out: string[] = []
		vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
			out.push(String(line))
			return true
		})
		await expect(run(buildProgram({ env: TMUX, exec: paneServer([], THREE) }), ['list', '--help'])).rejects.toThrow(
			'exit:0',
		)
		expect(errExit).toHaveBeenCalledWith(0)
		expect(`${out.join('')}${logs.join('\n')}`).not.toContain('unknown')
	})

	it('@id:lookup-error-honors-format-json', async () => {
		catchExit()
		const stderr = captureStderr()
		await withArgv(['list', '--format', 'json'], () =>
			expect(run(buildProgram({ env: {}, exec: noAncestry }), ['list', '--format', 'json'])).rejects.toThrow('exit:1'),
		)
		const parsed = JSON.parse(logs.join('\n'))
		expect(parsed.error.code).toBe('no-mux')
		expect(stderr.join('')).toBe('')
	})

	it('@id:lookup-failed-stdout-error-alone', async () => {
		catchExit()
		captureStderr()
		const out: string[] = []
		vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
			out.push(String(line))
			return true
		})
		await expect(
			run(buildProgram({ env: TMUX, exec: throwingExec('', 'capture-pane: no such pane') }), ['read', '%1']),
		).rejects.toThrow('exit:1')
		expect(out).toEqual([])
		expect(logs.join('\n')).toContain('pane-not-found')
	})

	it('@id:lookup-read-writes-raw-bytes', async () => {
		const out: string[] = []
		vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
			out.push(String(line))
			return true
		})
		const program = buildProgram({
			env: TMUX,
			exec: paneServer([], [{ id: '%1', cwd: '/repo' }], { 'capture-pane': 'HELLO' }),
		})
		await run(program, ['read', '%1'])
		expect(out.join('')).toContain('HELLO')
		expect(logs.join('\n')).toBe('')
	})

	it('@id:lookup-read-lines-caps-trailing', async () => {
		const calls: string[][] = []
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const program = buildProgram({
			env: TMUX,
			exec: paneServer(calls, [{ id: '%1', cwd: '/repo' }], { 'capture-pane': 'x' }),
		})
		await run(program, ['read', '%1', '--lines', '5'])
		expect(calls).toContainEqual(['capture-pane', '-p', '-t', '%1', '-S', '-5'])
	})

	it('@id:lookup-focus-beams-view', async () => {
		const calls: string[][] = []
		const out: string[] = []
		vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
			out.push(String(line))
			return true
		})
		const program = buildProgram({ env: TMUX, exec: paneServer(calls, [{ id: '%1', cwd: '/repo' }]) })
		await run(program, ['focus', '%1'])
		expect(calls.some((c) => c[0] === 'switch-client')).toBe(true)
		expect(calls).toContainEqual(['select-pane', '-t', '%1'])
		expect(out.join('')).toBe('')
		expect(logs.join('\n')).toBe('')
	})

	it('@id:lookup-error-no-backend-leak', async () => {
		catchExit()
		captureStderr()
		const diagnostic = "can't find pane: %99 — tmux server error 3"
		await expect(
			run(buildProgram({ env: TMUX, exec: throwingExec('', diagnostic) }), ['focus', '%99']),
		).rejects.toThrow('exit:1')
		const out = logs.join('\n')
		expect(out).toContain('pane-not-found')
		expect(out).toContain('cyber-mux list')
		expect(out).not.toContain("can't find pane")
		expect(out).not.toContain('tmux server error')
	})

	it('@id:lookup-worktree-catchall-no-leak', async () => {
		catchExit()
		captureStderr()
		const diagnostic = 'no server running on /tmp/tmux-501/default'
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
		expect(out).not.toContain('tmux')
		expect(out).not.toContain(diagnostic)
	})
})

describe('spec:cyber-mux/cli/template/apply', () => {
	const REPO_DIR = '/repo/.cyber-mux/templates'
	const XDG = { XDG_CONFIG_HOME: '/home/u/.config' }
	function repo(name: string): string {
		return `${REPO_DIR}/${name}.json`
	}

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
	const POOL_TABS = {
		name: 'pool',
		tabs: [
			{ label: 'editor', panes: [{ label: 'edit' }] },
			{ label: 'logs', panes: [{ label: 'tail' }] },
		],
	}
	const POOL_TABS_SPLIT = {
		name: 'pool',
		tabs: [
			{ label: 'editor', arrange: 'even-horizontal', panes: [{ label: 'edit' }, { label: 'test' }] },
			{ label: 'logs', panes: [{ label: 'tail' }] },
		],
	}
	const worktreeOut = JSON.stringify({
		result: {
			root_pane: { pane_id: 'w9:root', tab_id: 'w9:t1' },
			workspace: { workspace_id: 'w9' },
			worktree: { path: '/repo.worktrees/feat-x', branch: 'feat-x' },
		},
	})

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

	function captureStderr(): string[] {
		const lines: string[] = []
		vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
			lines.push(String(line))
			return true
		})
		return lines
	}

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

	function repoExec(calls: string[][], responses: Record<string, string> = {}): Exec {
		let n = 0
		return (cmd, args) => {
			calls.push([cmd, ...args])
			if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
			if (cmd === 'tmux') {
				if (args[0] !== 'new-window' && args[0] !== 'split-window') return ''
				const id = n++
				return args.includes('#{pane_id}\t#{window_id}') ? `%${id}\t@${id}` : `%${id}`
			}
			const key = args.slice(0, 2).join(' ')
			if (key === 'pane split') return JSON.stringify({ result: { pane: { pane_id: `w9:p${n++}`, tab_id: 'w9:t1' } } })
			return responses[key] ?? ''
		}
	}

	/** herdr with a real workspace/tab tier — so `workspace create` vs `tab create` is observable. */
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
			if (key === 'pane split') {
				return JSON.stringify({
					result: { pane: { pane_id: `w1:p${n++}`, tab_id: `w1:t${tab}`, workspace_id: 'w1' } },
				})
			}
			return ''
		}
	}

	// ── The read verbs — list, show, validate ──

	it.each([
		['list', ['template', 'list']],
		['show pool-4', ['template', 'show', 'pool-4']],
		['validate pool-4', ['template', 'validate', 'pool-4']],
	])('@id:template-apply-read-verbs-no-mux', async (_name, argv) => {
		// Their subject is a FILE, the same way `worktree list`'s subject is git.
		const calls: string[][] = []
		const store = fakeStore({ [repo('pool-4')]: POOL_4 })
		const program = buildProgram({ env: XDG, exec: repoExec(calls), store })
		await run(program, argv)
		expect(calls.every((c) => c[0] === 'git')).toBe(true)
	})

	it('@id:template-apply-file-skips-resolution', async () => {
		const store = fakeStore({ './scratch/pool.json': { name: 'pool', panes: [{ label: 'a' }] } })
		const program = buildProgram({ env: XDG, exec: repoExec([]), store })
		await run(program, ['template', 'show', '--file', './scratch/pool.json'])
		expect(store.reads).toEqual(['./scratch/pool.json'])
		expect(logs.join('\n')).toContain('"name": "pool"')
	})

	it('@id:template-apply-show-desugar-tree', async () => {
		const store = fakeStore({ [repo('pool-4')]: POOL_4 })
		const program = buildProgram({ env: XDG, exec: repoExec([]), store })
		await run(program, ['template', 'show', 'pool-4', '--desugar'])
		expect(JSON.parse(logs.join('\n'))).toEqual({
			type: 'split',
			direction: 'right',
			ratio: 0.5,
			first: { type: 'pane', label: 'w1' },
			second: { type: 'pane', label: 'w2' },
		})
	})

	it('@id:template-apply-validate-exit-0', async () => {
		const exit = catchExit()
		const stderr = captureStderr()
		const store = fakeStore({ [repo('pool-4')]: POOL_4 })
		const program = buildProgram({ env: XDG, exec: repoExec([]), store })
		await run(program, ['template', 'validate', 'pool-4'])
		expect(exit).not.toHaveBeenCalled()
		expect(stderr).toEqual([])
	})

	// ── Applying is --template, the exact sibling of --launch ──

	it('@id:template-apply-template-launch-exclusive', async () => {
		catchExit()
		const store = fakeStore({ [repo('pool-4')]: POOL_4 })
		const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
		await expect(run(program, ['open', '--template', 'pool-4', '--launch', 'claude'])).rejects.toThrow('exit:2')
	})

	it('@id:template-apply-at-defaults-workspace', async () => {
		const calls: string[][] = []
		const store = fakeStore({ [repo('pool-4')]: POOL_4 })
		const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
		await run(program, ['open', '--template', 'pool-4'])
		// tmux collapses workspace to a window — the region is a new-window, not a split.
		expect(calls.find((c) => c[0] === 'tmux')?.[1]).toBe('new-window')
	})

	it('@id:template-apply-tabs-defaults-workspace', async () => {
		const calls: string[][] = []
		const store = fakeStore({ [repo('pool')]: POOL_TABS })
		const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'herdr' }, exec: tabsExec(calls), store })
		await run(program, ['open', '--template', 'pool'])
		const opens = calls.filter((c) => c[0] === 'herdr' && c[2] === 'create')
		expect(opens[0]?.slice(1, 3)).toEqual(['workspace', 'create'])
		expect(opens[1]?.slice(1, 3)).toEqual(['tab', 'create'])
		expect(calls.some((c) => c[1] === 'pane' && c[2] === 'split')).toBe(false)
	})

	it('@id:template-apply-label-defaults-name', async () => {
		const calls: string[][] = []
		const store = fakeStore({ [repo('pool-4')]: POOL_4 })
		const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec(calls), store })
		await run(program, ['open', '--template', 'pool-4'])
		expect(calls.find((c) => c[1] === 'new-window')).toEqual(expect.arrayContaining(['-n', 'pool-4']))
	})

	// ── The manifest is the handoff (--format json) ──

	it('@id:template-apply-json-reports-panes', async () => {
		const store = fakeStore({ [repo('agent-pool-3')]: AGENT_POOL_3 })
		const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
		await withArgv(['open', '--template', 'agent-pool-3', '--format', 'json'], () =>
			run(program, ['open', '--template', 'agent-pool-3', '--cwd', '/w/feat-x', '--format', 'json']),
		)
		const manifest = JSON.parse(logs.join('\n'))
		expect(manifest.template).toBe('agent-pool-3')
		expect(manifest.cwd).toBe('/w/feat-x')
		expect(manifest).toHaveProperty('workspace')
		expect(manifest.panes).toEqual([
			{ label: 'planner', pane: '%0', dir: '/w/feat-x', command: 'claude', tab: null },
			{ label: 'worker-a', pane: '%1', dir: '/w/feat-x', command: 'claude', tab: null },
			{ label: 'worker-b', pane: '%2', dir: '/w/feat-x', command: 'claude', tab: null },
		])
	})

	it('@id:template-apply-manifest-workspace-null-tmux', async () => {
		const store = fakeStore({ [repo('pool-4')]: POOL_4 })
		const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: repoExec([]), store })
		await withArgv(['open', '--template', 'pool-4', '--format', 'json'], () =>
			run(program, ['open', '--template', 'pool-4', '--format', 'json']),
		)
		expect(JSON.parse(logs.join('\n')).workspace).toBeNull()
	})

	it('@id:template-apply-manifest-tab-per-pane', async () => {
		const calls: string[][] = []
		const store = fakeStore({ [repo('pool')]: POOL_TABS_SPLIT })
		const wtOut = JSON.stringify({
			result: {
				root_pane: { pane_id: 'w9:root', tab_id: 'w9:t1', workspace_id: 'w9' },
				workspace: { workspace_id: 'w9' },
				worktree: { path: '/repo.worktrees/feat-x', branch: 'feat-x' },
			},
		})
		const program = buildProgram({
			env: { ...XDG, CYBER_MUX: 'herdr' },
			exec: tabsExec(calls, { 'worktree create': wtOut }),
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

	// Single-tab template names no tabs, so each pane's tab comes back null (asserted below, alongside
	// this test's dir-degradation checks — the tab:null claim is what binds it to this scenario).
	it('@id:template-apply-manifest-tab-null-single', async () => {
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

describe('spec:cyber-mux/cli/template/capture', () => {
	const REPO_DIR = '/repo/.cyber-mux/templates'
	const USER_DIR = '/home/u/.config/cyber-mux/templates'
	const XDG = { XDG_CONFIG_HOME: '/home/u/.config' }
	const POOL_4 = { name: 'pool-4', arrange: 'tiled', panes: [{ label: 'w1' }, { label: 'w2' }] }
	function repo(name: string): string {
		return `${REPO_DIR}/${name}.json`
	}
	function user(name: string): string {
		return `${USER_DIR}/${name}.json`
	}

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

	function captureStderr(): string[] {
		const lines: string[] = []
		vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
			lines.push(String(line))
			return true
		})
		return lines
	}

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

	// ── The caller's region: save's default subject and --from ──

	/** tmux, plus a region of three panes around `%1` — a live capture from tmux 3.6b. */
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

	it('@id:template-capture-writes-repo-path', async () => {
		const calls: string[][] = []
		const store = fakeStore({})
		const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
		await run(program, ['template', 'save', 'pool-3'])
		expect(logs).toEqual([`path  ${repo('pool-3')}`])
		const written = JSON.parse(store.writes[repo('pool-3')]!)
		expect(written.name).toBe('pool-3')
		expect(written.root.direction).toBe('right')
		expect(written.root.ratio).toBe(0.6)
		expect(written.root.first.ratio).toBe(0.7)
		expect(written.root.second).toEqual({ type: 'pane', label: 'editor' })
		expect(written.root.first.first).toEqual({ type: 'pane' })
		expect(JSON.stringify(written)).not.toContain('zeta')
		expect(written.root.first.second).toEqual({ type: 'pane', label: 'watcher', dir: 'api' })
		expect(JSON.stringify(written)).not.toContain('/repo')
	})

	it('@id:template-capture-from-names-region', async () => {
		const calls: string[][] = []
		const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store: fakeStore({}) })
		await run(program, ['template', 'save', 'pool-3', '--from', '%7'])
		expect(calls.find((c) => c[1] === 'list-panes' && c[2] === '-t')?.[3]).toBe('%7')
	})

	it('@id:template-capture-description-replaces-note', async () => {
		const store = fakeStore({})
		const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
		await run(program, ['template', 'save', 'pool-3', '--description', 'the review pool'])
		expect(JSON.parse(store.writes[repo('pool-3')]!).description).toBe('the review pool')
	})

	it('@id:template-capture-to-user-directory', async () => {
		const store = fakeStore({})
		const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
		await run(program, ['template', 'save', 'pool-3', '--to', 'user'])
		expect(Object.keys(store.writes)).toEqual([user('pool-3')])
	})

	it('@id:template-capture-refuses-overwrite', async () => {
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

	it('@id:template-capture-force-overwrites', async () => {
		const store = fakeStore({ [repo('pool-3')]: POOL_4 })
		const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
		await run(program, ['template', 'save', 'pool-3', '--force'])
		expect(JSON.parse(store.writes[repo('pool-3')]!).root).toBeDefined()
	})

	it('@id:template-capture-validates-name-first', async () => {
		catchExit()
		captureStderr()
		const calls: string[][] = []
		const store = fakeStore({})
		const program = buildProgram({ env: SAVE_ENV, exec: saveExec(calls), store })
		await expect(run(program, ['template', 'save', '../escape'])).rejects.toThrow('exit:2')
		expect(logs.join('\n')).toContain('invalid template name')
		expect(store.writes).toEqual({})
		expect(calls).toEqual([])
	})

	it('@id:template-capture-no-pane-refuses', async () => {
		catchExit()
		captureStderr()
		const calls: string[][] = []
		const store = fakeStore({})
		const program = buildProgram({ env: { ...XDG, CYBER_MUX: 'tmux' }, exec: saveExec(calls), store })
		await expect(run(program, ['template', 'save', 'pool-3'])).rejects.toThrow('exit:2')
		expect(logs.join('\n')).toContain('--from')
		expect(store.writes).toEqual({})
		expect(calls.some((c) => c[1] === 'list-panes')).toBe(false)
	})

	it('@id:template-capture-backend-no-geometry-refuses', async () => {
		catchExit()
		captureStderr()
		const store = fakeStore({})
		const original = tmuxMuxAdapter.regions
		try {
			delete (tmuxMuxAdapter as { regions?: unknown }).regions
			const program = buildProgram({ env: SAVE_ENV, exec: saveExec([]), store })
			await expect(run(program, ['template', 'save', 'pool-3'])).rejects.toThrow('exit:1')
		} finally {
			;(tmuxMuxAdapter as { regions?: unknown }).regions = original
		}
		expect(logs.join('\n')).toContain('tmux')
		expect(store.writes).toEqual({})
	})

	// ── Capturing a whole workspace: --workspace (herdr, with a real workspace tier) ──

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

	type HerdrTab = { tab_id: string; label?: string }
	type HerdrPane = { pane_id: string; tab_id: string; cwd?: string; label?: string }

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
				const tab = workspace.panes.find((p) => p.pane_id === args[3])?.tab_id
				return JSON.stringify({ result: { layout: { panes: tab ? LAYOUT_OF[tab] : [] } } })
			}
			return ''
		}
	}

	const WS_3 = { tabs: TABS_3, panes: PANES_3 }
	const HERDR_ENV = { ...XDG, CYBER_MUX: 'herdr', CYBER_MUX_PANE: 'w1:p1' }

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

	it('@id:template-capture-workspace-captures-all-tabs', async () => {
		const store = fakeStore({})
		const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
		await run(program, ['template', 'save', 'pool', '--workspace'])
		const written = JSON.parse(store.writes[repo('pool')]!)
		expect(written.tabs).toHaveLength(3)
		expect(written.root).toBeUndefined()
		expect(written.tabs.map((t: { root: unknown }) => t.root)).toEqual([TAB_1_TREE, TAB_2_TREE, TAB_3_TREE])
	})

	it('@id:template-capture-default-caller-region', async () => {
		const store = fakeStore({})
		const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
		await run(program, ['template', 'save', 'pool'])
		const written = JSON.parse(store.writes[repo('pool')]!)
		expect(written.root).toEqual(TAB_1_TREE)
		expect(written.tabs).toBeUndefined()
	})

	it('@id:template-capture-bare-save-reveals-left-out', async () => {
		const stderr = captureStderr()
		const store = fakeStore({})
		const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
		await run(program, ['template', 'save', 'pool'])
		expect(logs[0]).toBe(`path  ${repo('pool')}`)
		const out = logs.join('\n')
		expect(out).toContain('3 tabs')
		expect(out).toContain('help[0]:')
		expect(out).toContain('cyber-mux template save pool --workspace')
		expect(stderr.join('')).toBe('')
	})

	it('@id:template-capture-json-path-and-help', async () => {
		const store = fakeStore({})
		const program = buildProgram({ env: HERDR_ENV, exec: herdrWorkspaceExec([], WS_3), store })
		await withArgv(['template', 'save', 'pool', '--format', 'json'], () =>
			run(program, ['template', 'save', 'pool', '--format', 'json']),
		)
		const payload = JSON.parse(logs.join('\n'))
		expect(payload.path).toBe(repo('pool'))
		expect(Array.isArray(payload.help)).toBe(true)
		expect(payload.help[0].message).toContain('3 tabs')
		expect(payload.help[0].command).toBe('cyber-mux template save pool --workspace')
	})

	/** tmux with an unset grouping tag — a window nobody grouped, for the no-workspace-tier refusal. */
	function untaggedTmuxExec(calls: string[][]): Exec {
		return (cmd, args) => {
			calls.push([cmd, ...args])
			if (cmd === 'git') return args[0] === 'rev-parse' ? '/repo/.git' : ''
			if (args[0] === 'display-message') return '@1\t\tzsh'
			if (args[0] === 'list-panes') {
				return ['%0\t0\t0\t119\t50\t/repo\tzeta\tzeta', '%1\t120\t0\t80\t50\t/repo/api\tzeta\tzeta'].join('\n')
			}
			return ''
		}
	}

	it('@id:template-capture-backend-no-tabs-refuses', async () => {
		catchExit()
		captureStderr()
		const store = fakeStore({})
		const original = tmuxMuxAdapter.regions
		try {
			delete (tmuxMuxAdapter as { regions?: unknown }).regions
			const program = buildProgram({
				env: { ...XDG, CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%0' },
				exec: untaggedTmuxExec([]),
				store,
			})
			await expect(run(program, ['template', 'save', 'pool', '--workspace'])).rejects.toThrow('exit:1')
		} finally {
			;(tmuxMuxAdapter as { regions?: unknown }).regions = original
		}
		expect(logs.join('\n')).toContain('tmux')
		expect(store.writes).toEqual({})
	})
})
