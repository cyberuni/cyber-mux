import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { createZellijAdapter, zellijMuxAdapter } from './mux.zellij.ts'

/**
 * Keyed by `args[1]`, not `args[0]` — every zellij call is `zellij action <verb> …`, so `args[0]` is
 * always `'action'` and cannot distinguish `new-pane` from `new-tab` the way tmux/herdr's fakes key
 * off their own first argument. (Same shape as the wezterm fake, whose `args[0]` is always `'cli'`.)
 */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[1]!] ?? null
	}
}

const LIST_ONE = JSON.stringify([
	{
		id: 'terminal_9',
		tab_id: 2,
		tab_name: 'main',
		title: 'zsh',
		pane_command: 'zsh',
		pane_cwd: '/unit',
		is_focused: true,
	},
])

// A session-bound adapter for the workspace-reporting cases; the exported singleton has no session.
const sessionAdapter = createZellijAdapter({ session: 'my-session' })

describe('spec:cyber-mux/mux/placement', () => {
	describe('zellijMuxAdapter', () => {
		it('open() at pane:right splits with --direction right and resolves tab from list-panes', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			const target = zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'terminal_9', tab: '2' })
			expect(calls[0]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
			// the tab costs a SEPARATE list-panes call — new-pane reports only the bare pane id.
			expect(calls[1]).toEqual(['action', 'list-panes', '--json'])
		})

		it('open() at pane:down splits with --direction down', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[0]).toEqual(['action', 'new-pane', '--direction', 'down', '--cwd', '/unit'])
		})

		it('open() reports the ambient session as the workspace when the adapter is bound to one', () => {
			const exec = fakeExec([], { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			const target = sessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'terminal_9', tab: '2', workspace: 'my-session' })
		})

		it('placement-at-tab-new-tab', () => {
			const calls: string[][] = []
			// new-tab reports the TAB id; the tab's initial pane is the list-panes record carrying it.
			const exec = fakeExec(calls, { 'new-tab': '2', 'list-panes': LIST_ONE })
			const target = zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[0]).toEqual(['action', 'new-tab', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'terminal_9', tab: '2' })
		})

		it('placement-at-workspace-visible-space', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-tab': '2', 'list-panes': LIST_ONE })
			const target = sessionAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			// identical to a `tab` open — the collapse forced by session-scoped ids + a session-less target.
			expect(calls[0]).toEqual(['action', 'new-tab', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'terminal_9', tab: '2', workspace: 'my-session' })
		})

		it('open() names the tab at birth with --name', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-tab': '2', 'list-panes': LIST_ONE })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', label: 'ledger' })
			expect(calls[0]).toEqual(['action', 'new-tab', '--cwd', '/unit', '--name', 'ledger'])
		})

		it('open() names the pane at birth with --name — Zellij can title a pane, unlike wezterm', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', label: 'worker' })
			expect(calls[0]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit', '--name', 'worker'])
		})

		it('open() with a `from` focuses that pane first — the only way to choose the split target', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'terminal_3' } })
			expect(calls[0]).toEqual(['action', 'focus-pane-id', 'terminal_3'])
			expect(calls[1]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
		})

		it('open() drops a ratio — a tiled split is always even', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio: 0.333 })
			expect(calls[0]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[0]).not.toContain('--width')
			expect(calls[0]).not.toContain('33')
		})

		// zellij has no --env on new-pane/new-tab, so env rides in as a prefix on the launch command,
		// exactly the fallback wezterm and herdr's worktree route use.
		it('placement-env-rides-command-prefix', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', env: { ROLE: 'worker' }, launch: 'claude' })
			const newPane = calls.find((c) => c[1] === 'new-pane')!
			expect(newPane).not.toContain('--env')
			expect(newPane.join(' ')).not.toContain('ROLE')
			// the launch is submitted: write-chars the env-prefixed command, then send-keys Enter.
			expect(calls).toContainEqual(['action', 'write-chars', '--pane-id', 'terminal_9', "env ROLE='worker' claude"])
			expect(calls).toContainEqual(['action', 'send-keys', '--pane-id', 'terminal_9', 'Enter'])
		})

		it('placement-env-no-command-warns', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			const writes: string[] = []
			const original = process.stderr.write
			process.stderr.write = ((s: string) => {
				writes.push(s)
				return true
			}) as never
			try {
				zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', env: { ROLE: 'worker' } })
			} finally {
				process.stderr.write = original
			}
			expect(writes.some((w) => w.includes('ROLE'))).toBe(true)
			expect(calls.some((c) => c[1] === 'write-chars')).toBe(false)
		})

		it('open() throws when new-pane reports nothing', () => {
			const exec = fakeExec([], { 'new-pane': null })
			expect(() => zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })).toThrow(/new-pane/)
		})

		it('rename() on a tab uses rename-tab-by-id', () => {
			const calls: string[][] = []
			zellijMuxAdapter.rename(fakeExec(calls), { id: '2' }, 'tab', 'ledger')
			expect(calls).toEqual([['action', 'rename-tab-by-id', '2', 'ledger']])
		})

		it('rename() on a pane uses rename-pane --pane-id', () => {
			const calls: string[][] = []
			zellijMuxAdapter.rename(fakeExec(calls), { id: 'terminal_9' }, 'pane', 'worker')
			expect(calls).toEqual([['action', 'rename-pane', '--pane-id', 'terminal_9', 'worker']])
		})

		it('group() is a complete no-op — the session is already the workspace tier', () => {
			const calls: string[][] = []
			zellijMuxAdapter.group(fakeExec(calls), { id: '2' }, 'my-group', 'ledger')
			expect(calls).toEqual([])
		})

		it('does not declare it can size a split — tiled splits are always even', () => {
			expect(zellijMuxAdapter.canSizeSplits).toBeUndefined()
		})

		// Optional omissions, not stubs: pane geometry semantics need a live binary (regions), and there
		// is no worktree subcommand in the CLI at all.
		it('has no regions (describeRegion/describeWorkspace) or worktree capability', () => {
			expect(zellijMuxAdapter.regions).toBeUndefined()
			expect(zellijMuxAdapter.worktree).toBeUndefined()
		})
	})
})

