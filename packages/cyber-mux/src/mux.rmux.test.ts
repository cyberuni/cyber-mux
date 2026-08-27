import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { FloatingPanesUnsupportedError } from './floating.ts'
import { RMUX_TAB_NAME_OPTION, RMUX_WORKSPACE_GROUP_OPTION, rmuxMuxAdapter } from './mux.rmux.ts'
import type { MuxPlacement, MuxSpaceTier } from './mux.ts'

function fakeExec(calls: string[][], responses: Record<string, string | null> = {}): Exec {
	return (_cmd, args) => {
		calls.push(args)
		return responses[args[0]!] ?? null
	}
}

describe('spec:cyber-mux/mux/placement', () => {
	it('placement-launch-command-submitted', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		const target = rmuxMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'pane:right' })
		expect(target).toEqual({ id: '%9', tab: '@1' })
		expect(calls[0]).toEqual(['split-window', '-d', '-h', '-c', '/unit', '-P', '-F', '#{pane_id}\t#{window_id}'])
		// --launch SUBMITS: typed literally, then Enter — so the command actually runs rather than
		// sitting staged. Two calls, since rmux (like tmux) has no atomic literal-text-plus-Enter primitive.
		expect(calls[1]).toEqual(['send-keys', '-t', '%9', '-l', 'claude'])
		expect(calls[2]).toEqual(['send-keys', '-t', '%9', 'Enter'])
	})

	// The outline is ONE key, so rmux's three Examples rows fold under this one static title. rmux's
	// Tab is its Window, exactly as tmux's, so 'workspace' and 'tab' report the same KIND of thing (the
	// window just opened) even though they are the tier distinction rmux collapses.
	it.each<{ at: MuxPlacement; response: Record<string, string>; tab: string }>([
		{ at: 'tab', response: { 'new-window': '%2\t@2' }, tab: '@2' },
		{ at: 'workspace', response: { 'new-window': '%2\t@2' }, tab: '@2' },
		// A split opens no window of its own, so rmux reports the window it LANDED in — the caller's.
		{ at: 'pane:right', response: { 'split-window': '%9\t@1' }, tab: '@1' },
	])('placement-open-reports-tab', ({ at, response, tab }) => {
		const calls: string[][] = []
		const opened = rmuxMuxAdapter.open(fakeExec(calls, response), { cwd: '/unit', at })
		expect(opened.tab).toBe(tab)
		// Read from the output the pane id already comes from — the SAME `-F` on the SAME call, which
		// is what makes it cost nothing. One call, and that call asked for both ids together.
		expect(calls).toHaveLength(1)
		expect(calls[0]).toContain('#{pane_id}\t#{window_id}')
	})

	// The outline is ONE key, so both of rmux's Examples rows fold under this one static title. rmux's
	// two tiers are two DIFFERENT verbs rather than one verb with a noun (unlike herdr), so the rows
	// assert the whole argv each tier emits — that is the entire content of the claim.
	it.each<{ tier: MuxSpaceTier; id: string; expected: string[] }>([
		// A tab is a Window on rmux, so it is `rename-window` — not a "tab" verb rmux does not have.
		{ tier: 'tab', id: '@4', expected: ['rename-window', '-t', '@4', 'ledger'] },
		// A pane has no rename verb at all; its name IS its title.
		{ tier: 'pane', id: '%7', expected: ['select-pane', '-t', '%7', '-T', 'ledger'] },
	])('placement-rename-after-birth', ({ tier, id, expected }) => {
		const calls: string[][] = []
		rmuxMuxAdapter.rename(fakeExec(calls), { id }, tier, 'ledger')
		expect(calls).toEqual([expected])
	})

	// The read-only claim, asserted as the ABSENCE of any other call rather than as the presence of
	// the rename: a rename that also beamed the client would still emit the right rename argv, so
	// only the exact-call-list assertion can catch it. `select-window`/`switch-client` would move
	// focus and `new-window` would open a space — none may appear, and nothing else may either.
	it('placement-rename-no-focus-no-create', () => {
		const calls: string[][] = []
		// A window the caller is not in — the rename addresses it by id, never by visiting it.
		rmuxMuxAdapter.rename(fakeExec(calls), { id: '@9' }, 'tab', 'ledger')
		expect(calls).toEqual([['rename-window', '-t', '@9', 'ledger']])
	})

	// rmux carries env natively via `-e` at every tier, so the launch command it submits must be the
	// bare command — never `env KEY=VALUE claude` prefixed on top of the env it already set.
	it.each<{ at: MuxPlacement; response: Record<string, string> }>([
		{ at: 'pane:right', response: { 'split-window': '%9\t@1' } },
		{ at: 'tab', response: { 'new-window': '%2\t@2' } },
		{ at: 'workspace', response: { 'new-window': '%2\t@2' } },
	])('placement-native-env-no-double-prefix', ({ at, response }) => {
		const calls: string[][] = []
		rmuxMuxAdapter.open(fakeExec(calls, response), {
			cwd: '/unit',
			at,
			env: { ROLE: 'worker' },
			launch: 'claude',
		})
		const open = calls.find((c) => c[0] === 'split-window' || c[0] === 'new-window')!
		expect(open).toContain('-e')
		expect(open).toContain('ROLE=worker')
		// The command is typed literally — never as an `env ...` prefix.
		expect(calls.some((c) => c[0] === 'send-keys' && c.includes('-l') && c.includes('claude'))).toBe(true)
		expect(calls.every((c) => c.every((a) => !a.startsWith('env ')))).toBe(true)
	})

	// Extra: exact argv across three placements together; no single scenario id names this compound
	// assertion, and each placement's own claim is proven individually elsewhere in this file.
	it('open() defaults to tab and honors pane:right / pane:down / tab placement', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%1\t@1', 'new-window': '%2\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'pane:right' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'pane:down' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', launch: 'x', at: 'tab' })
		// Assert on the placement calls themselves rather than fixed offsets into `calls`: a
		// `--launch` now costs two send-keys calls (literal text, then Enter), so positional
		// indexing would break on a change that has nothing to do with placement.
		const placements = calls.filter((c) => c[0] === 'split-window' || c[0] === 'new-window')
		expect(placements).toEqual([
			['split-window', '-d', '-h', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'],
			['split-window', '-d', '-v', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'],
			['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'],
		])
	})

	// `from` is what makes `pane:*` mean the CALLING pane. This adapter passes `-t` unconditionally
	// off `from` rather than off rmux's own $RMUX_PANE resolution — the CR's own reasoning is that
	// leaning on rmux's friendlier default would be an rmux-only code path whose whole benefit is
	// saving one flag. These assert the flag for that reason, not because rmux would otherwise guess
	// wrong the way tmux does.
	it('placement-from-names-split-target', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', from: { id: '%3' } })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'pane:down', from: { id: '%3' } })
		expect(calls.filter((c) => c[0] === 'split-window')).toEqual([
			['split-window', '-d', '-h', '-t', '%3', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'],
			['split-window', '-d', '-v', '-t', '%3', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'],
		])
	})

	it('placement-from-ignored-by-tab-workspace', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%2\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'tab', from: { id: '%3' } })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'workspace', from: { id: '%3' } })
		// No `-t`: a window is not placed relative to a pane, so leaking `from` here would target
		// the new window at an unrelated pane's session.
		expect(calls.filter((c) => c[0] === 'new-window')).toEqual([
			['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'],
			['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'],
		])
	})

	// `ratio` is the fraction kept by the ORIGINAL pane; rmux's `-l` sizes the NEW one, exactly as
	// tmux's does. This adapter INVERTS where herdr's passes the same number straight through. The
	// inversion's direction was PROBED on the live binary rather than assumed from tmux's — see
	// `toRmuxSize` — so asserting the literal flag is the cheapest guard against a future edit
	// silently un-probing it.
	it('placement-ratio-sign-convention', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', from: { id: '%3' }, ratio: 0.333 })
		expect(calls[0]).toEqual([
			'split-window',
			'-d',
			'-h',
			'-t',
			'%3',
			'-l',
			'67%',
			'-c',
			'/u',
			'-P',
			'-F',
			'#{pane_id}\t#{window_id}',
		])
		// 33% would be the un-inverted number — the exact shape of getting this backwards.
		expect(calls[0]).not.toContain('33%')
	})

	// Half is its own complement, so this is the one input the inversion cannot be seen through —
	// 50% either way. It earns its place for the opposite reason to the case above: an even split is
	// what anyone reaches for first by hand, so the value most likely to be used as a smoke test is
	// the one that proves least. Pin it so it at least cannot silently stop being 50%.
	// Extra: no dedicated scenario id for this rounding-boundary edge case beyond the sign convention.
	it('an even split converts to half regardless of the inversion', () => {
		const calls: string[][] = []
		rmuxMuxAdapter.open(fakeExec(calls, { 'split-window': '%9\t@1' }), {
			cwd: '/u',
			at: 'pane:right',
			from: { id: '%3' },
			ratio: 0.5,
		})
		expect(calls[0]).toContain('50%')
	})

	// rmux takes `-l` as a whole percent, exactly as tmux's, so the conversion rounds — and a ratio
	// landing exactly on .5 is where a swap to floor/ceil or truncation would show. 0.125 inverts to
	// 87.5%, which rounds half-up to 88%; truncating would say 87%.
	// Extra: no dedicated scenario id for the rounding-boundary case.
	it('a ratio on the rounding boundary rounds half up', () => {
		const calls: string[][] = []
		rmuxMuxAdapter.open(fakeExec(calls, { 'split-window': '%9\t@1' }), {
			cwd: '/u',
			at: 'pane:right',
			from: { id: '%3' },
			ratio: 0.125,
		})
		expect(calls[0]).toContain('88%')
	})

	it('placement-ratio-omitted-even-default', () => {
		const calls: string[][] = []
		rmuxMuxAdapter.open(fakeExec(calls, { 'split-window': '%9\t@1' }), { cwd: '/u', at: 'pane:right' })
		expect(calls[0]).not.toContain('-l')
	})

	// A window is not sized against a pane, so `-l` must never reach `new-window`. Every other ratio
	// check uses a pane placement, so this is the only one covering the window tiers.
	//
	// What this catches is now narrow, and deliberately so: `size` is lexically scoped inside the
	// pane-split branch (as tmux's always was), so the window branch cannot spread a value it
	// cannot see — the ordinary way to break this does not compile. The wrong subject left is an
	// author who hoists `size` back out to function scope AND spreads it into the window branch,
	// which is exactly the compound move this rejects. It is a backstop against the structure being
	// dismantled, not against a flag being passed.
	it.each(['tab', 'workspace'] as const)('placement-ratio-not-for-tab-workspace', (at) => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/unit', at, ratio: 0.3 })
		expect(calls[0]![0]).toBe('new-window')
		expect(calls[0]).not.toContain('-l')
		// neither the number as given nor its inversion — the two ways a leak would look.
		expect(calls[0]).not.toContain('30%')
		expect(calls[0]).not.toContain('70%')
	})

	// The seam refuses a ratio outside `0 < ratio < 1` rather than render `-l -50%` (above 1) or a
	// whole-region `-l 100%` (0). It throws BEFORE the split command reaches rmux, so no broken split
	// is created — the loud-over-quiet answer the boundary now takes.
	it.each([1.5, 0])('placement-ratio-out-of-range-rejected', (ratio) => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		expect(() => rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', ratio })).toThrow(
			/ratio must be strictly between 0 and 1/,
		)
		expect(calls).toEqual([])
	})

	it('placement-env-each-var-own-flag', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker', TIER: 'gpu' } })
		expect(calls[0]).toEqual([
			'split-window',
			'-d',
			'-h',
			'-e',
			'ROLE=worker',
			'-e',
			'TIER=gpu',
			'-c',
			'/u',
			'-P',
			'-F',
			'#{pane_id}\t#{window_id}',
		])
	})

	it('placement-env-no-launch-blank-shell', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right', env: { ROLE: 'worker' } })
		expect(calls[0]).toContain('ROLE=worker')
		expect(calls.some((c) => c[0] === 'send-keys')).toBe(false)
	})

	it('placement-backend-declares-can-size', () => {
		expect(rmuxMuxAdapter.canSizeSplits).toBe(true)
	})

	// rmux has NO floating-pane concept at all — `new-pane` is not in its command table. The
	// declaration is the OMITTED member, not a `false`: absence is what wezterm and herdr also use,
	// and `canFloatPanes` is meant to be read through the `canFloatPanes()` helper rather than
	// compared directly, so `undefined` and `false` must both read as "cannot".
	it('placement-backend-declares-no-float', () => {
		expect(rmuxMuxAdapter.canFloatPanes).toBeUndefined()
	})

	// The enforcement side of that declaration: `open({ at: 'pane:float' })` refuses BY NAME before
	// any argv is built — a float never degrades silently into a `split-window` that takes a share of
	// the region and resizes its neighbors, which is exactly the property a float exists to avoid.
	// Asserted as an EMPTY call list, not merely a throw: a refusal that first shelled out and then
	// threw on the response would still throw here, so only the exact-call-list assertion catches
	// that ordering bug.
	it('open({ at: "pane:float" }) throws FloatingPanesUnsupportedError before any exec call', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		expect(() => rmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float' })).toThrow(FloatingPanesUnsupportedError)
		expect(() => rmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:float' })).toThrow(
			/rmux cannot open a floating pane/,
		)
		expect(calls).toEqual([])
	})

	// ── the workspace group ──
	// The label here is deliberately one the group id could be mis-read OUT of: `oak - ridge - mill`
	// splits into group `oak` with tab `ridge - mill` exactly as well as group `oak - ridge` with tab
	// `mill`. So an adapter that derived the grouping from the label would emit one of those, and an
	// assertion on the exact value catches it. The group id itself carries the same separator, so
	// "forwarded verbatim" is distinguishable from "split on ' - ' and took a piece".
	it('placement-group-id-opaque', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%4\t@8' })
		rmuxMuxAdapter.open(exec, {
			cwd: '/quarry',
			at: 'tab',
			label: 'oak - ridge - mill',
			workspaceGroup: 'shift - a',
		})
		const set = calls.find((c) => c[0] === 'set-option')
		// Verbatim, separator and all — never a piece of it, and never anything the label could have
		// produced: the id reaches the backend as the opaque value the caller handed over.
		expect(set?.at(-1)).toBe('shift - a')
		expect(set).not.toContain('oak - ridge - mill')
		expect(set).not.toContain('oak')
		expect(set).not.toContain('shift')
	})

	// rmux has no Workspace tier, exactly as tmux, so the grouping has nowhere structural to live. A
	// window USER option (`@`-prefixed) is rmux's own mechanism (inherited from tmux) for a value it
	// stores but never interprets: it survives `rename-window` (unlike a name-encoded grouping) and
	// `list-windows` can filter on it server-side via `#{@cm_ws}`. Asserting the whole argv is what
	// pins "natively": a stash in cyber-mux's own memory would satisfy any weaker check while leaving
	// rmux unable to filter.
	it('placement-rmux-group-id-window-option', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%4\t@8' })
		rmuxMuxAdapter.open(exec, { cwd: '/quarry', at: 'tab', workspaceGroup: 'shift-a' })
		// `-w` scopes the option to the WINDOW, targeted by the window id the open itself reported —
		// so the tag lands on the window this call created and no other.
		expect(calls).toContainEqual(['set-option', '-w', '-t', '@8', RMUX_WORKSPACE_GROUP_OPTION, 'shift-a'])
		// The window id has to be asked for at birth, in the report the pane id already rides out on —
		// not bought with a second round trip.
		expect(calls[0]).toEqual(['new-window', '-d', '-c', '/quarry', '-P', '-F', '#{pane_id}\t#{window_id}'])
		// A user option, which is what makes it rmux's to filter on rather than an inert string.
		expect(RMUX_WORKSPACE_GROUP_OPTION.startsWith('@')).toBe(true)
		// The tag is written BEFORE anything the caller launches starts running in the window.
		const setAt = calls.findIndex((c) => c[0] === 'set-option')
		expect(setAt).toBe(1)
	})

	// `open` cannot be the only way in: a caller that did not open the space still has to group it,
	// and it holds that space's id the moment the open returns. The claim is not merely that the
	// verb works — it is that the verb and `open`'s option are ONE spelling, so they cannot drift.
	it('placement-group-existing-space', () => {
		const direct: string[][] = []
		// A window that already exists — nothing opens it here, which is the whole point.
		rmuxMuxAdapter.group(fakeExec(direct), { id: '@8' }, 'shift-a')
		// The backend stores the id ON THAT SPACE: `-w` scopes it to the window, targeted by id.
		expect(direct).toEqual([['set-option', '-w', '-t', '@8', RMUX_WORKSPACE_GROUP_OPTION, 'shift-a']])

		// The SAME command open itself issues to group a space it just created. Compared as argv
		// rather than asserted twice: two spellings that agree today are exactly what drifts, and a
		// second `set-option` hand-written inside `open` would pass a per-call check while being free
		// to diverge on the next edit.
		const viaOpen: string[][] = []
		rmuxMuxAdapter.open(fakeExec(viaOpen, { 'new-window': '%4\t@8' }), {
			cwd: '/quarry',
			at: 'tab',
			workspaceGroup: 'shift-a',
		})
		expect(viaOpen.filter((c) => c[0] === 'set-option')).toEqual(direct)
		// And routing costs NO call: rmux has no birth flag for a window option, so grouping was
		// already a second call after the window exists. An exact count — a verb that grouped by
		// re-querying and then setting would emit the right set-option and still be wrong.
		expect(viaOpen).toHaveLength(2)
	})

	// rmux has ONE name field per space, exactly as tmux's, having reimplemented tmux's data model
	// unchanged. A caller that composes a display name out of the tab's name has DESTROYED the
	// original, and splitting it back out is unsound. So the own name is stored beside the group —
	// the same rule the group id follows, one tier down.
	it('placement-rmux-name-stored-separately-from-group', () => {
		const calls: string[][] = []
		rmuxMuxAdapter.group(fakeExec(calls), { id: '@8' }, 'shift-a', 'editor')
		// Stored as the space's own name, verbatim.
		expect(calls).toContainEqual(['set-option', '-w', '-t', '@8', RMUX_TAB_NAME_OPTION, 'editor'])
		// SEPARATELY from its display name: the display name is rmux's `window_name`, and this write
		// must not touch it. A verb that stored the own name by renaming the window would satisfy
		// "stores editor" while destroying the composed name the human reads.
		expect(calls.some((c) => c[0] === 'rename-window')).toBe(false)
		expect(calls.flat()).not.toContain('window_name')
		// Two distinct options, never one: the group and the name are different facts, and a reader
		// that had to split one value apart would be back to the ambiguous parse this refuses.
		expect(RMUX_TAB_NAME_OPTION).not.toBe(RMUX_WORKSPACE_GROUP_OPTION)
		// A user option, like the group — rmux stores it without interpreting it, and it survives the
		// rename that composed the display name in the first place.
		expect(RMUX_TAB_NAME_OPTION.startsWith('@')).toBe(true)
		expect(calls).toHaveLength(2)
	})

	it('placement-group-id-not-invented', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%4\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/quarry', at: 'tab', label: 'oak - ridge - mill' })
		// Not "no id derived from the label" — no window option AT ALL. A window nobody grouped stays
		// ungrouped, and reads back as a workspace of one.
		expect(calls.some((c) => c[0] === 'set-option')).toBe(false)
		expect(calls.flat()).not.toContain(RMUX_WORKSPACE_GROUP_OPTION)
		// And nothing is even asked for: the ungrouped open emits the argv it always did.
		expect(calls[0]).toEqual([
			'new-window',
			'-n',
			'oak - ridge - mill',
			'-d',
			'-c',
			'/quarry',
			'-P',
			'-F',
			'#{pane_id}\t#{window_id}',
		])
	})

	// The regression this exists to stop: a tag cyber-mux wrote is its own bookkeeping, not a tier
	// rmux gained, so surfacing it as `workspace` would be a confident lie about the backend's
	// shape. Absent rather than false — the same convention `isPaneFocused`'s `unknown` follows.
	it('placement-group-id-not-reported-as-workspace', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%4\t@8' })
		const opened = rmuxMuxAdapter.open(exec, { cwd: '/quarry', at: 'tab', workspaceGroup: 'shift-a' })
		// The tag WAS written — this is the grouped case, not a vacuous pass.
		expect(calls.some((c) => c[0] === 'set-option')).toBe(true)
		// Absent, and not merely `!== 'shift-a'`: no `workspace` key at all, so no consumer reading
		// the pane can find one to report.
		expect(opened).toEqual({ id: '%4', tab: '@8' })
		expect('workspace' in opened).toBe(false)
		expect(opened.workspace).toBeUndefined()
	})

	// `new-window` takes `-e` too, verified live on rmux 0.10.0, so env is native at EVERY tier. That
	// matters because a template's root pane is born by the window open, never by a split — scoping
	// env to the split path would drop it. The title is static rather than interpolated so every tier
	// folds into the one scenario key.
	it.each([
		[
			'pane:right' as const,
			[
				'split-window',
				'-d',
				'-h',
				'-e',
				'ROLE=planner',
				'-e',
				'TIER=cpu',
				'-c',
				'/unit',
				'-P',
				'-F',
				'#{pane_id}\t#{window_id}',
			],
		],
		[
			'tab' as const,
			[
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
				'#{pane_id}\t#{window_id}',
			],
		],
		[
			'workspace' as const,
			[
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
				'#{pane_id}\t#{window_id}',
			],
		],
	])('placement-env-native-at-birth', (at, expected) => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%9\t@1', 'split-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/unit', at, env: { ROLE: 'planner', TIER: 'cpu' } })
		expect(calls[0]).toEqual(expected)
	})

	// Extra: birth-naming combined with env in one call is not itself a dedicated scenario id.
	it('open({at:workspace, env, label}) names the window and sets its env together', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'workspace', label: 'render-farm', env: { ROLE: 'planner' } })
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
			'#{pane_id}\t#{window_id}',
		])
	})

	it('placement-from-omitted-tracks-focus', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/u', at: 'pane:right' })
		// The pre-`from` behavior, kept for a caller that cannot identify itself: rmux's own default
		// (whatever it resolves without `-t`) is a guess this adapter never leans on deliberately, but
		// it is a better outcome than refusing to open at all.
		expect(calls[0]).toEqual(['split-window', '-d', '-h', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'])
		expect(calls[0]).not.toContain('-t')
	})

	it('placement-omitted-defaults-to-tab', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%2\t@1' })
		const target = rmuxMuxAdapter.open(exec, { cwd: '/u', launch: 'x' })
		expect(target).toEqual({ id: '%2', tab: '@1' })
		expect(calls[0]).toEqual(['new-window', '-d', '-c', '/u', '-P', '-F', '#{pane_id}\t#{window_id}'])
	})

	// rmux has no workspace tier — `workspace` and `tab` both collapse to a Window — so it has
	// nothing to report here, which is NOT the same as reporting that nothing is there. The field is
	// absent, never a false "none": `toEqual` pins the exact shape, so a stray `workspace: null`
	// would fail this.
	it.each(['workspace', 'tab', 'pane:right', 'pane:down'] as const)('placement-rmux-no-workspace-tier', (at) => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%20\t@1', 'split-window': '%20\t@1' })
		const target = rmuxMuxAdapter.open(exec, { cwd: '/unit', at })
		expect(target).toEqual({ id: '%20', tab: '@1' })
		expect('workspace' in target).toBe(false)
	})

	it('placement-rmux-workspace-visible-window', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%20\t@1' })
		const target = rmuxMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude', at: 'workspace' })
		expect(target).toEqual({ id: '%20', tab: '@1' })
		// A window (visible in the status bar, select-window-able), not a new-session -d detached
		// session that the attached client can't see or beam to.
		expect(calls[0]).toEqual(['new-window', '-d', '-c', '/unit', '-P', '-F', '#{pane_id}\t#{window_id}'])
		expect(calls.some((c) => c[0] === 'new-session')).toBe(false)
		expect(calls[1]).toEqual(['send-keys', '-t', '%20', '-l', 'claude'])
		expect(calls[2]).toEqual(['send-keys', '-t', '%20', 'Enter'])
	})

	it('placement-open-no-launch-blank-pane', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		const target = rmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right' })
		expect(target).toEqual({ id: '%9', tab: '@1' })
		expect(calls).toHaveLength(1)
		expect(calls.some((c) => c[0] === 'send-keys')).toBe(false)
	})

	// Extra: error-message shape for a null exec report is not itself a dedicated scenario id.
	it('open() throws when rmux reports no pane', () => {
		const exec: Exec = () => null
		expect(() => rmuxMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude' })).toThrow(/new-window/)
		// A runner that cannot say why yields the bare failure — no dangling em-dash, no guess.
		expect(() => rmuxMuxAdapter.open(exec, { cwd: '/unit', launch: 'claude' })).toThrow(/^rmux new-window failed$/)
	})

	// Extra: error-message shape for a backend-supplied reason is not itself a dedicated scenario id.
	it('open() carries the backend’s own reason for refusing a split', () => {
		// The real case this exists for: a pool too large for the region. rmux says its own reason on
		// stderr and, before `lastError`, the seam dropped it — leaving the caller a bare "rmux
		// split-window failed" to act on. These tests are mocked-exec unit tests — they pin the argv
		// and message shape, not a live rmux's actual stderr text.
		const exec: Exec = () => null
		exec.lastError = 'no space for new pane'
		expect(() => rmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:down', from: { id: '%4' } })).toThrow(
			/^rmux split-window failed — no space for new pane$/,
		)
	})

	// Extra: rmux has no workspace binding to a worktree at all — nothing in placement/lookup/driving
	// specs it; kept as a smoke check that the field is simply absent on this adapter.
	it('binds no worktree to a workspace — rmux has no workspace tier to bind one to', () => {
		expect(rmuxMuxAdapter.worktree).toBeUndefined()
	})

	// Extra: birth-naming via --label is documented in placement.feature's header but has no
	// dedicated scenario id distinct from the rename-after-birth scenarios above.
	it.each(['workspace', 'tab'] as const)('open({at:%s}) names the window with --label', (at) => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'new-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/unit', at, label: 'my-name' })
		// `-n` at birth also turns rmux's automatic-rename off, so the name survives what the pane runs.
		expect(calls[0]).toEqual([
			'new-window',
			'-n',
			'my-name',
			'-d',
			'-c',
			'/unit',
			'-P',
			'-F',
			'#{pane_id}\t#{window_id}',
		])
	})

	// Extra: birth-naming a pane via select-pane -T is not itself a dedicated scenario id.
	it('open({at:pane:right}) titles the pane after the split — rmux has no name flag there', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'split-window': '%9\t@1' })
		rmuxMuxAdapter.open(exec, { cwd: '/unit', at: 'pane:right', label: 'my-name' })
		expect(calls[0]).toEqual(['split-window', '-d', '-h', '-c', '/unit', '-P', '-F', '#{pane_id}\t#{window_id}'])
		expect(calls[1]).toEqual(['select-pane', '-t', '%9', '-T', 'my-name'])
	})

	// Extra: absence-of-naming is not itself a dedicated scenario id.
	it('open() names nothing when no label is given', () => {
		const calls: string[][] = []
		rmuxMuxAdapter.open(fakeExec(calls, { 'new-window': '%9\t@1' }), { cwd: '/unit', at: 'tab' })
		expect(calls[0]).not.toContain('-n')
		expect(calls.some((c) => c[0] === 'select-pane')).toBe(false)
	})

	/**
	 * `describeRegion` is OPTIONAL on the seam — a backend that cannot describe its own region omits
	 * it entirely. The rmux adapter must implement it, so bind it once here: if it ever goes missing
	 * these tests fail loudly on that fact rather than silently skipping every case below.
	 */
	const describeRegion = rmuxMuxAdapter.regions?.describeRegion
	if (!describeRegion) throw new Error('the rmux adapter must implement describeRegion')

	// A 200x50 window split into 3 panes (two stacked on the left, one full-height on the right),
	// queried from pane %0 — the same fixture shape tmux's own describeRegion carries, since rmux's
	// `-F` format for this read is byte-identical to tmux's (no floating flag rides this query on
	// either backend). These are mocked-exec unit tests, so this pins the parse, not a live capture;
	// the real-boundary proof belongs in mux.rmux.integration.test.ts.
	const REGION_OUT = [
		'%0\t0\t0\t119\t34\t/repo\tzeta\tzeta',
		'%2\t0\t35\t119\t15\t/repo\tzeta\tzeta',
		'%1\t120\t0\t80\t50\t/repo\teditor\tzeta',
	].join('\n')

	// Extra: describeRegion has no matching scenario in mux/placement, mux/driving, mux/lookup, or
	// mux/detection — bound only by the module-scope guard above; left as a harmless extra per the
	// bridge convention.
	it('describeRegion() queries list-panes scoped to the pane’s own window, not -a', () => {
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

	it('describeRegion() parses every pane’s rect from the 3-pane fixture', () => {
		const exec = fakeExec([], { 'list-panes': REGION_OUT })
		const panes = describeRegion(exec, { id: '%0' })
		expect(panes.map((p) => p.rect)).toEqual([
			{ x: 0, y: 0, width: 119, height: 34 },
			{ x: 0, y: 35, width: 119, height: 15 },
			{ x: 120, y: 0, width: 80, height: 50 },
		])
	})

	// rmux defaults pane_title to the hostname on an untouched pane — exporting THAT as a label
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

	it('describeRegion() throws when rmux reports nothing', () => {
		const exec: Exec = () => null
		expect(() => describeRegion(exec, { id: '%0' })).toThrow(/could not describe the region/)
	})

	it('describeRegion() throws when rmux reports no panes', () => {
		// A blank line, not '' — '' is falsy and would hit the null-output throw instead of this one.
		const exec = fakeExec([], { 'list-panes': '\n' })
		expect(() => describeRegion(exec, { id: '%0' })).toThrow(/reported no panes/)
	})

	/**
	 * The workspace-wide read. rmux has NO workspace tier, exactly as tmux, so a workspace is not a
	 * fact it holds — what it holds is the grouping TAG the walk wrote into a window user option. The
	 * read is therefore literally "which windows carry this group id", filtered server-side on the tag.
	 *
	 * Extra: describeWorkspace has no matching scenario in mux/placement, mux/driving, mux/lookup, or
	 * mux/detection — left as a harmless extra per the bridge convention.
	 */
	const describeWorkspace = rmuxMuxAdapter.regions?.describeWorkspace
	if (!describeWorkspace) throw new Error('the rmux adapter must implement describeWorkspace')

	it('describeWorkspace() reads the caller’s window and its tag in one call, then the tagged windows', () => {
		const calls: string[][] = []
		// Each window DISPLAYS the composed `pool - <tab>` and carries its own name in @cm_tab beside
		// the tag — exactly what the walk stored, because composing the display name destroyed the
		// original.
		const exec = fakeExec(calls, {
			'display-message': '@1\tws-7\teditor\tpool - editor',
			'list-windows': ['@1\teditor\tpool - editor', '@2\tlogs\tpool - logs'].join('\n'),
			'list-panes': REGION_OUT,
		})
		const tabs = describeWorkspace(exec, { id: '%0' })
		expect(calls[0]).toEqual([
			'display-message',
			'-p',
			'-t',
			'%0',
			`#{window_id}\t#{${RMUX_WORKSPACE_GROUP_OPTION}}\t#{${RMUX_TAB_NAME_OPTION}}\t#{window_name}`,
		])
		// Keyed on the TAG, filtered server-side. `list-windows -a` spans sessions, so a name match
		// would over-collect a same-named window belonging to somebody else's session entirely.
		expect(calls[1]).toEqual([
			'list-windows',
			'-a',
			'-F',
			`#{window_id}\t#{${RMUX_TAB_NAME_OPTION}}\t#{window_name}`,
			'-f',
			`#{==:#{${RMUX_WORKSPACE_GROUP_OPTION}},ws-7}`,
		])
		// One region read per tagged window — by WINDOW id, since a workspace's other tabs have no
		// pane the caller named.
		expect(calls.slice(2).map((c) => [c[0], c[1], c[2]])).toEqual([
			['list-panes', '-t', '@1'],
			['list-panes', '-t', '@2'],
		])
		// The tab's OWN name, from the option — never the composed display name the window shows.
		expect(tabs.map((t) => ({ id: t.id, label: t.label, panes: t.panes.length }))).toEqual([
			{ id: '@1', label: 'editor', panes: 3 },
			{ id: '@2', label: 'logs', panes: 3 },
		])
	})

	it('describeWorkspace() throws when rmux cannot resolve the caller’s window', () => {
		expect(() => describeWorkspace(() => null, { id: '%0' })).toThrow(/could not resolve the workspace/)
	})
})

