import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { createZellijAdapter, zellijMuxAdapter } from './mux.zellij.ts'

/**
 * Keyed by `args[1]`, not `args[0]` — every zellij call is `zellij action <verb> …`, so `args[0]` is
 * always `'action'` and cannot distinguish `new-pane` from `new-tab` the way tmux/herdr's fakes key
 * off their own first argument. (Same shape as the wezterm fake, whose `args[0]` is always `'cli'`.)
 */
function fakeExec(calls: string[][], responses: Record<string, string | null | (string | null)[]> = {}): Exec {
	const queued = new Map<string, (string | null)[]>()
	return (_cmd, args) => {
		calls.push(args)
		const verb = args[1]!
		const canned = responses[verb]
		// An ARRAY is a SEQUENCE of replies for repeated calls to the same verb, with the last one
		// standing for every call after it. `list-panes` needs it: an open now reads the listing BEFORE
		// the command as well as after, and the whole point of that read is that the two differ.
		if (!Array.isArray(canned)) return canned ?? null
		const rest = queued.get(verb) ?? [...canned]
		const next = rest.length > 1 ? rest.shift()! : rest[0]
		queued.set(verb, rest)
		return next ?? null
	}
}

/** The session BEFORE an open — nothing standing, so anything the listing gains is the open's. */
const LIST_NONE = '[]'

const LIST_ONE = JSON.stringify([
	{
		id: 'terminal_9',
		tab_id: 2,
		tab_name: 'main',
		title: 'zsh',
		terminal_command: 'zsh',
		is_focused: true,
	},
])

// A session-bound adapter for the workspace-reporting cases; the exported singleton has no session.
const sessionAdapter = createZellijAdapter({ session: 'my-session' })

