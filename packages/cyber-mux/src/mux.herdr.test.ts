import { describe, expect, it, vi } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import type { MuxPlacement, MuxSpaceTier } from './mux.ts'

function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		const key = args.slice(0, 2).join(' ')
		return responses[key] ?? null
	}
}

/** The capability under test — herdr always has it, so the optional member is asserted, not guessed. */
function worktree() {
	const capability = herdrMuxAdapter.worktree
	if (!capability) throw new Error('the herdr adapter must implement the worktree capability')
	return capability
}

/** The envelope `worktree create` and `worktree open` share, for tests that assert argv, not parsing. */
function worktreeOut() {
	return JSON.stringify({
		result: {
			root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' },
			workspace: { workspace_id: 'w9' },
			worktree: { path: '/p', branch: 'b' },
		},
	})
}

/** The real envelopes each placement's herdr call returns — the workspace_id rides in on all three. */
const PANE_IN_WORKSPACE = (paneId: string, ws: string) =>
	JSON.stringify({
		id: 'cli:workspace:create',
		result: { root_pane: { pane_id: paneId, tab_id: `${ws}:t1`, workspace_id: ws }, workspace: { workspace_id: ws } },
	})
const PANE_IN_TAB = (paneId: string, ws: string) =>
	JSON.stringify({
		result: {
			root_pane: { pane_id: paneId, tab_id: `${ws}:t2`, workspace_id: ws },
			tab: { tab_id: `${ws}:t2` },
			type: 'tab_created',
		},
	})
const PANE_IN_SPLIT = (paneId: string, ws: string) =>
	JSON.stringify({
		id: 'cli:pane:split',
		result: { pane: { pane_id: paneId, tab_id: `${ws}:t1`, workspace_id: ws }, type: 'pane_info' },
	})

/**
 * `describeRegion` is OPTIONAL on the seam — a backend that cannot describe its own region omits
 * it entirely. The herdr adapter must implement it, so bind it once here: if it ever goes missing
 * these tests fail loudly on that fact rather than silently skipping every case below.
 */
const describeRegion = herdrMuxAdapter.regions?.describeRegion
if (!describeRegion) throw new Error('the herdr adapter must implement describeRegion')

