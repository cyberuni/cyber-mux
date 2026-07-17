import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'

function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[0]!] ?? null
	}
}

/**
 * `describeRegion` is OPTIONAL on the seam — a backend that cannot describe its own region omits
 * it entirely. The tmux adapter must implement it, so bind it once here: if it ever goes missing
 * these tests fail loudly on that fact rather than silently skipping every case below.
 */
const describeRegion = tmuxSessionAdapter.describeRegion
if (!describeRegion) throw new Error('the tmux adapter must implement describeRegion')

describe('spec:cyber-mux/mux', () => {
	describe('tmuxSessionAdapter', () => {
		it('open() splits a pane at the given cwd and launches the command in it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			const target = tmuxSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })
			expect(target).toEqual({ id: '%9' })
			expect(calls[0]).toEqual(['split-window', '-h', '-c', '/unit', '-P', '-F', '#{pane_id}'])
			// --launch SUBMITS: typed literally, then Enter — so the command actually runs rather than
			// sitting staged. Two calls, since tmux has no atomic literal-text-plus-Enter primitive.
			expect(calls[1]).toEqual(['send-keys', '-t', '%9', '-l', 'claude'])
			expect(calls[2]).toEqual(['send-keys', '-t', '%9', 'Enter'])
		})

		it('open() defaults to tab and honors pane:right / pane:down / tab placement', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%1', 'new-window': '%2' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'pane:right' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'pane:down' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'tab' })
			// Assert on the placement calls themselves rather than fixed offsets into `calls`: a
			// `--launch` now costs two send-keys calls (literal text, then Enter), so positional
			// indexing would break on a change that has nothing to do with placement.
			const placements = calls.filter((c) => c[0] === 'split-window' || c[0] === 'new-window')
			expect(placements).toEqual([
				['split-window', '-h', '-c', '/u', '-P', '-F', '#{pane_id}'],
				['split-window', '-v', '-c', '/u', '-P', '-F', '#{pane_id}'],
				['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}'],
			])
		})

		// `from` is what makes `pane:*` mean the CALLING pane. Without `-t`, tmux splits the session's
		// ACTIVE pane and ignores $TMUX_PANE outright — verified against tmux 3.6b, where a
		// `split-window` run inside %1 (with $TMUX_PANE=%1) split the active %0 instead. These assert
		// the flag because that is the entire fix: the wrong-pane split is silent, so only the emitted
		// argv distinguishes a correct call from a broken one.
		it('open({at:pane:*, from}) splits the NAMED pane via -t rather than tmux’s active pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right', from: { id: '%3' } })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'pane:down', from: { id: '%3' } })
			expect(calls.filter((c) => c[0] === 'split-window')).toEqual([
				['split-window', '-h', '-t', '%3', '-c', '/u', '-P', '-F', '#{pane_id}'],
				['split-window', '-v', '-t', '%3', '-c', '/u', '-P', '-F', '#{pane_id}'],
			])
		})

		it('open({from}) is ignored by tab/workspace, which split nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-window': '%2' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'tab', from: { id: '%3' } })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'workspace', from: { id: '%3' } })
			// No `-t`: a window is not placed relative to a pane, so leaking `from` here would target
			// the new window at an unrelated pane's session.
			expect(calls.filter((c) => c[0] === 'new-window')).toEqual([
				['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}'],
				['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}'],
			])
		})

		// `ratio` is the fraction kept by the ORIGINAL pane; tmux's `-l` sizes the NEW one, so this
		// adapter INVERTS where herdr's passes the same number straight through. Asserting the literal
		// flag is the cheapest guard against the inversion being applied twice, or to the wrong backend.
		it('open({ratio}) inverts to -l, because tmux sizes the NEW pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right', from: { id: '%3' }, ratio: 0.333 })
			expect(calls[0]).toEqual(['split-window', '-h', '-t', '%3', '-l', '67%', '-c', '/u', '-P', '-F', '#{pane_id}'])
			// 33% would be the un-inverted number — the exact shape of getting this backwards.
			expect(calls[0]).not.toContain('33%')
		})

		it('open() with no ratio emits no -l, leaving tmux its own even default', () => {
			const calls: string[][] = []
			tmuxSessionAdapter.open(fakeExec(calls, { 'split-window': '%9' }), { cwd: '/u', at: 'pane:right' })
			expect(calls[0]).not.toContain('-l')
		})

		it('open({env}) sets each variable natively at the pane’s birth via a repeatable -e', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker', TIER: 'gpu' } })
			expect(calls[0]).toEqual([
				'split-window',
				'-h',
				'-e',
				'ROLE=worker',
				'-e',
				'TIER=gpu',
				'-c',
				'/u',
				'-P',
				'-F',
				'#{pane_id}',
			])
		})

		it('open({env}) with no launch yields a blank shell with the env set, sending nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker' } })
			expect(calls[0]).toContain('ROLE=worker')
			expect(calls.some((c) => c[0] === 'send-keys')).toBe(false)
		})

		it('declares that it can size a split, so a ratio is never degraded away on tmux', () => {
			expect(tmuxSessionAdapter.canSizeSplits).toBe(true)
		})

		// `new-window` takes `-e` too (tmux(1): `new-window [-abdkPS] [-c start-directory] [-e
		// environment] ...`), so env is native at EVERY tier. That matters because a layout's root pane
		// is born by the window open, never by a split — scoping env to the split path would drop it.
		it.each(['workspace', 'tab'] as const)('open({at:%s, env}) sets env natively on the window via -e', (at) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/unit', at, env: { ROLE: 'planner', TIER: 'cpu' } })
			expect(calls[0]).toEqual([
				'new-window',
				'-d',
				'-e',
				'ROLE=planner',
				'-e',
				'TIER=cpu',
				'-c',
				'/unit',
				'-P',
				'-F',
				'#{pane_id}',
			])
		})

		it('open({at:workspace, env, label}) names the window and sets its env together', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/unit', at: 'workspace', label: 'render-farm', env: { ROLE: 'planner' } })
			expect(calls[0]).toEqual([
				'new-window',
				'-n',
				'render-farm',
				'-d',
				'-e',
				'ROLE=planner',
				'-c',
				'/unit',
				'-P',
				'-F',
				'#{pane_id}',
			])
		})

		it('open({at:pane:*}) with no `from` falls back to tmux’s own default, emitting no -t', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', at: 'pane:right' })
			// The pre-`from` behavior, kept for a caller that cannot identify itself: tmux's active
			// pane is a guess, but it is a better outcome than refusing to open at all.
			expect(calls[0]).toEqual(['split-window', '-h', '-c', '/u', '-P', '-F', '#{pane_id}'])
			expect(calls[0]).not.toContain('-t')
		})

		it('--at omitted falls back to tab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-window': '%2' })
			const target = tmuxSessionAdapter.open(exec, { cwd: '/u', launch: 'x' })
			expect(target).toEqual({ id: '%2' })
			expect(calls[0]).toEqual(['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}'])
		})

		// tmux has no workspace tier — `workspace` and `tab` both collapse to a Window — so it has
		// nothing to report here, which is NOT the same as reporting that nothing is there. The field is
		// absent, never a false "none": `toEqual` pins the exact shape, so a stray `workspace: null`
		// would fail this.
		it.each([
			'workspace',
			'tab',
			'pane:right',
			'pane:down',
		] as const)('a backend with no workspace tier reports no workspace at all (--at %s)', (at) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-window': '%20', 'split-window': '%20' })
			const target = tmuxSessionAdapter.open(exec, { cwd: '/unit', at })
			expect(target).toEqual({ id: '%20' })
			expect('workspace' in target).toBe(false)
		})

		it('tmux --at workspace opens a visible window in the current session, never a detached session', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-window': '%20' })
			const target = tmuxSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })
			expect(target).toEqual({ id: '%20' })
			// A window (visible in the status bar, select-window-able), not a new-session -d detached
			// session that the attached client can't see or beam to.
			expect(calls[0]).toEqual(['new-window', '-d', '-c', '/unit', '-P', '-F', '#{pane_id}'])
			expect(calls.some((c) => c[0] === 'new-session')).toBe(false)
			expect(calls[1]).toEqual(['send-keys', '-t', '%20', '-l', 'claude'])
			expect(calls[2]).toEqual(['send-keys', '-t', '%20', 'Enter'])
		})

		it('open() with no launch creates a blank pane and sends nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			const target = tmuxSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: '%9' })
			expect(calls).toHaveLength(1)
			expect(calls.some((c) => c[0] === 'send-keys')).toBe(false)
		})

		it('open() throws when tmux reports no pane', () => {
			const exec: Exec = () => null
			expect(() => tmuxSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude' })).toThrow(/new-window/)
			// A runner that cannot say why yields the bare failure — no dangling em-dash, no guess.
			expect(() => tmuxSessionAdapter.open(exec, { cwd: '/unit', launch: 'claude' })).toThrow(
				/^tmux new-window failed$/,
			)
		})

		it('open() carries the backend’s own reason for refusing a split', () => {
			// The real case this exists for: a pool too large for the region. tmux says "no space for new
			// pane" on stderr and, before `lastError`, the seam dropped it — leaving the caller a bare
			// "tmux split-window failed" to act on.
			const exec: Exec = () => null
			exec.lastError = 'no space for new pane'
			expect(() => tmuxSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: '%4' } })).toThrow(
				/^tmux split-window failed — no space for new pane$/,
			)
		})

		it('sendText() types literal text and presses no Enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.sendText(exec, { id: '%3' }, 'hello')
			expect(calls).toEqual([['send-keys', '-t', '%3', '-l', 'hello']])
		})

		it('sendText() passes -l so a key-named word is typed, not interpreted as that key', () => {
			// Without -l, tmux resolves 'Up' as the arrow key and moves the cursor (recalling shell
			// history) instead of typing the word.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.sendText(exec, { id: '%3' }, 'Up')
			expect(calls[0]).toEqual(['send-keys', '-t', '%3', '-l', 'Up'])
		})

		it('sendKeys() presses each key in order, typing nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.sendKeys(exec, { id: '%3' }, ['Escape', 'Up', 'C-c'])
			expect(calls).toEqual([['send-keys', '-t', '%3', 'Escape', 'Up', 'C-c']])
		})

		it('sendKeys() renames Backspace to tmux BSpace — the core vocabulary’s only rename', () => {
			// tmux has no 'Backspace' key name and would type the word; BSpace is its name for the key.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.sendKeys(exec, { id: '%3' }, ['Backspace'])
			expect(calls[0]).toEqual(['send-keys', '-t', '%3', 'BSpace'])
		})

		it('sendKeys() forwards a non-core token verbatim rather than rejecting it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.sendKeys(exec, { id: '%3' }, ['Home', 'M-x'])
			expect(calls[0]).toEqual(['send-keys', '-t', '%3', 'Home', 'M-x'])
		})

		it('sendKeys() Enter presses Enter, because the caller asked for it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.sendKeys(exec, { id: '%3' }, ['Enter'])
			expect(calls[0]).toEqual(['send-keys', '-t', '%3', 'Enter'])
		})

		it('submit() with text types it literally then presses Enter — two calls, no atomic primitive', () => {
			// -l applies to the whole arg list, so `send-keys -l <text> Enter` would type a literal
			// "Enter". The text must be typed literally and the Enter pressed as a key: two calls.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.submit(exec, { id: '%3' }, 'echo hi')
			expect(calls).toEqual([
				['send-keys', '-t', '%3', '-l', 'echo hi'],
				['send-keys', '-t', '%3', 'Enter'],
			])
		})

		it('submit() types key-named text literally, never recalling and re-running pane history', () => {
			// The regression this CR exists for: `send-keys -t %3 Up Enter` presses Up (recalling the
			// previous command) and then Enter, RE-RUNNING it. Verified live against tmux 3.6b.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.submit(exec, { id: '%3' }, 'Up')
			expect(calls).toEqual([
				['send-keys', '-t', '%3', '-l', 'Up'],
				['send-keys', '-t', '%3', 'Enter'],
			])
			expect(calls).not.toContainEqual(['send-keys', '-t', '%3', 'Up', 'Enter'])
		})

		it('submit() with no text flushes the staged buffer with a bare Enter, never re-typing it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.submit(exec, { id: '%3' })
			expect(calls).toEqual([['send-keys', '-t', '%3', 'Enter']])
		})

		it('submit() with empty text is the bare flush, not a second contract', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.submit(exec, { id: '%3' }, '')
			expect(calls).toEqual([['send-keys', '-t', '%3', 'Enter']])
		})

		it('read() captures pane output, optionally scoped to N lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'capture-pane': 'line1\nline2' })
			expect(tmuxSessionAdapter.read(exec, { id: '%3' })).toBe('line1\nline2')
			expect(calls[0]).toEqual(['capture-pane', '-p', '-t', '%3'])

			tmuxSessionAdapter.read(exec, { id: '%3' }, { lines: 50 })
			expect(calls[1]).toEqual(['capture-pane', '-p', '-t', '%3', '-S', '-50'])
		})

		it("focus() beams the attached client to the pane's own session and window, in order", () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panes': '%1 sess-a @1\n%3 sess-b @9\n%7 sess-a @1' })
			tmuxSessionAdapter.focus(exec, { id: '%3' })
			expect(calls).toEqual([
				['list-panes', '-a', '-F', '#{pane_id} #{session_name} #{window_id}'],
				['switch-client', '-t', 'sess-b'],
				['select-window', '-t', '@9'],
				['select-pane', '-t', '%3'],
			])
		})

		it('focus() throws instead of a false success when the recorded pane no longer resolves, and switches nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panes': '%1 sess-a @1\n%7 sess-a @1' })
			expect(() => tmuxSessionAdapter.focus(exec, { id: '%3' })).toThrow(/could not be resolved to beam to/)
			expect(calls).toEqual([['list-panes', '-a', '-F', '#{pane_id} #{session_name} #{window_id}']])
		})

		it('teardown() kills the pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.teardown(exec, { id: '%3' })
			expect(calls[0]).toEqual(['kill-pane', '-t', '%3'])
		})

		it('paneExists() is true when list-panes includes the id, false when it is gone', () => {
			// has-session misses (not a session name); list-panes lists the pane → exists
			expect(tmuxSessionAdapter.paneExists(fakeExec([], { 'list-panes': '%1\n%3\n%7' }), { id: '%3' })).toBe(true)
			// list-panes omits it → gone
			expect(tmuxSessionAdapter.paneExists(fakeExec([], { 'list-panes': '%1\n%7' }), { id: '%3' })).toBe(false)
		})

		it('tmux reports a pane focused when an attached client is currently viewing it', () => {
			const exec = fakeExec([], { 'list-panes': '%1 0 1 1\n%3 1 1 1\n%7 0 0 0' })
			expect(tmuxSessionAdapter.isPaneFocused(exec, { id: '%3' })).toBe(true)
		})

		it('tmux reports a pane not focused when no attached client is viewing it', () => {
			const exec = fakeExec([], { 'list-panes': '%1 0 1 1\n%3 0 1 1\n%7 1 0 1\n%9 1 1 0' })
			expect(tmuxSessionAdapter.isPaneFocused(exec, { id: '%3' })).toBe(false)
			expect(tmuxSessionAdapter.isPaneFocused(exec, { id: '%7' })).toBe(false)
			expect(tmuxSessionAdapter.isPaneFocused(exec, { id: '%9' })).toBe(false)
		})

		it('a focus query that cannot be answered is unknown, not a boolean', () => {
			const exec = fakeExec([], { 'list-panes': '%1 1 1 1' })
			expect(tmuxSessionAdapter.isPaneFocused(exec, { id: '%3' })).toBeUndefined()
			expect(tmuxSessionAdapter.isPaneFocused(() => null, { id: '%3' })).toBeUndefined()
		})

		it('listPanes() reports every live pane with its id and cwd, no harness', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panes': '%1 claude /repo/a\n%3 zsh /repo/b' })
			expect(tmuxSessionAdapter.listPanes(exec)).toEqual([
				{ id: '%1', mux: 'tmux', cwd: '/repo/a' },
				{ id: '%3', mux: 'tmux', cwd: '/repo/b' },
			])
			expect(calls[0]).toEqual(['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command} #{pane_current_path}'])
		})

		it('listPanes() returns empty when tmux reports nothing', () => {
			expect(tmuxSessionAdapter.listPanes(() => null)).toEqual([])
		})

		it('binds no worktree to a workspace — tmux has no workspace tier to bind one to', () => {
			expect(tmuxSessionAdapter.worktree).toBeUndefined()
		})

		it.each(['workspace', 'tab'] as const)('open({at:%s}) names the window with --label', (at) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/unit', at, label: 'my-name' })
			// `-n` at birth also turns tmux's automatic-rename off, so the name survives what the pane runs.
			expect(calls[0]).toEqual(['new-window', '-n', 'my-name', '-d', '-c', '/unit', '-P', '-F', '#{pane_id}'])
		})

		it('open({at:pane:right}) titles the pane after the split — tmux has no name flag there', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%9' })
			tmuxSessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right', label: 'my-name' })
			expect(calls[0]).toEqual(['split-window', '-h', '-c', '/unit', '-P', '-F', '#{pane_id}'])
			expect(calls[1]).toEqual(['select-pane', '-t', '%9', '-T', 'my-name'])
		})

		it('open() names nothing when no label is given', () => {
			const calls: string[][] = []
			tmuxSessionAdapter.open(fakeExec(calls, { 'new-window': '%9' }), { cwd: '/unit', at: 'tab' })
			expect(calls[0]).not.toContain('-n')
			expect(calls.some((c) => c[0] === 'select-pane')).toBe(false)
		})

		// Real capture from tmux 3.6b: a 200x50 window split into 3 panes (two stacked on the left,
		// one full-height on the right), queried from pane %0.
		const REGION_OUT = [
			'%0\t0\t0\t119\t34\t/repo\tzeta\tzeta',
			'%2\t0\t35\t119\t15\t/repo\tzeta\tzeta',
			'%1\t120\t0\t80\t50\t/repo\teditor\tzeta',
		].join('\n')

		it('describeRegion() queries list-panes scoped to the pane\u2019s own window, not -a', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panes': REGION_OUT })
			describeRegion(exec, { id: '%0' })
			expect(calls[0]).toEqual([
				'list-panes',
				'-t',
				'%0',
				'-F',
				'#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_title}\t#{host}',
			])
			// Scoped to the target's own window: -a would reach every window server-wide, which is
			// exactly what a region query must not do.
			expect(calls[0]).not.toContain('-a')
		})

		it('describeRegion() parses every pane\u2019s rect from the real 3-pane capture', () => {
			const exec = fakeExec([], { 'list-panes': REGION_OUT })
			const panes = describeRegion(exec, { id: '%0' })
			expect(panes.map((p) => p.rect)).toEqual([
				{ x: 0, y: 0, width: 119, height: 34 },
				{ x: 0, y: 35, width: 119, height: 15 },
				{ x: 120, y: 0, width: 80, height: 50 },
			])
		})

		// tmux defaults pane_title to the hostname on an untouched pane — exporting THAT as a label
		// would tag every pane in the window "zeta". A title differing from the host is one someone
		// actually set (cyber-mux's own \`select-pane -T\` among them), and that one survives.
		it('describeRegion() drops a pane_title equal to the host, but keeps one that differs', () => {
			const exec = fakeExec([], { 'list-panes': REGION_OUT })
			const panes = describeRegion(exec, { id: '%0' })
			expect(panes.find((p) => p.id === '%0')?.label).toBeUndefined()
			expect(panes.find((p) => p.id === '%2')?.label).toBeUndefined()
			expect(panes.find((p) => p.id === '%1')?.label).toBe('editor')
		})

		it('describeRegion() parses cwd for every pane', () => {
			const exec = fakeExec([], { 'list-panes': REGION_OUT })
			const panes = describeRegion(exec, { id: '%0' })
			expect(panes.every((p) => p.cwd === '/repo')).toBe(true)
		})

		// Tab-separated, not space: pane_current_path (and pane_title) can contain a space, and
		// splitting on spaces is exactly how a directory with one in it becomes the wrong pane.
		it('describeRegion() survives a cwd containing a space, because the format is tab-separated', () => {
			const out = '%0\t0\t0\t119\t34\t/repo with space\tzeta\tzeta'
			const exec = fakeExec([], { 'list-panes': out })
			const panes = describeRegion(exec, { id: '%0' })
			expect(panes).toEqual([{ id: '%0', rect: { x: 0, y: 0, width: 119, height: 34 }, cwd: '/repo with space' }])
		})

		it('describeRegion() throws when tmux reports nothing', () => {
			const exec: Exec = () => null
			expect(() => describeRegion(exec, { id: '%0' })).toThrow(/could not describe the region/)
		})

		it('describeRegion() throws when tmux reports no panes', () => {
			// A blank line, not '' — '' is falsy and would hit the null-output throw instead of this one.
			const exec = fakeExec([], { 'list-panes': '\n' })
			expect(() => describeRegion(exec, { id: '%0' })).toThrow(/reported no panes/)
		})
	})
})