describe('spec:cyber-mux/mux/driving', () => {
	describe('zellijMuxAdapter', () => {
		it('sendText writes literal characters with write-chars, pressing no Enter', () => {
			const calls: string[][] = []
			zellijMuxAdapter.sendText(fakeExec(calls), { id: 'terminal_9' }, 'Enter')
			expect(calls).toEqual([['action', 'write-chars', '--pane-id', 'terminal_9', 'Enter']])
		})

		it('sendKeys renames core keys to Zellij spellings and forwards the rest verbatim', () => {
			const calls: string[][] = []
			zellijMuxAdapter.sendKeys(fakeExec(calls), { id: 'terminal_9' }, ['C-c', 'Escape', 'Up', 'Zzz'])
			expect(calls).toEqual([['action', 'send-keys', '--pane-id', 'terminal_9', 'Ctrl c', 'Esc', 'Up', 'Zzz']])
		})

		it('submit with text writes it literally then presses Enter, two calls', () => {
			const calls: string[][] = []
			zellijMuxAdapter.submit(fakeExec(calls), { id: 'terminal_9' }, 'hello')
			expect(calls).toEqual([
				['action', 'write-chars', '--pane-id', 'terminal_9', 'hello'],
				['action', 'send-keys', '--pane-id', 'terminal_9', 'Enter'],
			])
		})

		it('driving-submit-no-text-bare-enter', () => {
			const calls: string[][] = []
			zellijMuxAdapter.submit(fakeExec(calls), { id: 'terminal_9' })
			expect(calls).toEqual([['action', 'send-keys', '--pane-id', 'terminal_9', 'Enter']])
		})

		it('read dumps the viewport to stdout', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'dump-screen': 'hello' })
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' })).toBe('hello')
			expect(calls).toEqual([['action', 'dump-screen', '--pane-id', 'terminal_9']])
		})

		it('read with lines dumps the full scrollback and keeps the trailing N lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'dump-screen': 'a\nb\nc\nd\ne' })
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' }, { lines: 2 })).toBe('d\ne')
			expect(calls).toEqual([['action', 'dump-screen', '--pane-id', 'terminal_9', '--full']])
		})

		it('teardown closes the pane', () => {
			const calls: string[][] = []
			zellijMuxAdapter.teardown(fakeExec(calls), { id: 'terminal_9' })
			expect(calls).toEqual([['action', 'close-pane', '--pane-id', 'terminal_9']])
		})
	})
})

describe('spec:cyber-mux/mux/lookup', () => {
	describe('zellijMuxAdapter', () => {
		it('focus drives focus-pane-id', () => {
			const calls: string[][] = []
			zellijMuxAdapter.focus(fakeExec(calls), { id: 'terminal_9' })
			expect(calls).toEqual([['action', 'focus-pane-id', 'terminal_9']])
		})

		it('paneExists scans the live listing, treating a bare id and its terminal_ twin as equal', () => {
			const exec = fakeExec([], { 'list-panes': LIST_ONE })
			expect(zellijMuxAdapter.paneExists(exec, { id: 'terminal_9' })).toBe(true)
			// a bare `9` names the same pane as `terminal_9`.
			expect(zellijMuxAdapter.paneExists(exec, { id: '9' })).toBe(true)
			expect(zellijMuxAdapter.paneExists(exec, { id: 'terminal_99' })).toBe(false)
		})

		it('lookup-focus-unknown-not-boolean', () => {
			const exec = fakeExec([], { 'list-panes': LIST_ONE })
			expect(zellijMuxAdapter.isPaneFocused(exec, { id: 'terminal_9' })).toBe(true)
			expect(zellijMuxAdapter.isPaneFocused(exec, { id: 'terminal_99' })).toBeUndefined()
		})

		it('isPaneFocused reports false for a pane the backend says is not focused', () => {
			const list = JSON.stringify([{ id: 'terminal_9', tab_id: 2, pane_command: 'zsh', is_focused: false }])
			const exec = fakeExec([], { 'list-panes': list })
			expect(zellijMuxAdapter.isPaneFocused(exec, { id: 'terminal_9' })).toBe(false)
		})

		it('lookup-listing-enumerates-all-panes', () => {
			const list = JSON.stringify([
				{ id: 'terminal_9', tab_id: 2, title: 'worker', pane_command: 'claude', pane_cwd: '/unit' },
				// title equals the running command — ambient, not chosen — so it reports no label.
				{ id: 'terminal_10', tab_id: 2, title: 'zsh', pane_command: 'zsh', pane_cwd: '/other' },
			])
			const exec = fakeExec([], { 'list-panes': list })
			expect(zellijMuxAdapter.listPanes(exec)).toEqual([
				{ id: 'terminal_9', mux: 'zellij', cwd: '/unit', label: 'worker' },
				{ id: 'terminal_10', mux: 'zellij', cwd: '/other' },
			])
		})

		it('listPanes returns nothing when the backend cannot be read', () => {
			expect(zellijMuxAdapter.listPanes(fakeExec([]))).toEqual([])
		})

		it('listPanes returns nothing on non-JSON output rather than throwing', () => {
			const exec = fakeExec([], { 'list-panes': 'not json' })
			expect(zellijMuxAdapter.listPanes(exec)).toEqual([])
		})
	})
})
