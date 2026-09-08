import { describe, expect, it } from 'vitest'
import { AgentWaitStatesUnsupportedError } from './agent-states.ts'
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
	// Explicit `is_focused: false` — the row type models the field as optional, and the two readings
	// have to be told apart: pane:2 is a pane otty SAYS is not focused, pane:3 is a row that says
	// nothing about focus at all. Which of the two a real otty emits for an unfocused pane is unknown
	// (its listing's row fields are undocumented — #128), and `isPaneFocused` is written so that being
	// wrong about it costs an `undefined` rather than a confident lie.
	{ pane_id: 'pane:2', title: 'tests', cwd: '/home/user/tests', is_focused: false },
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
			expect(calls[0]).toEqual(['tab', 'new'])
			expect(target).toEqual({ id: 'pane:8', tab: 'tab:4' })
		})

		// `otty tab new --title` is documented, so the tab is named in the CREATING call — one round
		// trip, and no window in which the tab carries otty's default name. The whole-argv assertion is
		// what pins the absence of the follow-up `tab rename` this used to issue.
		it('open() at tab names the tab at birth with --title', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', label: 'build' })
			expect(calls).toEqual([
				['tab', 'new', '--title', 'build'],
				['pane', 'send-keys', '--pane', 'pane:8', '--', "cd '/unit'", 'key:Enter'],
			])
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

		// #163, and the two routes take DIFFERENT answers on purpose.
		//
		// `pane split --cwd` is REAL: otty's own /agents/orchestration runs
		// `otty pane split --direction right --cwd "$PWD" --no-focus --json` by hand. #163 read
		// /reference/cli's silence as proof the flag was fabricated, but that page carries no flag table
		// for this command family at all and omits `--no-focus` too — measured over all 141 URLs in
		// docs.otty.sh/sitemap.xml, `--cwd` occurs on exactly one page, that one. So the flag stays and
		// no `cd` is sent, which is what this pins.
		it('open() at pane:right sets cwd with the documented --cwd and sends no cd', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(calls).toEqual([['pane', 'split', '--direction', 'right', '--cwd', '/unit']])
		})

		// A launch command on the split route runs UNPREFIXED — `--cwd` already put the pane in the
		// directory, so a `cd` here would be a second, redundant line in the pane's shell history.
		it('open() at pane:right runs the launch command without a cd prefix', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane split': NEW_PANE_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', launch: 'npm test' })
			expect(calls[1]).toEqual(['pane', 'send-keys', '--pane', 'pane:7', '--', 'npm test', 'key:Enter'])
		})

		// `tab new` gets no such rescue: nothing on any of otty's 141 doc pages puts a working directory
		// on it, and otty publishes no source to settle it. So the tab route takes the answer that is
		// correct under BOTH readings — a `cd` works whether or not `--cwd` exists, while sending a flag
		// otty does not take would fail every `--at tab` open outright. The `not.toContain` is the half
		// that catches a regression back to the flag.
		it('open() at tab carries cwd as a cd, never as a --cwd flag', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'tab' })
			expect(calls[0]).not.toContain('--cwd')
			expect(calls).toEqual([
				['tab', 'new'],
				['pane', 'send-keys', '--pane', 'pane:8', '--', "cd '/unit'", 'key:Enter'],
			])
		})

		// The cd needs no command to ride — unlike env, which is dropped with a warning when there is
		// none. With one, the command is chained behind it so it runs in the right directory.
		it('open() at tab chains the launch command behind the cd', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', launch: 'npm test' })
			expect(calls[1]?.[5]).toBe("cd '/unit' && npm test")
		})

		// The ordering rule, and the only one here that is silently wrong when broken: `env K=V cd '/x'
		// && cmd` sets the variables on `cd` and leaves `cmd` without them. The prefix belongs INSIDE
		// the `&&`.
		it('open() at tab puts the env prefix inside the cd chain, not ahead of it', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			ottyMuxAdapter.open(exec, {
				cwd: '/unit',
				at: 'tab',
				launch: 'npm test',
				env: { TOKEN: 'abc' },
			})
			expect(calls[1]?.[5]).toBe("cd '/unit' && env TOKEN='abc' npm test")
		})

		// env with no command to ride is dropped and announced — but the directory is not collateral:
		// the `cd` is still sent on its own.
		it('open() at tab still sends the cd when env is dropped for want of a command', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			const written = captureStderr(() => {
				ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', env: { TOKEN: 'abc' } })
			})
			expect(written).toContain('TOKEN')
			expect(calls[1]).toEqual(['pane', 'send-keys', '--pane', 'pane:8', '--', "cd '/unit'", 'key:Enter'])
		})

		// A directory is user data on a shell command line: a space would split it into two words and a
		// quote would unbalance the line. Single-quoted, with the quote-escape `envFallback` already
		// carries. This risk is new to the tab route and does not exist on the argv-passed `--cwd`.
		it('open() at tab shell-quotes a cwd carrying a space or a quote', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab new': NEW_TAB_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: "/tmp/my dir/it's", at: 'tab' })
			expect(calls[1]?.[5]).toBe(`cd '/tmp/my dir/it'\\''s'`)
		})

		// The workspace tier is untouched by all of the above: `otty open [path]` takes the directory as
		// a documented POSITIONAL, so it is set natively and no `cd` is sent.
		it('open() at workspace sets cwd natively and sends no cd', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { open: NEW_WINDOW_RESPONSE })
			ottyMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(calls).toEqual([['open', '/unit']])
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

		// `otty panes --json` is documented as a command; its row FIELDS never are. So a real row
		// without `is_focused` is the likeliest shape of being wrong about this backend, and
		// `undefined === true` is `false` — a confident "not focused" read out of a silence. Revert to
		// `found.is_focused === true` and this goes red.
		it('isPaneFocused() is undefined when the row carries no focus field', () => {
			const exec = fakeExec([], { panes: LIST_PANES_RESPONSE })
			expect(ottyMuxAdapter.isPaneFocused(exec, { id: 'pane:3' })).toBeUndefined()
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

describe('spec:cyber-mux/agent', () => {
	describe('ottyMuxAdapter agentLifecycle (mocked exec — otty is a GUI app, not installed here)', () => {
		/** The capability object, asserted present before anything reads through it. */
		const agentLifecycle = (() => {
			const capability = ottyMuxAdapter.agentLifecycle
			if (!capability) throw new Error('otty must declare agentLifecycle')
			return capability
		})()

		it('agent-wait-otty-builds-command', () => {
			// `otty pane wait --pane <id>` — the PANE-selected native wait, not `otty watch:<agent> <id>`,
			// whose positional is an agent session id no documented pane read can produce.
			const calls: string[][] = []
			const reached = agentLifecycle.waitForState(fakeExec(calls, { 'pane wait': '' }), { id: 'pane:7' }, {})
			expect(calls[0]).toEqual(['pane', 'wait', '--pane', 'pane:7'])
			expect(reached).toBe('idle')
		})

		it('agent-wait-otty-succeeds-on-empty-stdout', () => {
			// The bug this exists to catch: a satisfied `otty pane wait` prints nothing documented, so the
			// runner hands back `''`. Guarding with `!out` instead of `out === null` turns every successful
			// wait into a throw — revert to `!out` and this goes red while the argv test above stays green.
			const exec: Exec = () => ''
			expect(agentLifecycle.waitForState(exec, { id: 'pane:7' }, {})).toBe('idle')
		})

		it('agent-wait-otty-timeout-rounds-up-to-whole-seconds', () => {
			// otty's flag is `--timeout-secs`. 1500ms is 1.5s, which has no spelling — it rounds UP, never
			// down, because `--timeout-secs 1` would give up before the caller's bound.
			const calls: string[][] = []
			agentLifecycle.waitForState(fakeExec(calls, { 'pane wait': '' }), { id: 'pane:7' }, { timeoutMs: 1500 })
			expect(calls[0]).toEqual(['pane', 'wait', '--pane', 'pane:7', '--timeout-secs', '2'])
		})

		it('agent-wait-otty-zero-timeout-never-unbounds-the-wait', () => {
			// The silent-unbounding guard, and the ONE input that exercises it: `--timeout-secs 0` is otty's
			// spelling for WAIT FOREVER, which is what OMITTING timeoutMs already means at the seam — so a
			// caller who passed a bound must never get 0. Drop the `Math.max(1, …)` and this goes red with a
			// wait that blocks forever. (Every positive sub-second value is already floored by the ceil.)
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane wait': '' })
			agentLifecycle.waitForState(exec, { id: 'pane:7' }, { timeoutMs: 0 })
			agentLifecycle.waitForState(exec, { id: 'pane:7' }, { timeoutMs: 200 })
			expect(calls[0]).toEqual(['pane', 'wait', '--pane', 'pane:7', '--timeout-secs', '1'])
			expect(calls[1]).toEqual(['pane', 'wait', '--pane', 'pane:7', '--timeout-secs', '1'])
		})

		it('agent-wait-otty-timeout-omitted-indefinite', () => {
			// No timeoutMs — no `--timeout-secs`, so otty's own indefinite wait applies rather than a
			// bound cyber-mux invented.
			const calls: string[][] = []
			agentLifecycle.waitForState(fakeExec(calls, { 'pane wait': '' }), { id: 'pane:7' }, {})
			expect(calls[0]).not.toContain('--timeout-secs')
		})

		it('agent-wait-otty-until-idle-and-omitted-both-send-no-flag', () => {
			// `otty pane wait` has no `--until`. An omitted set takes otty's own default (idle, the only
			// state it has) and an explicit `['idle']` asks for exactly that — neither adds a flag.
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane wait': '' })
			agentLifecycle.waitForState(exec, { id: 'pane:7' }, {})
			agentLifecycle.waitForState(exec, { id: 'pane:7' }, { until: [] })
			agentLifecycle.waitForState(exec, { id: 'pane:7' }, { until: ['idle'] })
			for (const call of calls) expect(call).toEqual(['pane', 'wait', '--pane', 'pane:7'])
		})

		it('agent-wait-otty-refuses-unreachable-until', () => {
			// Refused BY NAME rather than narrowed to idle: a wait that ends on a state the caller did not
			// ask for is the plausible-wrong-answer shape, not a degrade. Refused BEFORE any exec.
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane wait': '' })
			expect(() => agentLifecycle.waitForState(exec, { id: 'pane:7' }, { until: ['blocked'] })).toThrow(
				AgentWaitStatesUnsupportedError,
			)
			// A set that CONTAINS idle is refused too — otty cannot end on the other member either.
			expect(() => agentLifecycle.waitForState(exec, { id: 'pane:7' }, { until: ['idle', 'done'] })).toThrow(
				/otty can only end an agent wait on idle/,
			)
			expect(calls).toEqual([])
		})

		it('agent-wait-otty-throws-when-the-wait-does-not-land', () => {
			// otty tells satisfied (exit 0) from no-reportable-state (6), no-such-pane (4) and timeout (9)
			// by EXIT CODE, which `Exec` does not carry — so the three fold into one throw naming the pane,
			// never into a returned status nobody reached.
			const exec: Exec = () => null
			expect(() => agentLifecycle.waitForState(exec, { id: 'pane:7' }, {})).toThrow(/otty pane wait/)
			expect(() => agentLifecycle.waitForState(exec, { id: 'pane:7' }, {})).toThrow(/pane:7/)
			// The exit-code detail is lost; otty's own sentence is not. `withReason` appends whatever the
			// runner captured — a diagnostic only, never branched on (a guard keyed on `lastError` is a
			// live no-op against a runner that never sets it).
			const withWords: Exec = Object.assign(() => null, { lastError: 'timed out; still busy: pane:7' })
			expect(() => agentLifecycle.waitForState(withWords, { id: 'pane:7' }, {})).toThrow(/still busy/)
		})

		it('agent-status-otty-stays-undefined', () => {
			// The wait and the SNAPSHOT are independent members, and otty is where they part: it can block
			// on its own agent state and exposes no documented CLI read of it, so every listed pane still
			// reports no agentStatus. Never a false `unknown`.
			const panes = ottyMuxAdapter.listPanes(fakeExec([], { panes: LIST_PANES_RESPONSE }))
			expect(panes.length).toBeGreaterThan(0)
			for (const pane of panes) expect(pane.agentStatus).toBeUndefined()
		})
	})
})
