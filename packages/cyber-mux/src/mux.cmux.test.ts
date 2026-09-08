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

/**
 * `workspace create` answers `{window_*, workspace_*, surface_*}` — and **no `pane_ref`**, which is
 * why a workspace open reports its own surface as the tab.
 */
const NEW_WORKSPACE_RESPONSE = JSON.stringify({
	window_ref: 'window:1',
	workspace_ref: 'workspace:2',
	surface_ref: 'surface:10',
})

/** `rpc surface.list` echoes the workspace it resolved the pane into at the TOP level, not per row. */
const SURFACE_LIST_RESPONSE = JSON.stringify({
	workspace_id: '9C4E1B2A-0000-4000-8000-000000000001',
	workspace_ref: 'workspace:2',
	window_ref: 'window:1',
	surfaces: [{ ref: 'surface:10', pane_ref: 'pane:5' }],
})

/** A workspace the routing fell BACK to: it holds neither the pane nor the surface that was asked for. */
const OTHER_WORKSPACE_LIST_RESPONSE = JSON.stringify({
	workspace_ref: 'workspace:9',
	surfaces: [{ ref: 'surface:1', pane_ref: 'pane:1' }],
})

/** `workspace-group create` wraps the group in a `{ group, created }` envelope. */
const GROUP_CREATE_RESPONSE = JSON.stringify({
	group: { ref: 'workspace_group:1', name: 'shift-a', member_workspace_refs: [] },
	created: true,
})

/**
 * `list-panels` (`surface.list`) — a top-level OBJECT with a `surfaces` array, whose rows key the id as
 * `ref`, focus as `focused`, and carry no cwd. The shape this adapter used to expect (an array of panes
 * each holding surface objects keyed `surface_ref`/`is_focused`) is one cmux never emits.
 */
const LIST_PANELS_RESPONSE = JSON.stringify({
	workspace_ref: 'workspace:1',
	surfaces: [
		{
			ref: 'surface:1',
			id: '11111111-0000-4000-8000-000000000001',
			index: 0,
			type: 'terminal',
			title: 'main',
			focused: true,
			pane_ref: 'pane:1',
			selected_in_pane: true,
			requested_working_directory: '/home/user',
		},
		{
			ref: 'surface:2',
			index: 1,
			type: 'terminal',
			title: 'tests',
			focused: false,
			pane_ref: 'pane:1',
			selected_in_pane: false,
		},
		{
			ref: 'surface:3',
			index: 2,
			type: 'terminal',
			title: '',
			focused: false,
			pane_ref: 'pane:2',
			selected_in_pane: true,
		},
	],
})

const workspaceAdapter = createCmuxAdapter({ workspace: 'workspace:1' })

