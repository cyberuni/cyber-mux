import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { MuxAdapter, MuxPlacement } from './mux.ts'
import { addAndOpenWorktree, listWorktrees, openExistingWorktree, removeWorktree } from './worktree-session.ts'

/**
 * The real adapters are driven here rather than hand-rolled fakes: the routing decision turns on
 * whether an adapter binds worktrees to workspaces, and a fake could claim either. Only `Exec` is
 * faked, so what these assert is the argv the backends genuinely produce.
 */
const HERDR_WORKTREE_OUT = JSON.stringify({
	result: {
		root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' },
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

/**
 * Routes by binary name, so one fake serves a git call and a mux call in the same flow. Matching is on
 * the WHOLE invocation rather than its first two args, because `listWorktreesFromGit` runs four
 * different git commands against the same `-C <root>` — a two-arg key could not tell `worktree list`
 * from the `symbolic-ref`/`branch`/`status` reads behind the disposability signals. First match wins,
 * so a fixture lists its specific routes before any catch-all prefix.
 */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (cmd, args) => {
		calls.push([cmd, ...args])
		const key = [cmd, ...args].join(' ')
		for (const [prefix, out] of Object.entries(responses)) {
			if (key.startsWith(prefix)) return out
		}
		return ''
	}
}

const ran = (calls: string[][], cmd: string, ...head: string[]) =>
	calls.some((c) => c[0] === cmd && head.every((h, i) => c[i + 1] === h))

describe('spec:cyber-mux/mux/worktree', () => {
	describe('worktree routing — native when the backend binds, plain git plus open() otherwise', () => {
		const addOpts = { primaryRoot: '/repo', branch: 'feat/x', path: '/repo.worktrees/x', launch: 'claude' }

		it('herdr --at workspace routes through the backend, binding the worktree to its workspace', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree create': HERDR_WORKTREE_OUT })
			const opened = addAndOpenWorktree(exec, herdrMuxAdapter, { ...addOpts, at: 'workspace' })

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
		] as const)('a placement the binding cannot serve falls back rather than failing', (at, verb, sub) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'herdr pane split': '{"result":{"pane":{"pane_id":"w3:pB","tab_id":"w3:t1"}}}',
				'herdr tab create': '{"result":{"root_pane":{"pane_id":"w3:pB","tab_id":"w3:t1"}}}',
			})
			const opened = addAndOpenWorktree(exec, herdrMuxAdapter, { ...addOpts, at: at as MuxPlacement })

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
		] as const)('a backend that binds nothing falls back without reporting a lost grouping', (at) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tmux split-window': '%9\t@1', 'tmux new-window': '%9\t@1' })
			const opened = addAndOpenWorktree(exec, tmuxMuxAdapter, { ...addOpts, at })

			expect(opened.workspace).toBeUndefined()
			expect(opened.degraded).toBe(false)
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'add')).toBe(true)
		})

		it('passes a label through both routes — each backend names the tier it opened', () => {
			// herdr, grouped: the label names the bound workspace.
			const herdrCalls: string[][] = []
			addAndOpenWorktree(fakeExec(herdrCalls, { 'herdr worktree create': HERDR_WORKTREE_OUT }), herdrMuxAdapter, {
				...addOpts,
				at: 'workspace',
				label: 'my-name',
			})
			expect(herdrCalls[0]).toContain('--label')

			// tmux, no binding: the same label names the window `workspace` collapses to.
			const tmuxCalls: string[][] = []
			addAndOpenWorktree(fakeExec(tmuxCalls, { 'tmux new-window': '%9\t@1' }), tmuxMuxAdapter, {
				...addOpts,
				at: 'workspace',
				label: 'my-name',
			})
			expect(tmuxCalls.some((c) => c[0] === 'tmux' && c.includes('-n') && c.includes('my-name'))).toBe(true)
		})

		it('passes a base through both routes', () => {
			const herdrCalls: string[][] = []
			addAndOpenWorktree(fakeExec(herdrCalls, { 'herdr worktree create': HERDR_WORKTREE_OUT }), herdrMuxAdapter, {
				...addOpts,
				at: 'workspace',
				base: 'origin/main',
			})
			expect(herdrCalls[0]).toContain('--base')

			const tmuxCalls: string[][] = []
			addAndOpenWorktree(fakeExec(tmuxCalls, { 'tmux new-window': '%9\t@1' }), tmuxMuxAdapter, {
				...addOpts,
				at: 'workspace',
				base: 'origin/main',
			})
			expect(tmuxCalls[0]!.at(-1)).toBe('origin/main')
		})
	})

	describe('openExistingWorktree — the add-now-group-later remedy', () => {
		it('worktree open groups a worktree that plain git created earlier', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree open': HERDR_WORKTREE_OUT })
			const opened = openExistingWorktree(exec, herdrMuxAdapter, {
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
			openExistingWorktree(fakeExec(calls, { 'herdr worktree open': HERDR_WORKTREE_OUT }), herdrMuxAdapter, {
				primaryRoot: '/repo',
				path: '/repo.worktrees/x',
			})
			expect(ran(calls, 'herdr', 'worktree', 'open')).toBe(true)
		})

		it('falls back to a plain open on a backend that cannot bind, reading the branch from git', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tmux new-window': '%9\t@1', 'git -C /repo': GIT_PORCELAIN })
			const opened = openExistingWorktree(exec, tmuxMuxAdapter, { primaryRoot: '/repo', path: '/repo.worktrees/x' })

			expect(opened.worktree).toEqual({ root: '/repo.worktrees/x', branch: 'feat/x' })
			expect(opened.workspace).toBeUndefined()
			expect(opened.degraded).toBe(false)
		})
	})

	describe('listWorktrees — git owns the facts, the backend contributes only the binding', () => {
		// Every git read the listing makes, answered explicitly: the primary is merged into origin/main
		// and the linked worktree is not, and both checkouts are clean.
		const GIT_FACTS: Record<string, string | null> = {
			'git -C /repo worktree list': GIT_PORCELAIN,
			'git -C /repo symbolic-ref': 'origin/main',
			'git -C /repo branch': 'main',
			'git -C /repo status': '',
			'git -C /repo.worktrees/x status': '',
		}
		const GIT_ANSWER = [
			{ root: '/repo', branch: 'main', linked: false, prunable: false, merged: true, dirty: false },
			{ root: '/repo.worktrees/x', branch: 'feat/x', linked: true, prunable: false, merged: false, dirty: false },
		]

		it('worktree list reports which workspace each worktree is open in', () => {
			// Only the linked worktree is open in a workspace. The primary is open in NONE — which is
			// the half of the scenario a fixture with every worktree bound could never show.
			const listOut = JSON.stringify({
				result: { worktrees: [{ path: '/repo.worktrees/x', open_workspace_id: 'w21' }] },
			})
			const exec = fakeExec([], { ...GIT_FACTS, 'herdr worktree list': listOut })
			expect(listWorktrees(exec, herdrMuxAdapter, { primaryRoot: '/repo' })).toEqual([
				{ ...GIT_ANSWER[0], workspace: undefined },
				{ ...GIT_ANSWER[1], workspace: 'w21' },
			])
		})

		it('worktree-facts-from-git-not-backend', () => {
			// herdr re-reads git and reports facts of its own — a stale branch, and a linked/prunable
			// that disagree with git on every count. All of them are ignored, on purpose.
			const listOut = JSON.stringify({
				result: {
					worktrees: [
						{
							path: '/repo.worktrees/x',
							branch: 'a-stale-lie',
							linked: false,
							prunable: true,
							open_workspace_id: 'w21',
						},
					],
				},
			})
			const exec = fakeExec([], { ...GIT_FACTS, 'herdr worktree list': listOut })
			const entries = listWorktrees(exec, herdrMuxAdapter, { primaryRoot: '/repo' })
			// Path, branch, linked, prunable, merged and dirty are ALL git's answer — asserting the branch
			// alone would leave the backend free to win on the rest. `workspace` is the one and only fact
			// the backend contributes.
			expect(entries).toEqual([
				{ ...GIT_ANSWER[0], workspace: undefined },
				{ ...GIT_ANSWER[1], workspace: 'w21' },
			])
		})

		it('reports no workspace on a backend with no binding, and asks it nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'git -C /repo': GIT_PORCELAIN })
			const entries = listWorktrees(exec, tmuxMuxAdapter, { primaryRoot: '/repo' })
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

		it('worktree-remove-not-delegated-to-backend', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree list': bindingOut(realExistingDir) })
			removeWorktree(exec, herdrMuxAdapter, realExistingDir, { primaryRoot: '/repo' })

			const closed = calls.findIndex((c) => c[0] === 'herdr' && c[1] === 'workspace' && c[2] === 'close')
			const removed = calls.findIndex((c) => c[0] === 'git' && c[3] === 'worktree' && c[4] === 'remove')
			expect(closed).toBeGreaterThanOrEqual(0)
			expect(closed).toBeLessThan(removed)
			expect(calls[closed]).toEqual(['herdr', 'workspace', 'close', 'w21'])
		})

		it('worktree remove refuses uncommitted changes BEFORE releasing the workspace', () => {
			const calls: string[][] = []
			const exec: Exec = (cmd, args) => {
				calls.push([cmd, ...args])
				if (cmd === 'herdr') return bindingOut(realExistingDir)
				return args[2] === 'status' ? ' M some/file' : ''
			}
			// The refusal must NAME --force as the way to discard them, not merely report the dirt.
			expect(() => removeWorktree(exec, herdrMuxAdapter, realExistingDir, { primaryRoot: '/repo' })).toThrow(
				/uncommitted changes[\s\S]*--force/,
			)
			// A refused removal has no side effect — the workspace is still open.
			expect(ran(calls, 'herdr', 'workspace', 'close')).toBe(false)
		})

		it('refuses uncommitted changes identically on a backend with no binding', () => {
			const exec: Exec = (_cmd, args) => (args[2] === 'status' ? ' M some/file' : '')
			expect(() => removeWorktree(exec, tmuxMuxAdapter, realExistingDir, { primaryRoot: '/repo' })).toThrow(
				/uncommitted changes/,
			)
		})

		it('worktree remove refuses the primary checkout, even with --force', () => {
			for (const adapter of [herdrMuxAdapter, tmuxMuxAdapter, undefined] as (MuxAdapter | undefined)[]) {
				const calls: string[][] = []
				// A primary checkout that REALLY EXISTS on disk. A fake path would let the removal hide
				// behind the not-on-disk early return, so "removes nothing" would hold for a reason that
				// has nothing to do with the refusal — and a real primary always exists.
				expect(() =>
					removeWorktree(fakeExec(calls), adapter, realExistingDir, { primaryRoot: realExistingDir, force: true }),
				).toThrow(/primary checkout/)
				// "and removes nothing" — refusing while still having run the removal would satisfy a
				// throw-only assertion, so pin that no git removal was ever issued.
				expect(calls.some((c) => c[0] === 'git' && c.includes('remove'))).toBe(false)
			}
		})

		it('worktree remove releases the workspace of a checkout already gone from disk', () => {
			const calls: string[][] = []
			const gone = '/repo.worktrees/does-not-exist'
			const exec = fakeExec(calls, { 'herdr worktree list': bindingOut(gone) })
			removeWorktree(exec, herdrMuxAdapter, gone, { primaryRoot: '/repo' })

			expect(ran(calls, 'herdr', 'workspace', 'close')).toBe(true)
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'remove')).toBe(false)
		})

		it('removes an unbound worktree with plain git, asking the backend for nothing to close', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'herdr worktree list': JSON.stringify({ result: { worktrees: [] } }) })
			removeWorktree(exec, herdrMuxAdapter, realExistingDir, { primaryRoot: '/repo' })

			expect(ran(calls, 'herdr', 'workspace', 'close')).toBe(false)
			expect(ran(calls, 'git', '-C', '/repo', 'worktree', 'remove')).toBe(true)
		})
	})
})

