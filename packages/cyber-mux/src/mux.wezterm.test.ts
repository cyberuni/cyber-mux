import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import type { MuxPlacement } from './mux.ts'
import { createWeztermAdapter, weztermMuxAdapter } from './mux.wezterm.ts'
import { FULL_SCROLLBACK_LINES } from './read-window.ts'

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

const LIST_TWO = JSON.stringify([
	{ window_id: 1, tab_id: 2, pane_id: 9, workspace: 'default' },
	{ window_id: 1, tab_id: 2, pane_id: 10, workspace: 'default' },
])

/**
 * Two tabs in one window, each with its own active pane — the shape measured live, where `is_active`
 * was `true` on more than one row at once. A focus probe reading that field cannot tell these apart.
 */
const LIST_TWO_TABS_BOTH_ACTIVE = JSON.stringify([
	{ window_id: 1, tab_id: 2, pane_id: 9, workspace: 'default', is_active: true },
	{ window_id: 1, tab_id: 3, pane_id: 10, workspace: 'default', is_active: true },
])

/** `wezterm cli list-clients --format json` — one row per attached client. */
const CLIENTS_ON_9 = JSON.stringify([{ username: 'u', hostname: 'h', pid: 1, focused_pane_id: 9 }])
const CLIENTS_ON_10 = JSON.stringify([{ username: 'u', hostname: 'h', pid: 1, focused_pane_id: 10 }])

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
			expect(weztermMuxAdapter.read(exec, { id: '9' }, { lines: 20 })).toEqual({ text: 'hello' })
			// Untouched argv, and no `truncated`: nothing was asked, so no second capture was spent and
			// nothing is claimed — absent, never a `false` that means "I did not check".
			expect(calls).toEqual([['cli', 'get-text', '--pane-id', '9', '--start-line', '-20']])
		})

		it('read({ truncation }) reports omitted rows from a capture taken one row deeper', () => {
			const calls: string[][] = []
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return args.at(-1) === '-21' ? 'older\nhello' : 'hello'
			}
			expect(weztermMuxAdapter.read(exec, { id: '9' }, { lines: 20, truncation: true })).toEqual({
				text: 'hello',
				truncated: true,
			})
			expect(calls).toEqual([
				['cli', 'get-text', '--pane-id', '9', '--start-line', '-20'],
				['cli', 'get-text', '--pane-id', '9', '--start-line', '-21'],
			])
		})

		it("read({ lines: 'all' }) reaches past any real scrollback, WezTerm clamping to what it holds", () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'get-text': 'older\nhello' })
			// No all-history token in `get-text` — `--start-line` takes a number — so 'all' is a window
			// deeper than any pane's history. Unbounded, so `truncated` costs no probe.
			expect(weztermMuxAdapter.read(exec, { id: '9' }, { lines: 'all', truncation: true })).toEqual({
				text: 'older\nhello',
				truncated: false,
			})
			expect(calls).toEqual([['cli', 'get-text', '--pane-id', '9', '--start-line', `-${FULL_SCROLLBACK_LINES}`]])
		})

		it('read({ truncation }) reports a complete capture as not truncated, probing -1 for a bare read', () => {
			const calls: string[][] = []
			// A start line past the top of the scrollback is clamped, so the deeper read hands back the
			// same rows when there is nothing above the window.
			const exec = fakeExec(calls, { 'get-text': 'hello' })
			expect(weztermMuxAdapter.read(exec, { id: '9' }, { truncation: true })).toEqual({
				text: 'hello',
				truncated: false,
			})
			expect(calls).toEqual([
				['cli', 'get-text', '--pane-id', '9'],
				['cli', 'get-text', '--pane-id', '9', '--start-line', '-1'],
			])
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

		// wezterm DOES have a focus primitive — `list-clients --format json` carries `focused_pane_id`,
		// and it moves with `activate-pane` (measured live on the pinned 20240203 build). The member
		// used to answer a blanket `undefined` on the claim that no primitive existed.
		it('lookup-wezterm-focus-reads-the-attached-client', () => {
			const focused = fakeExec([], { list: LIST_ONE, 'list-clients': CLIENTS_ON_9 })
			expect(weztermMuxAdapter.isPaneFocused(focused, { id: '9' })).toBe(true)
			const elsewhere = fakeExec([], { list: LIST_TWO, 'list-clients': CLIENTS_ON_10 })
			expect(weztermMuxAdapter.isPaneFocused(elsewhere, { id: '9' })).toBe(false)
		})

		// The trap this member is written around. `list --format json`'s `is_active` is per-TAB, and
		// measured live it read `true` on THREE rows at once across two tabs and two windows — so a
		// probe reading it would answer a confident `true` for two panes nobody is looking at. Pane 10
		// here is its tab's active pane and is NOT where the client is.
		it('lookup-wezterm-focus-does-not-read-is_active', () => {
			const exec = fakeExec([], { list: LIST_TWO_TABS_BOTH_ACTIVE, 'list-clients': CLIENTS_ON_9 })
			expect(weztermMuxAdapter.isPaneFocused(exec, { id: '9' })).toBe(true)
			expect(weztermMuxAdapter.isPaneFocused(exec, { id: '10' })).toBe(false)
		})

		// The three ways this cannot be answered, none of which may become `false`: a pane no listing
		// carries (gone, or the listing itself failed), a mux server with no client attached (measured:
		// a literal `[]`), and an unparseable answer.
		it('lookup-wezterm-focus-unknown-when-unanswerable', () => {
			expect(
				weztermMuxAdapter.isPaneFocused(fakeExec([], { list: LIST_ONE, 'list-clients': CLIENTS_ON_9 }), { id: '99' }),
			).toBeUndefined()
			expect(
				weztermMuxAdapter.isPaneFocused(fakeExec([], { list: LIST_ONE, 'list-clients': '[]' }), { id: '9' }),
			).toBeUndefined()
			expect(weztermMuxAdapter.isPaneFocused(fakeExec([], { list: LIST_ONE }), { id: '9' })).toBeUndefined()
			expect(
				weztermMuxAdapter.isPaneFocused(fakeExec([], { list: LIST_ONE, 'list-clients': 'not json' }), { id: '9' }),
			).toBeUndefined()
			expect(weztermMuxAdapter.isPaneFocused(fakeExec([]), { id: '9' })).toBeUndefined()
		})

		// The wezterm row of the outline: `cwd` is reported as a `file://` URI and reduced to the bare
		// path, so a caller filtering by directory compares like with like.
		it('lookup-listing-reports-cwd', () => {
			expect(weztermMuxAdapter.listPanes(fakeExec([], { list: LIST_ONE }))[0]?.cwd).toBe('/unit')
		})

		it('lookup-wezterm-never-labeled', () => {
			const exec = fakeExec([], { list: LIST_ONE })
			expect(weztermMuxAdapter.listPanes(exec)).toEqual([{ id: '9', mux: 'wezterm', cwd: '/unit', floating: false }])
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

		it('lookup-listing-agent-status-absent-non-herdr', () => {
			// wezterm carries no agent-state feed at all, so no pane ever reports agentStatus — absent,
			// never a false 'unknown'. The wezterm row of the outline.
			const exec = fakeExec([], { list: LIST_ONE })
			const panes = weztermMuxAdapter.listPanes(exec)
			for (const pane of panes) expect(pane.agentStatus).toBeUndefined()
		})

		it('lookup-listing-floating-false-by-construction', () => {
			// wezterm has no floating-pane concept at all, so every pane it reports really is tiled.
			// `false` is the TRUE answer here, not a stub standing in for one — and unlike `agentStatus`
			// above it is never omitted: an absent value would leave a caller guessing between "not
			// floating" and "cannot tell". The create side refuses a `pane:float` open here BY NAME
			// (mux.wezterm.test.ts's placement rows) precisely because there is no truthful pane to hand
			// back; the read side has a truthful answer, and this is it.
			const panes = weztermMuxAdapter.listPanes(fakeExec([], { list: LIST_ONE }))
			expect(panes.length).toBeGreaterThan(0)
			for (const pane of panes) expect(pane.floating).toBe(false)
		})
	})
})

