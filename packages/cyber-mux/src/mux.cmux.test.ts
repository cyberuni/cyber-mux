import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { cmuxMuxAdapter, createCmuxAdapter } from './mux.cmux.ts'

/**
 * Keyed by `args[0]` — every cmux call is `cmux <verb> …` (or `cmux --json <verb> …`), so we match
 * on the verb after stripping `--json`.
 */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		// Find the verb (skip --json if present)
		const verbIndex = args[0] === '--json' ? 1 : 0
		const verb = args[verbIndex]!
		return responses[verb] ?? null
	}
}

const NEW_PANE_RESPONSE = JSON.stringify({
	surface_ref: 'surface:7',
	pane_ref: 'pane:3',
	workspace_ref: 'workspace:1',
})

const NEW_SURFACE_RESPONSE = JSON.stringify({
	surface_ref: 'surface:8',
	pane_ref: 'pane:2',
})

const NEW_WORKSPACE_RESPONSE = JSON.stringify({
	surface_ref: 'surface:10',
	pane_ref: 'pane:5',
	workspace_ref: 'workspace:2',
})

const LIST_PANES_RESPONSE = JSON.stringify([
	{
		pane_ref: 'pane:1',
		surfaces: [
			{ surface_ref: 'surface:1', title: 'main', cwd: '/home/user', is_focused: true },
			{ surface_ref: 'surface:2', title: 'tests', cwd: '/home/user/tests' },
		],
	},
	{
		pane_ref: 'pane:2',
		surfaces: [{ surface_ref: 'surface:3', cwd: '/tmp' }],
	},
])

const workspaceAdapter = createCmuxAdapter({ workspace: 'workspace:1' })