describe('spec:cyber-mux/mux', () => {
	describe('cmuxMuxAdapter', () => {
		// `--direction` is the ONLY flag this route may send: `new-pane` has no `--cwd` and no `--size`,
		// and validates no unknown flag, so anything else would be accepted and dropped on the floor.
		it('open() at pane:right splits with --direction right and no fabricated flags', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			const target = cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'surface:7', tab: 'pane:3' })
			expect(calls[0]).toEqual(['--json', 'new-pane', '--direction', 'right'])
		})

		it('open() at pane:down splits with --direction down', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[0]).toEqual(['--json', 'new-pane', '--direction', 'down'])
		})

		// The split cannot take a cwd natively, so it rides a `cd` — the same last-resort shape env takes.
		it('open() at pane:right carries cwd as a cd, alone when there is no launch command', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit dir', at: 'pane:right' })
			expect(calls[1]).toEqual(['send', '--surface', 'surface:7', "cd '/unit dir'"])
			expect(calls[2]).toEqual(['send-key', '--surface', 'surface:7', 'enter'])
		})

		it('open() at pane:right chains the launch command after the cd, with env inside it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', launch: 'pnpm test', env: { CI: '1' } })
			expect(calls[1]).toEqual(['send', '--surface', 'surface:7', "cd '/unit' && env CI='1' pnpm test"])
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

		// The NAMESPACED spelling: `new-workspace` hardcodes `honorJSONOutput: false`, so `--json
		// new-workspace` prints `OK workspace:N` and this route threw on every call parsing it.
		it('open() at workspace creates a new workspace through `workspace create`', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { workspace: NEW_WORKSPACE_RESPONSE })
			const target = cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(calls[0]).toEqual(['--json', 'workspace', 'create', '--cwd', '/unit'])
			// No pane_ref in the payload, so the new workspace's own surface is the tab.
			expect(target).toEqual({ id: 'surface:10', tab: 'surface:10', workspace: 'workspace:2' })
		})

		// A workspace is named AT BIRTH here — `--name` — so no rename follows it.
		it('open() at workspace names the workspace at birth, issuing no rename', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { workspace: NEW_WORKSPACE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', label: 'shift a' })
			expect(calls).toEqual([['--json', 'workspace', 'create', '--cwd', '/unit', '--name', 'shift a']])
		})

		it('open() with a `from` focuses that surface first — the only way to choose the split target', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'surface:3' } })
			expect(calls[0]).toEqual(['focus-panel', '--panel', 'surface:3'])
			expect(calls[1]).toEqual(['--json', 'new-pane', '--direction', 'right'])
		})

		// cmux has no split-size flag at all, so a ratio degrades to its own even split rather than
		// riding a `--size` the CLI would accept and ignore.
		it('open() with a ratio renders no size flag', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio: 0.7 })
			expect(calls[0]).toEqual(['--json', 'new-pane', '--direction', 'right'])
		})

		it('canSizeSplits is not declared', () => {
			expect(cmuxMuxAdapter.canSizeSplits).toBeUndefined()
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

		// With an explicit `--surface`, cmux resolves it INSIDE a workspace and refuses when it has
		// neither `--workspace` nor `--window`, falling back to `$CMUX_WORKSPACE_ID` — the caller's own.
		// A bound adapter names the workspace instead of leaning on that fallback.
		it('teardown() names the workspace the adapter is bound to', () => {
			const calls: string[][] = []
			workspaceAdapter.teardown(fakeExec(calls, {}), { id: 'surface:1' })
			expect(calls[0]).toEqual(['close-surface', '--surface', 'surface:1', '--workspace', 'workspace:1'])
		})

		it('teardown() unbound sends the flagless form, which cmux resolves from $CMUX_WORKSPACE_ID', () => {
			const calls: string[][] = []
			cmuxMuxAdapter.teardown(fakeExec(calls, {}), { id: 'surface:1' })
			expect(calls[0]).toEqual(['close-surface', '--surface', 'surface:1'])
		})

		// `rename-surface` / `rename-pane` do not exist in cmux. `rename-tab` does, and cmux's tab is its
		// surface — so BOTH tiers land on it, the pane tier by retargeting the surface the pane shows.
		it('rename() at the tab tier renames the surface through rename-tab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panels': LIST_PANELS_RESPONSE })
			cmuxMuxAdapter.rename(exec, { id: 'surface:2' }, 'tab', 'build logs')
			expect(calls).toEqual([
				['--json', 'list-panels'],
				['rename-tab', '--surface', 'surface:2', '--title', 'build logs'],
			])
		})

		it('rename() given a PANE handle retargets the surface that pane is showing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panels': LIST_PANELS_RESPONSE })
			// pane:1 holds surface:1 (selected) and surface:2 — the selected one is what a human reads.
			cmuxMuxAdapter.rename(exec, { id: 'pane:1' }, 'pane', 'agent run')
			expect(calls[1]).toEqual(['rename-tab', '--surface', 'surface:1', '--title', 'agent run'])
		})

		it('rename() throws when no surface answers the handle, issuing no rename', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panels': LIST_PANELS_RESPONSE })
			expect(() => cmuxMuxAdapter.rename(exec, { id: 'surface:99' }, 'tab', 'nope')).toThrow(/surface/i)
			expect(calls).toEqual([['--json', 'list-panels']])
		})

		// `label` on a split routes through `rename`, which is why the split's own surface is what gets
		// named — there is no pane name in cmux for it to have set instead.
		it('open() at pane:right labels the split by renaming its surface', () => {
			const calls: string[][] = []
			const listing = JSON.stringify({
				surfaces: [{ ref: 'surface:7', title: '', focused: true, pane_ref: 'pane:3', selected_in_pane: true }],
			})
			const exec = fakeExec(calls, { 'new-pane': NEW_PANE_RESPONSE, 'list-panels': listing })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', label: 'worker' })
			expect(calls[0]).toEqual(['--json', 'new-pane', '--direction', 'right'])
			expect(calls[2]).toEqual(['rename-tab', '--surface', 'surface:7', '--title', 'worker'])
		})

		// All three read `list-panels`, not `list-panes`: the pane verb answers a different tier in a
		// different shape, which the old parse rejected outright — leaving all three dead on every real
		// response (empty listing, always-false existence, always-unknown focus).
		it('paneExists() returns true when the surface is in the list', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panels': LIST_PANELS_RESPONSE })
			expect(cmuxMuxAdapter.paneExists(exec, { id: 'surface:2' })).toBe(true)
			expect(calls[0]).toEqual(['--json', 'list-panels'])
		})

		it('paneExists() returns false when the surface is not in the list', () => {
			const exec = fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE })
			expect(cmuxMuxAdapter.paneExists(exec, { id: 'surface:99' })).toBe(false)
		})

		it('isPaneFocused() returns true for the focused surface', () => {
			const exec = fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE })
			expect(cmuxMuxAdapter.isPaneFocused(exec, { id: 'surface:1' })).toBe(true)
		})

		it('isPaneFocused() returns false for a non-focused surface', () => {
			const exec = fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE })
			expect(cmuxMuxAdapter.isPaneFocused(exec, { id: 'surface:2' })).toBe(false)
		})

		it('isPaneFocused() returns undefined for an unknown surface', () => {
			const exec = fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE })
			expect(cmuxMuxAdapter.isPaneFocused(exec, { id: 'surface:99' })).toBeUndefined()
		})

		// No `cwd`: cmux reports none per surface, and `requested_working_directory` is the directory
		// asked for at creation, not where the shell is — exporting it would be a quiet lie after a `cd`.
		it('listPanes() returns every surface, with no cwd and no invented label', () => {
			const exec = fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE })
			const panes = cmuxMuxAdapter.listPanes(exec)
			expect(panes).toEqual([
				{ id: 'surface:1', mux: 'cmux', label: 'main', floating: false },
				{ id: 'surface:2', mux: 'cmux', label: 'tests', floating: false },
				{ id: 'surface:3', mux: 'cmux', floating: false },
			])
		})

		// The old parse required a top-level ARRAY, which is what made the real object response read as
		// empty. Keep a case pinned on the shape cmux actually emits being the one that is understood.
		it('listPanes() is empty for the pane-tier shape, and full for the surface-tier one', () => {
			const paneShape = JSON.stringify({ panes: [{ ref: 'pane:1', surface_refs: ['surface:1'] }] })
			expect(cmuxMuxAdapter.listPanes(fakeExec([], { 'list-panels': paneShape }))).toEqual([])
			expect(cmuxMuxAdapter.listPanes(fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE }))).toHaveLength(3)
		})

		// `--id-format uuids` strips `ref` and leaves `id`; the listing must survive either format.
		it('listPanes() falls back to the uuid id when no ref is present', () => {
			const uuidShape = JSON.stringify({
				surfaces: [{ id: '11111111-0000-4000-8000-000000000001', title: 'main', focused: true }],
			})
			expect(cmuxMuxAdapter.listPanes(fakeExec([], { 'list-panels': uuidShape }))).toEqual([
				{ id: '11111111-0000-4000-8000-000000000001', mux: 'cmux', label: 'main', floating: false },
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
			// Both spellings are tried — the handle may be a pane or a surface — and neither answered.
			expect(calls).toEqual([
				['rpc', 'surface.list', '{"pane_id":"pane:5"}'],
				['rpc', 'surface.list', '{"surface_id":"pane:5"}'],
			])
		})

		// The tab id a workspace open hands back is a SURFACE, and cmux's handle registry is keyed by the
		// ref string rather than by kind — so `pane_id: 'surface:10'` resolves to a UUID that names no
		// pane, and the routing falls back to the CALLER's workspace. Each attempt is therefore checked
		// against its own rows, and the surface spelling is what answers.
		it('group() retries with the surface selector when the pane one routes to another workspace', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				if (args[0] === 'rpc') {
					return args[2] === '{"pane_id":"surface:10"}' ? OTHER_WORKSPACE_LIST_RESPONSE : SURFACE_LIST_RESPONSE
				}
				return args[1] === 'workspace-group' ? GROUP_CREATE_RESPONSE : null
			}
			cmuxMuxAdapter.group(exec, { id: 'surface:10' }, 'shift-a')
			expect(calls[0]).toEqual(['rpc', 'surface.list', '{"pane_id":"surface:10"}'])
			expect(calls[1]).toEqual(['rpc', 'surface.list', '{"surface_id":"surface:10"}'])
			// workspace:9 was the fallback answer and is NOT the one grouped.
			expect(calls[3]).toEqual(['workspace-group', 'add', '--group', 'workspace_group:1', '--workspace', 'workspace:2'])
		})

		// A routing that lands on a workspace holding neither the pane nor the surface is a fallback, not
		// an answer — grouping it would group a space the caller never named.
		it('group() throws rather than grouping a workspace that does not hold the target', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				rpc: OTHER_WORKSPACE_LIST_RESPONSE,
				'workspace-group': GROUP_CREATE_RESPONSE,
			})
			expect(() => cmuxMuxAdapter.group(exec, { id: 'pane:5' }, 'shift-a')).toThrow(/workspace/i)
			expect(calls.map((c) => c[0])).toEqual(['rpc', 'rpc'])
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
				workspace: NEW_WORKSPACE_RESPONSE,
				rpc: SURFACE_LIST_RESPONSE,
				'workspace-group': GROUP_CREATE_RESPONSE,
			})
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', workspaceGroup: 'shift-a' })
			expect(calls).toEqual([
				['--json', 'workspace', 'create', '--cwd', '/unit'],
				// the TAB id of the new workspace — its own surface, since `workspace create` reports no pane
				['rpc', 'surface.list', '{"pane_id":"surface:10"}'],
				['--json', 'workspace-group', 'create', '--name', 'shift-a', '--idempotency-key', 'shift-a'],
				['workspace-group', 'add', '--group', 'workspace_group:1', '--workspace', 'workspace:2'],
			])
		})

		// A workspace nobody grouped stays ungrouped, and no adapter invents an id.
		it('open() at workspace with no group issues no grouping command', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { workspace: NEW_WORKSPACE_RESPONSE })
			cmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(calls).toEqual([['--json', 'workspace', 'create', '--cwd', '/unit']])
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
			expect(paneCalls[0]).toEqual(['--json', 'new-pane', '--direction', 'right'])
			expect(paneCalls.map((c) => c[0])).not.toContain('workspace-group')
		})
	})
})

