import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrSessionAdapter } from './session.herdr.ts'

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

describe('spec:cyber-mux/mux', () => {
	describe('herdrSessionAdapter (mocked exec — herdr is not installed in this environment)', () => {
		it('open() splits a pane at the given cwd, extracts the pane id from herdr JSON, and runs the launch command', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1', workspace_id: 'w3' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })
			expect(target).toEqual({ id: 'w3:pB' })
			expect(calls[0]).toEqual(['pane', 'split', '--current', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pB', 'claude'])
		})

		it("open() at 'tab' opens a real herdr tab without stealing focus, extracting the pane id the same way as workspace create", () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({
				result: { root_pane: { pane_id: 'w3:pT' }, tab: { tab_id: 'w3:t2' }, type: 'tab_created' },
			})
			const exec = fakeExec(calls, { 'tab create': tabOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'tab' })
			expect(target).toEqual({ id: 'w3:pT' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pT', 'claude'])
		})

		it('--at omitted falls back to tab', () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({
				result: { root_pane: { pane_id: 'w3:pT' }, tab: { tab_id: 'w3:t2' }, type: 'tab_created' },
			})
			const exec = fakeExec(calls, { 'tab create': tabOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude' })
			expect(target).toEqual({ id: 'w3:pT' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pT', 'claude'])
		})

		it('herdr --at workspace creates its own workspace, unattached to any repo', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({
				id: 'cli:workspace:create',
				result: { root_pane: { pane_id: 'w7:p1' }, workspace: { workspace_id: 'w7' } },
			})
			const exec = fakeExec(calls, { 'workspace create': createOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })
			expect(target).toEqual({ id: 'w7:p1' })
			// `workspace create` — NOT `worktree create`. It carries no --branch/--path and produces no
			// worktree record, so the workspace is bound to no repo even when its cwd is a checkout.
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w7:p1', 'claude'])
		})

		it('open() with no launch creates a blank pane and runs nothing', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1', workspace_id: 'w3' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'w3:pB' })
			expect(calls).toHaveLength(1)
			expect(calls.some((c) => c[0] === 'pane' && c[1] === 'run')).toBe(false)
		})

		it('open() throws when workspace create reports no root pane id', () => {
			const exec = fakeExec([], { 'workspace create': JSON.stringify({ id: 'cli:workspace:create', result: {} }) })
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })).toThrow(
				/root_pane/,
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

		it('send() runs text in the target pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.send(exec, { id: 'p-1' }, 'hello')
			expect(calls[0]).toEqual(['pane', 'run', 'p-1', 'hello'])
		})

		it('submit() flushes the staged buffer with a bare Enter, never re-typing the text', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrSessionAdapter.submit(exec, { id: 'p-1' })
			expect(calls[0]).toEqual(['pane', 'send-keys', 'p-1', 'Enter'])
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
	})
})
