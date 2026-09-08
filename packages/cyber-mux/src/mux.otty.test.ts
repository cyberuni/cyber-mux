import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { createOttyAdapter, ottyMuxAdapter } from './mux.otty.ts'

/**
 * Keyed by the verb — `otty <verb> <subverb> …`, so we match on `<verb> <subverb>` or just `<verb>`.
 */
function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		// Match on verb or verb+subverb
		const key = args.slice(0, 2).join(' ')
		const verbOnly = args[0]!
		return responses[key] ?? responses[verbOnly] ?? null
	}
}

/** Collect what an adapter writes to stderr while `run` executes, restoring the real stream after. */
function captureStderr(run: () => void): string {
	const written: string[] = []
	const write = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: string) => {
		written.push(String(chunk))
		return true
	}) as typeof process.stderr.write
	try {
		run()
	} finally {
		process.stderr.write = write
	}
	return written.join('')
}

const NEW_PANE_RESPONSE = JSON.stringify({
	pane_id: 'pane:7',
	tab_id: 'tab:3',
	window_id: 'window:1',
})

const NEW_TAB_RESPONSE = JSON.stringify({
	pane_id: 'pane:8',
	tab_id: 'tab:4',
})

const NEW_WINDOW_RESPONSE = JSON.stringify({
	pane_id: 'pane:10',
	tab_id: 'tab:5',
	window_id: 'window:2',
})

const LIST_PANES_RESPONSE = JSON.stringify([
	{ pane_id: 'pane:1', title: 'main', cwd: '/home/user', is_focused: true },
	{ pane_id: 'pane:2', title: 'tests', cwd: '/home/user/tests' },
	{ pane_id: 'pane:3', cwd: '/tmp' },
])

const windowAdapter = createOttyAdapter({ window: 'window:1' })