describe('spec:cyber-mux/agent', () => {
	it('agent-lifecycle-absent-non-herdr', () => {
		// wezterm has no native per-pane agent-state wait, so the optional capability is genuinely absent
		// — its absence IS the refusal deriveAgentWait turns into AgentLifecycleUnsupportedError.
		expect(weztermMuxAdapter.agentLifecycle).toBeUndefined()
	})
})

/**
 * `wezterm cli` reads text (`get-text`) and never blocks on it, so the wait is the shared poll over
 * this adapter's own read — see `wait-output.test.ts` for the cadence/deadline/liveness rules the poll
 * itself owns.
 */
describe('weztermMuxAdapter — wait-output by polling', () => {
	it('polls get-text and matches what is already on screen', async () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'get-text': 'booting\nserver ready on :8080', list: LIST_ONE })
		const result = await weztermMuxAdapter.waitForOutput(exec, { id: '9' }, { match: 'ready', timeoutMs: 1000 })
		expect(result.matched).toBe(true)
		expect(calls).toEqual([
			['cli', 'list', '--format', 'json'],
			['cli', 'get-text', '--pane-id', '9'],
		])
	})

	it('refuses a pane that is gone instead of waiting out the timeout', async () => {
		const exec = fakeExec([], { 'get-text': 'booting', list: LIST_ONE })
		await expect(
			weztermMuxAdapter.waitForOutput(exec, { id: '404' }, { match: 'ready', timeoutMs: 60_000 }),
		).rejects.toThrow(/no longer exists/)
	})
})

