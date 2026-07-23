import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import type { MuxPlacement } from './mux.ts'
import { createWeztermAdapter, weztermMuxAdapter } from './mux.wezterm.ts'

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

describe('spec:cyber-mux/mux/placement', () => {
	describe('weztermMuxAdapter', () => {
		it('placement-wezterm-workspace-followup-call', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: '9', tab: '2', workspace: 'default' })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--right', '--cwd', '/unit'])
			// unlike tmux/herdr, the tab/workspace cost a SEPARATE list call — spawn/split-pane report
			// only the bare pane id.
			expect(calls[1]).toEqual(['cli', 'list', '--format', 'json'])
		})

		// Every wezterm pane belongs to SOME workspace, even the implicit "default" one — unlike tmux,
		// which has no tier at all to report, this is never absent on any placement.
		it.each<{ at: MuxPlacement }>([
			{ at: 'workspace' },
			{ at: 'tab' },
			{ at: 'pane:right' },
		])('placement-wezterm-workspace-never-absent', ({ at }) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', 'split-pane': '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at })
			expect(target.workspace).toBeDefined()
			expect(typeof target.workspace).toBe('string')
		})

		// No scenario in placement.feature pins the --bottom flag itself — left as an extra.
		it('open() at pane:down splits with --bottom', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--bottom', '--cwd', '/unit'])
		})

		it('placement-at-tab-new-tab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[0]).toEqual(['cli', 'spawn', '--cwd', '/unit'])
			expect(target).toEqual({ id: '9', tab: '2', workspace: 'default' })
		})

		// `within` has no scenario in placement.feature (nor elsewhere in this node's suite) — extra.
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

		// `within` has no scenario — extra.
		it('open() at tab throws when the named workspace has no window left to open a tab in', () => {
			// Never a silent fall back to an untargeted spawn: that IS the wrong-space bug.
			const exec = fakeExec([], { spawn: '9', list: LIST_ONE })
			expect(() => weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', within: 'gone' })).toThrow(/gone/)
		})

		it('placement-wezterm-workspace-fresh-name', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			const spawnCall = calls.find((c) => c[1] === 'spawn')!
			expect(spawnCall).toEqual(['cli', 'spawn', '--new-window', '--workspace', spawnCall[4], '--cwd', '/unit'])
			// the workspace name IS what open() picked — known without a list lookup, unlike the tab.
			expect(target.workspace).toBe(spawnCall[4])
			expect(target.tab).toBe('2')
		})

		// Same scenario (a fresh workspace name is minted) — many-to-one, this leg pins the injected id source.
		it('placement-wezterm-workspace-fresh-name', () => {
			// The seam: createWeztermAdapter takes its id source, so a test drives a deterministic name
			// instead of a UUID. The minted name is `cyber-mux-<first 8 of newId()>`.
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			const adapter = createWeztermAdapter({ newId: () => 'abcdef1234' })
			const target = adapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(target.workspace).toBe('cyber-mux-abcdef12')
			expect(calls[0]).toEqual(['cli', 'spawn', '--new-window', '--workspace', 'cyber-mux-abcdef12', '--cwd', '/unit'])
		})

		// Same scenario — many-to-one, this leg pins --label overriding the mint.
		it('placement-wezterm-workspace-fresh-name', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			const target = weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', label: 'my-unit' })
			expect(calls[0]).toEqual(['cli', 'spawn', '--new-window', '--workspace', 'my-unit', '--cwd', '/unit'])
			expect(target.workspace).toBe('my-unit')
		})

		it('placement-wezterm-every-tab-named-after-birth', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', label: 'ledger' })
			expect(calls).toContainEqual(['cli', 'set-tab-title', '--tab-id', '2', 'ledger'])
		})

		// No scenario pins a pane-placement label degrading to a stderr warning — extra.
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
		it('placement-ratio-sign-convention', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio: 0.333 })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--right', '--percent', '67', '--cwd', '/unit'])
			expect(calls[0]).not.toContain('33')
		})

		it('placement-ratio-omitted-even-default', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(calls[0]).not.toContain('--percent')
		})

		// The seam refuses a ratio outside `0 < ratio < 1` before `--percent` reaches wezterm, rather than
		// render `--percent -50` (above 1) or `--percent 100` (0). It throws before any exec call, so no
		// split-pane command is issued.
		it.each([1.5, 0])('placement-ratio-out-of-range-rejected', (ratio) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			expect(() => weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio })).toThrow(
				/ratio must be strictly between 0 and 1/,
			)
			expect(calls).toEqual([])
		})

		// A ratio is a split concept — a tab or workspace opens with `spawn`, which has no --percent
		// flag at all, because a window is never sized against a pane.
		it.each<{ at: MuxPlacement }>([
			{ at: 'tab' },
			{ at: 'workspace' },
		])('placement-wezterm-ratio-not-for-tab-workspace', ({ at }) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { spawn: '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at, ratio: 0.333 })
			const spawnCall = calls.find((c) => c[1] === 'spawn')!
			expect(spawnCall).not.toContain('--percent')
		})

		it('placement-from-names-split-target', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-pane': '9', list: LIST_ONE })
			weztermMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: '3' } })
			expect(calls[0]).toEqual(['cli', 'split-pane', '--right', '--pane-id', '3', '--cwd', '/unit'])
		})

		// wezterm has NO --env on spawn or split-pane at all — unlike herdr, which loses it on only one
		// route, every wezterm open takes the same fallback herdr's worktree route does.
		it('placement-wezterm-env-never-native', () => {
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

		it('placement-env-no-command-warns', () => {
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

		it('placement-rename-after-birth', () => {
			const calls: string[][] = []
			weztermMuxAdapter.rename(fakeExec(calls), { id: '2' }, 'tab', 'ledger')
			expect(calls).toEqual([['cli', 'set-tab-title', '--tab-id', '2', 'ledger']])
		})

		// No CLI primitive names a pane at all — throwing is the honest answer, not a silent no-op.
		it('placement-wezterm-rename-pane-throws', () => {
			expect(() => weztermMuxAdapter.rename(fakeExec([]), { id: '9' }, 'pane', 'ledger')).toThrow(/pane/i)
		})

		it('placement-wezterm-group-id-ignored', () => {
			const calls: string[][] = []
			weztermMuxAdapter.group(fakeExec(calls), { id: '2' }, 'my-group', 'ledger')
			expect(calls).toEqual([])
		})

		it('placement-backend-declares-can-size', () => {
			expect(weztermMuxAdapter.canSizeSplits).toBe(true)
		})

		// Optional omissions, not stubs: no pane geometry to build a rect from, and no worktree
		// subcommand in the CLI at all. No scenario in this suite pins the omission itself — extra.
		it('has no regions (describeRegion/describeWorkspace) or worktree capability', () => {
			expect(weztermMuxAdapter.regions).toBeUndefined()
			expect(weztermMuxAdapter.worktree).toBeUndefined()
		})
	})
})