describe('spec:cyber-mux/mux/placement', () => {
	describe('herdrMuxAdapter (mocked exec — herdr is not installed in this environment)', () => {
		// The outline is ONE key, so every Examples row folds under this one static title. The
		// placement-specific tests below each cover a single row and assert argv besides; this one
		// exists to carry the outline's own claim — that whatever tier is opened, `open` returns the
		// workspace the pane landed in — across all three rows at once.
		it.each<{
			at: MuxPlacement
			response: Record<string, string | null>
			expected: { id: string; tab: string; workspace: string }
		}>([
			{
				at: 'workspace',
				response: { 'workspace create': PANE_IN_WORKSPACE('w7:p1', 'w7') },
				// The workspace it created.
				expected: { id: 'w7:p1', tab: 'w7:t1', workspace: 'w7' },
			},
			{
				at: 'tab',
				response: { 'tab create': PANE_IN_TAB('w3:pT', 'w3') },
				// The workspace the new tab was created in.
				expected: { id: 'w3:pT', tab: 'w3:t2', workspace: 'w3' },
			},
			{
				at: 'pane:right',
				response: { 'pane split': PANE_IN_SPLIT('w3:pB', 'w3') },
				// The workspace the split landed in — the caller's own.
				expected: { id: 'w3:pB', tab: 'w3:t1', workspace: 'w3' },
			},
		])('placement-open-returns-workspace', ({ at, response, expected }) => {
			const target = herdrMuxAdapter.open(fakeExec([], response), { cwd: '/unit', at })
			expect(target).toEqual(expected)
		})

		it('placement-launch-command-submitted', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1', workspace_id: 'w3' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })
			// The workspace the split LANDED IN — the caller's own. Free: it rides in on the same output
			// the pane id is read from.
			expect(target).toEqual({ id: 'w3:pB', tab: 'w3:t1', workspace: 'w3' })
			expect(calls[0]).toEqual(['pane', 'split', '--current', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pB', 'claude'])
		})

		it('placement-tab-no-focus-steal', () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w3:pT', tab_id: 'w3:t2', workspace_id: 'w3' },
					tab: { tab_id: 'w3:t2' },
					type: 'tab_created',
				},
			})
			const exec = fakeExec(calls, { 'tab create': tabOut })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'tab' })
			expect(target).toEqual({ id: 'w3:pT', tab: 'w3:t2', workspace: 'w3' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pT', 'claude'])
		})

		// No matching scenario in placement.feature (the `within` flag is not covered there) — left as
		// an extra, title kept descriptive rather than bound to a slug.
		it("open() at 'tab' opens in the workspace the caller NAMES, not the one the user is looking at", () => {
			// The tab tier's counterpart to `from`: `tab create` without `--workspace` resolves the
			// UI-focused space, so a caller filling a workspace it just opened has to name it or every tab
			// after the first lands beside the pane the command was run from.
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'tab create': PANE_IN_TAB('w7:pT', 'w7') })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', within: 'w7' })
			expect(target.workspace).toBe('w7')
			expect(calls[0]).toEqual(['tab', 'create', '--workspace', 'w7', '--cwd', '/unit', '--no-focus'])
		})

		// No matching scenario in placement.feature — left as an extra.
		it("a `within` is ignored by every placement but 'tab'", () => {
			// A split lands in its own pane's space and a `workspace` create makes the space it opens in —
			// neither has a space to be placed INTO, so neither emits a flag for one.
			const workspaceCalls: string[][] = []
			herdrMuxAdapter.open(fakeExec(workspaceCalls, { 'workspace create': PANE_IN_WORKSPACE('w7:p1', 'w7') }), {
				cwd: '/unit',
				at: 'workspace',
				within: 'w3',
			})
			expect(workspaceCalls[0]).not.toContain('--workspace')

			const splitCalls: string[][] = []
			herdrMuxAdapter.open(fakeExec(splitCalls, { 'pane split': PANE_IN_SPLIT('w3:pB', 'w3') }), {
				cwd: '/unit',
				at: 'pane:right',
				from: { id: 'w3:pA' },
				within: 'w3',
			})
			expect(splitCalls[0]).not.toContain('--workspace')
		})

		it('placement-omitted-defaults-to-tab', () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w3:pT', tab_id: 'w3:t2', workspace_id: 'w3' },
					tab: { tab_id: 'w3:t2' },
					type: 'tab_created',
				},
			})
			const exec = fakeExec(calls, { 'tab create': tabOut })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude' })
			expect(target).toEqual({ id: 'w3:pT', tab: 'w3:t2', workspace: 'w3' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w3:pT', 'claude'])
		})

		it('placement-herdr-workspace-unattached', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({
				id: 'cli:workspace:create',
				result: {
					root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1', workspace_id: 'w7' },
					workspace: { workspace_id: 'w7' },
				},
			})
			const exec = fakeExec(calls, { 'workspace create': createOut })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })
			expect(target).toEqual({ id: 'w7:p1', tab: 'w7:t1', workspace: 'w7' })
			// `workspace create` — NOT `worktree create`. It carries no --branch/--path and produces no
			// worktree record, so the workspace is bound to no repo even when its cwd is a checkout.
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[1]).toEqual(['pane', 'run', 'w7:p1', 'claude'])
		})

		// The workspace is read from the SAME output the pane id is read from, on every route. Probing
		// for it separately would buy nothing and cost a round trip per open, so the argv is the proof:
		// one command, and no `pane get`/`workspace list` follow-up.
		it('placement-herdr-workspace-free', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({
				result: {
					root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1', workspace_id: 'w7' },
					workspace: { workspace_id: 'w7' },
				},
			})
			const exec = fakeExec(calls, { 'workspace create': createOut })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			expect(target).toEqual({ id: 'w7:p1', tab: 'w7:t1', workspace: 'w7' })
			expect(calls).toHaveLength(1)
			expect(calls.some((c) => c[1] === 'get' || c[1] === 'list')).toBe(false)
		})

		// No matching scenario in placement.feature — left as an extra.
		// The pane id is required — a route that cannot name its pane has failed. The workspace is not:
		// a herdr build that stops emitting it degrades to "cannot say" rather than breaking `open`,
		// which is the meaning the seam already has for it.
		it('a pane whose output carries no workspace_id reports no workspace rather than throwing', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'w3:pB', tab: 'w3:t1' })
			expect(target.workspace).toBeUndefined()
		})

		it('placement-open-no-launch-blank-pane', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1', workspace_id: 'w3' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			const target = herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			expect(target).toEqual({ id: 'w3:pB', tab: 'w3:t1', workspace: 'w3' })
			expect(calls).toHaveLength(1)
			expect(calls.some((c) => c[0] === 'pane' && c[1] === 'run')).toBe(false)
		})

		// herdr's `--current` is not "the pane that called me": it reads $HERDR_PANE_ID and silently
		// resolves to the UI-FOCUSED pane when that is unset (verified against herdr 0.7.4), so an
		// unidentified caller splits whatever the user is looking at. Naming the pane is the fix, and
		// the emitted argv is the only place the difference is visible.
		it('placement-from-names-split-target', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', from: { id: 'w3:pA' } })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: 'w3:pA' } })
			expect(calls).toEqual([
				['pane', 'split', 'w3:pA', '--direction', 'right', '--cwd', '/unit'],
				['pane', 'split', 'w3:pA', '--direction', 'down', '--cwd', '/unit'],
			])
			expect(calls.every((c) => !c.includes('--current'))).toBe(true)
		})

		it('placement-from-omitted-tracks-focus', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({
				id: 'cli:pane:split',
				result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' }, type: 'pane_info' },
			})
			const exec = fakeExec(calls, { 'pane split': splitOut })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
			// Kept for a caller that cannot identify itself: herdr's guess beats refusing to open.
			expect(calls[0]).toEqual(['pane', 'split', '--current', '--direction', 'right', '--cwd', '/unit'])
		})

		// `ratio` is the fraction kept by the ORIGINAL pane, and herdr's `--ratio` sizes exactly that —
		// so it passes through UNCONVERTED, where tmux's `-l` sizes the new pane and inverts. Measured
		// against 0.7.4 rather than documented, which is why the literal flag is asserted, not trusted.
		it('placement-ratio-sign-convention', () => {
			const calls: string[][] = []
			const splitOut = JSON.stringify({ result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } } })
			const exec = fakeExec(calls, { 'pane split': splitOut })
			herdrMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', from: { id: 'w3:pA' }, ratio: 0.333 })
			expect(calls[0]).toEqual(['pane', 'split', 'w3:pA', '--direction', 'right', '--cwd', '/u', '--ratio', '0.333'])
			// 0.667 would be the inversion tmux needs — applying it here too is the failure this catches.
			expect(calls[0]).not.toContain('0.667')
		})

		it('placement-ratio-omitted-even-default', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } } }),
			})
			herdrMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right' })
			expect(calls[0]).not.toContain('--ratio')
		})

		// The seam refuses a ratio outside `0 < ratio < 1` before `--ratio` reaches herdr, rather than
		// pass `--ratio 5` (or `0`) through to a split herdr would then size wrong. It throws before any
		// exec call, so no split command is issued.
		it.each([1.5, 0])('placement-ratio-out-of-range-rejected', (ratio) => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } } }),
			})
			expect(() => herdrMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', ratio })).toThrow(
				/ratio must be strictly between 0 and 1/,
			)
			expect(calls).toEqual([])
		})

		it('placement-env-each-var-own-flag', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } } }),
			})
			herdrMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker', TIER: 'gpu' } })
			expect(calls[0]).toEqual([
				'pane',
				'split',
				'--current',
				'--direction',
				'right',
				'--cwd',
				'/u',
				'--env',
				'ROLE=worker',
				'--env',
				'TIER=gpu',
			])
		})

		it('placement-env-no-launch-blank-shell', () => {
			// Native env means no command to prefix is needed, so a warm pane with no command is coherent.
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } } }),
			})
			herdrMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker' } })
			expect(calls[0]).toContain('ROLE=worker')
			// The scenario says NOTHING is typed, sent, or run — so rule out all three of herdr's input
			// verbs, not just `run`. herdr spreads typing across `run`/`send-text`/`send-keys` where tmux
			// funnels everything through `send-keys`, so checking one verb leaves the others invisible: a
			// stray bare-Enter submit is exactly the regression that would slip through.
			expect(calls.some((c) => c[0] === 'pane' && ['run', 'send-text', 'send-keys'].includes(c[1] ?? ''))).toBe(false)
		})

		it('placement-backend-declares-can-size', () => {
			expect(herdrMuxAdapter.canSizeSplits).toBe(true)
		})

		// The outline is ONE key, so herdr's three Examples rows fold under this one static title. Each
		// row pins the tab herdr reports for that route AND that it cost no second call — the outline's
		// two Thens are one claim, so asserting the tab without the call count would leave the half that
		// a `pane get` follow-up would silently break.
		it.each<{ at: MuxPlacement; response: Record<string, string>; tab: string }>([
			// A new tab reports ITSELF — t2, the tab just created, not the workspace's root t1.
			{ at: 'tab', response: { 'tab create': PANE_IN_TAB('w3:pT', 'w3') }, tab: 'w3:t2' },
			// A created workspace reports its ROOT tab — the one herdr labels `1` and cannot name at birth.
			{ at: 'workspace', response: { 'workspace create': PANE_IN_WORKSPACE('w7:p1', 'w7') }, tab: 'w7:t1' },
			// A split opens no tab of its own, so it reports the tab it LANDED in — the caller's own.
			{ at: 'pane:right', response: { 'pane split': PANE_IN_SPLIT('w3:pB', 'w3') }, tab: 'w3:t1' },
		])('placement-open-reports-tab', ({ at, response, tab }) => {
			const calls: string[][] = []
			const opened = herdrMuxAdapter.open(fakeExec(calls, response), { cwd: '/unit', at })
			expect(opened.tab).toBe(tab)
			// Read from the output the pane id already comes from: one call, so the tab rode in on the
			// envelope that opened the pane rather than a query issued after it.
			expect(calls).toHaveLength(1)
		})

		// The trap this field exists to close. herdr refuses a rename addressed by a pane id outright
		// (`tab_not_found`, exit 1) — and since a failed command's output is discarded, a caller reaching
		// for `id` would leave the root tab named `1` with nothing raised. So the assertion is that the
		// rename carries the TAB and not the pane; asserting only "a tab rename ran" would pass on the
		// broken spelling.
		it('placement-reported-tab-names-root', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'workspace create': PANE_IN_WORKSPACE('w7:p1', 'w7') })
			const opened = herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			// The caller names the root tab with the tab open reported — never reaching for the pane.
			herdrMuxAdapter.rename(exec, { id: opened.tab }, 'tab', 'ledger')
			expect(calls[1]).toEqual(['tab', 'rename', 'w7:t1', 'ledger'])
			// The pane id and the tab id are different strings, and only the tab may appear.
			expect(opened.id).toBe('w7:p1')
			expect(calls[1]).not.toContain(opened.id)
		})

		// The outline is ONE key, so both of herdr's Examples rows fold under this one static title.
		it.each<{ tier: MuxSpaceTier; id: string; expected: string[] }>([
			{ tier: 'tab', id: 'w2:t3', expected: ['tab', 'rename', 'w2:t3', 'ledger'] },
			{ tier: 'pane', id: 'w2:pB', expected: ['pane', 'rename', 'w2:pB', 'ledger'] },
		])('placement-rename-after-birth', ({ tier, id, expected }) => {
			const calls: string[][] = []
			herdrMuxAdapter.rename(fakeExec(calls), { id }, tier, 'ledger')
			expect(calls).toEqual([expected])
		})

		// herdr labels a new workspace's root tab `1` and takes no flag for it at birth — `--label` on
		// `workspace create` names the WORKSPACE, never that tab. So the check is ordering plus absence:
		// the name must reach herdr only through a `tab rename`, and only after the create that made the
		// tab exist. A `workspace create` that carried the tab name would be the invented flag 0.7.4
		// answers with `unknown option`.
		it('placement-herdr-root-tab-rename-only', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'workspace create': PANE_IN_WORKSPACE('w7:p1', 'w7') })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace' })
			herdrMuxAdapter.rename(exec, { id: 'w7:t1' }, 'tab', 'ledger')
			// The create names no tab: the root tab's name is nowhere in the opening call.
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--no-focus'])
			expect(calls[0]).not.toContain('ledger')
			// And the name arrives by a rename, issued AFTER the workspace (and so its root tab) exists.
			expect(calls[1]).toEqual(['tab', 'rename', 'w7:t1', 'ledger'])
		})

		// The read-only claim, asserted as the ABSENCE of any other call rather than as the presence of
		// the rename: a rename that also beamed the client would still emit the right rename argv, so
		// only the exact-call-list assertion can catch it. `workspace focus`/`tab focus` would move
		// focus and `tab create` would open a space — none may appear, and nothing else may either.
		it('placement-rename-no-focus-no-create', () => {
			const calls: string[][] = []
			// A tab the caller is not in — the rename addresses it by id, never by visiting it.
			herdrMuxAdapter.rename(fakeExec(calls), { id: 'w9:t4' }, 'tab', 'ledger')
			expect(calls).toEqual([['tab', 'rename', 'w9:t4', 'ledger']])
		})

		// herdr's workspace IS the group: every pane and tab record already carries its `workspace_id`,
		// so a second grouping would duplicate a fact herdr never reads — and herdr would have to be
		// taught to read it. Asserting the argv is byte-identical to the ungrouped call is the check
		// that catches a flag invented for it (`--group`, `--label`, a `--env` smuggle), including one
		// herdr 0.7.4 would answer with `unknown option` and turn a working open into a failure.
		it('placement-herdr-group-id-ignored', () => {
			const grouped: string[][] = []
			const ungrouped: string[][] = []
			const out = PANE_IN_TAB('w3:pT', 'w3')
			const opts = { cwd: '/quarry', at: 'tab' as const, label: 'oak - ridge - mill' }
			herdrMuxAdapter.open(fakeExec(grouped, { 'tab create': out }), { ...opts, workspaceGroup: 'shift - a' })
			herdrMuxAdapter.open(fakeExec(ungrouped, { 'tab create': out }), opts)
			expect(grouped).toEqual(ungrouped)
			// Named explicitly too: `toEqual` above would also pass if BOTH calls leaked the id, which is
			// exactly the mistake this scenario forbids.
			expect(grouped.flat().join(' ')).not.toContain('shift - a')
			expect(grouped[0]).toEqual(['tab', 'create', '--cwd', '/quarry', '--label', 'oak - ridge - mill', '--no-focus'])
		})

		// The same answer the ignored `workspaceGroup` gives, now at the verb: herdr's tier IS the group
		// (every pane and tab record already carries its `workspace_id`), and its tab label IS the tab's
		// own name — its UI groups by the real workspace label, so the walk composes nothing to prefix.
		// Both are facts the backend already holds, so storing either would duplicate what it never
		// reads.
		it('placement-herdr-stores-neither-group-nor-name', () => {
			const calls: string[][] = []
			// Both a group id AND an own name are offered; neither may reach herdr.
			herdrMuxAdapter.group(fakeExec(calls), { id: 'w3:t1' }, 'shift-a', 'editor')
			// No grouping flag and no name flag — asserted as NO CALL AT ALL, which is stronger and is
			// the honest claim: there is no herdr command for this, so any argv would be invented. A
			// weaker "does not contain shift-a" check would pass an adapter that renamed the tab to
			// `editor`, silently overwriting a label the caller never asked to change.
			expect(calls).toEqual([])
			expect(calls.flat().join(' ')).not.toContain('shift-a')
			expect(calls.flat().join(' ')).not.toContain('editor')
		})

		// `WorkspaceCreateParams` and `TabCreateParams` both carry a native `env` Record in herdr's
		// socket schema (protocol 16), and the CLI takes the same repeatable `--env` there as `pane
		// split` does — verified against 0.7.4. Env is therefore native at EVERY tier, which a template's
		// root pane depends on: it is born by the region open, never by a split.
		// The pane tier of the same scenario. It overlaps the repeatable-flag test above by design:
		// that one owns the per-variable/order contract, this one owns "pane is a tier env reaches",
		// so the tier scenario's key covers every row it names rather than leaving pane to a
		// neighbouring key. Many-to-one binding is intended here.
		it('placement-env-native-at-birth', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, {
				'pane split': JSON.stringify({ result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } } }),
			})
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', env: { ROLE: 'planner' } })
			expect(calls[0]).toEqual([
				'pane',
				'split',
				'--current',
				'--direction',
				'right',
				'--cwd',
				'/unit',
				'--env',
				'ROLE=planner',
			])
		})

		it('placement-env-native-at-birth', () => {
			const calls: string[][] = []
			const createOut = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1' } } })
			const exec = fakeExec(calls, { 'workspace create': createOut })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', env: { ROLE: 'planner', TIER: 'cpu' } })
			expect(calls[0]).toEqual([
				'workspace',
				'create',
				'--cwd',
				'/unit',
				'--env',
				'ROLE=planner',
				'--env',
				'TIER=cpu',
				'--no-focus',
			])
		})

		it('placement-env-native-at-birth', () => {
			const calls: string[][] = []
			const tabOut = JSON.stringify({ result: { root_pane: { pane_id: 'w3:pT', tab_id: 'w3:t1' } } })
			const exec = fakeExec(calls, { 'tab create': tabOut })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', env: { ROLE: 'planner' } })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--env', 'ROLE=planner', '--no-focus'])
		})

		// `worktree create` is the ONE tier with no env: `WorktreeCreateParams` is
		// `[base, branch, cwd, focus, label, path, workspace_id]`, and 0.7.4 answers `--env` with
		// `unknown option: --env` — which Exec turns into a null and the adapter into a thrown "worktree
		// create failed". So passing env here must emit NOTHING, or the primary flow (a worktree pool
		// whose root pane sets ROLE) breaks outright. The adapter stays honest about its backend; the
		// caller honors env with the command prefix instead.
		it('placement-herdr-worktree-env-dropped', () => {
			const calls: string[][] = []
			// env with no launch now takes the compensation's warn path — silence its stderr; this test
			// asserts only that no `--env` reaches herdr's command, which the sibling scenarios cover for
			// the warning itself.
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
			worktree().createInWorkspace(exec, {
				primaryRoot: '/repo',
				branch: 'feat-x',
				path: '/repo.worktrees/feat-x',
				env: { ROLE: 'planner' },
			})
			expect(calls[0]).toEqual([
				'worktree',
				'create',
				'--cwd',
				'/repo',
				'--branch',
				'feat-x',
				'--path',
				'/repo.worktrees/feat-x',
				'--no-focus',
			])
			expect(calls[0]).not.toContain('--env')
			expect(calls[0]).not.toContain('ROLE=planner')
		})

		it('placement-herdr-worktree-env-dropped', () => {
			const calls: string[][] = []
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const exec = fakeExec(calls, { 'worktree open': worktreeOut() })
			worktree().openInWorkspace(exec, { primaryRoot: '/repo', path: '/p', env: { ROLE: 'planner' } })
			expect(calls[0]).toEqual(['worktree', 'open', '--cwd', '/repo', '--path', '/p', '--no-focus'])
			expect(calls[0]).not.toContain('--env')
		})

		it('placement-from-ignored-by-tab-workspace', () => {
			const calls: string[][] = []
			const created = JSON.stringify({
				id: 'cli:workspace:create',
				result: { root_pane: { pane_id: 'w4:p1', tab_id: 'w4:t1' }, type: 'workspace_created' },
			})
			const exec = fakeExec(calls, { 'workspace create': created, 'tab create': created })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'tab', from: { id: 'w3:pA' } })
			herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', from: { id: 'w3:pA' } })
			expect(calls.every((c) => !c.includes('w3:pA'))).toBe(true)
		})

		// No matching scenario in placement.feature — left as an extra.
		it('open() throws when workspace create reports no root pane id', () => {
			const exec = fakeExec([], { 'workspace create': JSON.stringify({ id: 'cli:workspace:create', result: {} }) })
			expect(() => herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })).toThrow(/root_pane/)
		})

		// No matching scenario in placement.feature — left as an extra.
		it('open() carries the backend’s own reason for refusing a split, and stays bare without one', () => {
			const exec = fakeExec([])
			expect(() => herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: 'w1:p2' } })).toThrow(
				/^herdr pane split failed$/,
			)
			exec.lastError = 'pane too small to split'
			expect(() => herdrMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: 'w1:p2' } })).toThrow(
				/^herdr pane split failed — pane too small to split$/,
			)
		})

		// No matching scenario for a bare labeling flag in placement.feature — left as an extra.
		it('open({at:workspace}) labels the workspace', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1' } } })
			herdrMuxAdapter.open(fakeExec(calls, { 'workspace create': out }), {
				cwd: '/unit',
				at: 'workspace',
				label: 'my-name',
			})
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--label', 'my-name', '--no-focus'])
		})

		it('open({at:tab}) labels the tab', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1' } } })
			herdrMuxAdapter.open(fakeExec(calls, { 'tab create': out }), { cwd: '/unit', at: 'tab', label: 'my-name' })
			expect(calls[0]).toEqual(['tab', 'create', '--cwd', '/unit', '--label', 'my-name', '--no-focus'])
		})

		it('open({at:pane:right}) renames the pane after the split — herdr has no label flag there', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { pane: { pane_id: 'w3:pB', tab_id: 'w3:t1' } } })
			herdrMuxAdapter.open(fakeExec(calls, { 'pane split': out }), {
				cwd: '/unit',
				at: 'pane:right',
				label: 'my-name',
			})
			expect(calls[0]).toEqual(['pane', 'split', '--current', '--direction', 'right', '--cwd', '/unit'])
			expect(calls[1]).toEqual(['pane', 'rename', 'w3:pB', 'my-name'])
		})

		it('open() names nothing when no label is given', () => {
			const calls: string[][] = []
			const out = JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1', tab_id: 'w7:t1' } } })
			herdrMuxAdapter.open(fakeExec(calls, { 'workspace create': out }), { cwd: '/unit', at: 'workspace' })
			expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/unit', '--no-focus'])
		})

		// No matching scenario in placement.feature — left as an extra.
		it('open() throws when herdr reports no pane id', () => {
			const exec: Exec = () => null
			expect(() => herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })).toThrow(
				/herdr pane split/,
			)
		})

		it('open() throws when herdr output lacks result.pane.pane_id', () => {
			const exec = fakeExec([], { 'pane split': JSON.stringify({ id: 'cli:pane:split', result: {} }) })
			expect(() => herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })).toThrow(/pane_id/)
		})

		it('open() throws when herdr reports no tab root pane id', () => {
			const exec: Exec = () => null
			expect(() => herdrMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'tab' })).toThrow(
				/herdr tab create/,
			)
		})

		// herdr's worktree verbs cannot set env at birth, so the capability compensates on the launch:
		// `carryLaunch` runs `envFallback`, and a `carried` command lands as an `env KEY=VALUE` prefix.
		it('placement-env-rides-command-prefix', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
			worktree().createInWorkspace(exec, {
				primaryRoot: '/repo',
				branch: 'b',
				path: '/p',
				env: { ROLE: 'worker' },
				launch: 'claude',
			})
			const paneRun = calls.find((c) => c[0] === 'pane' && c[1] === 'run')
			expect(paneRun).toEqual(['pane', 'run', 'w9:p1', "env ROLE='worker' claude"])
		})

		it('placement-env-no-command-warns', () => {
			const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			try {
				const calls: string[][] = []
				const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
				worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p', env: { ROLE: 'worker' } })
				// Named on stderr — a caller that asked for env and did not get it is told, not left guessing.
				expect(spy).toHaveBeenCalled()
				expect(String(spy.mock.calls[0]![0])).toContain('ROLE')
				// Nothing rides, because there was no command to ride on — no `pane run` at all.
				expect(calls.some((c) => c[0] === 'pane' && c[1] === 'run')).toBe(false)
			} finally {
				spy.mockRestore()
			}
		})

		it('placement-env-value-quoted-in-prefix', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
			worktree().createInWorkspace(exec, {
				primaryRoot: '/repo',
				branch: 'b',
				path: '/p',
				env: { GREETING: "hi there's" },
				launch: 'claude',
			})
			const paneRun = calls.find((c) => c[0] === 'pane' && c[1] === 'run')!
			// Single-quoted for the shell — the space stays inside one word and the quote does not unbalance it.
			expect(paneRun[3]).toContain("GREETING='hi there'\\''s'")
		})

		// The other half of the env rule, on the tier that DOES carry it natively: `open` sets `--env`
		// on the opening call, so the launch command it runs must never be prefixed on top of that.
		it.each<{ at: MuxPlacement; responses: Record<string, string>; pane: string }>([
			{ at: 'pane:right', responses: { 'pane split': PANE_IN_SPLIT('w3:pB', 'w3') }, pane: 'w3:pB' },
			{ at: 'tab', responses: { 'tab create': PANE_IN_TAB('w3:pT', 'w3') }, pane: 'w3:pT' },
			{ at: 'workspace', responses: { 'workspace create': PANE_IN_WORKSPACE('w7:p1', 'w7') }, pane: 'w7:p1' },
		])('placement-native-env-no-double-prefix', ({ at, responses, pane }) => {
			const calls: string[][] = []
			herdrMuxAdapter.open(fakeExec(calls, responses), {
				cwd: '/unit',
				at,
				env: { ROLE: 'worker' },
				launch: 'claude',
			})
			// Env is native — the flag is on the opening call...
			expect(calls[0]).toContain('--env')
			expect(calls[0]).toContain('ROLE=worker')
			// ...so the launched command runs verbatim, never `env ROLE=... claude`.
			const paneRun = calls.find((c) => c[0] === 'pane' && c[1] === 'run')!
			expect(paneRun).toEqual(['pane', 'run', pane, 'claude'])
		})
	})
})

