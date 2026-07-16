import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'

function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[0]!] ?? null
	}
}

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
	})
})
