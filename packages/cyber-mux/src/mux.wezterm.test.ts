import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'

/**
 * Keyed by `args[1]`, not `args[0]` — every wezterm call is `wezterm cli <subcommand> ...`, so
 * `args[0]` is always `'cli'` and cannot distinguish `spawn` from `split-pane` the way tmux/herdr's
 * fakes key off their own first argument.
 */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[1]!] ?? null
	}
}

const LIST_ONE = JSON.stringify([
	{ window_id: 1, tab_id: 2, pane_id: 9, workspace: 'default', title: 'zsh', cwd: 'file://host/unit' },
])

describe('spec:cyber-mux/mux', () => {
	describe('weztermMuxAdapter', () => {
		it('open() at pane:right splits with --right and reports the pane, resolving tab+workspace', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: '9', tab: '2', workspace: 'default' })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--right', '--cwd', '/unit'])
			// unlike tmux/herdr, the tab/workspace cost a SEPARATE list call — spawn/split-pane report
			// only the bare pane id.
			expect(calls[1]).toEqual(['cli', 'list', '--format', 'json'])
		})

		it('open() at pane:down splits with --bottom', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--bottom', '--cwd', '/unit'])
		})

		it('open() at tab spawns into the current window, never --new-window', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[0]).toEqual(['cli', 'spawn', '--cwd', '/unit'])
			expect(target).toEqual({ id: '9', tab: '2', workspace: 'default' })
		})

		it('open() at tab with a `within` spawns into a window of THAT workspace', () => {
			// A wezterm workspace is a set of WINDOWS, so the anchor resolves one tier down: any window
			// already in the named workspace will do. Untargeted, `spawn` lands in the window the user is
			// looking at — the wrong-workspace bug this closes.
			const calls: string[][] = []
			const list = JSON.stringify([
				{ window_id: 1, tab_id: 2, pane_id: 9, workspace: 'default' },
				{ window_id: 4, tab_id: 5, pane_id: 6, workspace: 'pool' },
			])
			const exec = fakeExec(calls, { spawn: '9', list })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', within: 'pool' })
			// The list lookup that resolved the anchor comes FIRST, then the targeted spawn.
			expect(calls[0]).toEqual(['cli', 'list', '--format', 'json'])
			expect(calls[1]).toEqual(['cli', 'spawn', '--window-id', '4', '--cwd', '/unit'])
		})

		it('open() at tab throws when the named workspace has no window left to open a tab in', () => {
			// Never a silent fall back to an untargeted spawn: that IS the wrong-space bug.
			const exec = fakeExec([], { spawn: '9', list: LIST_ONE })
			expect(() => weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', within: 'gone' })).toThrow(/gone/)
		})

		it('open() at workspace passes --new-window and a fresh --workspace name, and reports it without an extra call', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			const spawnCall = calls.find((c) => c[1] === 'spawn')!
			expect(spawnCall).toEqual(['cli', 'spawn', '--new-window', '--workspace', spawnCall[4], '--cwd', '/unit'])
			// the workspace name IS what open() picked — known without a list lookup, unlike the tab.
			expect(target.workspace).toBe(spawnCall[4])
			expect(target.tab).toBe('2')
		})

		it('open() at workspace uses --label as the workspace name when given, rather than minting one', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', label: 'my-unit' })
			expect(calls[0]).toEqual(['cli', 'spawn', '--new-window', '--workspace', 'my-unit', '--cwd', '/unit'])
			expect(target.workspace).toBe('my-unit')
		})

		it('open() at tab sets the tab title after birth, because spawn has no title flag at all', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', label: 'ledger' })
			expect(calls).toContainEqual(['cli', 'set-tab-title', '--tab-id', '2', 'ledger'])
		})

		it('open() at pane:right degrades a --label to a stderr warning, since no pane-title primitive exists', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			const writes: string[] = []
			const spy = (s: string) => {
				writes.push(s)
				return true
			}
			const original = process.stderr.write
			process.stderr.write = spy as never
			try {
				const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', label: 'ledger' })
				expect(target.id).toBe('9')
			} finally {
				process.stderr.write = original
			}
			expect(writes.some((w) => w.includes('ledger') && w.includes('9'))).toBe(true)
			// never a set-tab-title/set-window-title call for a pane placement's label
			expect(calls.some((c) => c[1] === 'set-tab-title' || c[1] === 'set-window-title')).toBe(false)
		})

		// The issue's own trap (#47): --percent sizes the NEW pane, same inversion as tmux's -l — not
		// herdr's pass-through. Pinned at a non-midpoint ratio, which is the one value the inversion
		// cannot hide behind.
		it('the ratio sign convention inverts, same direction as tmux', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio: 0.333 })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--right', '--percent', '67', '--cwd', '/unit'])
			expect(calls[0]).not.toContain('33')
		})

		it('ratio omitted leaves wezterm its own even default', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(calls[0]).not.toContain('--percent')
		})

		it('from names the pane a pane:* split targets', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: '3' } })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--right', '--pane-id', '3', '--cwd', '/unit'])
		})

		// wezterm has NO --env on spawn or split-pane at all — unlike herdr, which loses it on only one
		// route, every wezterm open takes the same fallback herdr's worktree route does.
		it('env is never native — it rides in as an env prefix on the launch command', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, {
				cwd: '/unit',
				at: 'pane:right',
				env: { ROLE: 'worker' },
				launch: 'claude',
			})
			const splitCall = calls.find((c) => c[1] === 'split-pane')!
			expect(splitCall).not.toContain('--env')
			expect(splitCall.join(' ')).not.toContain('ROLE')
			const sendText = calls.find((c) => c[1] === 'send-text' && !c.includes('--no-paste'))
			expect(sendText).toEqual(['cli', 'send-text', '--pane-id', '9', "env ROLE='worker' claude"])
		})

		it('env with no launch command warns to stderr rather than vanishing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			const writes: string[] = []
			const original = process.stderr.write
			process.stderr.write = ((s: string) => {
				writes.push(s)
				return true
			}) as never
			try {
				weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', env: { ROLE: 'worker' } })
			} finally {
				process.stderr.write = original
			}
			expect(writes.some((w) => w.includes('ROLE'))).toBe(true)
			expect(calls.some((c) => c[1] === 'send-text')).toBe(false)
		})

		it('rename() on a tab uses set-tab-title', () => {
			const calls: string[][] = []
			weztermMuxAdapter.rename(fakeExec(calls), { id: '2' }, 'tab', 'ledger')
			expect(calls).toEqual([['cli', 'set-tab-title', '--tab-id', '2', 'ledger']])
		})

		// No CLI primitive names a pane at all — throwing is the honest answer, not a silent no-op.
		it('rename() on a pane throws — wezterm has no way to title a pane', () => {
			expect(() => weztermMuxAdapter.rename(fakeExec([]), { id: '9' }, 'pane', 'ledger')).toThrow(/pane/i)
		})

		it('group() is a complete no-op — the real workspace tier is already the group', () => {
			const calls: string[][] = []
			weztermMuxAdapter.group(fakeExec(calls), { id: '2' }, 'my-group', 'ledger')
			expect(calls).toEqual([])
		})

		it('sendText types literal text as a bracketed paste, pressing no Enter', () => {
			const calls: string[][] = []
			weztermMuxAdapter.sendText(fakeExec(calls), { id: '9' }, 'Enter')
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', 'Enter']])
		})

		it('sendKeys presses core-vocabulary keys as their raw byte sequences via --no-paste', () => {
			const calls: string[][] = []
			weztermMuxAdapter.sendKeys(fakeExec(calls), { id: '9' }, ['Up', 'Enter'])
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', '\x1b[A\r']])
		})

		it('a non-core token this adapter cannot encode is forwarded as its own literal characters', () => {
			const calls: string[][] = []
			weztermMuxAdapter.sendKeys(fakeExec(calls), { id: '9' }, ['Zzz'])
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', 'Zzz']])
		})

		it('submit with text types it literally then presses Enter, two calls (no atomic primitive)', () => {
			const calls: string[][] = []
			weztermMuxAdapter.submit(fakeExec(calls), { id: '9' }, 'hello')
			expect(calls).toEqual([
				['cli', 'send-text', '--pane-id', '9', 'hello'],
				['cli', 'send-text', '--pane-id', '9', '--no-paste', '\r'],
			])
		})

		it('submit with no text sends a bare Enter only', () => {
			const calls: string[][] = []
			weztermMuxAdapter.submit(fakeExec(calls), { id: '9' })
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', '\r']])
		})

		it('read passes --start-line as a negative offset for a trailing-lines capture', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'get-text': 'hello' })
			expect(weztermMuxAdapter.read(exec, { id: '9' }, { lines: 20 })).toBe('hello')
			expect(calls).toEqual([['cli', 'get-text', '--pane-id', '9', '--start-line', '-20']])
		})

		it('focus drives activate-pane', () => {
			const calls: string[][] = []
			weztermMuxAdapter.focus(fakeExec(calls), { id: '9' })
			expect(calls).toEqual([['cli', 'activate-pane', '--pane-id', '9']])
		})

		it('teardown kills the pane', () => {
			const calls: string[][] = []
			weztermMuxAdapter.teardown(fakeExec(calls), { id: '9' })
			expect(calls).toEqual([['cli', 'kill-pane', '--pane-id', '9']])
		})

		it('paneExists scans the live listing for the pane id', () => {
			const exec = fakeExec([], { list: LIST_ONE })
			expect(weztermMuxAdapter.paneExists(exec, { id: '9' })).toBe(true)
			expect(weztermMuxAdapter.paneExists(exec, { id: '99' })).toBe(false)
		})

		// No primitive to report focus at all — `undefined` is the seam's own honest answer, not a
		// stand-in for false.
		it('isPaneFocused always answers unknown — there is no primitive to ask', () => {
			expect(weztermMuxAdapter.isPaneFocused(fakeExec([]), { id: '9' })).toBeUndefined()
		})

		it('listPanes reports every live pane, its cwd stripped of the file:// scheme, and never a label', () => {
			const exec = fakeExec([], { list: LIST_ONE })
			expect(weztermMuxAdapter.listPanes(exec)).toEqual([{ id: '9', mux: 'wezterm', cwd: '/unit' }])
		})

		it('listPanes returns nothing when the backend cannot be read', () => {
			expect(weztermMuxAdapter.listPanes(fakeExec([]))).toEqual([])
		})

		it('declares it can size a split', () => {
			expect(weztermMuxAdapter.canSizeSplits).toBe(true)
		})

		// Optional omissions, not stubs: no pane geometry to build a rect from, and no worktree
		// subcommand in the CLI at all.
		it('has no regions (describeRegion/describeWorkspace) or worktree capability', () => {
			expect(weztermMuxAdapter.regions).toBeUndefined()
			expect(weztermMuxAdapter.worktree).toBeUndefined()
		})
	})
})