describe('spec:cyber-mux/mux/driving', () => {
	it('driving-send-text-literal-no-enter', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.sendText(exec, { id: '%3' }, 'hello')
		expect(calls).toEqual([['send-keys', '-t', '%3', '-l', 'hello']])
	})

	it('driving-send-text-literal-no-enter', () => {
		// Without -l, rmux resolves 'Up' as the arrow key (inheriting tmux's key-name-first
		// resolution) and moves the cursor (recalling shell history) instead of typing the word.
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.sendText(exec, { id: '%3' }, 'Up')
		expect(calls[0]).toEqual(['send-keys', '-t', '%3', '-l', 'Up'])
	})

	it('driving-send-keys-core-vocab', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.sendKeys(exec, { id: '%3' }, ['Escape', 'Up', 'C-c'])
		expect(calls).toEqual([['send-keys', '-t', '%3', 'Escape', 'Up', 'C-c']])
	})

	it('driving-backspace-renamed-key', () => {
		// rmux has no 'Backspace' key name and would type the word; BSpace is its name for the key —
		// probed against the live binary rather than inherited from tmux's own rename (see
		// RMUX_KEY_RENAMES in mux.rmux.ts).
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.sendKeys(exec, { id: '%3' }, ['Backspace'])
		// The WHOLE call list, not just the first: the scenario's "never delivered as literal
		// characters" is a claim about every call, and a stray `send-keys -l Backspace` after
		// this one would satisfy an assertion that only looked at calls[0].
		expect(calls).toEqual([['send-keys', '-t', '%3', 'BSpace']])
	})

	it('driving-non-core-key-known-by-backend', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.sendKeys(exec, { id: '%3' }, ['Home', 'M-x'])
		// No -l anywhere: rmux PRESSES Home rather than typing the word.
		expect(calls).toEqual([['send-keys', '-t', '%3', 'Home', 'M-x']])
	})

	it('driving-unknown-token-not-rescued', () => {
		// A token that names no key at all in rmux's vocabulary, and no rename maps it either. rmux
		// has no way to REFUSE a key name — send-keys just types whatever it does not recognize as a
		// key, so the token reaches rmux unchanged and lands as literal characters on the pane.
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.sendKeys(exec, { id: '%3' }, ['Zzz'])
		expect(calls).toEqual([['send-keys', '-t', '%3', 'Zzz']])
	})

	it('driving-send-keys-enter-submits', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.sendKeys(exec, { id: '%3' }, ['Enter'])
		expect(calls[0]).toEqual(['send-keys', '-t', '%3', 'Enter'])
	})

	it('driving-submit-with-text', () => {
		// -l applies to the whole arg list, so `send-keys -l <text> Enter` would type a literal
		// "Enter". The text must be typed literally and the Enter pressed as a key: two calls.
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.submit(exec, { id: '%3' }, 'echo hi')
		expect(calls).toEqual([
			['send-keys', '-t', '%3', '-l', 'echo hi'],
			['send-keys', '-t', '%3', 'Enter'],
		])
	})

	it('driving-submit-text-literal-not-key', () => {
		// Mirrors the regression tmux's own CR exists for: `send-keys -t %3 Up Enter` presses Up
		// (recalling the previous command) and then Enter, RE-RUNNING it — rmux inherits the same
		// key-name-first resolution, so the same bug shape applies here. This is a mocked-exec pin on
		// the argv this adapter emits, not a live-binary reproduction.
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.submit(exec, { id: '%3' }, 'Up')
		expect(calls).toEqual([
			['send-keys', '-t', '%3', '-l', 'Up'],
			['send-keys', '-t', '%3', 'Enter'],
		])
		expect(calls).not.toContainEqual(['send-keys', '-t', '%3', 'Up', 'Enter'])
	})

	it('driving-submit-no-text-bare-enter', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.submit(exec, { id: '%3' })
		expect(calls).toEqual([['send-keys', '-t', '%3', 'Enter']])
	})

	it('driving-submit-empty-text-bare-flush', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.submit(exec, { id: '%3' }, '')
		expect(calls).toEqual([['send-keys', '-t', '%3', 'Enter']])
	})

	// Extra: a plain read()-capture-with-line-scope smoke test; no dedicated scenario id in
	// mux/driving or mux/lookup covers read() itself.
	it('read() captures pane output, optionally scoped to N lines', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'capture-pane': 'line1\nline2' })
		expect(rmuxMuxAdapter.read(exec, { id: '%3' }).text).toBe('line1\nline2')
		expect(calls[0]).toEqual(['capture-pane', '-p', '-t', '%3'])

		rmuxMuxAdapter.read(exec, { id: '%3' }, { lines: 50 })
		expect(calls[1]).toEqual(['capture-pane', '-p', '-t', '%3', '-S', '-50'])
	})

	// Extra: the truncation answer (#100). No dedicated scenario id covers read() itself.
	it('read() leaves truncation unanswered — and the argv untouched — until it is asked for', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'capture-pane': 'line1\nline2' })
		// ABSENT, not `false`: nothing was asked, so nothing was determined — and no second capture was
		// spent finding out. The argv is byte-identical to the read that has always been issued.
		expect(rmuxMuxAdapter.read(exec, { id: '%3' }, { lines: 50 })).toEqual({ text: 'line1\nline2' })
		expect(calls).toEqual([['capture-pane', '-p', '-t', '%3', '-S', '-50']])
	})

	it('read({ truncation }) reports omitted rows from a capture taken one row deeper', () => {
		const calls: string[][] = []
		// `-S -51` reaches one row further into the history than the `-S -50` window — a longer capture is
		// exactly the rows the window dropped.
		const exec: Exec = (_cmd, args) => {
			calls.push(args)
			return args.at(-1) === '-51' ? 'older\nline1\nline2' : 'line1\nline2'
		}
		expect(rmuxMuxAdapter.read(exec, { id: '%3' }, { lines: 50, truncation: true })).toEqual({
			text: 'line1\nline2',
			truncated: true,
		})
		expect(calls).toEqual([
			['capture-pane', '-p', '-t', '%3', '-S', '-50'],
			['capture-pane', '-p', '-t', '%3', '-S', '-51'],
		])
	})

	it('read({ truncation }) reports a complete capture as not truncated, and probes -S -1 for a bare read', () => {
		const calls: string[][] = []
		// rmux clamps a start line past the top of the history, same as tmux, so a pane with nothing
		// above the window answers the deeper capture with the same rows — `false`, with no special case.
		const exec = fakeExec(calls, { 'capture-pane': 'line1\nline2' })
		expect(rmuxMuxAdapter.read(exec, { id: '%3' }, { truncation: true })).toEqual({
			text: 'line1\nline2',
			truncated: false,
		})
		// A bare read is the visible screen (no `-S`), so one row deeper than it is `-S -1`.
		expect(calls).toEqual([
			['capture-pane', '-p', '-t', '%3'],
			['capture-pane', '-p', '-t', '%3', '-S', '-1'],
		])
	})

	it("read({ lines: 'all' }) takes the whole history with rmux's own -S -, and probes nothing", () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'capture-pane': 'older\nline1\nline2' })
		// An unbounded window omitted nothing by construction, so the answer is free — one capture, not two.
		expect(rmuxMuxAdapter.read(exec, { id: '%3' }, { lines: 'all', truncation: true })).toEqual({
			text: 'older\nline1\nline2',
			truncated: false,
		})
		expect(calls).toEqual([['capture-pane', '-p', '-t', '%3', '-S', '-']])
	})

	// Extra: focus()'s beam-order mechanics are not themselves a dedicated scenario id in
	// mux/lookup — that suite specs the focus PROBE (isPaneFocused) and the resolve-by-name outline.
	it("focus() beams the attached client to the pane's own session and window, in order", () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'list-panes': '%1 sess-a @1\n%3 sess-b @9\n%7 sess-a @1' })
		rmuxMuxAdapter.focus(exec, { id: '%3' })
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
		expect(() => rmuxMuxAdapter.focus(exec, { id: '%3' })).toThrow(/could not be resolved to beam to/)
		expect(calls).toEqual([['list-panes', '-a', '-F', '#{pane_id} #{session_name} #{window_id}']])
	})

	// Extra: teardown() has no dedicated scenario id in these four nodes.
	it('teardown() kills the pane', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls)
		rmuxMuxAdapter.teardown(exec, { id: '%3' })
		expect(calls[0]).toEqual(['kill-pane', '-t', '%3'])
	})
})

