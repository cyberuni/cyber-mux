import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { cmuxMuxAdapter } from './mux.cmux.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { ottyMuxAdapter } from './mux.otty.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { MuxAdapter } from './mux.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'
import { zellijMuxAdapter } from './mux.zellij.ts'

/**
 * `MuxAdapter.opensWithoutStealingFocus` — the declaration, and the argv that has to back it.
 *
 * Collected in one file rather than spread across six adapter suites for the reason
 * `floating.test.ts` collects the float contract: the interesting property is the SPLIT across
 * backends, and a table that names all six is the only shape in which "every backend answers this"
 * can fail loudly when a seventh arrives without an answer.
 *
 * What the argv rows can and cannot prove is worth being exact about. They prove the flag is spelled
 * and positioned as intended and that no route silently drops it — which is a real regression guard,
 * since the flags were added to five different call sites. They do not prove the backend HONORS it.
 * For tmux and herdr that half was measured against live binaries (3.7c and 0.8.2 respectively; see
 * each adapter's declaration comment). For zellij it is unmeasured — there is no zellij on this
 * machine and the integration suite skips its rows without one — and the adapter says so.
 */

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────

/** tmux keys off `args[0]`: every call is `tmux <command> …`. */
function tmuxExec(calls: string[][]): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return '%9\t@1'
	}
}

