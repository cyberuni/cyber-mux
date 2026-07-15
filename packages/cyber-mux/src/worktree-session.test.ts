import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrSessionAdapter } from './session.herdr.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'
import type { SessionAdapter, SessionPlacement } from './session.ts'
import { addAndOpenWorktree, listWorktrees, openExistingWorktree, removeWorktree } from './worktree-session.ts'

/**
 * The real adapters are driven here rather than hand-rolled fakes: the routing decision turns on
 * whether an adapter binds worktrees to workspaces, and a fake could claim either. Only `Exec` is
 * faked, so what these assert is the argv the backends genuinely produce.
 */
const HERDR_WORKTREE_OUT = JSON.stringify({
	result: {
		root_pane: { pane_id: 'w9:p1' },
		workspace: { workspace_id: 'w9' },
		worktree: { path: '/repo.worktrees/x', branch: 'feat/x' },
	},
})

const GIT_PORCELAIN = [
	'worktree /repo',
	'branch refs/heads/main',
	'',
	'worktree /repo.worktrees/x',
	'branch refs/heads/feat/x',
	'',
].join('\n')

/** Routes by binary name, so one fake serves a git call and a mux call in the same flow. */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (cmd, args) => {
		calls.push([cmd, ...args])
		const key = `${cmd} ${args.slice(0, 2).join(' ')}`
		for (const [prefix, out] of Object.entries(responses)) {
			if (key.startsWith(prefix)) return out
		}
		return ''
	}
}

const ran = (calls: string[][], cmd: string, ...head: string[]) =>
	calls.some((c) => c[0] === cmd && head.every((h, i) => c[i + 1] === h))