// These two exercise the worktree ROUTING seam, but what they pin is the mux/placement contract — how
// a route reports the workspace a pane landed in, and whether it carried env — so they bind to that
// leaf node rather than to mux/worktree, whose describe would shadow them if they lived inside it.
describe('spec:cyber-mux/mux/placement', () => {
	const addOpts = { primaryRoot: '/repo', branch: 'feat/x', path: '/repo.worktrees/x', launch: 'claude' }

	// One workspace tier, two questions. OCCUPANCY — which workspace the pane LIVES IN — is what
	// `open` answers, and a split lands in the caller's own workspace. BINDING — whether the worktree
	// is GROUPED to a workspace — is what this report answers, and a split creates none. Neither
	// answers for the other: a pane sitting in w3 is NOT evidence its worktree was grouped there, so
	// the pane's workspace must never leak into the worktree's report.
	it('placement-workspace-not-worktree-binding', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, {
			// The live envelope: herdr reports the split's own workspace_id — the caller's workspace.
			'herdr pane split': '{"result":{"pane":{"pane_id":"w3:pB","tab_id":"w3:t1","workspace_id":"w3"}}}',
		})
		const opened = addAndOpenWorktree(exec, herdrMuxAdapter, { ...addOpts, at: 'pane:right' })

		// The pane knows where it landed...
		expect(opened.target).toEqual({ id: 'w3:pB', tab: 'w3:t1', workspace: 'w3' })
		// ...and the worktree is STILL bound to nothing. This is the assertion that would break if
		// occupancy were ever mistaken for a binding.
		expect(opened.workspace).toBeUndefined()
		expect(opened.degraded).toBe(true)
		expect(ran(calls, 'herdr', 'worktree', 'create')).toBe(false)
	})

	const env = { ROLE: 'worker' }
	const base = { primaryRoot: '/repo', path: '/repo.worktrees/x', launch: 'claude' }

	// One row per Examples row: env is native on every route EXCEPT herdr's worktree bind, whose
	// `worktree create` takes no env param — so only that one route reports `envHonored: false`.
	it.each<{
		route: string
		call: (exec: Exec) => { envHonored: boolean }
		responses: Record<string, string>
		envHonored: boolean
	}>([
		{
			route: "herdr's worktree bind",
			call: (exec) => addAndOpenWorktree(exec, herdrMuxAdapter, { ...base, branch: 'feat/x', env, at: 'workspace' }),
			responses: { 'herdr worktree create': HERDR_WORKTREE_OUT },
			envHonored: false,
		},
		{
			// The same bind route reached through `worktree open` rather than `worktree add` — exposed
			// identically (herdr's `worktree open` takes no env either), so it must report the drop too.
			// Covered so the report is not wired on one worktree verb and silently forgotten on its sibling.
			route: "herdr's worktree bind, via open",
			call: (exec) => openExistingWorktree(exec, herdrMuxAdapter, { ...base, env, at: 'workspace' }),
			responses: { 'herdr worktree open': HERDR_WORKTREE_OUT },
			envHonored: false,
		},
		{
			route: 'the plain git worktree fallback',
			call: (exec) => addAndOpenWorktree(exec, tmuxMuxAdapter, { ...base, branch: 'feat/x', env, at: 'workspace' }),
			responses: { 'tmux new-window': '%9\t@1' },
			envHonored: true,
		},
		{
			route: 'a direct open on herdr',
			call: (exec) => openExistingWorktree(exec, herdrMuxAdapter, { ...base, env, at: 'pane:right' }),
			responses: {
				'herdr pane split': '{"result":{"pane":{"pane_id":"w3:pB","tab_id":"w3:t1"}}}',
				'git -C /repo': GIT_PORCELAIN,
			},
			envHonored: true,
		},
		{
			route: 'a direct open on tmux',
			call: (exec) => openExistingWorktree(exec, tmuxMuxAdapter, { ...base, env }),
			responses: { 'tmux new-window': '%9\t@1', 'git -C /repo': GIT_PORCELAIN },
			envHonored: true,
		},
	])('placement-route-reports-env-carried', ({ call, responses, envHonored }) => {
		const opened = call(fakeExec([], responses))
		expect(opened.envHonored).toBe(envHonored)
	})
})
