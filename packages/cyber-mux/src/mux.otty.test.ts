import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { createOttyAdapter, ottyMuxAdapter } from './mux.otty.ts'

/**
 * Keyed by the verb — `otty <verb> <subverb> …`, so we match on `<verb> <subverb>` or just `<verb>`.
 */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		// Match on verb or verb+subverb
		const key = args.slice(0, 2).join(' ')
		const verbOnly = args[0]!
		return responses[key] ?? responses[verbOnly] ?? null
	}
}

const NEW_PANE_RESPONSE = JSON.stringify({
	pane_id: 'pane:7',
	tab_id: 'tab:3',
	window_id: 'window:1',
})

const NEW_TAB_RESPONSE = JSON.stringify({
	pane_id: 'pane:8',
	tab_id: 'tab:4',
})

const NEW_WINDOW_RESPONSE = JSON.stringify({
	pane_id: 'pane:10',
	tab_id: 'tab:5',
	window_id: 'window:2',
})

const LIST_PANES_RESPONSE = JSON.stringify([
	{ pane_id: 'pane:1', title: 'main', cwd: '/home/user', is_focused: true },
	{ pane_id: 'pane:2', title: 'tests', cwd: '/home/user/tests' },
	{ pane_id: 'pane:3', cwd: '/tmp' },
])

const windowAdapter = createOttyAdapter({ window: 'window:1' })

describe('spec:cyber-mux/mux', () => {
	describe('ottyMuxAdapter', () => {
		it('open() at pane:right splits with --right', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			const target = ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'pane:7', tab: 'tab:3' })
			expect(calls[0]).toEqual(['pane', 'split', '--right', '--cwd', '/unit'])
		})

		it('open() at pane:down splits with --bottom', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[0]).toEqual(['pane', 'split', '--bottom', '--cwd', '/unit'])
		})

		it('open() reports the ambient window when the adapter is bound to one', () => {
			const exec = fakeExec([], { 'pane split': NEW_PANE_RESPONSE })
			const target = windowAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'pane:7', tab: 'tab:3', workspace: 'window:1' })
		})

		it('open() at tab creates a new tab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			const target = ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[0]).toEqual(['tab', 'new', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'pane:8', tab: 'tab:4' })
		})

		it('open() at workspace creates a new window', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { open: NEW_WINDOW_RESPONSE })
			const target = ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(calls[0]).toEqual(['open', '--new-window', '/unit'])
			expect(target).toEqual({ id: 'pane:10', tab: 'tab:5', workspace: 'window:2' })
		})

		it('open() with a `from` focuses that pane first', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'pane:3' } })
			expect(calls[0]).toEqual(['pane', 'focus', '--pane', 'pane:3'])
			expect(calls[1]).toEqual(['pane', 'split', '--right', '--cwd', '/unit'])
		})

		it('canSizeSplits is false', () => {
			expect(ottyMuxAdapter.canSizeSplits).toBe(false)
		})

		it('sendText() sends text to a pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.sendText(exec, { id: 'pane:1' }, 'hello world')
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'hello world'])
		})

		it('sendKeys() sends keys with key: prefix', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.sendKeys(exec, { id: 'pane:1' }, ['Enter', 'Tab'])
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'key:Enter', 'key:Tab'])
		})

		it('submit() with text sends text and key:Enter atomically', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.submit(exec, { id: 'pane:1' }, 'npm test')
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'npm test', 'key:Enter'])
		})

		it('submit() without text sends just key:Enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.submit(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'key:Enter'])
		})

		it('read() reads pane content via capture', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane capture': 'screen output' })
			const result = ottyMuxAdapter.read(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'capture', '--pane', 'pane:1'])
			expect(result).toEqual({ text: 'screen output' })
		})

		it('read() with lines passes --lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane capture': 'last 50 lines' })
			ottyMuxAdapter.read(exec, { id: 'pane:1' }, { lines: 50 })
			expect(calls[0]).toEqual(['pane', 'capture', '--pane', 'pane:1', '--lines', '50'])
		})

		it('focus() focuses a pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.focus(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'focus', '--pane', 'pane:1'])
		})

		it('teardown() closes a pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.teardown(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'close', '--pane', 'pane:1'])
		})

		it('paneExists() returns true when the pane is in the list', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.paneExists(exec, { id: 'pane:2' })).toBe(true)
		})

		it('paneExists() returns false when the pane is not in the list', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.paneExists(exec, { id: 'pane:99' })).toBe(false)
		})

		it('isPaneFocused() returns true for the focused pane', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.isPaneFocused(exec, { id: 'pane:1' })).toBe(true)
		})

		it('isPaneFocused() returns false for a non-focused pane', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.isPaneFocused(exec, { id: 'pane:2' })).toBe(false)
		})

		it('isPaneFocused() returns undefined for an unknown pane', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.isPaneFocused(exec, { id: 'pane:99' })).toBeUndefined()
		})

		it('listPanes() returns all panes with their metadata', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			const panes = ottyMuxAdapter.listPanes(exec)
			expect(panes).toEqual([
				{ id: 'pane:1', mux: 'otty', cwd: '/home/user', label: 'main' },
				{ id: 'pane:2', mux: 'otty', cwd: '/home/user/tests', label: 'tests' },
				{ id: 'pane:3', mux: 'otty', cwd: '/tmp' },
			])
		})

		it('group() is a no-op — otty has a real window tier', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.group(exec, { id: 'pane:1' }, 'my-group')
			expect(calls).toEqual([])
		})

		it('rename() at tab renames the tab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.rename(exec, { id: 'tab:1' }, 'tab', 'my-tab')
			expect(calls[0]).toEqual(['tab', 'rename', '--tab', 'tab:1', '--title', 'my-tab'])
		})

		it('rename() at pane renames the pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.rename(exec, { id: 'pane:1' }, 'pane', 'my-pane')
			expect(calls[0]).toEqual(['pane', 'rename', '--pane', 'pane:1', '--title', 'my-pane'])
		})

		it('name is otty', () => {
			expect(ottyMuxAdapter.name).toBe('otty')
		})
	})
})