describe('spec:cyber-mux/mux/lookup', () => {
	// Extra: paneExists() has no dedicated scenario id in mux/lookup.
	it('paneExists() is true when list-panes includes the id, false when it is gone', () => {
		// has-session misses (not a session name); list-panes lists the pane → exists
		expect(rmuxMuxAdapter.paneExists(fakeExec([], { 'list-panes': '%1\n%3\n%7' }), { id: '%3' })).toBe(true)
		// list-panes omits it → gone
		expect(rmuxMuxAdapter.paneExists(fakeExec([], { 'list-panes': '%1\n%7' }), { id: '%3' })).toBe(false)
	})

	it('lookup-rmux-focused-attached-client', () => {
		const exec = fakeExec([], { 'list-panes': '%1 0 1 1\n%3 1 1 1\n%7 0 0 0' })
		expect(rmuxMuxAdapter.isPaneFocused(exec, { id: '%3' })).toBe(true)
	})

	it('lookup-rmux-not-focused-conditions', () => {
		const exec = fakeExec([], { 'list-panes': '%1 0 1 1\n%3 0 1 1\n%7 1 0 1\n%9 1 1 0' })
		expect(rmuxMuxAdapter.isPaneFocused(exec, { id: '%3' })).toBe(false)
		expect(rmuxMuxAdapter.isPaneFocused(exec, { id: '%7' })).toBe(false)
		expect(rmuxMuxAdapter.isPaneFocused(exec, { id: '%9' })).toBe(false)
	})

	it('lookup-focus-unknown-not-boolean', () => {
		const exec = fakeExec([], { 'list-panes': '%1 1 1 1' })
		expect(rmuxMuxAdapter.isPaneFocused(exec, { id: '%3' })).toBeUndefined()
		expect(rmuxMuxAdapter.isPaneFocused(() => null, { id: '%3' })).toBeUndefined()
	})

	it('lookup-listing-enumerates-all-panes', () => {
		const calls: string[][] = []
		// Tab-separated, and `pane_title`/`host` ride along so a label can be told from the hostname
		// rmux defaults an unnamed pane's title to. Both panes here are named, so both carry a label.
		// No trailing floating-flag field — rmux's `-F` for this read has none.
		const exec = fakeExec(calls, {
			'list-panes': '%1\tclaude\t/repo/a\tworker\tzeta\n%3\tzsh\t/repo/b\tsidebar\tzeta',
		})
		expect(rmuxMuxAdapter.listPanes(exec)).toEqual([
			{ id: '%1', mux: 'rmux', cwd: '/repo/a', label: 'worker', floating: false },
			{ id: '%3', mux: 'rmux', cwd: '/repo/b', label: 'sidebar', floating: false },
		])
		expect(calls[0]).toEqual([
			'list-panes',
			'-a',
			'-F',
			'#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{host}',
		])
		// No `#{pane_floating_flag}` in the format at all — unlike tmux's, which carries it because
		// tmux CAN open a float. Asking rmux for a variable it has no meaning for would buy a column
		// that reads as `false` by accident rather than by construction.
		expect(calls[0]!.at(-1)).not.toContain('pane_floating_flag')
	})

	// Extra: listPanes()'s empty-report path has no dedicated scenario id in mux/lookup.
	it('listPanes() returns empty when rmux reports nothing', () => {
		expect(rmuxMuxAdapter.listPanes(() => null)).toEqual([])
	})

	// The rmux row of the outline: `#{pane_current_path}` already rides the one listing format string,
	// so a pane's directory costs no second query.
	it('lookup-listing-reports-cwd', () => {
		const exec = fakeExec([], { 'list-panes': '%1\tclaude\t/repo/a\tworker\tzeta' })
		expect(rmuxMuxAdapter.listPanes(exec)[0]?.cwd).toBe('/repo/a')
	})

	// The rmux half of the outline; the herdr row lives in mux.herdr.test.ts.
	it('lookup-listing-carries-label', () => {
		// A person named this pane `worker` — its title differs from the host, which is what makes it
		// a name someone chose rather than the one rmux handed it.
		const exec = fakeExec([], { 'list-panes': '%1\tclaude\t/repo/a\tworker\tzeta' })
		expect(rmuxMuxAdapter.listPanes(exec)).toEqual([
			{ id: '%1', mux: 'rmux', cwd: '/repo/a', label: 'worker', floating: false },
		])
	})

	// rmux has no unset title, exactly as tmux — it defaults `pane_title` to the hostname. Exporting
	// that would label EVERY untouched pane in the session `zeta`, and `zeta` would then resolve to
	// all of them.
	it('lookup-rmux-unnamed-no-label', () => {
		// Three panes nobody ever named: rmux reports the host as each one's title.
		const exec = fakeExec([], {
			'list-panes': '%1\tzsh\t/repo/a\tzeta\tzeta\n%2\tzsh\t/repo/b\tzeta\tzeta\n%3\tzsh\t/repo/c\tzeta\tzeta',
		})
		const panes = rmuxMuxAdapter.listPanes(exec)
		// That pane reports NO label — absent, not the hostname.
		for (const pane of panes) expect(pane.label).toBeUndefined()
		// So the hostname resolves to no pane, rather than colliding with every pane in the session.
		expect(panes.filter((p) => p.label === 'zeta')).toEqual([])
	})

	it('lookup-label-with-spaces-resolves', () => {
		// A label with a space, and a cwd with one too — the pair the old space-separated format could
		// not tell apart, and the reason this read is tab-separated.
		const exec = fakeExec([], { 'list-panes': '%1\tzsh\t/repo/my dir\tmy worker\tzeta' })
		const panes = rmuxMuxAdapter.listPanes(exec)
		// The label and the working directory are each read WHOLE — neither truncated at its space,
		// and neither bleeding into the other.
		expect(panes).toEqual([{ id: '%1', mux: 'rmux', cwd: '/repo/my dir', label: 'my worker', floating: false }])
		// And a caller naming `my worker` resolves that pane: the label matches in full, which is what
		// the CLI's resolver compares against.
		expect(panes.filter((p) => p.label === 'my worker').map((p) => p.id)).toEqual(['%1'])
	})

	it('lookup-listing-agent-status-absent-non-herdr', () => {
		// rmux carries no agent-state feed at all, so no pane ever reports agentStatus — absent, never a
		// false 'unknown'. The rmux row of the outline; the wezterm/zellij rows live in their own files.
		const exec = fakeExec([], {
			'list-panes': '%1\tclaude\t/repo/a\tworker\tzeta\n%3\tzsh\t/repo/b\tsidebar\tzeta',
		})
		const panes = rmuxMuxAdapter.listPanes(exec)
		for (const pane of panes) expect(pane.agentStatus).toBeUndefined()
	})

	// rmux has NO floating-pane concept at all, so every pane it reports really is tiled — `false` is
	// the TRUE answer here, by construction, not a stub standing in for one. This replaces tmux's
	// `lookup-listing-reports-floating` row (which pins the OPPOSITE fact — that a `new-pane` float
	// reads back as `1`): rmux has no such flag and no such pane to produce it, so there is no
	// floating-true case to assert on this backend.
	it('lookup-listing-reports-floating-false-by-construction', () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, {
			'list-panes': '%1\tclaude\t/repo/a\tworker\tzeta\n%3\tzsh\t/repo/b\tsidebar\tzeta',
		})
		expect(rmuxMuxAdapter.listPanes(exec)).toEqual([
			{ id: '%1', mux: 'rmux', cwd: '/repo/a', label: 'worker', floating: false },
			{ id: '%3', mux: 'rmux', cwd: '/repo/b', label: 'sidebar', floating: false },
		])
		// Still ONE call, and the format it sends carries no floating-flag variable at all.
		expect(calls).toEqual([
			['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{host}'],
		])
	})
})