describe('spec:cyber-mux/mux/driving', () => {
	describe('weztermMuxAdapter', () => {
		it('driving-send-text-literal-no-enter', () => {
			const calls: string[][] = []
			weztermMuxAdapter.sendText(fakeExec(calls), { id: '9' }, 'Enter')
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', 'Enter']])
		})

		it('driving-wezterm-key-as-escape-sequence', () => {
			const calls: string[][] = []
			weztermMuxAdapter.sendKeys(fakeExec(calls), { id: '9' }, ['Up', 'Enter'])
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', '\x1b[A\r']])
		})

		it('driving-wezterm-non-core-key-known', () => {
			// Home is not in the core vocabulary, but wezterm's own key table (the same extras tmux
			// "knows" Home by) carries it — so it becomes its own ANSI escape sequence, never the
			// literal word "Home".
			const calls: string[][] = []
			weztermMuxAdapter.sendKeys(fakeExec(calls), { id: '9' }, ['Home'])
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', '\x1b[H']])
		})

		it('driving-wezterm-unencodable-token-literal', () => {
			const calls: string[][] = []
			weztermMuxAdapter.sendKeys(fakeExec(calls), { id: '9' }, ['Zzz'])
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', 'Zzz']])
		})

		it('driving-submit-with-text', () => {
			const calls: string[][] = []
			weztermMuxAdapter.submit(fakeExec(calls), { id: '9' }, 'hello')
			expect(calls).toEqual([
				['cli', 'send-text', '--pane-id', '9', 'hello'],
				['cli', 'send-text', '--pane-id', '9', '--no-paste', '\r'],
			])
		})

		it('driving-submit-no-text-bare-enter', () => {
			const calls: string[][] = []
			weztermMuxAdapter.submit(fakeExec(calls), { id: '9' })
			expect(calls).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', '\r']])
		})

		// No scenario in driving.feature covers the `read` verb at all (feature is scoped to
		// text/keys/submit) — extra.
		it('read passes --start-line as a negative offset for a trailing-lines capture', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'get-text': 'hello' })
			expect(weztermMuxAdapter.read(exec, { id: '9' }, { lines: 20 })).toBe('hello')
			expect(calls).toEqual([['cli', 'get-text', '--pane-id', '9', '--start-line', '-20']])
		})
	})
})