describe('spec:cyber-mux/mux/driving', () => {
	describe('herdrMuxAdapter (mocked exec — herdr is not installed in this environment)', () => {
		it('driving-send-text-literal-no-enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.sendText(exec, { id: 'p-1' }, 'hello')
			expect(calls).toEqual([['pane', 'send-text', 'p-1', 'hello']])
		})

		it('driving-send-text-literal-no-enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.sendText(exec, { id: 'p-1' }, 'Up')
			expect(calls[0]).toEqual(['pane', 'send-text', 'p-1', 'Up'])
		})

		it('driving-send-keys-core-vocab', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.sendKeys(exec, { id: 'p-1' }, ['Escape', 'Up', 'C-c'])
			expect(calls).toEqual([['pane', 'send-keys', 'p-1', 'Escape', 'Up', 'C-c']])
		})

		it('driving-send-keys-core-vocab', () => {
			// Backspace is the one key tmux renames; herdr takes the core name as-is.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.sendKeys(exec, { id: 'p-1' }, ['Backspace'])
			expect(calls[0]).toEqual(['pane', 'send-keys', 'p-1', 'Backspace'])
		})

		it('driving-non-core-token-refused', () => {
			// herdr answers an unknown key with `unsupported key <k>` rather than typing it, so the
			// divergence is loud AT THE HERDR BOUNDARY (tmux types it instead). It is not loud at the
			// CLI: `Exec` drops stderr and reports failure as `null`, so exit 0 either way. What this
			// pins is only that cyber-mux forwards the token instead of pre-rejecting it.
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.sendKeys(exec, { id: 'p-1' }, ['Home'])
			expect(calls[0]).toEqual(['pane', 'send-keys', 'p-1', 'Home'])
		})

		it('driving-send-keys-enter-submits', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.sendKeys(exec, { id: 'p-1' }, ['Enter'])
			expect(calls[0]).toEqual(['pane', 'send-keys', 'p-1', 'Enter'])
		})

		it('driving-submit-with-text', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.submit(exec, { id: 'p-1' }, 'echo hi')
			expect(calls).toEqual([['pane', 'run', 'p-1', 'echo hi']])
		})

		it('driving-submit-text-literal-not-key', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.submit(exec, { id: 'p-1' }, 'Up')
			expect(calls).toEqual([['pane', 'run', 'p-1', 'Up']])
		})

		it('driving-submit-no-text-bare-enter', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.submit(exec, { id: 'p-1' })
			expect(calls).toEqual([['pane', 'send-keys', 'p-1', 'Enter']])
		})

		it('driving-submit-empty-text-bare-flush', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls)
			herdrMuxAdapter.submit(exec, { id: 'p-1' }, '')
			expect(calls).toEqual([['pane', 'send-keys', 'p-1', 'Enter']])
		})

		// No matching scenario in driving.feature (only send text / send keys / submit are specced there)
		// — left as an extra.
		it('read() captures visible pane output, optionally scoped to N lines', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane read': 'line1\nline2' })
			expect(herdrMuxAdapter.read(exec, { id: 'p-1' })).toBe('line1\nline2')
			expect(calls[0]).toEqual(['pane', 'read', 'p-1', '--source', 'visible'])

			herdrMuxAdapter.read(exec, { id: 'p-1' }, { lines: 50 })
			expect(calls[1]).toEqual(['pane', 'read', 'p-1', '--source', 'visible', '--lines', '50'])
		})
	})
})