describe('spec:cyber-mux/agent', () => {
	it('agent-lifecycle-absent-non-herdr', () => {
		// rmux has no native per-pane agent-state wait, so the optional capability is genuinely absent —
		// its absence IS the refusal deriveAgentWait turns into AgentLifecycleUnsupportedError.
		expect(rmuxMuxAdapter.agentLifecycle).toBeUndefined()
	})
})

/**
 * rmux inherits tmux's `wait-for` (synchronizes on a channel, not on printed text), and although it
 * also ships its own `wait-pane` extension outside the tmux-compatible surface, this adapter
 * deliberately does not reach for it — see the comment on `waitForOutput` in mux.rmux.ts. So the wait
 * is the shared poll over `capture-pane`, exactly as tmux's is. Pinned here: it goes through THIS
 * adapter's own read and reaches for no rmux verb that would only look like a wait. The cadence,
 * deadline and liveness rules are `pollForOutput`'s and are covered once, in `wait-output.test.ts`.
 */
describe('rmuxMuxAdapter — wait-output by polling', () => {
	it('polls capture-pane and matches what is already on screen', async () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'capture-pane': 'booting\nserver ready on :8080', 'has-session': '' })
		const result = await rmuxMuxAdapter.waitForOutput(exec, { id: '%9' }, { match: 'ready', timeoutMs: 1000 })
		expect(result.matched).toBe(true)
		expect(result.matchedLine).toBe('server ready on :8080')
		expect(calls).toEqual([
			['has-session', '-t', '%9'],
			['capture-pane', '-p', '-t', '%9'],
		])
	})

	it('scopes the searched snapshot through capture-pane’s own line flag', async () => {
		const calls: string[][] = []
		const exec = fakeExec(calls, { 'capture-pane': 'server ready', 'has-session': '' })
		await rmuxMuxAdapter.waitForOutput(exec, { id: '%9' }, { match: 'ready', timeoutMs: 1000, lines: 40 })
		expect(calls[1]).toEqual(['capture-pane', '-p', '-t', '%9', '-S', '-40'])
	})

	it('refuses a pane that is gone instead of waiting out the timeout', async () => {
		// No `has-session` and no pane in `list-panes` — the liveness probe answers gone.
		const exec = fakeExec([], { 'list-panes': '%1' })
		await expect(
			rmuxMuxAdapter.waitForOutput(exec, { id: '%9' }, { match: 'ready', timeoutMs: 60_000 }),
		).rejects.toThrow(/no longer exists/)
	})
})
describe('rmuxMuxAdapter — pane resize', () => {
	const resizePane = rmuxMuxAdapter.regions?.resizePane
	if (!resizePane) throw new Error('the rmux adapter must implement resizePane')

	// A live 0.10.0 capture of a 200x50 window: %0 full-height on the left, %1 over %2 on the right.
	// 120 + 79 = 199 rather than 200 because rmux eats a column for the divider exactly as tmux does —
	// the arithmetic has to put it back, which is why this fixture is not tidied.
	const RESIZE_OUT = [
		'%0\t0\t0\t120\t50\t/repo\tzeta\tzeta',
		'%1\t121\t0\t79\t35\t/repo\tzeta\tzeta',
		'%2\t121\t36\t79\t14\t/repo\tzeta\tzeta',
	].join('\n')

	it('resizePane() sizes the pane in CELLS on its own split’s axis, not in window percent', () => {
		const calls: string[][] = []
		resizePane(fakeExec(calls, { 'list-panes': RESIZE_OUT, 'resize-pane': '' }), { id: '%0' }, 0.6)
		// 0.6 of the 200-column region leaves the far side round(0.4 * 200) = 80 and the divider one
		// more, so the target keeps 119. `-x 60%` would have been 60% of the WINDOW — verified on a live
		// 0.10.0 to be 120 columns, a different pane.
		expect(calls[1]).toEqual(['resize-pane', '-t', '%0', '-x', '119'])
	})

	it('resizePane() uses -y on a stacked split, measured against that split’s region only', () => {
		const calls: string[][] = []
		resizePane(fakeExec(calls, { 'list-panes': RESIZE_OUT, 'resize-pane': '' }), { id: '%1' }, 0.7)
		expect(calls[1]).toEqual(['resize-pane', '-t', '%1', '-y', '34'])
	})

	it('resizePane() sizes the SECOND side directly, with no divider subtraction', () => {
		const calls: string[][] = []
		resizePane(fakeExec(calls, { 'list-panes': RESIZE_OUT, 'resize-pane': '' }), { id: '%2' }, 0.3)
		expect(calls[1]).toEqual(['resize-pane', '-t', '%2', '-y', '15'])
	})

	it('resizePane() is a no-op at the ratio describeRegion just reported', () => {
		const calls: string[][] = []
		resizePane(fakeExec(calls, { 'list-panes': RESIZE_OUT, 'resize-pane': '' }), { id: '%0' }, 0.605)
		expect(calls[1]).toEqual(['resize-pane', '-t', '%0', '-x', '120'])
	})

	it('resizePane() refuses a ratio outside (0, 1) rather than rendering a broken size', () => {
		const exec = fakeExec([], { 'list-panes': RESIZE_OUT, 'resize-pane': '' })
		expect(() => resizePane(exec, { id: '%0' }, 0)).toThrow(/ratio must be strictly between 0 and 1/)
	})

	it('resizePane() throws on a lone pane — there is no split to take a fraction of', () => {
		const exec = fakeExec([], { 'list-panes': '%0\t0\t0\t200\t50\t/repo\tzeta\tzeta' })
		expect(() => resizePane(exec, { id: '%0' }, 0.6)).toThrow(/is the only pane in its region/)
	})

	it('resizePane() throws when rmux’s own resize fails', () => {
		const exec = fakeExec([], { 'list-panes': RESIZE_OUT })
		expect(() => resizePane(exec, { id: '%0' }, 0.6)).toThrow(/rmux could not resize pane %0/)
	})
})
