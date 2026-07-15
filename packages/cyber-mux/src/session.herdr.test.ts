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

		it('herdr --at workspace creates its own workspace nested under the source', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({
				id: 'cli:workspace:create',
				result: { root_pane: { pane_id: 'w7:p1' }, workspace: { workspace_id: 'w7' } },
			})
			const exec = fakeExec(calls, { 'workspace create': createOut })
			const target = herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })
			expect(target).toEqual({ id: 'w7:p1' })
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w7:p1', 'claude'])
		})

		it('open() throws when workspace create reports no root pane id', () => {
			const exec = fakeExec([], { 'workspace create': JSON.stringify({ id: 'cli:workspace:create', result: {} }) })
			expect(() => herdrSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })).toThrow(
				/root_pane/,
			)
		})

		it('openInNewWorktree() creates the worktree and opens it in one call, extracting pane + worktree', () => {
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
			const result = herdrSessionAdapter.openInNewWorktree!(exec, {
				primaryRoot: '/repo',
				branch: 'cyber-mux/unit-abc123',
				path: '/repo.worktrees/mux-abc123',
				launch: 'claude',
			})
			expect(result.target).toEqual({ id: 'w9:p1' })
			expect(result.worktree).toEqual({ root: '/repo.worktrees/mux-abc123', branch: 'cyber-mux/unit-abc123' })
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

		it('openInNewWorktree() throws when herdr reports no root pane id', () => {
			const exec = fakeExec([], { 'worktree create': JSON.stringify({ id: 'cli:worktree:create', result: {} }) })
			expect(() =>
				herdrSessionAdapter.openInNewWorktree!(exec, {
					primaryRoot: '/repo',
					branch: 'b',
					path: '/p',
					launch: 'claude',
				}),
			).toThrow(/root_pane/)
		})

		it('openInNewWorktree() throws when herdr reports no worktree path/branch', () => {
			const out = JSON.stringify({ id: 'cli:worktree:create', result: { root_pane: { pane_id: 'w9:p1' } } })
			const exec = fakeExec([], { 'worktree create': out })
			expect(() =>
				herdrSessionAdapter.openInNewWorktree!(exec, {
					primaryRoot: '/repo',
					branch: 'b',
					path: '/p',
					launch: 'claude',
				}),
			).toThrow(/worktree/)
		})

		it('openInNewWorktree() throws when herdr reports nothing', () => {
			const exec: Exec = () => null
			expect(() =>
				herdrSessionAdapter.openInNewWorktree!(exec, {
					primaryRoot: '/repo',
					branch: 'b',
					path: '/p',
					launch: 'claude',
				}),
			).toThrow(/herdr worktree create/)
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

		it('listPanes() reports only panes with an agent, dropping scaffold panes with none', () => {
			const listOut = JSON.stringify({
				result: {
					panes: [
						{ pane_id: 'w3:p1', agent: 'claude', cwd: '/repo/a' },
						{ pane_id: 'w3:p2', agent: 'codex', cwd: '/repo/b' },
						{ pane_id: 'w3:p3' }, // scaffold pane, no agent — dropped
					],
				},
			})
			expect(herdrSessionAdapter.listPanes(fakeExec([], { 'pane list': listOut }))).toEqual([
				{ id: 'w3:p1', mux: 'herdr', harness: 'claude', cwd: '/repo/a' },
				{ id: 'w3:p2', mux: 'herdr', harness: 'codex', cwd: '/repo/b' },
			])
		})

		it('listPanes() returns empty when herdr reports nothing or unparseable output', () => {
			expect(herdrSessionAdapter.listPanes((): string | null => null)).toEqual([])
			expect(herdrSessionAdapter.listPanes(() => 'not json')).toEqual([])
		})
	})
})