describe('spec:cyber-mux/mux', () => {
	describe('ottyMuxAdapter', () => {
		// otty documents `pane split --direction <right|left|up|down>` — a flag taking a VALUE, not a
		// bare `--right`. These two assert the exact argv because that is the only place a wrong flag
		// spelling is catchable without a live otty (#128).
		it('open() at pane:right splits with --direction right', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			const target = ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'pane:7', tab: 'tab:3' })
			expect(calls[0]).toEqual(['pane', 'split', '--direction', 'right', '--cwd', '/unit'])
		})

		// `down`, NOT `bottom`: `--bottom` is the `otty view`/`otty edit` spelling and is not a value in
		// `pane split`'s direction vocabulary at all.
		it('open() at pane:down splits with --direction down', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down' })
			expect(calls[0]).toEqual(['pane', 'split', '--direction', 'down', '--cwd', '/unit'])
		})

		it('open() reports the ambient window when the adapter is bound to one', () => {
			const exec = fakeExec([], { 'pane split': NEW_PANE_RESPONSE })
			const target = windowAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'pane:7', tab: 'tab:3', workspace: 'window:1' })
		})

		it('open() at tab creates a new tab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			const target = ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[0]).toEqual(['tab', 'new', '--cwd', '/unit'])
			expect(target).toEqual({ id: 'pane:8', tab: 'tab:4' })
		})

		// `otty tab new --title` is documented, so the tab is named in the CREATING call — one round
		// trip, and no window in which the tab carries otty's default name. The whole-argv assertion is
		// what pins the absence of the follow-up `tab rename` this used to issue.
		it('open() at tab names the tab at birth with --title', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', label: 'build' })
			expect(calls).toEqual([['tab', 'new', '--title', 'build', '--cwd', '/unit']])
		})

		// `otty open` always opens a new window and documents no `--new-window` — that flag belongs to
		// `otty view`/`otty edit`. Asserting the exact argv is what pins the absence.
		it('open() at workspace creates a new window with no --new-window flag', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { open: NEW_WINDOW_RESPONSE })
			const target = ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(calls[0]).toEqual(['open', '/unit'])
			expect(target).toEqual({ id: 'pane:10', tab: 'tab:5', workspace: 'window:2' })
		})

		// `--title` names the WINDOW — the space `at: 'workspace'` opens — so `label` lands at birth in
		// one call, instead of a follow-up rename of the tab, which is a different tier.
		it('open() at workspace names the window at birth with --title', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { open: NEW_WINDOW_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', label: 'review' })
			expect(calls).toEqual([['open', '--title', 'review', '/unit']])
		})

		it('open() with a `from` focuses that pane first', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'pane:3' } })
			expect(calls[0]).toEqual(['pane', 'focus', '--pane', 'pane:3'])
			expect(calls[1]).toEqual(['pane', 'split', '--direction', 'right', '--cwd', '/unit'])
		})

		it('canSizeSplits is true', () => {
			expect(ottyMuxAdapter.canSizeSplits).toBe(true)
		})

		// The inversion, on the reference's own example number: otty's `--size` is the NEW pane's share
		// in whole percent, while `ratio` is the fraction kept by the ORIGINAL. Keeping 0.7 therefore
		// gives the new pane 30 — the docs' `--size 30` — NOT 70. Getting this backwards is a silently
		// wrong-sized pane, which is why it is asserted on the exact argv.
		it('open() at pane:right inverts ratio into otty --size, the NEW pane share', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio: 0.7 })
			expect(calls).toEqual([['pane', 'split', '--direction', 'right', '--cwd', '/unit', '--size', '30']])
		})

		it('open() renders an even split as --size 50', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down', ratio: 0.5 })
			expect(calls).toEqual([['pane', 'split', '--direction', 'down', '--cwd', '/unit', '--size', '50']])
		})

		// The two ends of otty's documented 10-90 range, rendered exactly — no clamp, no warning.
		it.each([
			[0.9, '10'],
			[0.1, '90'],
		])('open() renders ratio %s at the range boundary as --size %s', (ratio, size) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			const written = captureStderr(() => {
				ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio })
			})
			expect(calls).toEqual([['pane', 'split', '--direction', 'right', '--cwd', '/unit', '--size', size]])
			expect(written).toBe('')
		})

		// Past the boundary otty has no faithful rendering: `--size 5` is outside the range it documents
		// and would fail the split outright. So the size is clamped INTO the range and the near miss is
		// announced, rather than applied quietly or turned into a failure.
		it.each([
			[0.95, '10', 5],
			[0.05, '90', 95],
		])('open() clamps ratio %s to --size %s and says so', (ratio, size, requested) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			const written = captureStderr(() => {
				ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio })
			})
			expect(calls).toEqual([['pane', 'split', '--direction', 'right', '--cwd', '/unit', '--size', size]])
			expect(written).toContain(`${requested}%`)
			expect(written).toContain(`${size}% was used instead`)
		})

		// The seam's own precondition, reached through otty's size render: a ratio outside `(0, 1)` names
		// no split at all, so it throws BEFORE any command is issued.
		it.each([0, 1, 1.5, -0.2, Number.NaN])('open() refuses the out-of-range ratio %s', (ratio) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			expect(() => ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', ratio })).toThrow(
				/ratio must be strictly between 0 and 1/,
			)
			expect(calls).toEqual([])
		})

		it('open() without a ratio sends no --size, leaving otty its own even default', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(calls[0]).not.toContain('--size')
		})

		it('sendText() sends text to a pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.sendText(exec, { id: 'pane:1' }, 'hello world')
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'hello world'])
		})

		it('sendKeys() sends keys with key: prefix', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.sendKeys(exec, { id: 'pane:1' }, ['Enter', 'Tab'])
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'key:Enter', 'key:Tab'])
		})

		it('submit() with text sends text and key:Enter atomically', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.submit(exec, { id: 'pane:1' }, 'npm test')
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'npm test', 'key:Enter'])
		})

		it('submit() without text sends just key:Enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.submit(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'send-keys', '--pane', 'pane:1', '--', 'key:Enter'])
		})

		it('read() reads pane content via capture', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane capture': 'screen output' })
			const result = ottyMuxAdapter.read(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'capture', '--pane', 'pane:1'])
			expect(result).toEqual({ text: 'screen output' })
		})

		it('read() with lines passes --lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane capture': 'last 50 lines' })
			ottyMuxAdapter.read(exec, { id: 'pane:1' }, { lines: 50 })
			expect(calls[0]).toEqual(['pane', 'capture', '--pane', 'pane:1', '--lines', '50'])
		})

		it('focus() focuses a pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.focus(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'focus', '--pane', 'pane:1'])
		})

		it('teardown() closes a pane', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.teardown(exec, { id: 'pane:1' })
			expect(calls[0]).toEqual(['pane', 'close', '--pane', 'pane:1'])
		})

		it('paneExists() returns true when the pane is in the list', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.paneExists(exec, { id: 'pane:2' })).toBe(true)
		})

		it('paneExists() returns false when the pane is not in the list', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.paneExists(exec, { id: 'pane:99' })).toBe(false)
		})

		it('isPaneFocused() returns true for the focused pane', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.isPaneFocused(exec, { id: 'pane:1' })).toBe(true)
		})

		it('isPaneFocused() returns false for a non-focused pane', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.isPaneFocused(exec, { id: 'pane:2' })).toBe(false)
		})

		it('isPaneFocused() returns undefined for an unknown pane', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.isPaneFocused(exec, { id: 'pane:99' })).toBeUndefined()
		})

		it('listPanes() returns all panes with their metadata', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			const panes = ottyMuxAdapter.listPanes(exec)
			expect(panes).toEqual([
				{ id: 'pane:1', mux: 'otty', cwd: '/home/user', label: 'main', floating: false },
				{ id: 'pane:2', mux: 'otty', cwd: '/home/user/tests', label: 'tests', floating: false },
				{ id: 'pane:3', mux: 'otty', cwd: '/tmp', floating: false },
			])
		})

		it('group() is a no-op — otty has a real window tier', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.group(exec, { id: 'pane:1' }, 'my-group')
			expect(calls).toEqual([])
		})

		it('rename() at tab renames the tab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			ottyMuxAdapter.rename(exec, { id: 'tab:1' }, 'tab', 'my-tab')
			expect(calls[0]).toEqual(['tab', 'rename', '--tab', 'tab:1', '--title', 'my-tab'])
		})

		// otty scopes `rename` to window/tab — the reference says so twice in one sentence, and the
		// pane-additional verb list omits it. A caller reaching this member directly is TOLD, rather than
		// handed the false success of a command that dies at otty's argument parser.
		it('rename() at pane refuses by name', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {})
			expect(() => ottyMuxAdapter.rename(exec, { id: 'pane:1' }, 'pane', 'my-pane')).toThrow(/otty cannot name a pane/)
			expect(calls).toEqual([])
		})

		// The open path takes the OTHER trade: a name nobody needs to open a pane must not fail the
		// split, so the label degrades to a warning — the same split `mux.wezterm.ts` makes.
		it('open() at pane:right warns rather than failing when a label cannot be set', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			const written: string[] = []
			const write = process.stderr.write.bind(process.stderr)
			process.stderr.write = ((chunk: string) => {
				written.push(String(chunk))
				return true
			}) as typeof process.stderr.write
			try {
				const target = ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', label: 'build' })
				expect(target).toEqual({ id: 'pane:7', tab: 'tab:3' })
			} finally {
				process.stderr.write = write
			}
			expect(calls).toEqual([['pane', 'split', '--direction', 'right', '--cwd', '/unit']])
			expect(written.join('')).toContain('otty cannot name a pane')
		})

		it('name is otty', () => {
			expect(ottyMuxAdapter.name).toBe('otty')
		})
	})
})

describe('spec:cyber-mux/mux/lookup', () => {
	describe('ottyMuxAdapter', () => {
		// The otty row of the outline: `cwd` rides the same `panes` call the listing already makes.
		it('lookup-listing-reports-cwd', () => {
			const panes = ottyMuxAdapter.listPanes(fakeExec([], { panes: LIST_PANES_RESPONSE }))
			expect(panes.map((p) => p.cwd)).toEqual(['/home/user', '/home/user/tests', '/tmp'])
		})

		it('lookup-listing-floating-false-by-construction', () => {
			// otty has no floating-pane concept at all, so every pane it reports really is tiled. `false`
			// is the TRUE answer here, not a stub standing in for one — and it is never omitted: an absent
			// value would leave a caller guessing between "not floating" and "cannot tell".
			const panes = ottyMuxAdapter.listPanes(fakeExec([], { panes: LIST_PANES_RESPONSE }))
			expect(panes.length).toBeGreaterThan(0)
			for (const pane of panes) expect(pane.floating).toBe(false)
		})
	})
})