describe('spec:cyber-mux/mux/placement', () => {
	describe('zellijMuxAdapter', () => {
		it('open() at pane:right splits with --direction right and resolves tab from list-panes', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
			const target = zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'terminal_9', tab: '2' })
			// The listing is read TWICE around the split: once before, to know which panes were already
			// standing, and once after, because new-pane reports only a bare pane id and the tab costs a
			// separate call. The before read is what makes the reported id checkable rather than trusted.
			expect(calls[0]).toEqual(['action', 'list-panes', '--json'])
			expect(calls[1]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[2]).toEqual(['action', 'list-panes', '--json'])
		})

		it('open() at pane:down splits with --direction down', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[1]).toEqual(['action', 'new-pane', '--direction', 'down', '--cwd', '/unit'])
		})

		it('open() reports the ambient session as the workspace when the adapter is bound to one', () => {
			const exec = fakeExec([], { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
			const target = sessionAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'terminal_9', tab: '2', workspace: 'my-session' })
		})

		it('placement-at-tab-new-tab', () => {
			const calls: string[][] = []
			// new-tab reports the TAB id; the tab's initial pane is the list-panes record carrying it.
			const exec = fakeExec(calls, { 'new-tab': '2', 'list-panes': [LIST_NONE, LIST_ONE] })
			const target = zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[1]).toEqual(['action', 'new-tab', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'terminal_9', tab: '2' })
		})

		it('placement-at-workspace-visible-space', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-tab': '2', 'list-panes': [LIST_NONE, LIST_ONE] })
			const target = sessionAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			// identical to a `tab` open — the collapse forced by session-scoped ids + a session-less target.
			expect(calls[1]).toEqual(['action', 'new-tab', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'terminal_9', tab: '2', workspace: 'my-session' })
		})

		it('open() names the tab at birth with --name', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-tab': '2', 'list-panes': [LIST_NONE, LIST_ONE] })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', label: 'ledger' })
			expect(calls[1]).toEqual(['action', 'new-tab', '--cwd', '/unit', '--name', 'ledger'])
		})

		it('open() names the pane at birth with --name — Zellij can title a pane, unlike wezterm', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', label: 'worker' })
			expect(calls[1]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit', '--name', 'worker'])
		})

		it('open() with a `from` focuses that pane first — the only way to choose the split target', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'terminal_3' } })
			expect(calls[0]).toEqual(['action', 'focus-pane-id', 'terminal_3'])
			expect(calls[2]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
		})

		it('open() drops a ratio — a tiled split is always even', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
			zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio: 0.333 })
			expect(calls[1]).toEqual(['action', 'new-pane', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[1]).not.toContain('--width')
			expect(calls[1]).not.toContain('33')
		})

		// zellij has no --env on new-pane/new-tab, so env rides in as a prefix on the launch command,
		// exactly the fallback wezterm and herdr's worktree route use.
		it('placement-env-rides-command-prefix', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
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
			const exec = fakeExec(calls, { 'new-pane': 'terminal_9', 'list-panes': [LIST_NONE, LIST_ONE] })
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

		it('open() throws when new-pane fails', () => {
			const exec = fakeExec([], { 'new-pane': null })
			expect(() => zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })).toThrow(/new-pane/)
		})

		// zellij 0.44.3 can deliver a CLI reply to the wrong command: one exits 0 printing nothing and the
		// next receives its payload (see `LIST_PANES_ATTEMPTS` in the adapter for the repro). These four
		// rows are what keeps that from reaching a caller as a wrong pane or a phantom success. They are
		// unit rows on purpose — the defect is load-triggered, so the real-boundary suite can only ever
		// observe it by luck, while a fake can state it.
		it('open() refuses an id that names a pane which was already standing — the phantom guard', () => {
			// The listing is IDENTICAL before and after: nothing appeared, so `terminal_9` is a stale reply
			// that happens to name a live pane. Reporting it would hand the caller someone else's pane.
			const exec = fakeExec([], { 'new-pane': 'terminal_9', 'list-panes': LIST_ONE })
			expect(() => zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })).toThrow(/terminal_9/)
		})

		it('open() recovers the pane when new-pane exits 0 having printed no id at all', () => {
			// The reply was lost, not the pane: exactly one pane appeared over the open, which is an
			// unambiguous answer. Failing here would fail an open that genuinely happened.
			const exec = fakeExec([], { 'new-pane': '', 'list-panes': [LIST_NONE, LIST_ONE] })
			expect(zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })).toEqual({ id: 'terminal_9', tab: '2' })
		})

		it('open() at tab recovers the pane when new-tab exits 0 having printed no tab id', () => {
			const exec = fakeExec([], { 'new-tab': '', 'list-panes': [LIST_NONE, LIST_ONE] })
			expect(zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })).toEqual({ id: 'terminal_9', tab: '2' })
		})

		it('open() never resolves to a PLUGIN pane that appeared alongside the one it made', () => {
			// A tab zellij opens can be carrying a plugin pane in the same listing as its own initial pane,
			// and that record can sort first. Caught at the real boundary: an `open()` at `tab` returned
			// `plugin_15`, and the `rename()` after it renamed a pane the caller never opened.
			const withPlugin = JSON.stringify([
				{ id: 15, is_plugin: true, tab_id: 2, title: 'zellij:link' },
				{ id: 9, is_plugin: false, tab_id: 2, title: 'zsh', terminal_command: 'zsh' },
			])
			const exec = fakeExec([], { 'new-tab': '2', 'list-panes': [LIST_NONE, withPlugin] })
			expect(zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })).toEqual({ id: 'terminal_9', tab: '2' })
		})

		it('open() at tab refuses a tab id whose panes all predate it', () => {
			const exec = fakeExec([], { 'new-tab': '2', 'list-panes': LIST_ONE })
			expect(() => zellijMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })).toThrow(/tab 2/)
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
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' })).toEqual({ text: 'hello' })
			expect(calls).toEqual([['action', 'dump-screen', '--pane-id', 'terminal_9']])
		})

		it('read with lines dumps the full scrollback and keeps the trailing N lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'dump-screen': 'a\nb\nc\nd\ne' })
			// No `truncated` unasked, even though this read is holding the whole scrollback it would be
			// derived from: absent means undetermined, and nobody asked.
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' }, { lines: 2 })).toEqual({ text: 'd\ne' })
			expect(calls).toEqual([['action', 'dump-screen', '--pane-id', 'terminal_9', '--full']])
		})

		it('read({ lines, truncation }) answers from the full dump it already took — no extra query', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'dump-screen': 'a\nb\nc\nd\ne' })
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' }, { lines: 2, truncation: true })).toEqual({
				text: 'd\ne',
				truncated: true,
			})
			// The one backend whose truncation costs nothing: a `lines` read is a full dump trimmed, so the
			// deeper read was already in hand.
			expect(calls).toEqual([['action', 'dump-screen', '--pane-id', 'terminal_9', '--full']])
		})

		it('read({ lines, truncation }) reports a window that holds the whole dump as not truncated', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'dump-screen': 'a\nb' })
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' }, { lines: 5, truncation: true })).toEqual({
				text: 'a\nb',
				truncated: false,
			})
			expect(calls).toEqual([['action', 'dump-screen', '--pane-id', 'terminal_9', '--full']])
		})

		it("read({ lines: 'all' }) IS Zellij's --full dump, untrimmed and unprobed", () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'dump-screen': 'a\nb\nc\nd\ne' })
			// `--full` is Zellij's own all-history spelling, so an unbounded window is the primitive rather
			// than a trimmed one — and nothing was omitted from it.
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' }, { lines: 'all', truncation: true })).toEqual({
				text: 'a\nb\nc\nd\ne',
				truncated: false,
			})
			expect(calls).toEqual([['action', 'dump-screen', '--pane-id', 'terminal_9', '--full']])
		})

		it('read({ truncation }) compares a bare viewport dump against the full scrollback', () => {
			const calls: string[][] = []
			// Zellij has no "viewport plus one row" form, so the deeper read is the whole dump — more rows
			// than the viewport means rows sit above it.
			const exec: Exec = (_cmd, args) => {
				calls.push(args)
				return args.includes('--full') ? 'older\nd\ne' : 'd\ne'
			}
			expect(zellijMuxAdapter.read(exec, { id: 'terminal_9' }, { truncation: true })).toEqual({
				text: 'd\ne',
				truncated: true,
			})
			expect(calls).toEqual([
				['action', 'dump-screen', '--pane-id', 'terminal_9'],
				['action', 'dump-screen', '--pane-id', 'terminal_9', '--full'],
			])
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
			const list = JSON.stringify([{ id: 'terminal_9', tab_id: 2, terminal_command: 'zsh', is_focused: false }])
			const exec = fakeExec([], { 'list-panes': list })
			expect(zellijMuxAdapter.isPaneFocused(exec, { id: 'terminal_9' })).toBe(false)
		})

		it('lookup-listing-enumerates-all-panes', () => {
			// Field names are the LIVE 0.44.3 ones: `terminal_command` for the label guard (the doc probe
			// spelled it `pane_command`), and `pane_cwd` for the directory — a real key on a terminal
			// pane's record, whatever an earlier probe of a PLUGIN pane's key set concluded.
			const list = JSON.stringify([
				{
					id: 'terminal_9',
					tab_id: 2,
					title: 'worker',
					terminal_command: 'claude',
					is_floating: false,
					pane_cwd: '/repo/a',
				},
				// title equals the running command — ambient, not chosen — so it reports no label.
				{
					id: 'terminal_10',
					tab_id: 2,
					title: 'zsh',
					terminal_command: 'zsh',
					is_floating: false,
					pane_cwd: '/repo/b',
				},
			])
			const exec = fakeExec([], { 'list-panes': list })
			expect(zellijMuxAdapter.listPanes(exec)).toEqual([
				{ id: 'terminal_9', mux: 'zellij', cwd: '/repo/a', label: 'worker', floating: false },
				{ id: 'terminal_10', mux: 'zellij', cwd: '/repo/b', floating: false },
			])
		})

		// The zellij row of the outline, and the one that was missing entirely: `pane_cwd` IS on a live
		// 0.44.3 terminal-pane record, so a caller filtering the listing by directory gets an answer here
		// rather than nothing. It rides the `list-panes --json` call the listing already makes.
		it('lookup-listing-reports-cwd', () => {
			const calls: string[][] = []
			const list = JSON.stringify([
				{ id: 'terminal_9', tab_id: 2, title: 'zsh', terminal_command: 'zsh', pane_cwd: '/repo/a' },
			])
			expect(zellijMuxAdapter.listPanes(fakeExec(calls, { 'list-panes': list }))[0]?.cwd).toBe('/repo/a')
			// Still ONE call: no probe was added to answer this.
			expect(calls).toEqual([['action', 'list-panes', '--json']])
		})

		// A plugin pane's record OMITS `pane_cwd` — it has no working directory — so the entry carries no
		// cwd rather than an empty or invented one. Absent-not-false, the same as `label`.
		it('listPanes() omits cwd for a record that carries no pane_cwd', () => {
			const list = JSON.stringify([{ id: 'plugin_3', tab_id: 2, title: 'Release Notes', is_plugin: true }])
			expect(zellijMuxAdapter.listPanes(fakeExec([], { 'list-panes': list }))[0]?.cwd).toBeUndefined()
		})

		// The live 0.44.3 shape this exists for: a session's suppressed `zellij:link` plugin pane and its
		// first terminal pane BOTH report the number 0. Reporting both as `'0'` collapsed two genuinely
		// different panes onto one `LivePane.id`, and everything that resolves by id could then land on
		// the wrong one.
		it('lookup-listing-id-names-one-pane', () => {
			const list = JSON.stringify([
				{ id: 0, is_plugin: true, is_suppressed: true, title: '(.) - zellij:link', tab_id: 0 },
				{ id: 0, is_plugin: false, title: 'Pane #1', tab_id: 0, pane_cwd: '/repo/a' },
			])
			const panes = zellijMuxAdapter.listPanes(fakeExec([], { 'list-panes': list }))
			expect(panes.map((p) => p.id)).toEqual(['plugin_0', 'terminal_0'])
			// And each id still addresses its own pane: a bare `0` from a caller is the TERMINAL one, the
			// same pane zellij's own bare-id addressing resolves to.
			expect(zellijMuxAdapter.paneExists(fakeExec([], { 'list-panes': list }), { id: '0' })).toBe(true)
			expect(zellijMuxAdapter.paneExists(fakeExec([], { 'list-panes': list }), { id: 'plugin_0' })).toBe(true)
			expect(zellijMuxAdapter.paneExists(fakeExec([], { 'list-panes': list }), { id: 'plugin_9' })).toBe(false)
		})

		// An id zellij already spelled out is passed through untouched — this qualifies what the backend
		// left ambiguous rather than rewriting what it was explicit about.
		it('listPanes() leaves an already-prefixed zellij id exactly as reported', () => {
			const list = JSON.stringify([{ id: 'terminal_9', tab_id: 2, title: 'zsh', terminal_command: 'zsh' }])
			expect(zellijMuxAdapter.listPanes(fakeExec([], { 'list-panes': list }))[0]?.id).toBe('terminal_9')
		})

		it('listPanes returns nothing when the backend cannot be read', () => {
			expect(zellijMuxAdapter.listPanes(fakeExec([]))).toEqual([])
		})

		it('listPanes returns nothing on non-JSON output rather than throwing', () => {
			const exec = fakeExec([], { 'list-panes': 'not json' })
			expect(zellijMuxAdapter.listPanes(exec)).toEqual([])
		})

		// A LOST reply is not an empty session — a live zellij session always has at least one pane — and
		// reading it as one is what took the real-boundary suite down ten rows at a time (see
		// `LIST_PANES_ATTEMPTS`). The read is re-asked instead.
		it('listPanes re-asks a reply that did not come back as a pane array', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'list-panes': ['', LIST_ONE] })
			expect(zellijMuxAdapter.listPanes(exec)).toHaveLength(1)
			expect(calls).toHaveLength(2)
		})

		it('listPanes gives up at the retry ceiling rather than asking forever', () => {
			const calls: string[][] = []
			// Never answers, so `[]` here is a real answer rather than a dropped one — bounded by
			// LIST_PANES_ATTEMPTS, which is what keeps a wedged server from spinning.
			const exec = fakeExec(calls, { 'list-panes': '' })
			expect(zellijMuxAdapter.listPanes(exec)).toEqual([])
			expect(calls).toHaveLength(3)
		})

		it('lookup-listing-agent-status-absent-non-herdr', () => {
			// zellij carries no agent-state feed at all, so no pane ever reports agentStatus — absent,
			// never a false 'unknown'. The zellij row of the outline.
			const exec = fakeExec([], { 'list-panes': LIST_ONE })
			const panes = zellijMuxAdapter.listPanes(exec)
			for (const pane of panes) expect(pane.agentStatus).toBeUndefined()
		})

		// The zellij row of the outline; the tmux row lives in mux.tmux.test.ts. `is_floating` is in
		// 0.44.3's verified key set — the same live dump `terminal_command` was corrected from — and it
		// rides the `list-panes --json` call this adapter already makes, so it costs no second exec.
		it('lookup-listing-reports-floating', () => {
			const calls: string[][] = []
			const list = JSON.stringify([
				{ id: 'terminal_9', tab_id: 2, title: 'zsh', terminal_command: 'zsh', is_floating: true },
				{ id: 'terminal_10', tab_id: 2, title: 'zsh', terminal_command: 'zsh', is_floating: false },
			])
			const exec = fakeExec(calls, { 'list-panes': list })
			expect(zellijMuxAdapter.listPanes(exec)).toEqual([
				{ id: 'terminal_9', mux: 'zellij', floating: true },
				{ id: 'terminal_10', mux: 'zellij', floating: false },
			])
			// Still ONE call: no probe was added to answer this.
			expect(calls).toEqual([['action', 'list-panes', '--json']])
		})

		// Strictly `=== true`, so a record missing the key — an older zellij, or a shape this adapter
		// did not verify — reports the tiled answer rather than a truthy accident.
		it('listPanes() reads a zellij record with no is_floating key as not floating', () => {
			const list = JSON.stringify([{ id: 'terminal_9', tab_id: 2, title: 'zsh', terminal_command: 'zsh' }])
			expect(zellijMuxAdapter.listPanes(fakeExec([], { 'list-panes': list }))[0]?.floating).toBe(false)
		})
	})
})