/** herdr keys off the first two args — `pane split`, `tab create`, `workspace create`. */
function herdrExec(calls: string[][]): Exec {
	const envelopes: Record<string, unknown> = {
		'workspace create': { root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1', workspace_id: 'w9' } },
		'tab create': { root_pane: { pane_id: 'w9:p2', tab_id: 'w9:t2', workspace_id: 'w9' } },
		'pane split': { pane: { pane_id: 'w9:p3', tab_id: 'w9:t1', workspace_id: 'w9' } },
	}
	return (_cmd, args) => {
		calls.push(args)
		const result = envelopes[args.slice(0, 2).join(' ')]
		return result ? JSON.stringify({ result }) : null
	}
}

/** zellij keys off `args[1]`: every call is `zellij action <verb> …`. */
function zellijExec(calls: string[][], listings: string[]): Exec {
	const queued = [...listings]
	return (_cmd, args) => {
		calls.push(args)
		if (args[1] === 'list-panes') return queued.length > 1 ? queued.shift()! : (queued[0] ?? '[]')
		if (args[1] === 'new-pane') return 'terminal_9'
		if (args[1] === 'new-tab') return '2'
		return ''
	}
}

/** A session with one pane standing, and it is the FOCUSED one — the pane a restore has to land on. */
const ZELLIJ_FOCUSED_ON_3 = JSON.stringify([
	{ id: 3, tab_id: 1, title: 'zsh', terminal_command: 'zsh', is_focused: true },
])
/** The same session AFTER the open, now carrying the pane the open made. */
const ZELLIJ_AFTER = JSON.stringify([
	{ id: 3, tab_id: 1, title: 'zsh', terminal_command: 'zsh', is_focused: false },
	{ id: 9, tab_id: 2, title: 'zsh', terminal_command: 'zsh', is_focused: true },
])
/** A session no client has attached to: a real listing, and nothing in it reports focus. */
const ZELLIJ_NOBODY_FOCUSED = JSON.stringify([
	{ id: 3, tab_id: 1, title: 'zsh', terminal_command: 'zsh', is_focused: false },
])

// ── the declaration ────────────────────────────────────────────────────────────────────────────

describe('spec:cyber-mux/mux/placement', () => {
	describe('opensWithoutStealingFocus — the declaration', () => {
		// REQUIRED on the seam, unlike `canSizeSplits`/`canFloatPanes`, so `toBe` on a boolean is the
		// right assertion: there is no absent state to tolerate, and an adapter that forgot to answer is
		// a type error rather than a silent `undefined` this row would have to accept.
		it.each<{ adapter: MuxAdapter; keepsFocus: boolean }>([
			{ adapter: tmuxMuxAdapter, keepsFocus: true },
			{ adapter: herdrMuxAdapter, keepsFocus: true },
			{ adapter: zellijMuxAdapter, keepsFocus: true },
			{ adapter: weztermMuxAdapter, keepsFocus: false },
			{ adapter: cmuxMuxAdapter, keepsFocus: false },
			{ adapter: ottyMuxAdapter, keepsFocus: false },
		])('$adapter.name declares whether an open leaves the caller’s focus alone', ({ adapter, keepsFocus }) => {
			expect(adapter.opensWithoutStealingFocus).toBe(keepsFocus)
		})
	})

	// ── tmux: `-d` on every creating command ─────────────────────────────────────────────────────

	describe('tmux backs the declaration with -d on every route', () => {
		// One row per route rather than one row asserting "some call has -d", because the bug this
		// guards is a route that was MISSED — which only a per-route assertion can see. `new-window`
		// carried `-d` from the start; `split-window` and `new-pane` did not, and both activate what
		// they create (measured on 3.7c).
		it.each([
			{ at: 'tab', command: 'new-window' },
			{ at: 'workspace', command: 'new-window' },
			{ at: 'pane:right', command: 'split-window' },
			{ at: 'pane:down', command: 'split-window' },
			{ at: 'pane:float', command: 'new-pane' },
		] as const)('open({ at: $at }) passes -d to $command', ({ at, command }) => {
			const calls: string[][] = []
			tmuxMuxAdapter.open(tmuxExec(calls), { cwd: '/u', at })
			const created = calls.find((c) => c[0] === command)
			expect(created).toBeDefined()
			// Position asserted, not just presence: tmux takes `-d` among the flags, and pinning it
			// immediately after the command name is what keeps the argv rows in the adapter suites exact.
			expect(created![1]).toBe('-d')
		})
	})

	// ── herdr: `--no-focus` on every creating verb ────────────────────────────────────────────────

	describe('herdr backs the declaration with --no-focus on every creating verb', () => {
		// `pane split` is the row that is new. It is also the one where the flag changes nothing today:
		// 0.8.2's split already leaves focus on the pane it split (measured). Passed and pinned anyway —
		// the declaration above is now a promise, and one kept only by a backend default is one a
		// release note can break without anything here failing first.
		it.each([
			{ at: 'workspace', verb: 'workspace create' },
			{ at: 'tab', verb: 'tab create' },
			{ at: 'pane:right', verb: 'pane split' },
			{ at: 'pane:down', verb: 'pane split' },
		] as const)('open({ at: $at }) passes --no-focus to `$verb`', ({ at, verb }) => {
			const calls: string[][] = []
			herdrMuxAdapter.open(herdrExec(calls), { cwd: '/u', at })
			const created = calls.find((c) => c.slice(0, 2).join(' ') === verb)
			expect(created).toBeDefined()
			expect(created).toContain('--no-focus')
		})
	})

	// ── zellij: two mechanisms, and the one place --no-focus must NOT appear ──────────────────────

	describe('zellij backs the declaration two different ways', () => {
		it.each([
			{ at: 'tab', verb: 'new-tab' },
			{ at: 'workspace', verb: 'new-tab' },
			{ at: 'pane:right', verb: 'new-pane' },
			{ at: 'pane:down', verb: 'new-pane' },
			{ at: 'pane:float', verb: 'new-pane' },
		] as const)('open({ at: $at }) with no `from` passes --no-focus to `$verb` and moves nothing', ({ at, verb }) => {
			const calls: string[][] = []
			zellijMuxAdapter.open(zellijExec(calls, [ZELLIJ_FOCUSED_ON_3, ZELLIJ_AFTER]), { cwd: '/u', at })
			const created = calls.find((c) => c[1] === verb)
			expect(created).toBeDefined()
			expect(created).toContain('--no-focus')
			// The whole point of the flag on this path: no focus verb is issued at all, before or after.
			expect(calls.some((c) => c[1] === 'focus-pane-id')).toBe(false)
		})

		// The most load-bearing row in this file. `--no-focus` does not merely suppress the new pane's
		// activation — it re-anchors the split onto the ISSUING pane (`$ZELLIJ_PANE_ID`), ignoring which
		// pane is focused. So passing it alongside the focus move that honors `from` would split the pane
		// cyber-mux is running in, print a plausible id for it, and exit 0: a silent wrong pane. If this
		// row ever goes green with `--no-focus` present, `from` has stopped meaning anything on zellij.
		it('open() with a `from` must NOT pass --no-focus — it would silently split the issuing pane', () => {
			const calls: string[][] = []
			zellijMuxAdapter.open(zellijExec(calls, [ZELLIJ_FOCUSED_ON_3, ZELLIJ_AFTER]), {
				cwd: '/u',
				at: 'pane:right',
				from: { id: 'terminal_3' },
			})
			const created = calls.find((c) => c[1] === 'new-pane')
			expect(created).toBeDefined()
			expect(created).not.toContain('--no-focus')
		})

		it('open() with a `from` puts focus back on the pane that had it, in order', () => {
			const calls: string[][] = []
			zellijMuxAdapter.open(zellijExec(calls, [ZELLIJ_FOCUSED_ON_3, ZELLIJ_AFTER]), {
				cwd: '/u',
				at: 'pane:right',
				from: { id: 'terminal_5' },
			})
			// Read the listing BEFORE moving focus (the reading is only right while the move has not
			// happened), then focus the split target, then split it, then land back where it started.
			expect(calls.map((c) => [c[1], c[2]])).toEqual([
				['list-panes', '--json'],
				['focus-pane-id', 'terminal_5'],
				['new-pane', '--direction'],
				['list-panes', '--json'],
				['focus-pane-id', 'terminal_3'],
			])
		})

		// A session no client has attached to reports every pane unfocused (see the adapter header).
		// There is nothing to restore then — and nothing was stolen either, so issuing a focus verb
		// would be inventing a focus move rather than undoing one.
		it('open() with a `from` restores nothing when no pane reported focus', () => {
			const calls: string[][] = []
			zellijMuxAdapter.open(zellijExec(calls, [ZELLIJ_NOBODY_FOCUSED, ZELLIJ_AFTER]), {
				cwd: '/u',
				at: 'pane:right',
				from: { id: 'terminal_5' },
			})
			const focusCalls = calls.filter((c) => c[1] === 'focus-pane-id')
			expect(focusCalls).toEqual([['action', 'focus-pane-id', 'terminal_5']])
		})
	})
})