describe('spec:cyber-mux/mux/lookup', () => {
	describe('cmuxMuxAdapter', () => {
		// No cmux row on `lookup-listing-reports-cwd` any more: cmux reports no live cwd at any tier, so
		// the listing carries none rather than exporting the directory a surface was CREATED with.
		it('lookup-listing-reports-no-cwd-on-cmux', () => {
			const panes = cmuxMuxAdapter.listPanes(fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE }))
			expect(panes.length).toBeGreaterThan(0)
			for (const pane of panes) expect(pane.cwd).toBeUndefined()
		})

		it('lookup-listing-floating-false-by-construction', () => {
			// cmux has no floating-pane concept at all, so every surface it reports really is tiled.
			// `false` is the TRUE answer here, not a stub standing in for one — and it is never omitted:
			// an absent value would leave a caller guessing between "not floating" and "cannot tell".
			const panes = cmuxMuxAdapter.listPanes(fakeExec([], { 'list-panels': LIST_PANELS_RESPONSE }))
			expect(panes.length).toBeGreaterThan(0)
			for (const pane of panes) expect(pane.floating).toBe(false)
		})
	})
})

describe('spec:cyber-mux/mux/driving', () => {
	// The `pane.break` envelope, keyed the way cmux's default `--id-format refs` emits it.
	const BROKEN = JSON.stringify({
		window_ref: 'window:1',
		workspace_ref: 'workspace:9',
		pane_ref: 'pane:4',
		surface_ref: 'surface:7',
	})

	it('breakPane() always names the surface, because a flagless pane.break breaks the FOCUSED one', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'break-pane': BROKEN })
		expect(cmuxMuxAdapter.breakPane(exec, { id: 'surface:7' }, 'workspace')).toEqual({
			id: 'surface:7',
			tab: 'pane:4',
			workspace: 'workspace:9',
		})
		expect(calls).toEqual([['--json', 'break-pane', '--surface', 'surface:7', '--focus', 'false']])
	})

	// `at` collapses UPWARD on cmux — a surface IS a tab, so the only break it has lands the surface
	// alone in a fresh workspace. The returned pane reports that workspace rather than pretending a tab.
	it.each(['tab', 'workspace'] as const)('breakPane(%s) sends the same command and reports the new workspace', (at) => {
		const opened = cmuxMuxAdapter.breakPane(fakeExec([], { 'break-pane': BROKEN }), { id: 'surface:7' }, at)
		expect(opened.workspace).toBe('workspace:9')
	})

	it('breakPane() carries the bound workspace as the SOURCE context, exactly as teardown does', () => {
		const calls: string[][] = []
		workspaceAdapter.breakPane(fakeExec(calls, { 'break-pane': BROKEN }), { id: 'surface:7' }, 'workspace')
		expect(calls[0]).toEqual([
			'--json',
			'break-pane',
			'--surface',
			'surface:7',
			'--focus',
			'false',
			'--workspace',
			'workspace:1',
		])
	})

	it('breakPane() throws on a refusal, and on an envelope with no surface ref', () => {
		expect(() => cmuxMuxAdapter.breakPane(fakeExec([]), { id: 'surface:7' }, 'tab')).toThrow(
			/cmux could not break out surface surface:7 into its own tab/,
		)
		expect(() => cmuxMuxAdapter.breakPane(fakeExec([], { 'break-pane': '{}' }), { id: 'surface:7' }, 'tab')).toThrow(
			/cmux break-pane did not report the surface ref/,
		)
	})
})