describe('spec:cyber-mux/agent', () => {
	it('agent-lifecycle-absent-non-herdr', () => {
		// zellij has no native per-pane agent-state wait, so the optional capability is genuinely absent
		// — its absence IS the refusal deriveAgentWait turns into AgentLifecycleUnsupportedError.
		expect(zellijMuxAdapter.agentLifecycle).toBeUndefined()
	})
})

/**
 * `zellij action` dumps a screen and never blocks on what is on it, so the wait is the shared poll over
 * this adapter's own read — see `wait-output.test.ts` for the cadence/deadline/liveness rules the poll
 * itself owns.
 */
describe('zellijMuxAdapter — wait-output by polling', () => {
	it('polls dump-screen and matches what is already on screen', async () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'dump-screen': 'booting\nserver ready on :8080', 'list-panes': LIST_ONE })
		const result = await zellijMuxAdapter.waitForOutput(exec, { id: 'terminal_9' }, { match: 'ready', timeoutMs: 1000 })
		expect(result.matched).toBe(true)
		expect(calls).toEqual([
			['action', 'list-panes', '--json'],
			['action', 'dump-screen', '--pane-id', 'terminal_9'],
		])
	})

	it('refuses a pane that is gone instead of waiting out the timeout', async () => {
		const exec = fakeExec([], { 'dump-screen': 'booting', 'list-panes': LIST_ONE })
		await expect(
			zellijMuxAdapter.waitForOutput(exec, { id: 'terminal_404' }, { match: 'ready', timeoutMs: 60_000 }),
		).rejects.toThrow(/no longer exists/)
	})
})
