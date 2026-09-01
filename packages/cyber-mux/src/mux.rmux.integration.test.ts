import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { FloatingPanesUnsupportedError } from './floating.ts'
import { RMUX_TAB_NAME_OPTION, RMUX_WORKSPACE_GROUP_OPTION, rmuxMuxAdapter } from './mux.rmux.ts'

function hasRmux(): boolean {
	try {
		execFileSync('rmux', ['-V'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

async function pollUntil(read: () => string, done: (out: string) => boolean, timeoutMs = 5000): Promise<string> {
	const start = Date.now()
	let out = read()
	while (!done(out) && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 50))
		out = read()
	}
	return out
}

// A throwaway, isolated rmux daemon on its own socket (`-L`) — never the ambient session this
// process (or this very test runner) might itself be running inside. `kill-server` in `afterAll`
// takes the daemon down with it; a leaked daemon would outlive the run and hold the socket.
const SOCKET = `cyber-mux-itest-${process.pid}`

/**
 * The rmux adapter against the real `rmux` binary — the only place its claims can actually be
 * falsified.
 *
 * Every row here is a claim a mocked `Exec` cannot reach: whether rmux really implements tmux's
 * `-P -F` print-format, whether `-S -N` is a history OFFSET that clamps at the top rather than
 * failing, whether the `@`-prefixed user option really filters server-side, and — the load-bearing
 * one for this backend — whether the `#{...}` format vocabulary the adapter sends actually expands.
 * The unit suite (`mux.rmux.test.ts`) pins the argv; these rows pin what rmux does with it.
 *
 * Written against **rmux 0.10.0**. The suite skips itself outright when no `rmux` is on PATH, which
 * is an honest report rather than a pass — see issue #125 for why a silent skip reading as green is
 * a hazard worth naming.
 */
describe.skipIf(!hasRmux())('spec:cyber-mux/mux', () => {
	describe('rmuxMuxAdapter — real rmux boundary', () => {
		let cwd: string
		let exec: Exec

		beforeAll(() => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-itest-'))
			execFileSync('rmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'main', '-c', cwd, '-x', '80', '-y', '24'])
			// `-x 80 -y 24` is not decoration: a detached rmux session has no client to take its size
			// from, and the region rows below assert against an 80-column window. Pinning the geometry
			// here is what keeps those rows about the DIVIDER rule rather than about the default size.
			//
			// Reproduce the `$RMUX` env var a real caller running inside this session would carry, so the
			// adapter's target-less commands resolve "current" correctly. rmux exports the same
			// `<socket>,<pid>,<session>` triple tmux does, under both `$RMUX` and `$TMUX`.
			const [socketPath, pid, sessionId] = execFileSync(
				'rmux',
				['-L', SOCKET, 'display-message', '-p', '-t', 'main', '#{socket_path},#{pid},#{session_id}'],
				{ encoding: 'utf8' },
			)
				.trim()
				.split(',')
			const triple = `${socketPath},${pid},${sessionId?.replace(/^\$/, '')}`
			const env = { ...process.env, RMUX: triple, TMUX: triple }
			exec = (cmd, args) => {
				try {
					const fullArgs = cmd === 'rmux' ? ['-L', SOCKET, ...args] : args
					return execFileSync(cmd, fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim()
				} catch {
					return null
				}
			}
		})

		afterAll(() => {
			try {
				execFileSync('rmux', ['-L', SOCKET, 'kill-server'])
			} catch {
				// already gone
			}
			rmSync(cwd, { recursive: true, force: true })
		})

		it('open() actually creates a real pane the real rmux binary reports back', () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right' })
			// The `%N` shape is rmux's own, not a cyber-mux normalization — this is the gate the whole
			// backend rests on, so it is asserted against the binary rather than assumed from the docs.
			expect(target.id).toMatch(/^%\d+$/)
			// Both ids come from ONE `split-window -P -F` call, which is the claim `-P -F` support buys.
			expect(target.tab).toMatch(/^@\d+$/)
			expect(rmuxMuxAdapter.paneExists(exec, target)).toBe(true)
			rmuxMuxAdapter.teardown(exec, target)
		})

		// The declaration's own claim, driven rather than argued: after an open at every placement the
		// session is still on the pane it started on. `-d` is a claim about what RMUX does with a flag,
		// which no mocked `Exec` can answer — the unit rows can only prove the flag was spelled.
		//
		// `#{pane_active}` off `list-panes` rather than `display-message -p '#{pane_id}'`: this session
		// is detached by construction (see the harness above), so there is no attached client whose
		// focus could be read. The active pane is the same fact one layer down, and it is the one a
		// client would land on.
		it.each([
			'tab',
			'workspace',
			'pane:right',
			'pane:down',
		] as const)('open({ at: %s }) does not move the active pane — backing opensWithoutStealingFocus', (at) => {
			const before = exec('rmux', ['display-message', '-p', '-t', 'main', '#{pane_id}'])
			expect(before).toMatch(/^%\d+$/)
			const opened = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at })
			expect(opened.id).not.toBe(before)
			expect(exec('rmux', ['display-message', '-p', '-t', 'main', '#{pane_id}'])).toBe(before)
			rmuxMuxAdapter.teardown(exec, opened)
		})

		it('listPanes() sees the real pane, cwd and all', () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const panes = rmuxMuxAdapter.listPanes(exec)
			expect(panes.some((p) => p.id === target.id && p.cwd === cwd)).toBe(true)
			// `floating: false` BY CONSTRUCTION, and this is the row that shows it is not an artifact of
			// parsing an empty column: the adapter's format asks for no floating variable at all, and
			// every pane rmux can report is genuinely tiled.
			expect(panes.every((p) => p.floating === false)).toBe(true)
			rmuxMuxAdapter.teardown(exec, target)
		})

		// The float REFUSAL against the real binary. The unit suite proves the adapter throws without
		// shelling out; this row proves the premise that makes throwing right — that rmux genuinely has
		// no `new-pane`. If a later rmux added one, this row is what would notice, and the refusal would
		// become a lie rather than a limitation.
		it('refuses a float by name — and rmux really has no new-pane to open one with', () => {
			expect(() => rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float' })).toThrow(
				FloatingPanesUnsupportedError,
			)
			// The binary's own answer, not the adapter's. `exec` returns null on a failed command, so a
			// `new-pane` that started working would come back non-null and fail here.
			expect(exec('rmux', ['new-pane', '-t', 'main'])).toBeNull()
			// And it is absent from the command table, not merely refused for this target.
			expect(exec('rmux', ['list-commands'])).not.toContain('new-pane')
		})

		it('teardown() actually kills the real pane', () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(rmuxMuxAdapter.paneExists(exec, target)).toBe(true)
			rmuxMuxAdapter.teardown(exec, target)
			expect(rmuxMuxAdapter.paneExists(exec, target)).toBe(false)
		})

		it('submit()/read() actually run a command in and capture from a real pane', async () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			// submit, not sendText: the marker has to RUN, which needs the Enter submit supplies.
			rmuxMuxAdapter.submit(exec, target, 'echo cyber-mux-itest-marker')
			const output = await pollUntil(
				() => rmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('cyber-mux-itest-marker'),
			)
			expect(output).toContain('cyber-mux-itest-marker')
			rmuxMuxAdapter.teardown(exec, target)
		})

		// `env` and `cwd` at BIRTH, read back out of the pane itself rather than off the create command.
		// This is what "native env, no `envFallback` compensation" means operationally: the variable is
		// in the pane's own environment, so anything the pane later runs sees it — which a command
		// prefix on the launch line would not deliver.
		it('open({ env, cwd }) really sets both in the born pane, natively', async () => {
			const target = rmuxMuxAdapter.open(exec, {
				cwd: '/etc',
				launch: 'sh',
				at: 'tab',
				env: { CYBER_MUX_ITEST: 'native-env-ok' },
			})
			rmuxMuxAdapter.submit(exec, target, 'echo "V=$CYBER_MUX_ITEST D=$PWD"')
			const out = await pollUntil(
				() => rmuxMuxAdapter.read(exec, target).text,
				(text) => text.includes('V=native-env-ok'),
			)
			expect(out).toContain('V=native-env-ok')
			expect(out).toContain('D=/etc')
			rmuxMuxAdapter.teardown(exec, target)
		})

		// The `-l` SIGN CONVENTION against the real binary — the single most likely thing to be silently
		// backwards, and the one a mocked Exec can only prove we spelled. `ratio` is the fraction kept by
		// the ORIGINAL pane, so 0.75 must leave the original the WIDE one. Asserted as an inequality
		// plus a rounded fraction rather than an exact cell count: the divider column and rmux's own
		// rounding are not this row's subject.
		it('a ratio sizes the ORIGINAL pane, not the new one', () => {
			const root = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: root, ratio: 0.75 })
			const panes = rmuxMuxAdapter.regions!.describeRegion(exec, root)
			const original = panes.find((p) => p.id === root.id)
			const created = panes.find((p) => p.id === split.id)
			expect(original).toBeDefined()
			expect(created).toBeDefined()
			expect(original!.rect.width).toBeGreaterThan(created!.rect.width)
			// Roughly three quarters of the two panes' combined width — the caller's 0.75, surviving the
			// `1 - ratio` inversion the adapter applies on the way in.
			const total = original!.rect.width + created!.rect.width
			expect(original!.rect.width / total).toBeGreaterThan(0.6)
			rmuxMuxAdapter.teardown(exec, split)
			rmuxMuxAdapter.teardown(exec, root)
		})

		// The region read against the real binary: window-relative origins, and widths that EXCLUDE the
		// divider column rmux draws between panes. Both are what `RegionPane.rect` documents and what a
		// captured template stores, so a backend that included the divider would silently shift every
		// rect a user commits. Only a live binary can tell the two apart.
		it('describeRegion() reports window-relative rects with the divider excluded', () => {
			const root = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: root })
			const panes = rmuxMuxAdapter.regions!.describeRegion(exec, root)
			expect(panes).toHaveLength(2)
			// The left pane starts at the window's own origin — relative to the WINDOW, not the screen.
			const left = panes.find((p) => p.id === root.id)!
			const right = panes.find((p) => p.id === split.id)!
			expect(left.rect.x).toBe(0)
			expect(left.rect.y).toBe(0)
			expect(right.rect.x).toBeGreaterThan(0)
			// The divider: the two widths sum to ONE LESS than the window, never to the window itself.
			const windowWidth = Number(exec('rmux', ['display-message', '-p', '-t', root.id, '#{window_width}']))
			expect(windowWidth).toBe(80)
			expect(left.rect.width + right.rect.width).toBe(windowWidth - 1)
			// And the cwd rides the same tab-separated format, per pane.
			expect(left.cwd).toBe(cwd)
			rmuxMuxAdapter.teardown(exec, split)
			rmuxMuxAdapter.teardown(exec, root)
		})

		// The `@`-user-option grouping, INCLUDING the server-side filter — the half a docs read cannot
		// settle, and the mechanism `describeWorkspace` is entirely built on. Two windows are grouped and
		// a third is deliberately left out, because a filter that returned everything would pass a
		// one-window test.
		it('group()/describeWorkspace() really tag and filter windows server-side', () => {
			const first = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab', workspaceGroup: 'itest-grp' })
			const second = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab', workspaceGroup: 'itest-grp' })
			const outsider = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab', workspaceGroup: 'itest-other' })
			const tabs = rmuxMuxAdapter.regions!.describeWorkspace(exec, first)
			expect(tabs.map((t) => t.id).sort()).toEqual([first.tab, second.tab].sort())
			expect(tabs.map((t) => t.id)).not.toContain(outsider.tab)
			// The tag really is stored where the adapter says it is, and rmux reads it back through the
			// same `#{@cm_ws}` format the filter keys on.
			expect(exec('rmux', ['show-options', '-w', '-t', first.tab, '-v', RMUX_WORKSPACE_GROUP_OPTION])).toBe('itest-grp')
			// Every tab carries its region, which is what makes a workspace read a capture rather than a
			// listing.
			expect(tabs.every((t) => t.panes.length >= 1)).toBe(true)
			for (const t of [first, second, outsider]) rmuxMuxAdapter.teardown(exec, t)
		})

		// The tab's OWN name stored beside the group id, and the read preferring it over the display
		// name. The whole reason `RMUX_TAB_NAME_OPTION` exists is that rmux inherits tmux's single
		// `window_name` field, so this pins that the option survives a rename of the display name.
		it("group(name) stores a tab's own name, and the workspace read prefers it to the display name", () => {
			const tab = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab', label: 'pool - editor' })
			rmuxMuxAdapter.group(exec, { id: tab.tab }, 'itest-named', 'editor')
			expect(exec('rmux', ['show-options', '-w', '-t', tab.tab, '-v', RMUX_TAB_NAME_OPTION])).toBe('editor')
			const tabs = rmuxMuxAdapter.regions!.describeWorkspace(exec, tab)
			expect(tabs.find((t) => t.id === tab.tab)?.label).toBe('editor')
			rmuxMuxAdapter.teardown(exec, tab)
		})

		// `rename` at both tiers against the binary, and the read-only claim with it: `select-pane -T`
		// is a title write that moves no focus, despite the verb. The focus half is what a mocked Exec
		// cannot see at all.
		it('rename() names a window and a pane — and naming a pane moves no focus', () => {
			const root = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const sibling = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: root })
			rmuxMuxAdapter.rename(exec, { id: root.tab }, 'tab', 'itest-window')
			expect(exec('rmux', ['display-message', '-p', '-t', root.tab, '#{window_name}'])).toBe('itest-window')
			// Whichever pane is active in that window before the title write must still be active after.
			const activeBefore = exec('rmux', ['display-message', '-p', '-t', root.tab, '#{pane_id}'])
			rmuxMuxAdapter.rename(exec, root, 'pane', 'itest pane')
			expect(exec('rmux', ['display-message', '-p', '-t', root.tab, '#{pane_id}'])).toBe(activeBefore)
			// The title is the pane's LABEL on the way back out — and `paneLabel`'s host rule did not eat
			// it, because it differs from the hostname.
			const listed = rmuxMuxAdapter.listPanes(exec).find((p) => p.id === root.id)
			expect(listed?.label).toBe('itest pane')
			rmuxMuxAdapter.teardown(exec, sibling)
			rmuxMuxAdapter.teardown(exec, root)
		})

		// `pane_title` defaults to the HOSTNAME on rmux exactly as on tmux, which is the entire reason
		// `paneLabel` compares the two. Only a live binary can show that the default is the host rather
		// than empty — and if it were empty, the comparison would be dead code hiding a simpler rule.
		it('a pane nobody named reports no label, because rmux defaults its title to the host', () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const raw = exec('rmux', ['display-message', '-p', '-t', target.id, '#{pane_title}\t#{host}'])
			const [title, host] = (raw ?? '').split('\t')
			expect(title).toBe(host)
			expect(rmuxMuxAdapter.listPanes(exec).find((p) => p.id === target.id)?.label).toBeUndefined()
			rmuxMuxAdapter.teardown(exec, target)
		})

		// `sendKeys` at the real boundary, and the ONE key whose rmux spelling differs. `BSpace` must
		// actually erase a character while `Backspace` — the seam's core vocabulary spelling — would be
		// TYPED verbatim by rmux's unrecognized-token fallback. The rename table is the whole content of
		// the claim, and it is only observable against a binary that presses keys.
		it('sendKeys(["Backspace"]) presses the key rather than typing the word', async () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			rmuxMuxAdapter.sendText(exec, target, 'echo itest-bspaceX')
			rmuxMuxAdapter.sendKeys(exec, target, ['Backspace'])
			rmuxMuxAdapter.submit(exec, target)
			const out = await pollUntil(
				() => rmuxMuxAdapter.read(exec, target).text,
				(text) => text.includes('itest-bspace') && !text.trimEnd().endsWith('itest-bspaceX'),
			)
			// The `X` was erased, so the command that ran echoed the trimmed word...
			expect(out).toContain('itest-bspace')
			// ...and the literal word `Backspace` never reached the shell, which is what an unmapped key
			// name would have produced.
			expect(out).not.toContain('Backspace')
			rmuxMuxAdapter.teardown(exec, target)
		})

		// The truncation rule against the REAL binary — the one claim that cannot be proven with a
		// mocked Exec, since it rests on what rmux itself does with `-S -(N+1)`: clamping a start line
		// past the top of the history rather than failing, and returning the older rows when they exist.
		it('read({ truncation }) tells a window that dropped rows from one that reached the top', async () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			// Enough rows to overflow the pane's 24-row viewport and push real content into the scrollback —
			// without that, nothing has been omitted from ANY window and `false` is the right answer.
			rmuxMuxAdapter.submit(exec, target, 'i=1; while [ $i -le 60 ]; do echo row-$i; i=$((i+1)); done')
			await pollUntil(
				() => rmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('row-60'),
			)
			// A window that starts 3 rows into the history leaves the rest of that history behind.
			const scoped = rmuxMuxAdapter.read(exec, target, { lines: 3, truncation: true })
			expect(scoped.truncated).toBe(true)
			// The same pane read with a window wider than everything it holds reaches the top of the
			// history, so nothing was omitted — the answer is `false`, not "I did not check". This is
			// also the clamping claim: `-S -10001` did not fail.
			const whole = rmuxMuxAdapter.read(exec, target, { lines: 10_000, truncation: true })
			expect(whole.truncated).toBe(false)
			expect(whole.text).toContain('row-1')
			// Unasked stays unanswered, on the real binary too.
			expect(rmuxMuxAdapter.read(exec, target, { lines: 3 }).truncated).toBeUndefined()
			rmuxMuxAdapter.teardown(exec, target)
		})

		// The unbounded window against the real binary — `-S -` is the escape hatch a truncated capture
		// points at, so it has to actually reach past the viewport that dropped those rows.
		it("read({ lines: 'all' }) captures the whole history a bounded window left behind", async () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			rmuxMuxAdapter.submit(exec, target, 'i=1; while [ $i -le 60 ]; do echo row-$i; i=$((i+1)); done')
			await pollUntil(
				() => rmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('row-60'),
			)
			// The default window is the 24-row viewport: row-1 scrolled off it long ago.
			const viewport = rmuxMuxAdapter.read(exec, target, { truncation: true })
			expect(viewport.truncated).toBe(true)
			expect(viewport.text).not.toContain('row-1\n')
			// `-S -` reaches the start of the history and brings those rows back — and reports itself
			// complete without spending a probe on it.
			const whole = rmuxMuxAdapter.read(exec, target, { lines: 'all', truncation: true })
			expect(whole.text).toContain('row-1\n')
			expect(whole.truncated).toBe(false)
			rmuxMuxAdapter.teardown(exec, target)
		})

		// `waitForOutput` end to end. rmux ships its own `wait-pane` extension, which this adapter
		// deliberately does NOT use — so this row is what shows the shared `capture-pane` poll is
		// sufficient on this backend rather than merely available.
		it('waitForOutput() resolves on text a real pane actually printed', async () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			rmuxMuxAdapter.submit(exec, target, 'echo itest-wait-marker')
			const result = await rmuxMuxAdapter.waitForOutput(exec, target, {
				match: 'itest-wait-marker',
				timeoutMs: 10_000,
			})
			expect(result.matched).toBe(true)
			rmuxMuxAdapter.teardown(exec, target)
		})

		// `isPaneFocused` on a DETACHED server. The suite runs with no client attached, so
		// `#{session_attached}` is `0` and the honest answer is `false` for every pane — never
		// `undefined`, which is reserved for a pane that could not be resolved at all. The distinction
		// is the whole contract of the member, and only a real listing can show which branch was taken.
		it('isPaneFocused() answers false with no client attached, and undefined for a pane that is gone', () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(rmuxMuxAdapter.isPaneFocused(exec, target)).toBe(false)
			rmuxMuxAdapter.teardown(exec, target)
			// Gone, so it resolves to no line at all — unknown, not a confident `false`.
			expect(rmuxMuxAdapter.isPaneFocused(exec, target)).toBeUndefined()
		})

		// `focus` refuses a pane it cannot resolve rather than issuing a partial beam. The success path
		// is NOT covered here: `switch-client` needs an attached client, and this suite runs detached on
		// purpose (attaching would need a pty and would put the runner inside the session it drives).
		// Recorded so the gap is visible rather than implied — the three verbs' success path was probed
		// by hand against an attached pty client on rmux 0.10.0 and is written up in `mux.rmux.ts`, but
		// it is NOT pinned by this suite.
		it('focus() throws on a pane that no longer resolves, instead of a false-success beam', () => {
			const target = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			rmuxMuxAdapter.teardown(exec, target)
			expect(() => rmuxMuxAdapter.focus(exec, target)).toThrow(/could not be resolved/)
		})
		/**
		 * The round trip the seam's `ratio` promises, against the real binary. This is where the sign
		 * convention is pinned: `split-window -l` sizes the NEW pane and `resize-pane -x` sizes the
		 * TARGET, so an adapter that inverted one of them would pass every mocked row and silently size
		 * the wrong pane here. Run against rmux rather than inherited from the tmux suite — the two
		 * adapters are copies on purpose, and a copy's verification claim has to be its own.
		 */
		it('resizePane() moves the real divider to the ratio asked for, and reads back at that ratio', () => {
			const regions = rmuxMuxAdapter.regions
			if (!regions) throw new Error('the rmux adapter must implement regions')
			const opened = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })

			regions.resizePane(exec, opened, 0.7)
			const after = regions.describeRegion(exec, opened)
			const kept = after.find((p) => p.id === opened.id)!
			const taken = after.find((p) => p.id === split.id)!
			// The seam's own definition of what the region reads back at: 1 - second / total, the divider
			// included in the total.
			const total = kept.rect.width + taken.rect.width + 1
			// Within ONE CELL, derived from the region rather than a constant: a cell-based backend can
			// only land on k/total, and this session is 80 columns wide by harness choice — a fixed
			// tolerance would encode that width and break at the next one.
			expect(Math.abs(1 - taken.rect.width / total - 0.7)).toBeLessThanOrEqual(1 / total)
			// And the ORIGINAL pane is the one that grew — the half a wrong sign convention gets backwards.
			expect(kept.rect.width).toBeGreaterThan(taken.rect.width)
		})

		it('resizePane() on the NEW pane sizes that pane, not the one it was split from', () => {
			const regions = rmuxMuxAdapter.regions
			if (!regions) throw new Error('the rmux adapter must implement regions')
			const opened = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })

			regions.resizePane(exec, split, 0.75)
			const after = regions.describeRegion(exec, opened)
			expect(after.find((p) => p.id === split.id)!.rect.width).toBeGreaterThan(
				after.find((p) => p.id === opened.id)!.rect.width,
			)
		})

		it('resizePane() throws on a region rmux reports as a single pane', () => {
			const regions = rmuxMuxAdapter.regions
			if (!regions) throw new Error('the rmux adapter must implement regions')
			const opened = rmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(() => regions.resizePane(exec, opened, 0.6)).toThrow(/is the only pane in its region/)
		})
	})
})