describe('spec:cyber-mux/mux/lookup', () => {
	describe('weztermMuxAdapter', () => {
		// No scenario pins the focus() write-verb itself (only the isPaneFocused query) — extra.
		it('focus drives activate-pane', () => {
			const calls: string[][] = []
			weztermMuxAdapter.focus(fakeExec(calls), { id: '9' })
			expect(calls).toEqual([['cli', 'activate-pane', '--pane-id', '9']])
		})

		// No scenario pins teardown anywhere in this suite — extra.
		it('teardown kills the pane', () => {
			const calls: string[][] = []
			weztermMuxAdapter.teardown(fakeExec(calls), { id: '9' })
			expect(calls).toEqual([['cli', 'kill-pane', '--pane-id', '9']])
		})

		// No scenario pins paneExists directly (only the pane-verb resolution outlines) — extra.
		it('paneExists scans the live listing for the pane id', () => {
			const exec = fakeExec([], { list: LIST_ONE })
			expect(weztermMuxAdapter.paneExists(exec, { id: '9' })).toBe(true)
			expect(weztermMuxAdapter.paneExists(exec, { id: '99' })).toBe(false)
		})

		// No primitive to report focus at all — `undefined` is the seam's own honest answer, not a
		// stand-in for false.
		it('lookup-wezterm-focus-always-unknown', () => {
			expect(weztermMuxAdapter.isPaneFocused(fakeExec([]), { id: '9' })).toBeUndefined()
		})

		it('lookup-wezterm-never-labeled', () => {
			const exec = fakeExec([], { list: LIST_ONE })
			expect(weztermMuxAdapter.listPanes(exec)).toEqual([{ id: '9', mux: 'wezterm', cwd: '/unit' }])
		})

		it('lookup-wezterm-name-never-resolves', () => {
			// A live wezterm pane, and a caller naming some word as if it were a label. Every pane verb
			// resolves a name by matching it against listPanes()'s `label` field (the CLI's resolver) —
			// so this is provable right here: no wezterm pane ever carries that field at all, so no name
			// can ever match one, the same failure as a name matching no live pane anywhere else.
			const list = JSON.stringify([
				{ window_id: 1, tab_id: 2, pane_id: 9, workspace: 'default', title: 'worker', cwd: 'file://host/unit' },
			])
			const exec = fakeExec([], { list })
			const panes = weztermMuxAdapter.listPanes(exec)
			for (const pane of panes) expect(pane.label).toBeUndefined()
			expect(panes.filter((p) => p.label === 'worker')).toEqual([])
		})

		// No scenario pins the empty-listing degrade path — extra.
		it('listPanes returns nothing when the backend cannot be read', () => {
			expect(weztermMuxAdapter.listPanes(fakeExec([]))).toEqual([])
		})
	})
})
