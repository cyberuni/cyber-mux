import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'

function hasTmux(): boolean {
	try {
		execFileSync('tmux', ['-V'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * Whether the tmux on PATH is new enough to HAVE a floating pane — `new-pane` landed in 3.7, and on
 * anything older it is simply not a command.
 *
 * A second gate on top of `hasTmux()`, because the two questions are genuinely different and the
 * harness only guarantees the first. A float test that assumed 3.7 on an older binary would fail the
 * job while proving nothing about the adapter — `canFloatPanes` is declared unconditionally BY DESIGN
 * (see the `mux.tmux.ts` header) and an older tmux refusing `new-pane` with its own `unknown command`
 * is that contract working, not breaking. So the float rows SKIP below 3.7 rather than fail.
 *
 * The gate is kept even though CI is no longer one of the places it fires: `pull-request.yml` used to
 * install tmux with `apt-get install -y tmux` (Ubuntu's 3.4), which skipped every float row and so
 * covered nothing; it now builds a pinned 3.7c from source, and the step verifies `tmux -V` rather
 * than trusting the build. What the gate still protects is the contributor whose distro tmux is
 * older — for them a skip is the honest report, not a failure.
 *
 * Parsed off the leading `<major>.<minor>`, which covers every spelling tmux ships: `3.4`, `3.7c`
 * (the letter is a patch suffix, never a version bump) and `next-3.8`.
 */
function tmuxHasFloatingPanes(): boolean {
	try {
		const version = execFileSync('tmux', ['-V'], { encoding: 'utf8' })
		const parts = /(\d+)\.(\d+)/.exec(version)
		if (!parts) return false
		const major = Number(parts[1])
		const minor = Number(parts[2])
		return major > 3 || (major === 3 && minor >= 7)
	} catch {
		return false
	}
}

async function pollUntil(read: () => string, done: (out: string) => boolean, timeoutMs = 2000): Promise<string> {
	const start = Date.now()
	let out = read()
	while (!done(out) && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 50))
		out = read()
	}
	return out
}

// A throwaway, isolated tmux server on its own socket (`-L`) — never the ambient session this
// process (or this very test runner) might itself be running inside.
const SOCKET = `cyber-mux-itest-${process.pid}`

describe.skipIf(!hasTmux())('spec:cyber-mux/mux', () => {
	describe('tmuxMuxAdapter — real tmux boundary', () => {
		let cwd: string
		let exec: Exec

		beforeAll(() => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-itest-'))
			execFileSync('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'main', '-c', cwd])
			// Reproduce the $TMUX env var a real caller running inside this session would carry, so the
			// adapter's target-less commands (split-window, new-window, …) resolve "current" correctly.
			const [socketPath, pid, sessionId] = execFileSync(
				'tmux',
				['-L', SOCKET, 'display-message', '-p', '-t', 'main', '#{socket_path},#{pid},#{session_id}'],
				{ encoding: 'utf8' },
			)
				.trim()
				.split(',')
			const env = { ...process.env, TMUX: `${socketPath},${pid},${sessionId?.replace(/^\$/, '')}` }
			exec = (cmd, args) => {
				try {
					const fullArgs = cmd === 'tmux' ? ['-L', SOCKET, ...args] : args
					return execFileSync(cmd, fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim()
				} catch {
					return null
				}
			}
		})

		afterAll(() => {
			try {
				execFileSync('tmux', ['-L', SOCKET, 'kill-server'])
			} catch {
				// already gone
			}
			rmSync(cwd, { recursive: true, force: true })
		})

		it('open() actually creates a real pane the real tmux binary reports back', () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right' })
			expect(target.id).toMatch(/^%\d+$/)
			expect(tmuxMuxAdapter.paneExists(exec, target)).toBe(true)
		})

		it('listPanes() sees the real pane, cwd and all', () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const panes = tmuxMuxAdapter.listPanes(exec)
			expect(panes.some((p) => p.id === target.id && p.cwd === cwd)).toBe(true)
		})

		// The READ side of `pane:float`, at the boundary that owns the answer: `#{pane_floating_flag}` is
		// a tmux format variable, so a mocked exec only ever proves we can parse our own fixture. Live on
		// 3.7c it reports `1` for a `new-pane` float and `0` for a tiled pane. Opened both ways in one
		// test on purpose — a suite that only ever saw a float could pass on an adapter hardcoding
		// `true`. The CREATE path is pinned by the rows below.
		it.skipIf(!tmuxHasFloatingPanes())('listPanes() tells a real float from a real tiled pane', () => {
			// A window of its own, so the pair is not competing for room with whatever earlier tests left
			// behind, and the float is anchored on the tiled pane rather than on the ambient active one.
			const tiled = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled })
			const panes = tmuxMuxAdapter.listPanes(exec)
			expect(panes.find((p) => p.id === float.id)?.floating).toBe(true)
			expect(panes.find((p) => p.id === tiled.id)?.floating).toBe(false)
			// `list-panes -a` really does enumerate the float alongside the tiled panes — the field would
			// be unreachable if it did not.
			expect(panes.map((p) => p.id)).toEqual(expect.arrayContaining([float.id, tiled.id]))
			tmuxMuxAdapter.teardown(exec, float)
			tmuxMuxAdapter.teardown(exec, tiled)
		})

		// The CREATE side of `pane:float`. Everything below it was written from tmux's CHANGES file
		// against a 3.6b binary that has no `new-pane` at all, so until 3.7 was installable the whole
		// branch rested on a document. These rows are what pays for it.

		it.skipIf(!tmuxHasFloatingPanes())('open({ at: pane:float }) creates a real float the binary reports back', () => {
			const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float' })
			expect(float.id).toMatch(/^%\d+$/)
			// The pane and the window it landed in come back from ONE `new-pane -P -F` — the same format
			// the split path sends, so the float owes no second lookup for its tab.
			expect(float.tab).toMatch(/^@\d+$/)
			expect(tmuxMuxAdapter.paneExists(exec, float)).toBe(true)
			// `teardown` needs no float-specific spelling: `kill-pane` kills a float exactly as it kills a
			// tiled pane.
			tmuxMuxAdapter.teardown(exec, float)
			expect(tmuxMuxAdapter.paneExists(exec, float)).toBe(false)
		})

		// The anchor claim, at the boundary that can actually falsify it: with a mocked Exec `-t %3` only
		// proves we spelled a flag. Live, it decides WHICH WINDOW the float lands in — and the harness is
		// arranged so the two candidate answers differ. Every `at: 'tab'` open above uses `new-window -d`,
		// so the attached client is still looking at the session's first window; the float is anchored on
		// a pane in a different one. Without `-t` tmux resolves the ACTIVE pane's window, which is the
		// user's and only coincidentally the caller's.
		it.skipIf(!tmuxHasFloatingPanes())('a float is anchored into the TARGET pane’s window, not the active one', () => {
			const tiled = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const activeWindow = exec('tmux', ['display-message', '-p', '#{window_id}'])
			// The premise the assertion rests on: the anchor is somewhere the client is NOT looking.
			expect(tiled.tab).not.toBe(activeWindow)
			const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled })
			expect(float.tab).toBe(tiled.tab)
			expect(float.tab).not.toBe(activeWindow)
			tmuxMuxAdapter.teardown(exec, float)
			tmuxMuxAdapter.teardown(exec, tiled)
		})

		// `ratio` is dropped on a float — the observable half of the claim, and it is deliberately paired
		// with the argv-level row in `floating.test.ts` rather than replacing it. What this row can see is
		// that a float asked for a ratio comes out the SIZE of one that asked for nothing, and that the
		// size is `new-pane`'s documented default: half the window's width by a quarter its height.
		//
		// What it CANNOT see is a regression that starts passing `-l`, because `new-pane` accepts `-l`
		// and `-p` and ignores them (see the `mux.tmux.ts` float branch) — a float built with `-l 30%`
		// measures the same as this one. That is exactly why the "no sizing flag is emitted" claim is
		// pinned on the argv and this row is pinned on the geometry: neither check subsumes the other.
		it.skipIf(!tmuxHasFloatingPanes())('a float takes tmux’s own default size, whatever ratio was asked for', () => {
			const tiled = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const size = (pane: { id: string }) =>
				exec('tmux', ['display-message', '-p', '-t', pane.id, '#{pane_width}x#{pane_height}'])
			const plain = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled })
			const asked = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float', from: tiled, ratio: 0.3 })
			expect(size(asked)).toBe(size(plain))
			const [width, height] = (
				exec('tmux', ['display-message', '-p', '-t', tiled.id, '#{window_width}\t#{window_height}']) ?? ''
			)
				.split('\t')
				.map(Number)
			expect(size(plain)).toBe(`${Math.floor(width! / 2)}x${Math.floor(height! / 4)}`)
			tmuxMuxAdapter.teardown(exec, asked)
			tmuxMuxAdapter.teardown(exec, plain)
			tmuxMuxAdapter.teardown(exec, tiled)
		})

		// This row replaces one that pinned the opposite property, and the swap is the point. A float used
		// to become the ACTIVE pane of its window, and tmux refuses to split a float ("size or position
		// can't split a floating pane") — so a target-less split right after one FAILED, which was
		// recorded here as the behavior we wanted. `new-pane -d` removes the activation, so it no longer
		// fails; what it does instead is what this row now pins, at the boundary that decides it.
		//
		// The float is opened with no `from` ON PURPOSE, exactly as before: that is what puts it in the
		// window the client is attached to, the only arrangement where a target-less split could resolve
		// to it at all. The assertion is that it does not — the client is still on the pane it was on,
		// and the split that follows lands there, which is the backend default the seam documents rather
		// than a pane an open dragged the user onto. A loud failure was only ever the better of two wrong
		// answers.
		it.skipIf(!tmuxHasFloatingPanes())('a float leaves the client where it was, and a later split lands there', () => {
			const before = exec('tmux', ['display-message', '-p', '#{pane_id}'])
			const float = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:float' })
			// The float exists and is a real float — this is not passing because nothing was created.
			expect(tmuxMuxAdapter.paneExists(exec, float)).toBe(true)
			expect(exec('tmux', ['display-message', '-p', '#{pane_id}'])).toBe(before)
			expect(exec('tmux', ['display-message', '-p', '#{pane_id}'])).not.toBe(float.id)
			// It resolves to the pane the client was on, so it neither throws nor lands on the float.
			const split = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right' })
			expect(exec('tmux', ['display-message', '-p', '#{pane_id}'])).toBe(before)
			tmuxMuxAdapter.teardown(exec, split)
			tmuxMuxAdapter.teardown(exec, float)
		})

		// The declaration's own claim, driven rather than argued: after an open at every placement the
		// attached client is on the pane it started on. This is the row that would have caught the hole
		// the `-d`-less `split-window` left, and it is a real-binary row because `-d` is a claim about
		// what TMUX does with a flag, which no mocked `Exec` can answer.
		it.each([
			'tab',
			'workspace',
			'pane:right',
			'pane:down',
		] as const)('open({ at: %s }) does not move the attached client — backing focusOnOpen: preserved', (at) => {
			const before = exec('tmux', ['display-message', '-p', '#{pane_id}'])
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at })
			expect(opened.id).not.toBe(before)
			expect(exec('tmux', ['display-message', '-p', '#{pane_id}'])).toBe(before)
			tmuxMuxAdapter.teardown(exec, opened)
		})

		it('teardown() actually kills the real pane', () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(tmuxMuxAdapter.paneExists(exec, target)).toBe(true)
			tmuxMuxAdapter.teardown(exec, target)
			expect(tmuxMuxAdapter.paneExists(exec, target)).toBe(false)
		})

		it('submit()/read() actually run a command in and capture from a real pane', async () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			// submit, not sendText: the marker has to RUN, which needs the Enter submit supplies.
			tmuxMuxAdapter.submit(exec, target, 'echo cyber-mux-itest-marker')
			const output = await pollUntil(
				() => tmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('cyber-mux-itest-marker'),
			)
			expect(output).toContain('cyber-mux-itest-marker')
		})

		// The truncation rule against the REAL binary — the one claim that cannot be proven with a mocked
		// Exec, since it rests on what tmux itself does with `-S -(N+1)` (clamping at the top of the
		// history rather than failing, and returning the older rows when they exist).
		it('read({ truncation }) tells a window that dropped rows from one that reached the top', async () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			// Enough rows to overflow the pane's 24-row viewport and push real content into the scrollback —
			// without that, nothing has been omitted from ANY window and `false` is the right answer.
			tmuxMuxAdapter.submit(exec, target, 'i=1; while [ $i -le 60 ]; do echo row-$i; i=$((i+1)); done')
			await pollUntil(
				() => tmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('row-60'),
			)
			// A window that starts 3 rows into the history leaves the rest of that history behind.
			const scoped = tmuxMuxAdapter.read(exec, target, { lines: 3, truncation: true })
			expect(scoped.truncated).toBe(true)
			// The same pane read with a window wider than everything it holds reaches the top of the
			// history, so nothing was omitted — the answer is `false`, not "I did not check".
			const whole = tmuxMuxAdapter.read(exec, target, { lines: 10_000, truncation: true })
			expect(whole.truncated).toBe(false)
			expect(whole.text).toContain('row-1')
			// Unasked stays unanswered, on the real binary too.
			expect(tmuxMuxAdapter.read(exec, target, { lines: 3 }).truncated).toBeUndefined()
		})

		// The unbounded window against the real binary — `-S -` is the escape hatch a truncated capture
		// points at, so it has to actually reach past the viewport that dropped those rows.
		it("read({ lines: 'all' }) captures the whole history a bounded window left behind", async () => {
			const target = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			tmuxMuxAdapter.submit(exec, target, 'i=1; while [ $i -le 60 ]; do echo row-$i; i=$((i+1)); done')
			await pollUntil(
				() => tmuxMuxAdapter.read(exec, target).text,
				(out) => out.includes('row-60'),
			)
			// The default window is the 24-row viewport: row-1 scrolled off it long ago.
			const viewport = tmuxMuxAdapter.read(exec, target, { truncation: true })
			expect(viewport.truncated).toBe(true)
			expect(viewport.text).not.toContain('row-1\n')
			// `-S -` reaches the start of the history and brings those rows back — and reports itself
			// complete without spending a probe on it.
			const whole = tmuxMuxAdapter.read(exec, target, { lines: 'all', truncation: true })
			expect(whole.text).toContain('row-1\n')
			expect(whole.truncated).toBe(false)
		})
		/**
		 * The round trip the seam's `ratio` promises, against the real binary: open a split at a ratio,
		 * read the region back, resize to a NEW ratio, and read it back again. This is where the sign
		 * convention is actually pinned — `split-window -l` sizes the NEW pane and `resize-pane -x` sizes
		 * the TARGET, so an adapter that inverted one of them would still pass every mocked test and
		 * silently size the wrong pane here.
		 */
		it('resizePane() moves the real divider to the ratio asked for, and reads back at that ratio', () => {
			const regions = tmuxMuxAdapter.regions
			if (!regions) throw new Error('the tmux adapter must implement regions')
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })
			expect(split.id).toMatch(/^%\d+$/)

			regions.resizePane(exec, opened, 0.7)
			const after = regions.describeRegion(exec, opened)
			const kept = after.find((p) => p.id === opened.id)
			const taken = after.find((p) => p.id === split.id)
			expect(kept).toBeDefined()
			expect(taken).toBeDefined()
			// The seam's own definition of what the region reads back at: 1 - second / total.
			const total = kept!.rect.width + taken!.rect.width + 1
			// Within ONE CELL, derived from the region rather than a constant. A cell-based backend can
			// only land on k/total, so the achievable ratio nearest 0.7 is off by up to 1/total — a fixed
			// tolerance would pass at one terminal size and fail at the next.
			expect(Math.abs(1 - taken!.rect.width / total - 0.7)).toBeLessThanOrEqual(1 / total)
			// And the ORIGINAL pane is the one that grew — the half a wrong sign convention gets backwards.
			expect(kept!.rect.width).toBeGreaterThan(taken!.rect.width)
		})

		it('resizePane() on the NEW pane sizes that pane, not the one it was split from', () => {
			const regions = tmuxMuxAdapter.regions
			if (!regions) throw new Error('the tmux adapter must implement regions')
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })

			regions.resizePane(exec, split, 0.75)
			const after = regions.describeRegion(exec, opened)
			const taken = after.find((p) => p.id === split.id)
			expect(taken!.rect.width).toBeGreaterThan(after.find((p) => p.id === opened.id)!.rect.width)
		})

		/**
		 * The zoom rows. Every one of these is the reason a mocked `Exec` cannot settle this member:
		 * the assertions are about the pane's real WIDTH on a real screen and about what tmux does with
		 * a flag, neither of which a fake can be wrong about.
		 */
		it('setPaneZoom(true) really makes the pane fill its region, and reads back zoomed', () => {
			const regions = tmuxMuxAdapter.regions
			if (!regions) throw new Error('the tmux adapter must implement regions')
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })
			const before = regions.describeRegion(exec, opened)
			const half = before.find((p) => p.id === split.id)!.rect.width
			expect(tmuxMuxAdapter.isPaneZoomed(exec, split)).toBe(false)

			tmuxMuxAdapter.setPaneZoom(exec, split, true)

			expect(tmuxMuxAdapter.isPaneZoomed(exec, split)).toBe(true)
			// The pane got BIG — the whole point of the member, and the half no mock can assert.
			const zoomedWidth = tmuxMuxAdapter.regions!.describeRegion(exec, split).find((p) => p.id === split.id)!.rect.width
			expect(zoomedWidth).toBeGreaterThan(half)
			// Its sibling is still OPEN behind it — a zoom hides a pane, it does not close one.
			expect(tmuxMuxAdapter.paneExists(exec, opened)).toBe(true)
		})

		/**
		 * The row that a "read the flag, then toggle" implementation passes and a bare `resize-pane -Z
		 * -t <pane>` fails. Measured on 3.7c: with %1 zoomed, `-Z -t %2` leaves NOTHING zoomed, because
		 * tmux's zoom follows the ACTIVE pane rather than the named one. Only the `select-pane` first
		 * transfers it.
		 */
		it('setPaneZoom(true) TRANSFERS the zoom off a sibling that already had it', () => {
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })
			tmuxMuxAdapter.setPaneZoom(exec, opened, true)
			expect(tmuxMuxAdapter.isPaneZoomed(exec, opened)).toBe(true)

			tmuxMuxAdapter.setPaneZoom(exec, split, true)

			expect(tmuxMuxAdapter.isPaneZoomed(exec, split)).toBe(true)
			expect(tmuxMuxAdapter.isPaneZoomed(exec, opened)).toBe(false)
		})

		it('setPaneZoom(false) really restores the pane to its share of the split', () => {
			const regions = tmuxMuxAdapter.regions
			if (!regions) throw new Error('the tmux adapter must implement regions')
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })
			const half = regions.describeRegion(exec, opened).find((p) => p.id === split.id)!.rect.width
			tmuxMuxAdapter.setPaneZoom(exec, split, true)

			tmuxMuxAdapter.setPaneZoom(exec, split, false)

			expect(tmuxMuxAdapter.isPaneZoomed(exec, split)).toBe(false)
			expect(regions.describeRegion(exec, opened).find((p) => p.id === split.id)!.rect.width).toBe(half)
		})

		/**
		 * The seam's no-op, asserted through its OBSERVABLE consequence rather than a call count — the
		 * form a mocked test cannot reach at all. `setPaneZoom(<not zoomed>, false)` asks for nothing,
		 * so the sibling that IS zoomed must survive it. Without the read-first guard the bare
		 * `resize-pane -Z` would unzoom that sibling instead.
		 */
		it('setPaneZoom(false) on a pane that is not zoomed leaves its zoomed sibling alone', () => {
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const split = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: opened, ratio: 0.5 })
			tmuxMuxAdapter.setPaneZoom(exec, split, true)

			tmuxMuxAdapter.setPaneZoom(exec, opened, false)

			expect(tmuxMuxAdapter.isPaneZoomed(exec, split)).toBe(true)
		})

		it('isPaneZoomed() answers undefined for a pane the real tmux no longer has', () => {
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			tmuxMuxAdapter.teardown(exec, opened)
			expect(tmuxMuxAdapter.isPaneZoomed(exec, opened)).toBeUndefined()
		})

		/**
		 * The relocation rows. A mocked `Exec` can prove the argv and nothing else — that `-h` really
		 * lands the pane to the RIGHT of the destination rather than the left, that `-d` really leaves
		 * the client where it was, and that break-out on a lone pane really is a no-op are all screen
		 * facts, and all three are asserted here against real geometry the binary reports.
		 */
		it('movePane() carries a live pane into the destination’s tab and leaves its sibling behind', () => {
			const home = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const traveller = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: home, ratio: 0.5 })
			const destination = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })

			const moved = tmuxMuxAdapter.movePane(exec, traveller, destination, 'right')

			// tmux pane ids are server-wide, so the id survives — unlike herdr's, which do not.
			expect(moved.id).toBe(traveller.id)
			expect(moved.tab).toBe(destination.tab)
			expect(moved.tab).not.toBe(traveller.tab)
			// The pane itself is still alive, and the sibling it left is still in the old tab.
			expect(tmuxMuxAdapter.paneExists(exec, moved)).toBe(true)
			expect(tmuxMuxAdapter.listPanes(exec).some((p) => p.id === home.id)).toBe(true)
		})

		it.each([
			{ side: 'right', axis: 'x' },
			{ side: 'down', axis: 'y' },
		] as const)('movePane(%s) really lands the pane on that side of the destination', ({ side, axis }) => {
			const regions = tmuxMuxAdapter.regions
			if (!regions) throw new Error('the tmux adapter must implement regions')
			const home = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const traveller = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: home, ratio: 0.5 })
			const destination = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })

			const moved = tmuxMuxAdapter.movePane(exec, traveller, destination, side)

			const region = regions.describeRegion(exec, destination)
			const dest = region.find((p) => p.id === destination.id)
			const landed = region.find((p) => p.id === moved.id)
			if (!dest || !landed) throw new Error('both panes must be in the destination region after the move')
			// `right` means a greater x and the same y; `down` the reverse. Asserting the ORDER is what a
			// mocked argv check cannot do — `-h` and `-v` are only names until a binary places them.
			expect(landed.rect[axis]).toBeGreaterThan(dest.rect[axis])
		})

		it('movePane() does not drag the client to the destination window — the -d the argv carries', () => {
			const currentWindow = () => exec('tmux', ['display-message', '-p', '#{window_id}'])
			const home = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const traveller = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: home, ratio: 0.5 })
			const destination = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const before = currentWindow()

			tmuxMuxAdapter.movePane(exec, traveller, destination, 'right')

			expect(currentWindow()).toBe(before)
		})

		it('movePane() throws on a destination the real tmux cannot resolve', () => {
			const home = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(() => tmuxMuxAdapter.movePane(exec, home, { id: '%999' }, 'right')).toThrow(/tmux could not move pane/)
		})

		it('breakPane() gives a split pane its own window, with the pane alive and its sibling untouched', () => {
			const home = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const traveller = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: home, ratio: 0.5 })

			const broken = tmuxMuxAdapter.breakPane(exec, traveller, 'tab')

			expect(broken.id).toBe(traveller.id)
			expect(broken.tab).not.toBe(traveller.tab)
			expect(tmuxMuxAdapter.paneExists(exec, broken)).toBe(true)
			// The reported window is a REAL one, not a plausible-looking string: naming it succeeds.
			expect(() => tmuxMuxAdapter.rename(exec, { id: broken.tab }, 'tab', 'broken-out')).not.toThrow()
			// And the pane it left behind is alone in the old window rather than gone with it.
			const region = tmuxMuxAdapter.regions!.describeRegion(exec, home)
			expect(region.map((p) => p.id)).toEqual([home.id])
		})

		// tmux has no workspace tier, so BOTH tiers are a new window and the pane reports no workspace —
		// the same collapse `open` makes, asserted against the binary rather than the argv.
		it.each(['tab', 'workspace'] as const)('breakPane(%s) lands a new window and reports no workspace', (at) => {
			const home = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			const traveller = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'pane:right', from: home, ratio: 0.5 })

			const broken = tmuxMuxAdapter.breakPane(exec, traveller, at)

			expect(broken.workspace).toBeUndefined()
			expect(broken.tab).not.toBe(home.tab)
		})

		/**
		 * The divergence `MuxAdapter.breakPane` declares rather than normalizes: tmux NO-OPS a break-out
		 * of a pane that is already alone, where herdr and wezterm mint another tab. Only a live binary
		 * can say which family a backend is in.
		 */
		it('breakPane() on a pane that is already alone answers its existing window, changing nothing', () => {
			const alone = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })

			const broken = tmuxMuxAdapter.breakPane(exec, alone, 'tab')

			expect(broken).toEqual({ id: alone.id, tab: alone.tab })
		})

		it('resizePane() throws on a region tmux reports as a single pane', () => {
			const regions = tmuxMuxAdapter.regions
			if (!regions) throw new Error('the tmux adapter must implement regions')
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(() => regions.resizePane(exec, opened, 0.6)).toThrow(/is the only pane in its region/)
		})
	})
})

