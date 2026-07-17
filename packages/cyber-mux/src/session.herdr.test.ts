import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrSessionAdapter } from './session.herdr.ts'
import type { SessionPlacement } from './session.ts'

function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		const key = args.slice(0, 2).join(' ')
		return responses[key] ?? null
	}
}

/** The capability under test — herdr always has it, so the optional member is asserted, not guessed. */
function worktree() {
	const capability = herdrSessionAdapter.worktree
	if (!capability) throw new Error('the herdr adapter must implement the worktree capability')
	return capability
}

/** The envelope `worktree create` and `worktree open` share, for tests that assert argv, not parsing. */
function worktreeOut() {
	return JSON.stringify({
		result: {
			root_pane: { pane_id: 'w9:p1' },
			workspace: { workspace_id: 'w9' },
			worktree: { path: '/p', branch: 'b' },
		},
	})
}

/** The real envelopes each placement's herdr call returns — the workspace_id rides in on all three. */
const PANE_IN_WORKSPACE = (paneId: string, ws: string) =>
	JSON.stringify({
		id: 'cli:workspace:create',
		result: { root_pane: { pane_id: paneId, tab_id: `${ws}:t1`, workspace_id: ws }, workspace: { workspace_id: ws } },
	})
const PANE_IN_TAB = (paneId: string, ws: string) =>
	JSON.stringify({
		result: {
			root_pane: { pane_id: paneId, tab_id: `${ws}:t2`, workspace_id: ws },
			tab: { tab_id: `${ws}:t2` },
			type: 'tab_created',
		},
	})
const PANE_IN_SPLIT = (paneId: string, ws: string) =>
	JSON.stringify({
		id: 'cli:pane:split',
		result: { pane: { pane_id: paneId, tab_id: `${ws}:t1`, workspace_id: ws }, type: 'pane_info' },
	})

/**
 * `describeRegion` is OPTIONAL on the seam — a backend that cannot describe its own region omits
 * it entirely. The herdr adapter must implement it, so bind it once here: if it ever goes missing
 * these tests fail loudly on that fact rather than silently skipping every case below.
 */
const describeRegion = herdrSessionAdapter.describeRegion
if (!describeRegion) throw new Error('the herdr adapter must implement describeRegion')

