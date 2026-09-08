import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { weztermMuxAdapter } from './mux.wezterm.ts'

function hasWezterm(): boolean {
	try {
		execFileSync('wezterm', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * `wezterm cli` is a CLIENT. By default it connects to a running GUI instance, and `--prefer-mux`
 * points it at a background `wezterm-mux-server` instead — which it will start on demand. That
 * server's socket lives under `$XDG_RUNTIME_DIR`, so pointing that at a throwaway directory gives
 * this suite a PRIVATE wezterm to drive, never the operator's own GUI. It is the same isolation the
 * tmux suite gets from `-L <socket>`, supplied by the environment rather than by a flag.
 *
 * The adapter itself spells neither `--prefer-mux` nor a socket, exactly as the tmux adapter spells
 * no `-L`: connection targeting is the caller's business, and here the injected `Exec` supplies it —
 * the same seam, the same reason. Note what that implies for real use, which no mocked test can
 * show: driven from a plain shell with no GUI running and no `--prefer-mux`, every `wezterm cli`
 * call fails at the socket. In normal use the caller IS inside a wezterm GUI, so it connects; this
 * suite has to arrange the headless equivalent deliberately.
 */
function hasMuxServer(): boolean {
	try {
		execFileSync('wezterm-mux-server', ['--version'], { stdio: 'ignore' })
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

// A SHORT runtime dir, deliberately: a unix socket path must fit in `sun_path` (~108 bytes), and
// wezterm appends `wezterm/sock` to it. A long temp path makes the server bind silently fail and
// every command then reports "failed to connect", which reads like a wezterm problem and is not.
const RUNTIME_DIR = join(tmpdir(), `wz${process.pid}`)

describe.skipIf(!hasWezterm() || !hasMuxServer())('spec:cyber-mux/mux', () => {
	describe('weztermMuxAdapter — real wezterm boundary', () => {
		let cwd: string
		let exec: Exec
		let server: ReturnType<typeof spawn>

		beforeAll(async () => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-wz-'))
			const env = { ...process.env, XDG_RUNTIME_DIR: RUNTIME_DIR, WEZTERM_CONFIG_FILE: '/dev/null' }
			mkdirSync(RUNTIME_DIR, { recursive: true })
			// Started explicitly and held by PID, rather than letting `wezterm cli` auto-spawn it: the
			// teardown then kills exactly the process this suite owns. A pattern-matching kill
			// (`pkill -f wezterm-mux-server`) is the obvious alternative and is genuinely unsafe — it
			// matches any command line merely MENTIONING the name, up to and including the shell that
			// launched the test run.
			server = spawn('wezterm-mux-server', ['--skip-config'], { env, detached: true, stdio: 'ignore' })
			server.unref()
			exec = (cmd, args) => {
				try {
					// Inject the connection target the adapter deliberately does not spell, immediately after
					// the `cli` subcommand where wezterm accepts its options.
					const full = cmd === 'wezterm' && args[0] === 'cli' ? ['cli', '--prefer-mux', ...args.slice(1)] : args
					return execFileSync(cmd, full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim()
				} catch {
					return null
				}
			}
			// Wait for the socket to answer rather than sleeping a guessed interval — the first real
			// assertion must not race the server's startup.
			for (let i = 0; i < 60 && !exec('wezterm', ['cli', 'list']); i++) {
				await new Promise((r) => setTimeout(r, 100))
			}
		})

		afterAll(() => {
			try {
				if (server.pid) process.kill(-server.pid)
			} catch {
				try {
					if (server.pid) process.kill(server.pid)
				} catch {
					// already gone
				}
			}
			rmSync(cwd, { recursive: true, force: true })
			rmSync(RUNTIME_DIR, { recursive: true, force: true })
		})

		it('open() actually creates a real pane the real wezterm binary reports back', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			expect(base, 'the mux server should report at least one pane to split from').toBeDefined()
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			expect(target.id).toMatch(/^\d+$/)
			expect(weztermMuxAdapter.paneExists(exec, target)).toBe(true)
		})

		it('listPanes() sees the real pane, cwd and all', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:down', from: { id: base?.id ?? '0' } })
			const panes = weztermMuxAdapter.listPanes(exec)
			// `cwd` arrives as a `file://` URI that the adapter strips back to a bare path — a decode that
			// only a real listing exercises.
			expect(panes.some((p) => p.id === target.id && p.cwd === cwd)).toBe(true)
		})

		it('open({ at: workspace }) creates a real window in its own named workspace', () => {
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: `cm-itest-${process.pid}` })
			expect(target.workspace).toBe(`cm-itest-${process.pid}`)
			const panes = weztermMuxAdapter.listPanes(exec)
			expect(panes.some((p) => p.id === target.id)).toBe(true)
		})

		/**
		 * The half of wezterm's focus probe a CI runner CAN prove: with no GUI client attached — which is
		 * exactly what a headless `wezterm-mux-server` is — `list-clients` answers a literal `[]`, and
		 * `isPaneFocused` must turn that into `undefined` rather than `false`. Nobody is viewing
		 * anything, so "not focused" would be a fact read out of an absence.
		 *
		 * The `true`/`false` half needs a real client, which a runner has no display for. It was measured
		 * by hand instead, on this same pinned build, by attaching a `wezterm connect unix` GUI to a
		 * headless mux server under WSLg: `focused_pane_id` read `0` at rest, `1` after `cli
		 * activate-pane --pane-id 1`, and `0` again after activating pane 0 back. That measurement is
		 * what justifies reading this field at all; this row is what CI can keep honest.
		 */
		it('isPaneFocused() answers unknown — not false — when no client is attached', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			expect(base, 'the mux server should report at least one pane').toBeDefined()
			// The listing this rests on is real and empty, not merely unparseable.
			expect(exec('wezterm', ['cli', 'list-clients', '--format', 'json'])).toBe('[]')
			expect(weztermMuxAdapter.isPaneFocused(exec, { id: base?.id ?? '0' })).toBeUndefined()
			// A pane no listing carries is the other way this cannot be answered.
			expect(weztermMuxAdapter.isPaneFocused(exec, { id: '99999' })).toBeUndefined()
		})

		/**
		 * `list --format json`'s `is_active` is the field this adapter deliberately does NOT read for
		 * focus, and this is the measurement that says why: two tabs in one window report `is_active:
		 * true` on TWO rows at once. A probe reading it would answer a confident `true` for a pane the
		 * user is not looking at — the plausible wrong answer, not a throw or an empty result.
		 */
		it('is_active is per-tab, so more than one pane reports it at once', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const first = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			// A second TAB, which is the shape that makes `is_active` ambiguous. Driven as raw argv
			// rather than through `open({ at: 'tab' })`: that route spells no `--pane-id` and wezterm then
			// resolves the current pane from `$WEZTERM_PANE`, which this suite (running outside any
			// wezterm) does not have — it fails with "unable to resolve current pane". Not what is under
			// test here; the tab just has to exist.
			const second = exec('wezterm', ['cli', 'spawn', '--pane-id', first.id, '--cwd', cwd])
			expect(second, 'spawning a second tab should report its pane id').toBeTruthy()
			const rows = JSON.parse(exec('wezterm', ['cli', 'list', '--format', 'json']) ?? '[]') as {
				pane_id: number
				is_active?: boolean
			}[]
			const active = rows.filter((r) => r.is_active === true).map((r) => String(r.pane_id))
			// Torn down before the assertions, not after: these rows share one mux server with every other
			// row in this file, a split can only subdivide the space it is given, and a `expect` that
			// fails would otherwise leave an extra TAB standing and starve the rows that follow.
			weztermMuxAdapter.teardown(exec, { id: second?.trim() ?? '' })
			weztermMuxAdapter.teardown(exec, first)
			expect(active).toContain(first.id)
			expect(active).toContain(second?.trim())
			expect(active.length).toBeGreaterThan(1)
		})

		it('teardown() actually kills the real pane', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			expect(weztermMuxAdapter.paneExists(exec, target)).toBe(true)
			weztermMuxAdapter.teardown(exec, target)
			expect(weztermMuxAdapter.paneExists(exec, target)).toBe(false)
		})

		it('submit()/read() actually run a command in and capture from a real pane', async () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			weztermMuxAdapter.submit(exec, target, 'echo cyber-mux-wz-marker')
			const output = await pollUntil(
				() => weztermMuxAdapter.read(exec, target).text,
				(out) => out.includes('cyber-mux-wz-marker'),
			)
			expect(output).toContain('cyber-mux-wz-marker')
		})

		// The refusal, against the real binary. wezterm has no floating-pane concept at all, so the
		// adapter refuses by name rather than substituting a split — and it must refuse BEFORE running
		// anything, which a real boundary is what proves.
		/**
		 * The zoom rows — and on wezterm they are the whole evidence for the member, not a supplement to
		 * a doc read. Everything `mux.wezterm.ts` says about `zoom-pane` and `is_zoomed` was measured
		 * here, against a real headless mux server, in a file whose standing disclaimer is that its
		 * claims come from `--help`.
		 */
		it('setPaneZoom(true) really zooms the pane, and the real listing reports it back', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			expect(weztermMuxAdapter.isPaneZoomed(exec, target)).toBe(false)

			weztermMuxAdapter.setPaneZoom(exec, target, true)

			expect(weztermMuxAdapter.isPaneZoomed(exec, target)).toBe(true)
			// A zoom hides a pane, it does not close one — the pane it was split from is still there.
			expect(weztermMuxAdapter.paneExists(exec, { id: base?.id ?? '0' })).toBe(true)
			weztermMuxAdapter.setPaneZoom(exec, target, false)
		})

		/**
		 * wezterm's zoom is genuinely per-PANE, which no other backend here manages — so this row asserts
		 * the property rather than the workaround: zooming a second pane while the first is zoomed
		 * TRANSFERS the zoom, and unzooming a pane that is not zoomed leaves its zoomed sibling alone
		 * even before the seam's guard would have stopped it.
		 */
		it('setPaneZoom() transfers the zoom between siblings and leaves the zoomed one alone otherwise', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const first = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			const second = weztermMuxAdapter.open(exec, { cwd, at: 'pane:down', from: first })
			weztermMuxAdapter.setPaneZoom(exec, first, true)
			expect(weztermMuxAdapter.isPaneZoomed(exec, first)).toBe(true)

			weztermMuxAdapter.setPaneZoom(exec, second, true)
			expect(weztermMuxAdapter.isPaneZoomed(exec, second)).toBe(true)
			expect(weztermMuxAdapter.isPaneZoomed(exec, first)).toBe(false)

			// The seam's no-op, asserted through its consequence: asking a not-zoomed pane to unzoom must
			// not disturb the pane that IS zoomed.
			weztermMuxAdapter.setPaneZoom(exec, first, false)
			expect(weztermMuxAdapter.isPaneZoomed(exec, second)).toBe(true)

			weztermMuxAdapter.setPaneZoom(exec, second, false)
			expect(weztermMuxAdapter.isPaneZoomed(exec, second)).toBe(false)
		})

		it('isPaneZoomed() answers undefined for a pane the real wezterm no longer has', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			const target = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: { id: base?.id ?? '0' } })
			weztermMuxAdapter.teardown(exec, target)
			expect(weztermMuxAdapter.isPaneZoomed(exec, target)).toBeUndefined()
		})

		/**
		 * The relocation rows. Two things here are only knowable from the binary: that
		 * `split-pane --move-pane-id` really relocates the pane rather than opening a second one, and
		 * that `move-pane-to-new-tab` prints NOTHING on success — which is why the adapter checks
		 * `=== null` instead of falsiness. Every row below would fail on a falsiness check, so the whole
		 * block is that guard's test.
		 */
		// Every fixture below opens its own WORKSPACE rather than a tab, because a headless
		// `wezterm cli spawn` with no `--window-id` has no current pane to anchor to and fails outright
		// (`--pane-id was not specified and $WEZTERM_PANE is not set`). The workspace route spawns its own
		// window and so needs no anchor — and it makes the move cross a window boundary, which is the
		// harder case anyway.
		let relocationSpaces = 0
		function relocationSpace(): string {
			relocationSpaces += 1
			return `cm-reloc-${process.pid}-${relocationSpaces}`
		}

		function paneRow(id: string) {
			const raw = exec('wezterm', ['cli', 'list', '--format', 'json'])
			const rows = JSON.parse(raw ?? '[]') as {
				pane_id: number
				tab_id: number
				window_id: number
				workspace: string
				left_col: number
				top_row: number
			}[]
			const row = rows.find((r) => String(r.pane_id) === id)
			if (!row) throw new Error(`wezterm no longer reports pane ${id}`)
			return row
		}

		it('movePane() relocates the live pane into the destination’s tab rather than opening a new one', () => {
			const home = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })
			const traveller = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: home })
			const destination = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })
			const before = weztermMuxAdapter.listPanes(exec).length

			const moved = weztermMuxAdapter.movePane(exec, traveller, destination, 'down')

			// wezterm pane ids are server-wide, so the id survives the move.
			expect(moved.id).toBe(traveller.id)
			expect(moved.tab).toBe(destination.tab)
			// Nothing was CREATED — the point of `--move-pane-id` over a plain split.
			expect(weztermMuxAdapter.listPanes(exec)).toHaveLength(before)
		})

		it.each([
			{ side: 'right', axis: 'left_col' },
			{ side: 'down', axis: 'top_row' },
		] as const)('movePane(%s) really lands the pane on that side of the destination', ({ side, axis }) => {
			const home = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })
			const traveller = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: home })
			const destination = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })

			const moved = weztermMuxAdapter.movePane(exec, traveller, destination, side)

			// wezterm has no `regions` capability, so the geometry is read straight off its own listing —
			// `--right` and `--bottom` are only names until a binary places them.
			expect(paneRow(moved.id)[axis]).toBeGreaterThan(paneRow(destination.id)[axis])
		})

		it('movePane() throws on a destination the real wezterm cannot resolve', () => {
			const home = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })
			expect(() => weztermMuxAdapter.movePane(exec, home, { id: '9999' }, 'right')).toThrow(
				/wezterm could not move pane/,
			)
		})

		it("breakPane('tab') gives the pane its own tab in the same window, and reports nothing on stdout", () => {
			const home = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })
			const traveller = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: home })

			const broken = weztermMuxAdapter.breakPane(exec, traveller, 'tab')

			expect(broken.id).toBe(traveller.id)
			expect(broken.tab).not.toBe(traveller.tab)
			// Same WINDOW — the tier below the one `'workspace'` reaches for.
			expect(paneRow(broken.id).window_id).toBe(paneRow(home.id).window_id)
		})

		it("breakPane('workspace') takes a new window into a freshly MINTED workspace", () => {
			const home = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })
			const traveller = weztermMuxAdapter.open(exec, { cwd, at: 'pane:right', from: home })
			const homeWorkspace = paneRow(home.id).workspace

			const broken = weztermMuxAdapter.breakPane(exec, traveller, 'workspace')

			// `--workspace` defaults to "default", so a minted name is the only way this is a NEW space.
			expect(broken.workspace).toMatch(/^cyber-mux-[0-9a-f]{8}$/)
			expect(broken.workspace).not.toBe(homeWorkspace)
			expect(paneRow(broken.id).workspace).toBe(broken.workspace)
			expect(paneRow(broken.id).window_id).not.toBe(paneRow(home.id).window_id)
		})

		/** wezterm is in herdr's family, not tmux's: a lone pane still gets a brand new tab. */
		it("breakPane('tab') on a pane that is already alone still mints a new tab", () => {
			const alone = weztermMuxAdapter.open(exec, { cwd, at: 'workspace', label: relocationSpace() })

			const broken = weztermMuxAdapter.breakPane(exec, alone, 'tab')

			expect(broken.id).toBe(alone.id)
			expect(broken.tab).not.toBe(alone.tab)
		})

		it('open({ at: pane:float }) refuses rather than substituting a split', () => {
			const before = weztermMuxAdapter.listPanes(exec).length
			expect(() => weztermMuxAdapter.open(exec, { cwd, at: 'pane:float' })).toThrow()
			expect(weztermMuxAdapter.listPanes(exec)).toHaveLength(before)
		})

		// wezterm has `set-tab-title`/`set-window-title` and no pane equivalent, so naming a PANE is a
		// refusal, not a no-op. Proven here against the real CLI surface rather than a stub of it.
		it('rename() refuses at the pane tier, which wezterm genuinely cannot do', () => {
			const base = weztermMuxAdapter.listPanes(exec)[0]
			expect(() => weztermMuxAdapter.rename(exec, { id: base?.id ?? '0' }, 'pane', 'nope')).toThrow(
				/cannot name a pane/,
			)
		})
	})
})