describe('spec:cyber-mux/mux/driving', () => {
	describe('weztermMuxAdapter — pane zoom', () => {
		// `is_zoomed` is per PANE on wezterm, like zellij's `is_fullscreen` and unlike tmux's window flag.
		const listing = (zoomed: number | null) =>
			JSON.stringify(
				[9, 10].map((id) => ({
					window_id: 1,
					tab_id: 2,
					pane_id: id,
					workspace: 'default',
					is_zoomed: id === zoomed,
				})),
			)

		it('isPaneZoomed() reads is_zoomed straight off the listing it already makes', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { list: listing(9) })
			expect(weztermMuxAdapter.isPaneZoomed(exec, { id: '9' })).toBe(true)
			expect(weztermMuxAdapter.isPaneZoomed(fakeExec([], { list: listing(9) }), { id: '10' })).toBe(false)
			expect(calls[0]).toEqual(['cli', 'list', '--format', 'json'])
		})

		it('isPaneZoomed() answers undefined for a pane the listing does not carry, never a false false', () => {
			expect(weztermMuxAdapter.isPaneZoomed(fakeExec([], { list: listing(null) }), { id: '99' })).toBeUndefined()
		})

		it.each([
			{ zoomed: true, flag: '--zoom', current: null },
			{ zoomed: false, flag: '--unzoom', current: 9 },
		])('setPaneZoom() drives wezterm’s own ABSOLUTE flag, with no toggle to compose', ({ zoomed, flag, current }) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { list: listing(current), 'zoom-pane': '' })
			weztermMuxAdapter.setPaneZoom(exec, { id: '9' }, zoomed)
			expect(calls).toEqual([
				['cli', 'list', '--format', 'json'],
				['cli', 'zoom-pane', '--pane-id', '9', flag],
			])
		})

		it.each([
			{ id: '9', zoomed: true },
			{ id: '10', zoomed: false },
		])('setPaneZoom() touches nothing when the pane is already in the requested state', ({ id, zoomed }) => {
			const calls: string[][] = []
			weztermMuxAdapter.setPaneZoom(fakeExec(calls, { list: listing(9) }), { id }, zoomed)
			expect(calls).toEqual([['cli', 'list', '--format', 'json']])
		})

		it('setPaneZoom() throws rather than reporting a false success when wezterm refuses', () => {
			const exec = fakeExec([], { list: listing(null) })
			expect(() => weztermMuxAdapter.setPaneZoom(exec, { id: '9' }, true)).toThrow(/could not zoom pane 9/)
		})
	})
})

describe('spec:cyber-mux/mux/driving', () => {
	const LIST_AFTER = JSON.stringify([
		{ window_id: 1, tab_id: 7, pane_id: 1, workspace: 'default' },
		{ window_id: 1, tab_id: 7, pane_id: 2, workspace: 'default' },
	])

	it('movePane() rides split-pane’s --move-pane-id, naming the DESTINATION as the pane being split', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-pane': '1', list: LIST_AFTER })
		expect(weztermMuxAdapter.movePane(exec, { id: '1' }, { id: '2' }, 'down')).toEqual({
			id: '1',
			tab: '7',
			workspace: 'default',
		})
		expect(calls[0]).toEqual(['cli', 'split-pane', '--pane-id', '2', '--bottom', '--move-pane-id', '1'])
	})

	it("movePane('right') sends --right", () => {
		const calls: string[][] = []
		weztermMuxAdapter.movePane(
			fakeExec(calls, { 'split-pane': '1', list: LIST_AFTER }),
			{ id: '1' },
			{ id: '2' },
			'right',
		)
		expect(calls[0]).toEqual(['cli', 'split-pane', '--pane-id', '2', '--right', '--move-pane-id', '1'])
	})

	it('movePane() throws when wezterm refuses', () => {
		expect(() =>
			weztermMuxAdapter.movePane(fakeExec([], { list: LIST_AFTER }), { id: '1' }, { id: '2' }, 'right'),
		).toThrow(/wezterm could not move pane 1 to 2/)
	})

	// `move-pane-to-new-tab` prints NOTHING on success (measured on 20240203), so an empty string is a
	// SUCCESS and only `null` is a failure. A falsiness check here would throw on every real break.
	it('breakPane() treats empty output as success, because this verb reports nothing', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'move-pane-to-new-tab': '', list: LIST_AFTER })
		expect(weztermMuxAdapter.breakPane(exec, { id: '1' }, 'tab')).toEqual({ id: '1', tab: '7', workspace: 'default' })
		expect(calls[0]).toEqual(['cli', 'move-pane-to-new-tab', '--pane-id', '1'])
	})

	it('breakPane(workspace) takes a new WINDOW and mints the workspace name, since --workspace defaults to "default"', () => {
		const calls: string[][] = []
		const adapter = createWeztermAdapter({ newId: () => 'abcdef0123456789' })
		adapter.breakPane(fakeExec(calls, { 'move-pane-to-new-tab': '', list: LIST_AFTER }), { id: '1' }, 'workspace')
		expect(calls[0]).toEqual([
			'cli',
			'move-pane-to-new-tab',
			'--pane-id',
			'1',
			'--new-window',
			'--workspace',
			'cyber-mux-abcdef01',
		])
	})

	it('breakPane() throws when wezterm refuses', () => {
		expect(() => weztermMuxAdapter.breakPane(fakeExec([], { list: LIST_AFTER }), { id: '1' }, 'tab')).toThrow(
			/wezterm could not break out pane 1 into its own tab/,
		)
	})
})
