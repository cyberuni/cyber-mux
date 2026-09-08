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

/** `rpc surface.list` echoes the workspace it resolved the pane into at the TOP level, not per row. */
const SURFACE_LIST_RESPONSE = JSON.stringify({
	workspace_id: '9C4E1B2A-0000-4000-8000-000000000001',
	workspace_ref: 'workspace:2',
	window_ref: 'window:1',
	surfaces: [{ ref: 'surface:10', pane_ref: 'pane:5' }],
})

/** `workspace-group create` wraps the group in a `{ group, created }` envelope. */
const GROUP_CREATE_RESPONSE = JSON.stringify({
	group: { ref: 'workspace_group:1', name: 'shift-a', member_workspace_refs: [] },
	created: true,
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
				{ id: 'surface:1', mux: 'cmux', cwd: '/home/user', label: 'main', floating: false },
				{ id: 'surface:2', mux: 'cmux', cwd: '/home/user/tests', label: 'tests', floating: false },
				{ id: 'surface:3', mux: 'cmux', cwd: '/tmp', floating: false },
			])
		})

		it('name is cmux', () => {
			expect(cmuxMuxAdapter.name).toBe('cmux')
		})
	})
})

describe('spec:cyber-mux/mux/placement', () => {
	describe('cmuxMuxAdapter', () => {
		const groupExec = (calls: string[][]) =>
			fakeExec(calls, { rpc: SURFACE_LIST_RESPONSE, 'workspace-group': GROUP_CREATE_RESPONSE })

		// `group` on an already-open space, the verb `open` itself routes through — one spelling, so the
		// two cannot drift.
		it('group() creates the group idempotently, then adds the workspace', () => {
			const calls: string[][] = []
			cmuxMuxAdapter.group(groupExec(calls), { id: 'pane:5' }, 'shift-a')
			expect(calls).toEqual([
				['rpc', 'surface.list', '{"pane_id":"pane:5"}'],
				['--json', 'workspace-group', 'create', '--name', 'shift-a', '--idempotency-key', 'shift-a'],
				['workspace-group', 'add', '--group', 'workspace_group:1', '--workspace', 'workspace:2'],
			])
		})

		// The id reaches cmux VERBATIM, on both flags — never parsed, split, or derived from a label.
		it('group() passes the opaque id through unaltered', () => {
			const calls: string[][] = []
			cmuxMuxAdapter.group(groupExec(calls), { id: 'pane:5' }, 'acme - beta - main')
			expect(calls[1]).toEqual([
				'--json',
				'workspace-group',
				'create',
				'--name',
				'acme - beta - main',
				'--idempotency-key',
				'acme - beta - main',
			])
		})

		// The seam's `name` is the SPACE's own name, not the group's. cmux has a real workspace tier
		// whose tab label is already the tab's own name, so — herdr's answer exactly — it is not stored.
		it('group() ignores the space name: nothing composed it, so nothing is stored', () => {
			const withName: string[][] = []
			const withoutName: string[][] = []
			cmuxMuxAdapter.group(groupExec(withName), { id: 'pane:5' }, 'shift-a', 'editor')
			cmuxMuxAdapter.group(groupExec(withoutName), { id: 'pane:5' }, 'shift-a')
			expect(withName).toEqual(withoutName)
		})

		it('group() prefers the group ref, and falls back to a uuid id under --id-format uuids', () => {
			const calls: string[][] = []
			const uuid = '3F2504E0-4F89-11D3-9A0C-0305E82C3301'
			const exec = fakeExec(calls, {
				rpc: SURFACE_LIST_RESPONSE,
				'workspace-group': JSON.stringify({ group: { id: uuid, name: 'shift-a' }, created: true }),
			})
			cmuxMuxAdapter.group(exec, { id: 'pane:5' }, 'shift-a')
			expect(calls[2]).toEqual(['workspace-group', 'add', '--group', uuid, '--workspace', 'workspace:2'])
		})

		// A lookup that cannot answer must not guess a workspace: grouping the WRONG one is the failure
		// this whole route exists to avoid, so it refuses by name before any group command is issued.
		it("group() throws when the pane's workspace cannot be resolved, issuing no group command", () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'workspace-group': GROUP_CREATE_RESPONSE })
			expect(() => cmuxMuxAdapter.group(exec, { id: 'pane:5' }, 'shift-a')).toThrow(/workspace/i)
			expect(calls).toEqual([['rpc', 'surface.list', '{"pane_id":"pane:5"}']])
		})

		it('group() throws when create reports no group ref, issuing no add', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				rpc: SURFACE_LIST_RESPONSE,
				'workspace-group': JSON.stringify({ created: true }),
			})
			expect(() => cmuxMuxAdapter.group(exec, { id: 'pane:5' }, 'shift-a')).toThrow(/group ref/i)
			expect(calls.map((c) => c[0])).toEqual(['rpc', '--json'])
		})

		it('placement-cmux-group-id-workspace-group', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'new-workspace': NEW_WORKSPACE_RESPONSE,
				rpc: SURFACE_LIST_RESPONSE,
				'workspace-group': GROUP_CREATE_RESPONSE,
			})
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', workspaceGroup: 'shift-a' })
			expect(calls).toEqual([
				['--json', 'new-workspace', '--cwd', '/unit'],
				// the TAB id of the new workspace — cmux's pane ref — is what the lookup resolves
				['rpc', 'surface.list', '{"pane_id":"pane:5"}'],
				['--json', 'workspace-group', 'create', '--name', 'shift-a', '--idempotency-key', 'shift-a'],
				['workspace-group', 'add', '--group', 'workspace_group:1', '--workspace', 'workspace:2'],
			])
		})

		// A workspace nobody grouped stays ungrouped, and no adapter invents an id.
		it('open() at workspace with no group issues no grouping command', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-workspace': NEW_WORKSPACE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(calls).toEqual([['--json', 'new-workspace', '--cwd', '/unit']])
		})

		// A tab or split lands in the caller's EXISTING workspace; grouping that would group a space the
		// caller never opened — the same line tmux draws at its split.
		it('placement-cmux-group-only-the-workspace-route', () => {
			const tabCalls: string[][] = []
			cmuxMuxAdapter.open(fakeExec(tabCalls, { 'new-surface': NEW_SURFACE_RESPONSE }), {
				cwd: '/unit',
				at: 'tab',
				workspaceGroup: 'shift-a',
			})
			expect(tabCalls).toEqual([['--json', 'new-surface', '--cwd', '/unit']])

			const paneCalls: string[][] = []
			cmuxMuxAdapter.open(fakeExec(paneCalls, { 'new-pane': NEW_PANE_RESPONSE }), {
				cwd: '/unit',
				at: 'pane:right',
				workspaceGroup: 'shift-a',
			})
			expect(paneCalls).toEqual([['--json', 'new-pane', '--direction', 'right', '--cwd', '/unit']])
		})
	})
})

describe('spec:cyber-mux/mux/lookup', () => {
	describe('cmuxMuxAdapter', () => {
		// The cmux row of the outline: `cwd` rides the same `list-panes` call the listing already makes.
		it('lookup-listing-reports-cwd', () => {
			const panes = cmuxMuxAdapter.listPanes(fakeExec([], { 'list-panes': LIST_PANES_RESPONSE }))
			expect(panes.map((p) => p.cwd)).toEqual(['/home/user', '/home/user/tests', '/tmp'])
		})

		it('lookup-listing-floating-false-by-construction', () => {
			// cmux has no floating-pane concept at all, so every surface it reports really is tiled.
			// `false` is the TRUE answer here, not a stub standing in for one — and it is never omitted:
			// an absent value would leave a caller guessing between "not floating" and "cannot tell".
			const panes = cmuxMuxAdapter.listPanes(fakeExec([], { 'list-panes': LIST_PANES_RESPONSE }))
			expect(panes.length).toBeGreaterThan(0)
			for (const pane of panes) expect(pane.floating).toBe(false)
		})
	})
})