describe('spec:cyber-mux/mux', () => {
	describe('worktree routing — native when the backend binds, plain git plus open() otherwise', () => {
		const addOpts = { primaryRoot: '/repo', branch: 'feat/x', path: '/repo.worktrees/x', launch: 'claude' }

		it('herdr --at workspace routes through the backend, binding the worktree to its workspace', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree create': HERDR_WORKTREE_OUT })
			const opened = addAndOpenWorktree(exec, herdrSessionAdapter, { ...addOpts, at: 'workspace' })

			expect(opened.workspace).toBe('w9')
			expect(opened.degraded).toBe(false)
			expect(ran(calls, 'herdr', 'worktree', 'create')).toBe(true)
			// The whole point: git never ran, so herdr owns the checkout AND the binding.
			expect(ran(calls, 'git')).toBe(false)
		})

		it.each([
			['pane:right', 'pane', 'split'],
			['pane:down', 'pane', 'split'],
			['tab', 'tab', 'create'],
		] as const)('herdr --at %s falls back to plain git and reports the worktree ungrouped, rather than failing', (at, verb, sub) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'herdr pane split': '{"result":{"pane":{"pane_id":"w3:pB"}}}',
				'herdr tab create': '{"result":{"root_pane":{"pane_id":"w3:pB"}}}',
			})
			const opened = addAndOpenWorktree(exec, herdrSessionAdapter, { ...addOpts, at: at as SessionPlacement })

			// A complete, useful outcome — a worktree open in a pane/tab — just not a grouped one.
			expect(opened.worktree).toEqual({ root: '/repo.worktrees/x', branch: 'feat/x' })
			expect(opened.workspace).toBeUndefined()
			// ...and the caller is told, because herdr COULD have grouped it.
			expect(opened.degraded).toBe(true)
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'add')).toBe(true)
			expect(ran(calls, 'herdr', verb, sub)).toBe(true)
			expect(ran(calls, 'herdr', 'worktree', 'create')).toBe(false)
		})

		it.each([
			'workspace',
			'pane:right',
			'tab',
		] as const)('tmux --at %s falls back without claiming degradation — no grouping was ever on offer', (at) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tmux split-window': '%9', 'tmux new-window': '%9' })
			const opened = addAndOpenWorktree(exec, tmuxSessionAdapter, { ...addOpts, at })

			expect(opened.workspace).toBeUndefined()
			expect(opened.degraded).toBe(false)
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'add')).toBe(true)
		})

		it('passes a base through both routes', () => {
			const herdrCalls: string[][] = []
			addAndOpenWorktree(fakeExec(herdrCalls, { 'herdr worktree create': HERDR_WORKTREE_OUT }), herdrSessionAdapter, {
				...addOpts,
				at: 'workspace',
				base: 'origin/main',
			})
			expect(herdrCalls[0]).toContain('--base')

			const tmuxCalls: string[][] = []
			addAndOpenWorktree(fakeExec(tmuxCalls, { 'tmux new-window': '%9' }), tmuxSessionAdapter, {
				...addOpts,
				at: 'workspace',
				base: 'origin/main',
			})
			expect(tmuxCalls[0]!.at(-1)).toBe('origin/main')
		})
	})

	describe('openExistingWorktree — the add-now-group-later remedy', () => {
		it('groups an existing worktree through the backend that binds', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree open': HERDR_WORKTREE_OUT })
			const opened = openExistingWorktree(exec, herdrSessionAdapter, {
				primaryRoot: '/repo',
				path: '/repo.worktrees/x',
			})

			expect(opened.workspace).toBe('w9')
			expect(opened.degraded).toBe(false)
			expect(ran(calls, 'herdr', 'worktree', 'open')).toBe(true)
			// Never re-creates the checkout — it is already there.
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'add')).toBe(false)
		})

		it('defaults the placement to workspace — the only one that can bind', () => {
			const calls: string[][] = []
			openExistingWorktree(fakeExec(calls, { 'herdr worktree open': HERDR_WORKTREE_OUT }), herdrSessionAdapter, {
				primaryRoot: '/repo',
				path: '/repo.worktrees/x',
			})
			expect(ran(calls, 'herdr', 'worktree', 'open')).toBe(true)
		})

		it('falls back to a plain open on a backend that cannot bind, reading the branch from git', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tmux new-window': '%9', 'git -C /repo': GIT_PORCELAIN })
			const opened = openExistingWorktree(exec, tmuxSessionAdapter, { primaryRoot: '/repo', path: '/repo.worktrees/x' })

			expect(opened.worktree).toEqual({ root: '/repo.worktrees/x', branch: 'feat/x' })
			expect(opened.workspace).toBeUndefined()
			expect(opened.degraded).toBe(false)
		})
	})

	describe('listWorktrees — git owns the facts, the backend contributes only the binding', () => {
		it('reports which workspace each worktree is open in', () => {
			const listOut = JSON.stringify({
				result: {
					worktrees: [
						{ path: '/repo', open_workspace_id: 'w19' },
						{ path: '/repo.worktrees/x', open_workspace_id: 'w21' },
					],
				},
			})
			const exec = fakeExec([], { 'git -C /repo': GIT_PORCELAIN, 'herdr worktree list': listOut })
			expect(listWorktrees(exec, herdrSessionAdapter, { primaryRoot: '/repo' })).toEqual([
				{ root: '/repo', branch: 'main', linked: false, prunable: false, workspace: 'w19' },
				{ root: '/repo.worktrees/x', branch: 'feat/x', linked: true, prunable: false, workspace: 'w21' },
			])
		})

		it('reads every fact from git even when the backend claims otherwise — two backends can never disagree', () => {
			// herdr re-reads git and reports a branch of its own. It is ignored, on purpose.
			const listOut = JSON.stringify({
				result: { worktrees: [{ path: '/repo.worktrees/x', branch: 'a-stale-lie', open_workspace_id: 'w21' }] },
			})
			const exec = fakeExec([], { 'git -C /repo': GIT_PORCELAIN, 'herdr worktree list': listOut })
			const entries = listWorktrees(exec, herdrSessionAdapter, { primaryRoot: '/repo' })
			expect(entries.map((e) => e.branch)).toEqual(['main', 'feat/x'])
		})

		it('reports no workspace on a backend with no binding, and asks it nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'git -C /repo': GIT_PORCELAIN })
			const entries = listWorktrees(exec, tmuxSessionAdapter, { primaryRoot: '/repo' })
			expect(entries.every((e) => e.workspace === undefined)).toBe(true)
			expect(calls.every((c) => c[0] === 'git')).toBe(true)
		})

		it('answers outside a multiplexer, where there is no adapter at all — listing is a git question', () => {
			const exec = fakeExec([], { 'git -C /repo': GIT_PORCELAIN })
			expect(listWorktrees(exec, undefined, { primaryRoot: '/repo' }).map((e) => e.branch)).toEqual(['main', 'feat/x'])
		})
	})

	describe('removeWorktree — identical gates on every backend, the binding released only after they pass', () => {
		// This module's own directory stands in for a worktree that exists on disk — existsSync is
		// real, so the dirty-check path needs a real path; git itself is fully faked via exec.
		const realExistingDir = new URL('.', import.meta.url).pathname
		const bindingOut = (path: string) => JSON.stringify({ result: { worktrees: [{ path, open_workspace_id: 'w21' }] } })

		it('releases the bound workspace before git removes the checkout', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree list': bindingOut(realExistingDir) })
			removeWorktree(exec, herdrSessionAdapter, realExistingDir, { primaryRoot: '/repo' })

			const closed = calls.findIndex((c) => c[0] === 'herdr' && c[1] === 'workspace' && c[2] === 'close')
			const removed = calls.findIndex((c) => c[0] === 'git' && c[3] === 'worktree' && c[4] === 'remove')
			expect(closed).toBeGreaterThanOrEqual(0)
			expect(closed).toBeLessThan(removed)
			expect(calls[closed]).toEqual(['herdr', 'workspace', 'close', 'w21'])
		})

		it('refuses uncommitted changes on a binding backend WITHOUT closing the workspace', () => {
			const calls: string[][] = []
			const exec: Exec = (cmd, args) => {
				calls.push([cmd, ...args])
				if (cmd === 'herdr') return bindingOut(realExistingDir)
				return args[2] === 'status' ? ' M some/file' : ''
			}
			expect(() => removeWorktree(exec, herdrSessionAdapter, realExistingDir, { primaryRoot: '/repo' })).toThrow(
				/uncommitted changes/,
			)
			// A refused removal has no side effect — the workspace is still open.
			expect(ran(calls, 'herdr', 'workspace', 'close')).toBe(false)
		})

		it('refuses uncommitted changes identically on a backend with no binding', () => {
			const exec: Exec = (_cmd, args) => (args[2] === 'status' ? ' M some/file' : '')
			expect(() => removeWorktree(exec, tmuxSessionAdapter, realExistingDir, { primaryRoot: '/repo' })).toThrow(
				/uncommitted changes/,
			)
		})

		it('refuses the primary checkout on every backend, even with --force', () => {
			for (const adapter of [herdrSessionAdapter, tmuxSessionAdapter, undefined] as (SessionAdapter | undefined)[]) {
				expect(() => removeWorktree(fakeExec([]), adapter, '/repo', { primaryRoot: '/repo', force: true })).toThrow(
					/primary checkout/,
				)
			}
		})

		it('releases the workspace of a checkout already gone from disk — the orphan this prevents', () => {
			const calls: string[][] = []
			const gone = '/repo.worktrees/does-not-exist'
			const exec = fakeExec(calls, { 'herdr worktree list': bindingOut(gone) })
			removeWorktree(exec, herdrSessionAdapter, gone, { primaryRoot: '/repo' })

			expect(ran(calls, 'herdr', 'workspace', 'close')).toBe(true)
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'remove')).toBe(false)
		})

		it('removes an unbound worktree with plain git, asking the backend for nothing to close', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree list': JSON.stringify({ result: { worktrees: [] } }) })
			removeWorktree(exec, herdrSessionAdapter, realExistingDir, { primaryRoot: '/repo' })

			expect(ran(calls, 'herdr', 'workspace', 'close')).toBe(false)
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'remove')).toBe(true)
		})
	})
})