describe('spec:cyber-mux/mux', () => {
	describe('herdrSessionAdapter (mocked exec — herdr is not installed in this environment)', () => {
		// The outline is ONE key, so every Examples row folds under this one static title. The
		// placement-specific tests below each cover a single row and assert argv besides; this one
		// exists to carry the outline's own claim — that whatever tier is opened, `open` returns the
		// workspace the pane landed in — across all three rows at once.
		it.each<{
			at: SessionPlacement
			response: Record<string, string | null>
			expected: { id: string; workspace: string }
		}>([
			{
				at: 'workspace',
				response: { 'workspace create': PANE_IN_WORKSPACE('w7:p1', 'w7') },
				// The workspace it created.
				expected: { id: 'w7:p1', workspace: 'w7' },
			},
			{
				at: 'tab',
				response: { 'tab create': PANE_IN_TAB('w3:pT', 'w3') },
				// The workspace the new tab was created in.
				expected: { id: 'w3:pT', workspace: 'w3' },
			},
			{
				at: 'pane:right',
				response: { 'pane split': PANE_IN_SPLIT('w3:pB', 'w3') },
				// The workspace the split landed in — the caller's own.
				expected: { id: 'w3:pB', workspace: 'w3' },
			},
		])('open returns the workspace the new pane landed in', ({ at, response, expected }) => {
			const target = herdrSessionAdapter.open(fakeExec([], response), { cwd: '/unit', at })
			expect(target).toEqual(expected)
		})

		it('open() splits a pane at the given cwd, extracts the pane id from herdr JSON, and runs the launch command', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1', workspace_id: 'w3' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })
			// The workspace the split LANDED IN — the caller's own. Free: it rides in on the same output
			// the pane id is read from.
			expect(target).toEqual({ id: 'w3:pB', workspace: 'w3' })
			expect(calls[0]).toEqual(['pane', 'split', '--current', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pB', 'claude'])
		})

		it("open() at 'tab' opens a real herdr tab without stealing focus, extracting the pane id the same way as workspace create", () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w3:pT', tab_id: 'w3:t2', workspace_id: 'w3' },
					tab: { tab_id: 'w3:t2' },
					type: 'tab_created',
				},
			})
			const exec = fakeExec(calls, { 'tab create': tabOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'tab' })
			expect(target).toEqual({ id: 'w3:pT', workspace: 'w3' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pT', 'claude'])
		})

		it('--at omitted falls back to tab', () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w3:pT', tab_id: 'w3:t2', workspace_id: 'w3' },
					tab: { tab_id: 'w3:t2' },
					type: 'tab_created',
				},
			})
			const exec = fakeExec(calls, { 'tab create': tabOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude' })
			expect(target).toEqual({ id: 'w3:pT', workspace: 'w3' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pT', 'claude'])
		})

		it('herdr --at workspace creates its own workspace, unattached to any repo', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({
				id: 'cli:workspace:create',
				result: {
					root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1', workspace_id: 'w7' },
					workspace: { workspace_id: 'w7' },
				},
			})
			const exec = fakeExec(calls, { 'workspace create': createOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })
			expect(target).toEqual({ id: 'w7:p1', workspace: 'w7' })
			// `workspace create` — NOT `worktree create`. It carries no --branch/--path and produces no
			// worktree record, so the workspace is bound to no repo even when its cwd is a checkout.
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w7:p1', 'claude'])
		})

		// The workspace is read from the SAME output the pane id is read from, on every route. Probing
		// for it separately would buy nothing and cost a round trip per open, so the argv is the proof:
		// one command, and no `pane get`/`workspace list` follow-up.
		it('the workspace costs no extra backend call', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1', workspace_id: 'w7' },
					workspace: { workspace_id: 'w7' },
				},
			})
			const exec = fakeExec(calls, { 'workspace create': createOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(target).toEqual({ id: 'w7:p1', workspace: 'w7' })
			expect(calls).toHaveLength(1)
			expect(calls.some((c) => c[1] === 'get' || c[1] === 'list')).toBe(false)
		})

		// The pane id is required — a route that cannot name its pane has failed. The workspace is not:
		// a herdr build that stops emitting it degrades to "cannot say" rather than breaking `open`,
		// which is the meaning the seam already has for it.
		it('a pane whose output carries no workspace_id reports no workspace rather than throwing', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'w3:pB' })
			expect(target.workspace).toBeUndefined()
		})

		it('open() with no launch creates a blank pane and runs nothing', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1', workspace_id: 'w3' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'w3:pB', workspace: 'w3' })
			expect(calls).toHaveLength(1)
			expect(calls.some((c) => c[0] === 'pane' && c[1] === 'run')).toBe(false)
		})

		// herdr's `--current` is not "the pane that called me": it reads $HERDR_PANE_ID and silently
		// resolves to the UI-FOCUSED pane when that is unset (verified against herdr 0.7.4), so an
		// unidentified caller splits whatever the user is looking at. Naming the pane is the fix, and
		// the emitted argv is the only place the difference is visible.
		it('from names the pane a pane:* split targets', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'w3:pA' } })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: 'w3:pA' } })
			expect(calls).toEqual([
				['pane', 'split', 'w3:pA', '--direction', 'right', '--cwd', '/unit'],
				['pane', 'split', 'w3:pA', '--direction', 'down', '--cwd', '/unit'],
			])
			expect(calls.every((c) => !c.includes('--current'))).toBe(true)
		})

		it("from omitted leaves each backend its own default, which tracks the USER's focus", () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			// Kept for a caller that cannot identify itself: herdr's guess beats refusing to open.
			expect(calls[0]).toEqual(['pane', 'split', '--current', '--direction', 'right', '--cwd', '/unit'])
		})

		// `ratio` is the fraction kept by the ORIGINAL pane, and herdr's `--ratio` sizes exactly that —
		// so it passes through UNCONVERTED, where tmux's `-l` sizes the new pane and inverts. Measured
		// against 0.7.4 rather than documented, which is why the literal flag is asserted, not trusted.
		it('the ratio sign convention converts in opposite directions per backend', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({ result: { pane: { pane_id: 'w3:pB' } } })
			const exec = fakeExec(calls, { 'pane split': splitOut })
			herdrSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right', from: { id: 'w3:pA' }, ratio: 0.333 })
			expect(calls[0]).toEqual(['pane', 'split', 'w3:pA', '--direction', 'right', '--cwd', '/u', '--ratio', '0.333'])
			// 0.667 would be the inversion tmux needs — applying it here too is the failure this catches.
			expect(calls[0]).not.toContain('0.667')
		})

		it('ratio omitted leaves each backend its own even default', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB' } } }) })
			herdrSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right' })
			expect(calls[0]).not.toContain('--ratio')
		})

		it('each env variable gets its own flag, in the order given', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB' } } }) })
			herdrSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker', TIER: 'gpu' } })
			expect(calls[0]).toEqual([
				'pane',
				'split',
				'--current',
				'--direction',
				'right',
				'--cwd',
				'/u',
				'--env',
				'ROLE=worker',
				'--env',
				'TIER=gpu',
			])
		})

		it('env with no launch opens a blank shell carrying the env', () => {
			// Native env means no command to prefix is needed, so a warm pane with no command is coherent.
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB' } } }) })
			herdrSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker' } })
			expect(calls[0]).toContain('ROLE=worker')
			// The scenario says NOTHING is typed, sent, or run — so rule out all three of herdr's input
			// verbs, not just `run`. herdr spreads typing across `run`/`send-text`/`send-keys` where tmux
			// funnels everything through `send-keys`, so checking one verb leaves the others invisible: a
			// stray bare-Enter submit is exactly the regression that would slip through.
			expect(calls.some((c) => c[0] === 'pane' && ['run', 'send-text', 'send-keys'].includes(c[1] ?? ''))).toBe(false)
		})

		it('a backend declares whether it can size a split', () => {
			expect(herdrSessionAdapter.canSizeSplits).toBe(true)
		})

		// `WorkspaceCreateParams` and `TabCreateParams` both carry a native `env` Record in herdr's
		// socket schema (protocol 16), and the CLI takes the same repeatable `--env` there as `pane
		// split` does — verified against 0.7.4. Env is therefore native at EVERY tier, which a layout's
		// root pane depends on: it is born by the region open, never by a split.
		// The pane tier of the same scenario. It overlaps the repeatable-flag test above by design:
		// that one owns the per-variable/order contract, this one owns "pane is a tier env reaches",
		// so the tier scenario's key covers every row it names rather than leaving pane to a
		// neighbouring key. Many-to-one binding is intended here.
		it('env is set natively at the birth of whatever tier is opened', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB' } } }) })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right', env: { ROLE: 'planner' } })
			expect(calls[0]).toEqual([
				'pane',
				'split',
				'--current',
				'--direction',
				'right',
				'--cwd',
				'/unit',
				'--env',
				'ROLE=planner',
			])
		})

		it('env is set natively at the birth of whatever tier is opened', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1' } } })
			const exec = fakeExec(calls, { 'workspace create': createOut })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'workspace', env: { ROLE: 'planner', TIER: 'cpu' } })
			expect(calls[0]).toEqual([
				'workspace',
				'create',
				'--cwd',
				'/unit',
				'--env',
				'ROLE=planner',
				'--env',
				'TIER=cpu',
				'--no-focus',
			])
		})

		it('env is set natively at the birth of whatever tier is opened', () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({ result: { root_pane: { pane_id: 'w3:pT' } } })
			const exec = fakeExec(calls, { 'tab create': tabOut })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'tab', env: { ROLE: 'planner' } })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--env', 'ROLE=planner', '--no-focus'])
		})

		// `worktree create` is the ONE tier with no env: `WorktreeCreateParams` is
		// `[base, branch, cwd, focus, label, path, workspace_id]`, and 0.7.4 answers `--env` with
		// `unknown option: --env` — which Exec turns into a null and the adapter into a thrown "worktree
		// create failed". So passing env here must emit NOTHING, or the primary flow (a worktree pool
		// whose root pane sets ROLE) breaks outright. The adapter stays honest about its backend; the
		// caller honors env with the command prefix instead.
		it("herdr's worktree verbs cannot set env at birth, and drop it rather than failing", () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
			worktree().createInWorkspace(exec, {
				primaryRoot: '/repo',
				branch: 'feat-x',
				path: '/repo.worktrees/feat-x',
				env: { ROLE: 'planner' },
			})
			expect(calls[0]).toEqual([
				'worktree',
				'create',
				'--cwd',
				'/repo',
				'--branch',
				'feat-x',
				'--path',
				'/repo.worktrees/feat-x',
				'--no-focus',
			])
			expect(calls[0]).not.toContain('--env')
			expect(calls[0]).not.toContain('ROLE=planner')
		})

		it("herdr's worktree verbs cannot set env at birth, and drop it rather than failing", () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree open': worktreeOut() })
			worktree().openInWorkspace(exec, { primaryRoot: '/repo', path: '/p', env: { ROLE: 'planner' } })
			expect(calls[0]).toEqual(['worktree', 'open', '--cwd', '/repo', '--path', '/p', '--no-focus'])
			expect(calls[0]).not.toContain('--env')
		})

		it('from is ignored by tab and workspace, which split nothing', () => {
			const calls: string[][] = []
			const created = JSON.stringify({
				id: 'cli:workspace:create',
				result: { root_pane: { pane_id: 'w4:p1' }, type: 'workspace_created' },
			})
			const exec = fakeExec(calls, { 'workspace create': created, 'tab create': created })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'tab', from: { id: 'w3:pA' } })
			herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'workspace', from: { id: 'w3:pA' } })
			expect(calls.every((c) => !c.includes('w3:pA'))).toBe(true)
		})

		it('open() throws when workspace create reports no root pane id', () => {
			const exec = fakeExec([], { 'workspace create': JSON.stringify({ id: 'cli:workspace:create', result: {} }) })
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })).toThrow(
				/root_pane/,
			)
		})

		it('open() carries the backend’s own reason for refusing a split, and stays bare without one', () => {
			const exec = fakeExec([])
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: 'w1:p2' } })).toThrow(
				/^herdr pane split failed$/,
			)
			exec.lastError = 'pane too small to split'
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: 'w1:p2' } })).toThrow(
				/^herdr pane split failed — pane too small to split$/,
			)
		})

		it('worktree.createInWorkspace() creates the worktree and opens its bound workspace in one call', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({
				id: 'cli:worktree:create',
				result: {
					root_pane: { pane_id: 'w9:p1' },
					workspace: { workspace_id: 'w9' },
					worktree: { branch: 'cyber-mux/unit-abc123', path: '/repo.worktrees/mux-abc123' },
				},
			})
			const exec = fakeExec(calls, { 'worktree create': createOut })
			const result = worktree().createInWorkspace(exec, {
				primaryRoot: '/repo',
				branch: 'cyber-mux/unit-abc123',
				path: '/repo.worktrees/mux-abc123',
				launch: 'claude',
			})
			expect(result.target).toEqual({ id: 'w9:p1' })
			expect(result.worktree).toEqual({ root: '/repo.worktrees/mux-abc123', branch: 'cyber-mux/unit-abc123' })
			// The workspace id IS the binding — the whole reason to route through herdr rather than git.
			expect(result.workspace).toBe('w9')
			expect(calls[0]).toEqual([
				'worktree',
				'create',
				'--cwd',
				'/repo',
				'--branch',
				'cyber-mux/unit-abc123',
				'--path',
				'/repo.worktrees/mux-abc123',
				'--no-focus',
			])
			expect(calls[1]).toEqual(['pane', 'run', 'w9:p1', 'claude'])
		})

		it('open({at:workspace}) labels the workspace', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1' } } })
			herdrSessionAdapter.open(fakeExec(calls, { 'workspace create': out }), {
				cwd: '/unit',
				at: 'workspace',
				label: 'my-name',
			})
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--label', 'my-name', '--no-focus'])
		})

		it('open({at:tab}) labels the tab', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1' } } })
			herdrSessionAdapter.open(fakeExec(calls, { 'tab create': out }), { cwd: '/unit', at: 'tab', label: 'my-name' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--label', 'my-name', '--no-focus'])
		})

		it('open({at:pane:right}) renames the pane after the split — herdr has no label flag there', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { pane: { pane_id: 'w3:pB' } } })
			herdrSessionAdapter.open(fakeExec(calls, { 'pane split': out }), {
				cwd: '/unit',
				at: 'pane:right',
				label: 'my-name',
			})
			expect(calls[0]).toEqual(['pane', 'split', '--current', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[1]).toEqual(['pane', 'rename', 'w3:pB', 'my-name'])
		})

		it('open() names nothing when no label is given', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1' } } })
			herdrSessionAdapter.open(fakeExec(calls, { 'workspace create': out }), { cwd: '/unit', at: 'workspace' })
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--no-focus'])
		})

		it('worktree.createInWorkspace() labels the bound workspace', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
			worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p', label: 'my-name' })
			// Without it herdr names the workspace after the path basename, since we always pass --path.
			expect(calls[0]).toEqual([
				'worktree',
				'create',
				'--cwd',
				'/repo',
				'--branch',
				'b',
				'--path',
				'/p',
				'--label',
				'my-name',
				'--no-focus',
			])
		})

		it('worktree.openInWorkspace() labels the bound workspace', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree open': worktreeOut() })
			worktree().openInWorkspace(exec, { primaryRoot: '/repo', path: '/p', label: 'my-name' })
			expect(calls[0]).toEqual([
				'worktree',
				'open',
				'--cwd',
				'/repo',
				'--path',
				'/p',
				'--label',
				'my-name',
				'--no-focus',
			])
		})

		it('worktree.createInWorkspace() passes a base as the branch start-point', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
			worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p', base: 'origin/main' })
			expect(calls[0]).toEqual([
				'worktree',
				'create',
				'--cwd',
				'/repo',
				'--branch',
				'b',
				'--path',
				'/p',
				'--base',
				'origin/main',
				'--no-focus',
			])
		})

		it('worktree.createInWorkspace() leaves the pane blank when no launch is given', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
			worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })
			expect(calls.some((c) => c[0] === 'pane' && c[1] === 'run')).toBe(false)
		})

		it('worktree.createInWorkspace() throws when herdr reports no root pane id', () => {
			const exec = fakeExec([], { 'worktree create': JSON.stringify({ id: 'cli:worktree:create', result: {} }) })
			expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
				/root_pane/,
			)
		})

		it('worktree.createInWorkspace() throws when herdr reports no worktree path/branch', () => {
			const out = JSON.stringify({ id: 'cli:worktree:create', result: { root_pane: { pane_id: 'w9:p1' } } })
			const exec = fakeExec([], { 'worktree create': out })
			expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
				/worktree/,
			)
		})

		it('worktree.createInWorkspace() throws when herdr reports no bound workspace', () => {
			const out = JSON.stringify({
				id: 'cli:worktree:create',
				result: { root_pane: { pane_id: 'w9:p1' }, worktree: { path: '/p', branch: 'b' } },
			})
			const exec = fakeExec([], { 'worktree create': out })
			expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
				/workspace_id/,
			)
		})

		it('worktree.createInWorkspace() throws when herdr reports nothing', () => {
			const exec: Exec = () => null
			expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
				/herdr worktree create/,
			)
		})

		it('worktree.openInWorkspace() opens an existing checkout in a workspace bound to it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree open': worktreeOut() })
			const result = worktree().openInWorkspace(exec, { primaryRoot: '/repo', path: '/p', launch: 'claude' })
			expect(result.workspace).toBe('w9')
			expect(calls[0]).toEqual(['worktree', 'open', '--cwd', '/repo', '--path', '/p', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w9:p1', 'claude'])
		})

		it('worktree.openInWorkspace() throws when herdr reports nothing', () => {
			expect(() => worktree().openInWorkspace(() => null, { primaryRoot: '/repo', path: '/p' })).toThrow(
				/herdr worktree open/,
			)
		})

		it('worktree.bindings() reports only the worktrees a workspace is currently open on', () => {
			const calls: string[][] = []
			const listOut = JSON.stringify({
				id: 'cli:worktree:list',
				result: {
					worktrees: [
						{ branch: 'main', path: '/repo', open_workspace_id: 'w19' },
						{ branch: 'feat/x', path: '/repo.worktrees/x', open_workspace_id: 'w21' },
						{ branch: 'feat/y', path: '/repo.worktrees/y' },
					],
				},
			})
			const exec = fakeExec(calls, { 'worktree list': listOut })
			const bindings = worktree().bindings(exec, { primaryRoot: '/repo' })
			expect(calls[0]).toEqual(['worktree', 'list', '--cwd', '/repo'])
			expect([...bindings]).toEqual([
				['/repo', 'w19'],
				['/repo.worktrees/x', 'w21'],
			])
			expect(bindings.has('/repo.worktrees/y')).toBe(false)
		})

		it.each([
			['nothing', null],
			['unparseable output', 'not json'],
			['no worktrees array', JSON.stringify({ result: {} })],
			['a non-array worktrees field', JSON.stringify({ result: { worktrees: 'nope' } })],
		])('worktree.bindings() reports no bindings when herdr returns %s', (_label, out) => {
			expect(worktree().bindings(() => out, { primaryRoot: '/repo' }).size).toBe(0)
		})

		it('worktree.releaseWorkspace() closes the workspace without touching the checkout', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'workspace close': '' })
			worktree().releaseWorkspace(exec, 'w21')
			expect(calls).toEqual([['workspace', 'close', 'w21']])
		})

		it('open() throws when herdr reports no pane id', () => {
			const exec: Exec = () => null
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })).toThrow(
				/herdr pane split/,
			)
		})

		it('open() throws when herdr output lacks result.pane.pane_id', () => {
			const exec = fakeExec([], { 'pane split': JSON.stringify({ id: 'cli:pane:split', result: {} }) })
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })).toThrow(
				/pane_id/,
			)
		})

		it('open() throws when herdr reports no tab root pane id', () => {
			const exec: Exec = () => null
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'tab' })).toThrow(
				/herdr tab create/,
			)
		})

		it('sendText() types literal text and presses no Enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.sendText(exec, { id: 'p-1' }, 'hello')
			expect(calls).toEqual([['pane', 'send-text', 'p-1', 'hello']])
		})

		it('sendText() types a key-named word rather than interpreting it as that key', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.sendText(exec, { id: 'p-1' }, 'Up')
			expect(calls[0]).toEqual(['pane', 'send-text', 'p-1', 'Up'])
		})

		it('sendKeys() presses each key in order, typing nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.sendKeys(exec, { id: 'p-1' }, ['Escape', 'Up', 'C-c'])
			expect(calls).toEqual([['pane', 'send-keys', 'p-1', 'Escape', 'Up', 'C-c']])
		})

		it('sendKeys() sends every core key unrenamed — herdr already speaks the core vocabulary', () => {
			// Backspace is the one key tmux renames; herdr takes the core name as-is.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.sendKeys(exec, { id: 'p-1' }, ['Backspace'])
			expect(calls[0]).toEqual(['pane', 'send-keys', 'p-1', 'Backspace'])
		})

		it('sendKeys() forwards a non-core token verbatim, leaving herdr to refuse it', () => {
			// herdr answers an unknown key with `unsupported key <k>` rather than typing it, so the
			// divergence is loud AT THE HERDR BOUNDARY (tmux types it instead). It is not loud at the
			// CLI: `Exec` drops stderr and reports failure as `null`, so exit 0 either way. What this
			// pins is only that cyber-mux forwards the token instead of pre-rejecting it.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.sendKeys(exec, { id: 'p-1' }, ['Home'])
			expect(calls[0]).toEqual(['pane', 'send-keys', 'p-1', 'Home'])
		})

		it('sendKeys() Enter presses Enter, because the caller asked for it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.sendKeys(exec, { id: 'p-1' }, ['Enter'])
			expect(calls[0]).toEqual(['pane', 'send-keys', 'p-1', 'Enter'])
		})

		it('submit() with text uses pane run, herdr’s atomic text-plus-Enter primitive', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.submit(exec, { id: 'p-1' }, 'echo hi')
			expect(calls).toEqual([['pane', 'run', 'p-1', 'echo hi']])
		})

		it('submit() types key-named text literally — pane run does not interpret it as a key', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.submit(exec, { id: 'p-1' }, 'Up')
			expect(calls).toEqual([['pane', 'run', 'p-1', 'Up']])
		})

		it('submit() with no text flushes the staged buffer with a bare Enter, never re-typing it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.submit(exec, { id: 'p-1' })
			expect(calls).toEqual([['pane', 'send-keys', 'p-1', 'Enter']])
		})

		it('submit() with empty text is the bare flush, not a second contract', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.submit(exec, { id: 'p-1' }, '')
			expect(calls).toEqual([['pane', 'send-keys', 'p-1', 'Enter']])
		})

		it('read() captures visible pane output, optionally scoped to N lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane read': 'line1\nline2' })
			expect(herdrSessionAdapter.read(exec, { id: 'p-1' })).toBe('line1\nline2')
			expect(calls[0]).toEqual(['pane', 'read', 'p-1', '--source', 'visible'])

			herdrSessionAdapter.read(exec, { id: 'p-1' }, { lines: 50 })
			expect(calls[1]).toEqual(['pane', 'read', 'p-1', '--source', 'visible', '--lines', '50'])
		})

		it("focus() beams the attached client to the pane's own workspace and tab, in order", () => {
			const calls: string[][] = []
			const paneGetOut = JSON.stringify({
				result: { pane: { pane_id: 'w3:pB', workspace_id: 'w7', tab_id: 'w7:t2' } },
			})
			const exec = fakeExec(calls, { 'pane get': paneGetOut })
			herdrSessionAdapter.focus(exec, { id: 'w3:pB' })
			expect(calls).toEqual([
				['pane', 'get', 'w3:pB'],
				['workspace', 'focus', 'w7'],
				['tab', 'focus', 'w7:t2'],
			])
		})

		it('focus() throws instead of a false success when the recorded pane no longer resolves, and switches nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane get': null })
			expect(() => herdrSessionAdapter.focus(exec, { id: 'gone-pane' })).toThrow(/could not be resolved to beam to/)
			expect(calls).toEqual([['pane', 'get', 'gone-pane']])
		})

		it('teardown() closes the pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.teardown(exec, { id: 'p-1' })
			expect(calls[0]).toEqual(['pane', 'close', 'p-1'])
		})

		it('paneExists() is true for a live pane (read returns content, even empty) and false for a gone one', () => {
			// live pane with content
			expect(herdrSessionAdapter.paneExists(fakeExec([], { 'pane read': 'some output' }), { id: 'w3:p4' })).toBe(true)
			// live but empty pane — '' is non-null, so still exists
			expect(herdrSessionAdapter.paneExists(fakeExec([], { 'pane read': '' }), { id: 'w3:p4' })).toBe(true)
			// gone pane — read fails (Exec yields null)
			expect(herdrSessionAdapter.paneExists((): string | null => null, { id: 'w3:p4' })).toBe(false)
		})

		it('herdr reports a pane focused when its pane record is focused', () => {
			const focusedOut = JSON.stringify({ result: { pane: { pane_id: 'w3:pB', focused: true } } })
			expect(herdrSessionAdapter.isPaneFocused(fakeExec([], { 'pane get': focusedOut }), { id: 'w3:pB' })).toBe(true)
		})

		it('herdr reports a pane not focused when its pane record is not focused', () => {
			const notFocusedOut = JSON.stringify({ result: { pane: { pane_id: 'w3:pB', focused: false } } })
			expect(herdrSessionAdapter.isPaneFocused(fakeExec([], { 'pane get': notFocusedOut }), { id: 'w3:pB' })).toBe(
				false,
			)
		})

		it('a focus query that cannot be answered is unknown, not a boolean', () => {
			const errorOut = JSON.stringify({ error: { code: 'pane_not_found' } })
			expect(herdrSessionAdapter.isPaneFocused(fakeExec([], { 'pane get': errorOut }), { id: 'gone' })).toBeUndefined()
			expect(herdrSessionAdapter.isPaneFocused(() => null, { id: 'gone' })).toBeUndefined()
			expect(herdrSessionAdapter.isPaneFocused(() => 'not json', { id: 'w3:pB' })).toBeUndefined()
		})

		it('listPanes() reports every live pane, agent-bearing or not', () => {
			const listOut = JSON.stringify({
				result: {
					panes: [
						{ pane_id: 'w3:p1', agent: 'claude', cwd: '/repo/a' },
						{ pane_id: 'w3:p2', agent: 'codex', cwd: '/repo/b' },
						{ pane_id: 'w3:p3', cwd: '/repo/c' }, // blank/scaffold pane, no agent — still reported
					],
				},
			})
			expect(herdrSessionAdapter.listPanes(fakeExec([], { 'pane list': listOut }))).toEqual([
				{ id: 'w3:p1', mux: 'herdr', harness: 'claude', cwd: '/repo/a' },
				{ id: 'w3:p2', mux: 'herdr', harness: 'codex', cwd: '/repo/b' },
				{ id: 'w3:p3', mux: 'herdr', harness: undefined, cwd: '/repo/c' },
			])
		})

		it("listPanes() drops entries herdr reports with no pane_id, but keeps a bare '' agent as no harness", () => {
			const listOut = JSON.stringify({
				result: {
					panes: [
						{ agent: 'claude', cwd: '/repo/a' }, // no pane_id — dropped
						{ pane_id: 'w3:p9', agent: '' },
					],
				},
			})
			expect(herdrSessionAdapter.listPanes(fakeExec([], { 'pane list': listOut }))).toEqual([
				{ id: 'w3:p9', mux: 'herdr', harness: undefined, cwd: undefined },
			])
		})

		it('listPanes() returns empty when herdr reports nothing or unparseable output', () => {
			expect(herdrSessionAdapter.listPanes((): string | null => null)).toEqual([])
			expect(herdrSessionAdapter.listPanes(() => 'not json')).toEqual([])
		})

		// Real capture from herdr 0.7.4 (`herdr pane layout --pane w3V:p1`): a workspace at x=36,y=1
		// sized 201x45, split right at ratio 0.6 then down at 0.7 — three panes.
		const LAYOUT_OUT = JSON.stringify({
			id: 'cli:pane:layout',
			result: {
				layout: {
					area: { height: 45, width: 201, x: 36, y: 1 },
					focused_pane_id: 'w3V:p1',
					panes: [
						{ focused: true, pane_id: 'w3V:p1', rect: { height: 32, width: 121, x: 36, y: 1 } },
						{ focused: false, pane_id: 'w3V:p3', rect: { height: 13, width: 121, x: 36, y: 33 } },
						{ focused: false, pane_id: 'w3V:p2', rect: { height: 45, width: 80, x: 157, y: 1 } },
					],
					// Deliberately present but never read by describeRegion — see the "ignores splits" test below.
					splits: [
						{ direction: 'right', id: 'split_0_root', ratio: 0.6, rect: { height: 45, width: 201, x: 36, y: 1 } },
						{ direction: 'down', id: 'split_1_0', ratio: 0.7, rect: { height: 45, width: 121, x: 36, y: 1 } },
					],
					tab_id: 'w3V:t1',
					workspace_id: 'w3V',
					zoomed: false,
				},
				type: 'pane_layout',
			},
		})

		// `pane list` companion for LAYOUT_OUT — carries cwd/label, which `pane layout` does not.
		const LIST_OUT = JSON.stringify({
			id: 'cli:pane:list',
			result: {
				panes: [
					{ pane_id: 'w3V:p1', cwd: '/repo', label: 'editor' },
					{ pane_id: 'w3V:p2', cwd: '/repo' },
					{ pane_id: 'w3V:p3', cwd: '/repo/logs', label: 'logs' },
				],
			},
		})

		it('describeRegion() queries pane layout by id, and pane list separately for cwd/label', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
			describeRegion(exec, { id: 'w3V:p1' })
			expect(calls).toContainEqual(['pane', 'layout', '--pane', 'w3V:p1'])
			expect(calls).toContainEqual(['pane', 'list'])
		})

		it('describeRegion() parses rects from layout.panes, screen-absolute and passed through verbatim', () => {
			const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
			const panes = describeRegion(exec, { id: 'w3V:p1' })
			expect(panes.map((p) => ({ id: p.id, rect: p.rect }))).toEqual([
				{ id: 'w3V:p1', rect: { height: 32, width: 121, x: 36, y: 1 } },
				{ id: 'w3V:p3', rect: { height: 13, width: 121, x: 36, y: 33 } },
				{ id: 'w3V:p2', rect: { height: 45, width: 80, x: 157, y: 1 } },
			])
			// Screen-absolute, not window-relative like tmux: a workspace can start at x=36, not 0.
			expect(panes.every((p) => p.rect.x === 0)).toBe(false)
		})

		// `layout.splits[]` reports direction/ratio outright, but its parent links live only in an
		// undocumented id convention ("split_1_0") — the rects say the same thing in a fact herdr
		// actually promises, so the export must be derived from `panes[]`, never `splits[]`.
		it('describeRegion() ignores layout.splits, deriving rects from panes only', () => {
			const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
			const panes = describeRegion(exec, { id: 'w3V:p1' })
			// Two panes' worth of rects, not the splits' rects (which include the whole 201x45 area and a
			// 121x45 sub-area that no reported pane actually has).
			expect(panes.some((p) => p.rect.width === 201)).toBe(false)
			expect(panes.some((p) => p.rect.height === 45 && p.rect.width === 121)).toBe(false)
			expect(panes).toHaveLength(3)
		})

		it('describeRegion() attaches a label only when herdr reports one — no hostname filtering needed', () => {
			const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
			const panes = describeRegion(exec, { id: 'w3V:p1' })
			expect(panes.find((p) => p.id === 'w3V:p1')?.label).toBe('editor')
			expect(panes.find((p) => p.id === 'w3V:p3')?.label).toBe('logs')
			// p2's `pane list` entry carries no label key at all — omitted, not a falsy placeholder.
			expect(panes.find((p) => p.id === 'w3V:p2')?.label).toBeUndefined()
		})

		it('describeRegion() parses cwd from pane list, keyed by pane id', () => {
			const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
			const panes = describeRegion(exec, { id: 'w3V:p1' })
			expect(panes.find((p) => p.id === 'w3V:p3')?.cwd).toBe('/repo/logs')
		})

		it('describeRegion() throws when herdr reports nothing', () => {
			const exec: Exec = () => null
			expect(() => describeRegion(exec, { id: 'w3V:p1' })).toThrow(/could not describe the region/)
		})

		it('describeRegion() throws when pane layout returns unparseable JSON', () => {
			const exec = fakeExec([], { 'pane layout': 'not json' })
			expect(() => describeRegion(exec, { id: 'w3V:p1' })).toThrow(/unparseable output/)
		})

		it('describeRegion() throws when herdr reports no panes', () => {
			const out = JSON.stringify({ result: { layout: { panes: [] } } })
			const exec = fakeExec([], { 'pane layout': out })
			expect(() => describeRegion(exec, { id: 'w3V:p1' })).toThrow(/reported no panes/)
		})

		// Best-effort: the geometry is the verbose, hard-won part. A `pane list` failure must not take
		// down a query whose rects came back fine — cwd/label are just visibly absent.
		it('describeRegion() is best-effort: returns geometry without cwd/label when pane list fails', () => {
			const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': null })
			const panes = describeRegion(exec, { id: 'w3V:p1' })
			expect(panes).toHaveLength(3)
			expect(panes.every((p) => p.cwd === undefined && p.label === undefined)).toBe(true)
			expect(panes.map((p) => p.rect)).toEqual([
				{ height: 32, width: 121, x: 36, y: 1 },
				{ height: 13, width: 121, x: 36, y: 33 },
				{ height: 45, width: 80, x: 157, y: 1 },
			])
		})
	})
})
