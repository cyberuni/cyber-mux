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
			expect(calls[1]).toEqual(['send-keys', '-t', '%9', 'claude', 'Enter'])
		})

		it('open() defaults to tab and honors pane:right / pane:down / tab placement', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'split-window': '%1', 'new-window': '%2' })
			tmuxSessionAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'pane:right' })
			expect(calls[0]).toEqual(['split-window', '-h', '-c', '/u', '-P', '-F', '#{pane_id}'])
			tmuxSessionAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'pane:down' })
			expect(calls[2]).toEqual(['split-window', '-v', '-c', '/u', '-P', '-F', '#{pane_id}'])
			tmuxSessionAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'tab' })
			expect(calls[4]).toEqual(['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}'])
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
			expect(calls[1]).toEqual(['send-keys', '-t', '%20', 'claude', 'Enter'])
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

		it('send() types text into the target pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.send(exec, { id: '%3' }, 'hello')
			expect(calls[0]).toEqual(['send-keys', '-t', '%3', 'hello', 'Enter'])
		})

		it('submit() flushes the staged buffer with a bare Enter, never re-typing the text', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			tmuxSessionAdapter.submit(exec, { id: '%3' })
			expect(calls[0]).toEqual(['send-keys', '-t', '%3', 'Enter'])
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