describe('spec:cyber-mux/mux/lookup', () => {
	describe('herdrMuxAdapter (mocked exec — herdr is not installed in this environment)', () => {
		// No matching scenario in lookup.feature (which specs the isFocused PROBE, not the focus ACTION)
		// — left as an extra.
		it("focus() beams the attached client to the pane's own workspace and tab, in order", () => {
			const calls: string[][] = []
			const paneGetOut = JSON.stringify({
				result: { pane: { pane_id: 'w3:pB', workspace_id: 'w7', tab_id: 'w7:t2' } },
			})
			const exec = fakeExec(calls, { 'pane get': paneGetOut })
			herdrMuxAdapter.focus(exec, { id: 'w3:pB' })
			expect(calls).toEqual([
				['pane', 'get', 'w3:pB'],
				['workspace', 'focus', 'w7'],
				['tab', 'focus', 'w7:t2'],
			])
		})

		it('focus() throws instead of a false success when the recorded pane no longer resolves, and switches nothing', () => {
			const calls: string[][] = []
			const exec = fakeExec(calls, { 'pane get': null })
			expect(() => herdrMuxAdapter.focus(exec, { id: 'gone-pane' })).toThrow(/could not be resolved to beam to/)
			expect(calls).toEqual([['pane', 'get', 'gone-pane']])
		})

		// No matching scenario in lookup.feature — left as an extra.
		it('paneExists() is true for a live pane (read returns content, even empty) and false for a gone one', () => {
			// live pane with content
			expect(herdrMuxAdapter.paneExists(fakeExec([], { 'pane read': 'some output' }), { id: 'w3:p4' })).toBe(true)
			// live but empty pane — '' is non-null, so still exists
			expect(herdrMuxAdapter.paneExists(fakeExec([], { 'pane read': '' }), { id: 'w3:p4' })).toBe(true)
			// gone pane — read fails (Exec yields null)
			expect(herdrMuxAdapter.paneExists((): string | null => null, { id: 'w3:p4' })).toBe(false)
		})

		it('lookup-herdr-focused', () => {
			const focusedOut = JSON.stringify({ result: { pane: { pane_id: 'w3:pB', focused: true } } })
			expect(herdrMuxAdapter.isPaneFocused(fakeExec([], { 'pane get': focusedOut }), { id: 'w3:pB' })).toBe(true)
		})

		it('lookup-herdr-not-focused', () => {
			const notFocusedOut = JSON.stringify({ result: { pane: { pane_id: 'w3:pB', focused: false } } })
			expect(herdrMuxAdapter.isPaneFocused(fakeExec([], { 'pane get': notFocusedOut }), { id: 'w3:pB' })).toBe(false)
		})

		it('lookup-focus-unknown-not-boolean', () => {
			const errorOut = JSON.stringify({ error: { code: 'pane_not_found' } })
			expect(herdrMuxAdapter.isPaneFocused(fakeExec([], { 'pane get': errorOut }), { id: 'gone' })).toBeUndefined()
			expect(herdrMuxAdapter.isPaneFocused(() => null, { id: 'gone' })).toBeUndefined()
			expect(herdrMuxAdapter.isPaneFocused(() => 'not json', { id: 'w3:pB' })).toBeUndefined()
		})

		it('lookup-listing-enumerates-all-panes', () => {
			const listOut = JSON.stringify({
				result: {
					panes: [
						{ pane_id: 'w3:p1', agent: 'claude', cwd: '/repo/a' },
						{ pane_id: 'w3:p2', agent: 'codex', cwd: '/repo/b' },
						{ pane_id: 'w3:p3', cwd: '/repo/c' }, // blank/scaffold pane, no agent — still reported
					],
				},
			})
			expect(herdrMuxAdapter.listPanes(fakeExec([], { 'pane list': listOut }))).toEqual([
				{ id: 'w3:p1', mux: 'herdr', harness: 'claude', cwd: '/repo/a' },
				{ id: 'w3:p2', mux: 'herdr', harness: 'codex', cwd: '/repo/b' },
				{ id: 'w3:p3', mux: 'herdr', harness: undefined, cwd: '/repo/c' },
			])
		})

		// No matching scenario in lookup.feature — left as an extra.
		it("listPanes() drops entries herdr reports with no pane_id, but keeps a bare '' agent as no harness", () => {
			const listOut = JSON.stringify({
				result: {
					panes: [
						{ agent: 'claude', cwd: '/repo/a' }, // no pane_id — dropped
						{ pane_id: 'w3:p9', agent: '' },
					],
				},
			})
			expect(herdrMuxAdapter.listPanes(fakeExec([], { 'pane list': listOut }))).toEqual([
				{ id: 'w3:p9', mux: 'herdr', harness: undefined, cwd: undefined },
			])
		})

		it('listPanes() returns empty when herdr reports nothing or unparseable output', () => {
			expect(herdrMuxAdapter.listPanes((): string | null => null)).toEqual([])
			expect(herdrMuxAdapter.listPanes(() => 'not json')).toEqual([])
		})

		// The herdr row of the outline; the tmux row lives in session.tmux.test.ts.
		it('lookup-listing-carries-label', () => {
			// A person renamed this pane — herdr reports the name it was given, as its own field.
			const listOut = JSON.stringify({ result: { panes: [{ pane_id: 'w3:p1', cwd: '/repo/a', label: 'worker' }] } })
			expect(herdrMuxAdapter.listPanes(fakeExec([], { 'pane list': listOut }))).toEqual([
				{ id: 'w3:p1', mux: 'herdr', harness: undefined, cwd: '/repo/a', label: 'worker' },
			])
		})

		// The contrast that shows the tmux rule is a workaround, not the shape of the thing: herdr has
		// the honest primitive, so an unnamed pane needs no comparison to be read as unnamed.
		it('lookup-herdr-unnamed-no-label', () => {
			// herdr OMITS the key outright until a pane is renamed — not an empty string, not a default
			// standing in for absence. Nothing here is compared against anything to reach `undefined`.
			const listOut = JSON.stringify({ result: { panes: [{ pane_id: 'w3:p2', cwd: '/repo/b' }] } })
			const panes = herdrMuxAdapter.listPanes(fakeExec([], { 'pane list': listOut }))
			expect(panes[0]?.label).toBeUndefined()
		})
	})
})