// A second real-tmux boundary, driven the way #177 is actually reached: a caller with NO locale in its
// environment AND no `$TMUX` in it either. Both halves are load-bearing, and the second one was
// measured rather than assumed.
//
// tmux mangles its command output for a client it does not consider UTF-8 — every byte outside
// printable ASCII becomes a literal `_`, the TAB this adapter's formats separate fields with included.
// Two things independently make a client UTF-8, and a test has to defeat both:
//
//   1. A `LANG`/`LC_ALL`/`LC_CTYPE` containing the substring "UTF-8" or "UTF8" (tmux(1) `-u`). Every
//      other integration suite in this repo inherits the developer's or the runner's environment, which
//      carries one — which is precisely why `live-backends` stayed green across every release that
//      shipped this bug.
//   2. `$TMUX` being set, which makes the command client one INSIDE a session and gives it the
//      containing client's UTF-8 state instead. Measured on 3.7c: with `$TMUX` set and no locale at
//      all, `list-panes -a -F '#{pane_id}<TAB>#{window_id}'` still returns a real tab. That is the
//      honest limit on this bug's blast radius — a caller running inside a pane was never affected —
//      and it is also why the suite ABOVE could not have caught it even with the locale stripped: it
//      sets `$TMUX` on purpose.
//
// So the fixture below strips both: an environment built from nothing but `PATH` and `HOME`, which is
// what a systemd unit, a cron job, a container entrypoint or a non-interactive ssh session actually
// hands a process. `CYBER_MUX=tmux` is the documented way such a caller reaches this adapter.
//
// Without `$TMUX` the adapter's target-less commands resolve against the socket's most recently used
// session, which on an isolated single-session `-L` server is the one this block creates.
describe.skipIf(!hasTmux())('spec:cyber-mux/mux', () => {
	describe('tmuxMuxAdapter — real tmux boundary, no locale and no $TMUX', () => {
		const socket = `${SOCKET}-nolocale`
		let cwd: string
		let exec: Exec

		beforeAll(() => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-itest-nolocale-'))
			// `PATH` so tmux is findable and `HOME` so it has somewhere to look for a config; nothing else.
			// Deliberately NOT spread from `process.env` — that would re-import the very variables under
			// test, and it is what makes this block's environment a claim rather than a hope.
			const env: Record<string, string> = {
				PATH: process.env['PATH'] ?? '',
				HOME: process.env['HOME'] ?? '',
			}
			execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'main', '-c', cwd], { env })
			exec = (cmd, args) => {
				try {
					const fullArgs = cmd === 'tmux' ? ['-L', socket, ...args] : args
					return execFileSync(cmd, fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim()
				} catch {
					return null
				}
			}
		})

		afterAll(() => {
			try {
				execFileSync('tmux', ['-L', socket, 'kill-server'])
			} catch {
				// already gone
			}
			rmSync(cwd, { recursive: true, force: true })
		})

		/**
		 * A pane created WITHOUT going through the adapter, asking tmux for a single-field format that has
		 * no separator to lose. The rows that are about `listPanes` use it so that reverting the fix turns
		 * THEM red on their own claim: driving `open` for the setup would fail first, on `open`'s parse,
		 * and a row that never reaches its own subject proves nothing about it.
		 */
		function rawOpen(): string {
			const id = exec('tmux', ['new-window', '-d', '-c', cwd, '-P', '-F', '#{pane_id}', 'sh'])
			if (!id || !/^%\d+$/.test(id)) throw new Error(`the fixture could not open a pane: ${id}`)
			return id
		}

		// The environment this block claims to run under, asserted rather than described — a fixture that
		// quietly grew a `LANG` back would turn every row below into a test of nothing, silently, and the
		// whole point of this block is that it is the one place in the suite where that matters.
		it('drives tmux with no locale and no $TMUX in the environment', () => {
			const seen = (exec('sh', ['-c', 'env']) ?? '').split('\n').map((l) => l.split('=')[0])
			expect(seen).not.toContain('LANG')
			expect(seen).not.toContain('LC_ALL')
			expect(seen).not.toContain('LC_CTYPE')
			expect(seen).not.toContain('TMUX')
		})

		// The bug as filed. `open` asks for `#{pane_id}\t#{window_id}` and splits the reply on the tab; a
		// tab tmux rendered as `_` leaves ONE field, so the id swallows the window id and the tab is lost.
		// Both halves are asserted: a suite that only checked `tab` would pass an adapter still handing
		// back `%1_@1` as a pane id.
		it('open() reports a clean pane id and window id, not one field with a `_` where the tab was', () => {
			const opened = tmuxMuxAdapter.open(exec, { cwd, launch: 'sh', at: 'tab' })
			expect(opened.id).toMatch(/^%\d+$/)
			expect(opened.tab).toMatch(/^@\d+$/)
			tmuxMuxAdapter.teardown(exec, opened)
		})

		// The consequence the issue is named for: N panes collapsing into ONE record whose id is the whole
		// line. Two panes are opened so the COUNT is itself a claim — a listing that returned a single
		// junk row satisfies neither the id shape nor the pair.
		it('listPanes() returns one record PER pane, each with a real id and cwd', () => {
			const first = { id: rawOpen() }
			const second = { id: rawOpen() }

			const panes = tmuxMuxAdapter.listPanes(exec)

			for (const pane of panes) expect(pane.id).toMatch(/^%\d+$/)
			const mine = panes.filter((p) => p.id === first.id || p.id === second.id)
			expect(mine).toHaveLength(2)
			for (const pane of mine) expect(pane.cwd).toBe(cwd)

			tmuxMuxAdapter.teardown(exec, second)
			tmuxMuxAdapter.teardown(exec, first)
		})

		// The rest of the CLASS, not just the separator. tmux replaces EVERY byte outside printable ASCII
		// for a non-UTF-8 client, so a pane title carrying any non-ASCII character came back as `_`s — a
		// corruption re-picking the separator would have left standing, and the reason `runTmux` puts `-u`
		// on every invocation rather than only on the ones that parse a tab.
		it('listPanes() reports a non-ASCII pane title verbatim rather than as underscores', () => {
			const opened = { id: rawOpen() }
			exec('tmux', ['select-pane', '-t', opened.id, '-T', 'café–ledger'])

			const pane = tmuxMuxAdapter.listPanes(exec).find((p) => p.id === opened.id)

			expect(pane).toBeDefined()
			expect(pane?.label).toBe('café–ledger')

			tmuxMuxAdapter.teardown(exec, opened)
		})
	})
})