describe('spec:cyber-mux/mux', () => {
	describe('cmuxMuxAdapter', () => {
		it('open() at pane:right splits with --direction right', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			const target = cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'surface:7', tab: 'pane:3' })
			expect(calls[0]).toEqual(['--json', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
		})

		it('open() at pane:down splits with --direction down', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[0]).toEqual(['--json', 'new-pane', '--direction', 'down', '--cwd', '/unit'])
		})

		it('open() reports the ambient workspace when the adapter is bound to one', () => {
			const exec = fakeExec([], { 'new-pane': NEW_PANE_RESPONSE })
			const target = workspaceAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'surface:7', tab: 'pane:3', workspace: 'workspace:1' })
		})

		it('open() at tab creates a new surface in the current pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-surface': NEW_SURFACE_RESPONSE })
			const target = cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[0]).toEqual(['--json', 'new-surface', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'surface:8', tab: 'pane:2' })
		})

		it('open() at tab with `within` targets that pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-surface': NEW_SURFACE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', within: 'pane:5' })
			expect(calls[0]).toEqual(['--json', 'new-surface', '--pane', 'pane:5', '--cwd', '/unit'])
		})

		it('open() at workspace creates a new workspace', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-workspace': NEW_WORKSPACE_RESPONSE })
			const target = cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(calls[0]).toEqual(['--json', 'new-workspace', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'surface:10', tab: 'pane:5', workspace: 'workspace:2' })
		})

		it('open() with a `from` focuses that surface first — the only way to choose the split target', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'surface:3' } })
			expect(calls[0]).toEqual(['focus-panel', '--panel', 'surface:3'])
			expect(calls[1]).toEqual(['--json', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
		})

		it('open() with a ratio sizes the new pane via --size (inverted)', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio: 0.7 })
			// ratio 0.7 means original keeps 70%, new gets 30% → --size 0.3
			expect(calls[0]).toEqual([
				'--json',
				'new-pane',
				'--direction',
				'right',
				'--cwd',
				'/unit',
				'--size',
				'0.30000000000000004',
			])
		})

		it('canSizeSplits is true', () => {
			expect(cmuxMuxAdapter.canSizeSplits).toBe(true)
		})

		it('sendText() sends text to a surface', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			cmuxMuxAdapter.sendText(exec, { id: 'surface:1' }, 'hello world')
			expect(calls[0]).toEqual(['send', '--surface', 'surface:1', 'hello world'])
		})

		it('sendKeys() sends keys one at a time', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			cmuxMuxAdapter.sendKeys(exec, { id: 'surface:1' }, ['Enter', 'Tab'])
			expect(calls[0]).toEqual(['send-key', '--surface', 'surface:1', 'enter'])
			expect(calls[1]).toEqual(['send-key', '--surface', 'surface:1', 'tab'])
		})

		it('submit() with text sends text then Enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			cmuxMuxAdapter.submit(exec, { id: 'surface:1' }, 'npm test')
			expect(calls[0]).toEqual(['send', '--surface', 'surface:1', 'npm test'])
			expect(calls[1]).toEqual(['send-key', '--surface', 'surface:1', 'enter'])
		})

		it('submit() without text sends just Enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			cmuxMuxAdapter.submit(exec, { id: 'surface:1' })
			expect(calls[0]).toEqual(['send-key', '--surface', 'surface:1', 'enter'])
		})

		it('read() reads screen content', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'read-screen': 'screen output' })
			const result = cmuxMuxAdapter.read(exec, { id: 'surface:1' })
			expect(calls[0]).toEqual(['read-screen', '--surface', 'surface:1'])
			expect(result).toEqual({ text: 'screen output' })
		})

		it('read() with lines passes --lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'read-screen': 'last 50 lines' })
			cmuxMuxAdapter.read(exec, { id: 'surface:1' }, { lines: 50 })
			expect(calls[0]).toEqual(['read-screen', '--surface', 'surface:1', '--lines', '50'])
		})

		it('focus() focuses a surface', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			cmuxMuxAdapter.focus(exec, { id: 'surface:1' })
			expect(calls[0]).toEqual(['focus-panel', '--panel', 'surface:1'])
		})

		it('teardown() closes a surface', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			cmuxMuxAdapter.teardown(exec, { id: 'surface:1' })
			expect(calls[0]).toEqual(['close-surface', '--surface', 'surface:1'])
		})

		it('paneExists() returns true when the surface is in the list', () => {
			const exec = fakeExec([], { 'list-panes': LIST_PANES_RESPONSE })
			expect(cmuxMuxAdapter.paneExists(exec, { id: 'surface:2' })).toBe(true)
		})

		it('paneExists() returns false when the surface is not in the list', () => {
			const exec = fakeExec([], { 'list-panes': LIST_PANES_RESPONSE })
			expect(cmuxMuxAdapter.paneExists(exec, { id: 'surface:99' })).toBe(false)
		})

		it('isPaneFocused() returns true for the focused surface', () => {
			const exec = fakeExec([], { 'list-panes': LIST_PANES_RESPONSE })
			expect(cmuxMuxAdapter.isPaneFocused(exec, { id: 'surface:1' })).toBe(true)
		})

		it('isPaneFocused() returns false for a non-focused surface', () => {
			const exec = fakeExec([], { 'list-panes': LIST_PANES_RESPONSE })
			expect(cmuxMuxAdapter.isPaneFocused(exec, { id: 'surface:2' })).toBe(false)
		})

		it('isPaneFocused() returns undefined for an unknown surface', () => {
			const exec = fakeExec([], { 'list-panes': LIST_PANES_RESPONSE })
			expect(cmuxMuxAdapter.isPaneFocused(exec, { id: 'surface:99' })).toBeUndefined()
		})

		it('listPanes() returns all surfaces with their metadata', () => {
			const exec = fakeExec([], { 'list-panes': LIST_PANES_RESPONSE })
			const panes = cmuxMuxAdapter.listPanes(exec)
			expect(panes).toEqual([
				{ id: 'surface:1', mux: 'cmux', cwd: '/home/user', label: 'main' },
				{ id: 'surface:2', mux: 'cmux', cwd: '/home/user/tests', label: 'tests' },
				{ id: 'surface:3', mux: 'cmux', cwd: '/tmp' },
			])
		})

		it('group() is a no-op — cmux has a real workspace tier', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			cmuxMuxAdapter.group(exec, { id: 'surface:1' }, 'my-group')
			expect(calls).toEqual([])
		})

		it('name is cmux', () => {
			expect(cmuxMuxAdapter.name).toBe('cmux')
		})
	})
})