// The tests below prove capabilities with no owned node assigned to this file: the worktree
// capability (worktree/worktree.feature) and the region-description capability (describeRegion /
// describeWorkspace, uncovered by any of the four .agents/spec/mux/* nodes this file binds). Kept
// here, unmoved, but outside any `spec:` describe so the scenario bridge does not mis-attribute them.
describe('herdrMuxAdapter — capabilities without an owned node in this file', () => {
	it('teardown() closes the pane', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		herdrMuxAdapter.teardown(exec, { id: 'p-1' })
		expect(calls[0]).toEqual(['pane', 'close', 'p-1'])
	})

	it('worktree.createInWorkspace() creates the worktree and opens its bound workspace in one call', () => {
		const calls: string[][] = []
		const createOut = JSON.stringify({
			id: 'cli:worktree:create',
			result: {
				root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' },
				workspace: { workspace_id: 'w9' },
				worktree: { branch: 'cyber-mux/unit-abc123', path: '/repo.worktrees/mux-abc123' },
			},
		})
		const exec = fakeExec(calls, { 'worktree create': createOut })
		const result = worktree().createInWorkspace(exec, {
			primaryRoot: '/repo',
			branch: 'cyber-mux/unit-abc123',
			path: '/repo.worktrees/mux-abc123',
			launch: 'claude',
		})
		// The root pane AND its root tab — read from the same `root_pane` record `workspace create`
		// reports both in, so this route hides no fact it already held. The tab is what lets a caller
		// handed this workspace address its region's tab (group it, name it) without reaching for the
		// pane id, which herdr refuses outright.
		expect(result.target).toEqual({ id: 'w9:p1', tab: 'w9:t1' })
		expect(result.worktree).toEqual({ root: '/repo.worktrees/mux-abc123', branch: 'cyber-mux/unit-abc123' })
		// The workspace id IS the binding — the whole reason to route through herdr rather than git.
		expect(result.workspace).toBe('w9')
		expect(calls[0]).toEqual([
			'worktree',
			'create',
			'--cwd',
			'/repo',
			'--branch',
			'cyber-mux/unit-abc123',
			'--path',
			'/repo.worktrees/mux-abc123',
			'--no-focus',
		])
		expect(calls[1]).toEqual(['pane', 'run', 'w9:p1', 'claude'])
	})

	it('worktree.createInWorkspace() labels the bound workspace', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
		worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p', label: 'my-name' })
		// Without it herdr names the workspace after the path basename, since we always pass --path.
		expect(calls[0]).toEqual([
			'worktree',
			'create',
			'--cwd',
			'/repo',
			'--branch',
			'b',
			'--path',
			'/p',
			'--label',
			'my-name',
			'--no-focus',
		])
	})

	it('worktree.openInWorkspace() labels the bound workspace', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'worktree open': worktreeOut() })
		worktree().openInWorkspace(exec, { primaryRoot: '/repo', path: '/p', label: 'my-name' })
		expect(calls[0]).toEqual(['worktree', 'open', '--cwd', '/repo', '--path', '/p', '--label', 'my-name', '--no-focus'])
	})

	it('worktree.createInWorkspace() passes a base as the branch start-point', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
		worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p', base: 'origin/main' })
		expect(calls[0]).toEqual([
			'worktree',
			'create',
			'--cwd',
			'/repo',
			'--branch',
			'b',
			'--path',
			'/p',
			'--base',
			'origin/main',
			'--no-focus',
		])
	})

	it('worktree.createInWorkspace() leaves the pane blank when no launch is given', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'worktree create': worktreeOut() })
		worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })
		expect(calls.some((c) => c[0] === 'pane' && c[1] === 'run')).toBe(false)
	})

	it('worktree.createInWorkspace() throws when herdr reports no root pane id', () => {
		const exec = fakeExec([], { 'worktree create': JSON.stringify({ id: 'cli:worktree:create', result: {} }) })
		expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
			/root_pane/,
		)
	})

	it('worktree.createInWorkspace() throws when herdr reports no worktree path/branch', () => {
		const out = JSON.stringify({
			id: 'cli:worktree:create',
			result: { root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' } },
		})
		const exec = fakeExec([], { 'worktree create': out })
		expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
			/worktree/,
		)
	})

	it('worktree.createInWorkspace() throws when herdr reports no bound workspace', () => {
		const out = JSON.stringify({
			id: 'cli:worktree:create',
			result: { root_pane: { pane_id: 'w9:p1', tab_id: 'w9:t1' }, worktree: { path: '/p', branch: 'b' } },
		})
		const exec = fakeExec([], { 'worktree create': out })
		expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
			/workspace_id/,
		)
	})

	it('worktree.createInWorkspace() throws when herdr reports nothing', () => {
		const exec: Exec = () => null
		expect(() => worktree().createInWorkspace(exec, { primaryRoot: '/repo', branch: 'b', path: '/p' })).toThrow(
			/herdr worktree create/,
		)
	})

	it('worktree.openInWorkspace() opens an existing checkout in a workspace bound to it', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'worktree open': worktreeOut() })
		const result = worktree().openInWorkspace(exec, { primaryRoot: '/repo', path: '/p', launch: 'claude' })
		expect(result.workspace).toBe('w9')
		expect(calls[0]).toEqual(['worktree', 'open', '--cwd', '/repo', '--path', '/p', '--no-focus'])
		expect(calls[1]).toEqual(['pane', 'run', 'w9:p1', 'claude'])
	})

	it('worktree.openInWorkspace() throws when herdr reports nothing', () => {
		expect(() => worktree().openInWorkspace(() => null, { primaryRoot: '/repo', path: '/p' })).toThrow(
			/herdr worktree open/,
		)
	})

	it('worktree.bindings() reports only the worktrees a workspace is currently open on', () => {
		const calls: string[][] = []
		const listOut = JSON.stringify({
			id: 'cli:worktree:list',
			result: {
				worktrees: [
					{ branch: 'main', path: '/repo', open_workspace_id: 'w19' },
					{ branch: 'feat/x', path: '/repo.worktrees/x', open_workspace_id: 'w21' },
					{ branch: 'feat/y', path: '/repo.worktrees/y' },
				],
			},
		})
		const exec = fakeExec(calls, { 'worktree list': listOut })
		const bindings = worktree().bindings(exec, { primaryRoot: '/repo' })
		expect(calls[0]).toEqual(['worktree', 'list', '--cwd', '/repo'])
		expect([...bindings]).toEqual([
			['/repo', 'w19'],
			['/repo.worktrees/x', 'w21'],
		])
		expect(bindings.has('/repo.worktrees/y')).toBe(false)
	})

	it.each([
		['nothing', null],
		['unparseable output', 'not json'],
		['no worktrees array', JSON.stringify({ result: {} })],
		['a non-array worktrees field', JSON.stringify({ result: { worktrees: 'nope' } })],
	])('worktree.bindings() reports no bindings when herdr returns %s', (_label, out) => {
		expect(worktree().bindings(() => out, { primaryRoot: '/repo' }).size).toBe(0)
	})

	it('worktree.releaseWorkspace() closes the workspace without touching the checkout', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'workspace close': '' })
		worktree().releaseWorkspace(exec, 'w21')
		expect(calls).toEqual([['workspace', 'close', 'w21']])
	})

	// Real capture from herdr 0.7.4 (`herdr pane layout --pane w3V:p1`): a workspace at x=36,y=1
	// sized 201x45, split right at ratio 0.6 then down at 0.7 — three panes.
	const LAYOUT_OUT = JSON.stringify({
		id: 'cli:pane:layout',
		result: {
			layout: {
				area: { height: 45, width: 201, x: 36, y: 1 },
				focused_pane_id: 'w3V:p1',
				panes: [
					{ focused: true, pane_id: 'w3V:p1', rect: { height: 32, width: 121, x: 36, y: 1 } },
					{ focused: false, pane_id: 'w3V:p3', rect: { height: 13, width: 121, x: 36, y: 33 } },
					{ focused: false, pane_id: 'w3V:p2', rect: { height: 45, width: 80, x: 157, y: 1 } },
				],
				// Deliberately present but never read by describeRegion — see the "ignores splits" test below.
				splits: [
					{ direction: 'right', id: 'split_0_root', ratio: 0.6, rect: { height: 45, width: 201, x: 36, y: 1 } },
					{ direction: 'down', id: 'split_1_0', ratio: 0.7, rect: { height: 45, width: 121, x: 36, y: 1 } },
				],
				tab_id: 'w3V:t1',
				workspace_id: 'w3V',
				zoomed: false,
			},
			type: 'pane_layout',
		},
	})

	// `pane list` companion for LAYOUT_OUT — carries cwd/label, which `pane layout` does not.
	const LIST_OUT = JSON.stringify({
		id: 'cli:pane:list',
		result: {
			panes: [
				{ pane_id: 'w3V:p1', cwd: '/repo', label: 'editor' },
				{ pane_id: 'w3V:p2', cwd: '/repo' },
				{ pane_id: 'w3V:p3', cwd: '/repo/logs', label: 'logs' },
			],
		},
	})

	it('describeRegion() queries pane layout by id, and pane list separately for cwd/label', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
		describeRegion(exec, { id: 'w3V:p1' })
		expect(calls).toContainEqual(['pane', 'layout', '--pane', 'w3V:p1'])
		expect(calls).toContainEqual(['pane', 'list'])
	})

	it('describeRegion() parses rects from layout.panes, screen-absolute and passed through verbatim', () => {
		const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
		const panes = describeRegion(exec, { id: 'w3V:p1' })
		expect(panes.map((p) => ({ id: p.id, rect: p.rect }))).toEqual([
			{ id: 'w3V:p1', rect: { height: 32, width: 121, x: 36, y: 1 } },
			{ id: 'w3V:p3', rect: { height: 13, width: 121, x: 36, y: 33 } },
			{ id: 'w3V:p2', rect: { height: 45, width: 80, x: 157, y: 1 } },
		])
		// Screen-absolute, not window-relative like tmux: a workspace can start at x=36, not 0.
		expect(panes.every((p) => p.rect.x === 0)).toBe(false)
	})

	// `layout.splits[]` reports direction/ratio outright, but its parent links live only in an
	// undocumented id convention ("split_1_0") — the rects say the same thing in a fact herdr
	// actually promises, so the export must be derived from `panes[]`, never `splits[]`.
	it('describeRegion() ignores layout.splits, deriving rects from panes only', () => {
		const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
		const panes = describeRegion(exec, { id: 'w3V:p1' })
		// Two panes' worth of rects, not the splits' rects (which include the whole 201x45 area and a
		// 121x45 sub-area that no reported pane actually has).
		expect(panes.some((p) => p.rect.width === 201)).toBe(false)
		expect(panes.some((p) => p.rect.height === 45 && p.rect.width === 121)).toBe(false)
		expect(panes).toHaveLength(3)
	})

	it('describeRegion() attaches a label only when herdr reports one — no hostname filtering needed', () => {
		const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
		const panes = describeRegion(exec, { id: 'w3V:p1' })
		expect(panes.find((p) => p.id === 'w3V:p1')?.label).toBe('editor')
		expect(panes.find((p) => p.id === 'w3V:p3')?.label).toBe('logs')
		// p2's `pane list` entry carries no label key at all — omitted, not a falsy placeholder.
		expect(panes.find((p) => p.id === 'w3V:p2')?.label).toBeUndefined()
	})

	it('describeRegion() parses cwd from pane list, keyed by pane id', () => {
		const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': LIST_OUT })
		const panes = describeRegion(exec, { id: 'w3V:p1' })
		expect(panes.find((p) => p.id === 'w3V:p3')?.cwd).toBe('/repo/logs')
	})

	it('describeRegion() throws when herdr reports nothing', () => {
		const exec: Exec = () => null
		expect(() => describeRegion(exec, { id: 'w3V:p1' })).toThrow(/could not describe the region/)
	})

	it('describeRegion() throws when pane layout returns unparseable JSON', () => {
		const exec = fakeExec([], { 'pane layout': 'not json' })
		expect(() => describeRegion(exec, { id: 'w3V:p1' })).toThrow(/unparseable output/)
	})

	it('describeRegion() throws when herdr reports no panes', () => {
		const out = JSON.stringify({ result: { layout: { panes: [] } } })
		const exec = fakeExec([], { 'pane layout': out })
		expect(() => describeRegion(exec, { id: 'w3V:p1' })).toThrow(/reported no panes/)
	})

	// Best-effort: the geometry is the verbose, hard-won part. A `pane list` failure must not take
	// down a query whose rects came back fine — cwd/label are just visibly absent.
	it('describeRegion() is best-effort: returns geometry without cwd/label when pane list fails', () => {
		const exec = fakeExec([], { 'pane layout': LAYOUT_OUT, 'pane list': null })
		const panes = describeRegion(exec, { id: 'w3V:p1' })
		expect(panes).toHaveLength(3)
		expect(panes.every((p) => p.cwd === undefined && p.label === undefined)).toBe(true)
		expect(panes.map((p) => p.rect)).toEqual([
			{ height: 32, width: 121, x: 36, y: 1 },
			{ height: 13, width: 121, x: 36, y: 33 },
			{ height: 45, width: 80, x: 157, y: 1 },
		])
	})

	/**
	 * The workspace-wide read. herdr HAS a workspace tier, so every fact here is one the backend
	 * already holds: the caller's pane names its workspace, `tab list` enumerates it, and `pane list`
	 * stamps every pane with its tab. No grouping tag is read and none is written — the tier IS the
	 * group, which is why `open` ignores `workspaceGroup` on this backend.
	 */
	const WS_TABS_OUT = JSON.stringify({
		result: {
			tabs: [
				{ tab_id: 'w3V:t1', workspace_id: 'w3V', number: 1, label: 'editor', focused: true, pane_count: 1 },
				{ tab_id: 'w3V:t2', workspace_id: 'w3V', number: 2, label: 'logs', focused: false, pane_count: 1 },
			],
		},
	})
	const WS_PANES_OUT = JSON.stringify({
		result: {
			panes: [
				{ pane_id: 'w3V:p1', tab_id: 'w3V:t1', cwd: '/repo', label: 'editor' },
				{ pane_id: 'w3V:p9', tab_id: 'w3V:t2', cwd: '/repo/logs' },
			],
		},
	})
	const WS_PANE_GET = JSON.stringify({
		result: { pane: { pane_id: 'w3V:p1', tab_id: 'w3V:t1', workspace_id: 'w3V' } },
	})
	const ONE_PANE_LAYOUT = JSON.stringify({
		result: { layout: { panes: [{ pane_id: 'w3V:p9', rect: { x: 0, y: 0, width: 200, height: 50 } }] } },
	})

	const describeWorkspace = herdrMuxAdapter.regions?.describeWorkspace
	if (!describeWorkspace) throw new Error('the herdr adapter must implement describeWorkspace')

	it('describeWorkspace() resolves the caller’s workspace, enumerates its tabs, and reads each tab’s geometry', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, {
			'pane get': WS_PANE_GET,
			'tab list': WS_TABS_OUT,
			'pane list': WS_PANES_OUT,
			'pane layout': ONE_PANE_LAYOUT,
		})
		const tabs = describeWorkspace(exec, { id: 'w3V:p1' })
		expect(calls).toEqual([
			// The workspace the caller sits in — the tier herdr really has, read off the pane record.
			['pane', 'get', 'w3V:p1'],
			['tab', 'list', '--workspace', 'w3V'],
			// Scoped to the workspace, so another workspace's panes never reach a capture — and ONE call
			// for every tab, since each pane arrives stamped with the tab it sits in.
			['pane', 'list', '--workspace', 'w3V'],
			// Geometry is per-PANE, never per-tab: `herdr layout` takes a tab_id but is socket-API-only
			// in 0.7.4, so each tab's rects come through any one pane that sits in it. Race-free — an
			// unfocused tab reports live geometry, so nothing is focused first.
			['pane', 'layout', '--pane', 'w3V:p1'],
			['pane', 'layout', '--pane', 'w3V:p9'],
		])
		expect(tabs.map((t) => t.id)).toEqual(['w3V:t1', 'w3V:t2'])
		expect(tabs.map((t) => t.label)).toEqual(['editor', 'logs'])
	})

	it('describeWorkspace() throws when herdr cannot resolve the pane, rather than guessing a workspace', () => {
		expect(() => describeWorkspace(() => null, { id: 'gone' })).toThrow(/could not resolve the workspace/)
	})

	it('describeWorkspace() throws when the workspace reports no tabs', () => {
		const exec = fakeExec([], { 'pane get': WS_PANE_GET, 'tab list': JSON.stringify({ result: { tabs: [] } }) })
		expect(() => describeWorkspace(exec, { id: 'w3V:p1' })).toThrow(/reported no tabs/)
	})
})
