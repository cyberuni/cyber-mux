import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { createZellijAdapter } from './mux.zellij.ts'

function hasZellij(): boolean {
	try {
		execFileSync('zellij', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * `script` allocates the PTY this suite needs for its one client (see below). It is util-linux, so it
 * is present on the Ubuntu runners and on a normal Linux workstation — but check rather than assume,
 * because its absence must skip the suite, never fail it.
 */
function hasScript(): boolean {
	try {
		execFileSync('script', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * The budget is 15s rather than the 5s this started with, and it is a BACKSTOP, not a wait that
 * decides a pass: every row here still fails on its own assertion once the poll gives up. 5s was a
 * cliff — a real-boundary row that asks a shell to run `pwd` and reads the answer back off a captured
 * screen is at the mercy of how loaded the box is, and it was the last thing this suite lost a row to
 * under deliberate CPU contention. It sits well under the 30s `testTimeout`, which is the ceiling that
 * catches a genuinely wedged binary.
 */
async function pollUntil(read: () => string, done: (out: string) => boolean, timeoutMs = 15_000): Promise<string> {
	const start = Date.now()
	let out = read()
	while (!done(out) && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 50))
		out = read()
	}
	return out
}

const SESSION = `cm-itest-${process.pid}`

// SHORT, deliberately — the same `sun_path` trap the wezterm suite documents. Zellij's socket lands at
// `$XDG_RUNTIME_DIR/zellij/contract_version_1/<session>`, which already spends ~35 bytes of the ~108
// available before the session name, so a deep temp path makes the bind fail rather than report why.
const RUNTIME_DIR = join(tmpdir(), `zj${process.pid}`)

describe.skipIf(!hasZellij() || !hasScript())('spec:cyber-mux/mux', () => {
	describe('zellijMuxAdapter — real zellij boundary', () => {
		let cwd: string
		let exec: Exec
		let client: ReturnType<typeof spawn>
		let base: string
		// The session-bound adapter, because `workspace` reporting is one of the things under test —
		// `backend.ts` binds this same effect off `$ZELLIJ_SESSION_NAME`.
		const adapter = createZellijAdapter({ session: SESSION })

		/**
		 * Which pane THE CLIENT is on — the second column of `list-clients`, whose header row is skipped.
		 *
		 * Not `isPaneFocused`, deliberately. `list-panes --json` reports `is_focused: true` on more than
		 * one record at a time — a live session marks both the floating release-notes plugin pane and the
		 * tiled pane under it — so that flag answers "focused within its layer", not "where the client
		 * is". `new-pane --direction` cares about the client, so this row of `list-clients` is the only
		 * signal that means the precondition.
		 */
		function clientPane(): string {
			return (exec('zellij', ['action', 'list-clients']) ?? '').split('\n')[1]?.trim().split(/\s+/)[1] ?? ''
		}

		/**
		 * Park the client on a terminal pane and WAIT until it is actually there.
		 *
		 * `focus-pane-id` returns as soon as the server accepts it, not when the client has moved, and a
		 * `--direction` split issued into that gap sees the OLD focus. If that old focus is a plugin pane
		 * the split fails silently — prints a plausible pane id, exits 0, creates nothing — which the
		 * adapter then reports as a phantom. Under CPU contention that is the last thing this suite was
		 * still losing rows to, so the precondition is established and CHECKED rather than assumed.
		 */
		async function parkClientOn(id: string): Promise<string> {
			adapter.focus(exec, { id })
			return pollUntil(clientPane, (pane) => pane === id)
		}

		/**
		 * `paneExists`, polled until it says yes — for the one failure mode the adapter cannot defend
		 * against on its own.
		 *
		 * A `zellij action` reply can be delivered to the wrong command (see `LIST_PANES_ATTEMPTS` in the
		 * adapter). The adapter re-asks a reply that comes back empty or unparseable, but a misdelivered
		 * reply can also be a VALID pane array — just an older one, which simply does not carry the pane
		 * that has since been opened. Nothing in the shape of that answer marks it stale, so `listPanes`
		 * has no way to reject it and `paneExists` reports a live pane as missing.
		 *
		 * A poll is the honest response and costs the row nothing: a pane that does not exist never starts
		 * existing, so this can only wait out a stale read, never manufacture a pass.
		 */
		async function existsEventually(target: { id: string }): Promise<string> {
			return pollUntil(
				() => String(adapter.paneExists(exec, target)),
				(out) => out === 'true',
			)
		}

		beforeAll(async () => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-zj-'))
			mkdirSync(RUNTIME_DIR, { recursive: true })
			const env = {
				...process.env,
				// Isolation, supplied by the environment exactly as the wezterm suite's is: the live socket
				// lives under `XDG_RUNTIME_DIR`, so a throwaway one yields a private zellij. `XDG_CACHE_HOME`
				// matters too — the session RESURRECTION list is cached separately, and without it a fresh
				// runtime dir still lists this suite's dead sessions back to the operator.
				XDG_RUNTIME_DIR: RUNTIME_DIR,
				XDG_CACHE_HOME: join(RUNTIME_DIR, 'cache'),
				ZELLIJ_CONFIG_DIR: join(RUNTIME_DIR, 'config'),
				TERM: 'xterm-256color',
			}
			execFileSync('zellij', ['attach', '--create-background', SESSION], { env, stdio: 'ignore' })

			exec = (cmd, args) => {
				try {
					// Inject the connection target the adapter deliberately does not spell — the same seam the
					// tmux suite fills with `-L <socket>`. `--session` is a top-level option, so it goes ahead
					// of the `action` subcommand. This is also precisely why the adapter needs no session
					// qualifier on `MuxTarget` to be drivable against an isolated server.
					return execFileSync(cmd, ['--session', SESSION, ...args], {
						encoding: 'utf8',
						stdio: ['ignore', 'pipe', 'ignore'],
						env,
					}).trim()
				} catch {
					return null
				}
			}

			// A PTY-attached client, and NOT only because `new-pane --direction` needs one focused on a
			// terminal pane (it does — without that it prints a plausible pane id and exits 0 having created
			// nothing). A session that no client has ever attached to reports `list-panes --json` as an empty
			// ARRAY, verified against a live 0.44.3: no error, no missing session, just nothing. So the
			// client is what makes the WHOLE suite readable, not just the split rows.
			// `setsid` puts the client in its own process group so teardown kills it and its `script` child
			// by group, without a pattern match: `pkill -f zellij` matches any command line merely mentioning
			// the name, up to and including the shell that launched the test run.
			client = spawn('setsid', ['script', '-qec', `zellij attach ${SESSION}`, '/dev/null'], {
				env,
				detached: true,
				stdio: 'ignore',
			})
			client.unref()
			// Wait for the session to be genuinely DRIVABLE rather than sleeping a guess, and gate on the
			// listing rather than on `list-clients`: the two states arrive in that order, and a live probe
			// caught the listing still answering `[]` for several reads after a client had registered. The
			// old gate stopped at the registration and let the suite start against an empty listing — which
			// is the whole 10-of-11 collapse in issue #115, where every row failed at once on a session that
			// simply was not up yet.
			let clients = ''
			let panes: ReturnType<typeof adapter.listPanes> = []
			for (let i = 0; i < 150; i++) {
				clients = exec('zellij', ['action', 'list-clients']) ?? ''
				panes = adapter.listPanes(exec)
				if (/\bterminal_\d+|\bplugin_\d+/.test(clients) && panes.some((p) => p.id.startsWith('terminal_'))) break
				await new Promise((r) => setTimeout(r, 100))
			}
			// The session's own initial pane, and the anchor every split here is taken `from`. A fresh client
			// focuses zellij's release-notes PLUGIN pane, and a split relative to a plugin pane fails the same
			// silent way — so the tests must always name a terminal pane rather than trusting focus.
			//
			// Chosen by the id's KIND, which is the only reliable way to say "a terminal pane": a live
			// session carries a SECOND plugin pane besides the release notes — the suppressed `zellij:link`
			// one — so filtering by label alone can hand back a plugin pane and anchor every split on it.
			base = panes.find((p) => p.id.startsWith('terminal_'))?.id ?? ''
			// LOUD, and here rather than fifteen seconds later spread across eleven rows. A harness that
			// never came up is a harness failure; reporting it as `expected 0 to be greater than 5` in every
			// test that follows is what made this suite read like several unrelated bugs.
			if (!base) {
				throw new Error(
					`the zellij harness never came up: session ${SESSION} reported ${panes.length} pane(s) and no ` +
						`terminal pane after 15s. list-clients said ${JSON.stringify(clients)}. Every row below ` +
						'would have failed against that empty listing — this is the harness, not the adapter.',
				)
			}
			// Move the client OFF the release-notes plugin pane before any row runs, so the rows that do
			// not pass `from` also start from a state where a split could succeed at all.
			const parked = await parkClientOn(base)
			if (parked !== base) {
				throw new Error(
					`the zellij harness never came up: the client would not park on the terminal pane ${base}, ` +
						`it is on ${JSON.stringify(parked)}. A --direction split from a plugin pane fails silently, ` +
						'so every split row below would have reported a phantom — this is the harness, not the adapter.',
				)
			}
		})

		afterAll(() => {
			try {
				if (client.pid) process.kill(-client.pid)
			} catch {
				// already gone
			}
			try {
				execFileSync('zellij', ['delete-session', '--force', SESSION], {
					env: { ...process.env, XDG_RUNTIME_DIR: RUNTIME_DIR, XDG_CACHE_HOME: join(RUNTIME_DIR, 'cache') },
					stdio: 'ignore',
				})
			} catch {
				// the session may already be gone; the runtime dir goes either way
			}
			rmSync(cwd, { recursive: true, force: true })
			rmSync(RUNTIME_DIR, { recursive: true, force: true })
		})

		it('open() at tab actually creates a real tab the real zellij binary reports back', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			// `new-tab` reports a TAB id and the adapter resolves the tab's own initial pane out of
			// `list-panes` — a two-step only a real listing exercises.
			expect(target.id).toBeTruthy()
			expect(target.tab).toBeTruthy()
			expect(await existsEventually(target)).toBe('true')
		})

		it('open() at workspace collapses to a tab and reports the ambient session as the workspace', async () => {
			const target = adapter.open(exec, { cwd, at: 'workspace' })
			// The documented collapse, against the real binary: zellij's own workspace tier is the SESSION,
			// which this seam cannot address, so `workspace` lands a tab in the ambient one — and says so
			// truthfully rather than reporting a workspace that was never created.
			expect(target.workspace).toBe(SESSION)
			expect(await existsEventually(target)).toBe('true')
		})

		it('open() at pane:right actually splits a real pane', async () => {
			// The precondition, established and PROVEN before the split rather than assumed: earlier rows
			// leave the client wherever their own opens put it, and `--direction` fails silently unless the
			// client is sitting on a terminal pane. `open()` focuses `from` itself, but that focus and the
			// split are two separate round trips and the second can outrun the first under load — parking
			// first means the adapter's own focus call has nothing left to race.
			expect(await parkClientOn(base)).toBe(base)
			const before = adapter.listPanes(exec).length
			const target = adapter.open(exec, { cwd, at: 'pane:right', from: { id: base } })
			expect(await existsEventually(target)).toBe('true')
			expect(adapter.listPanes(exec).length).toBeGreaterThan(before)
		})

		it('open() at pane:float actually creates a real floating pane, backing canFloatPanes', async () => {
			const target = adapter.open(exec, { cwd, at: 'pane:float' })
			expect(await existsEventually(target)).toBe('true')
		})

		// The READ side, at the boundary that owns the answer: `is_floating` is a key this adapter reads
		// out of a live `list-panes --json`, so a mocked exec only ever proves we can parse our own
		// fixture. Opened both ways in one test on purpose — a suite that only ever saw a float could
		// pass on an adapter that hardcoded `true`.
		//
		// ONE open, and no `new-pane --direction` anywhere in it. The tiled half of the contrast is the
		// session's own panes, which are tiled by construction and always there — so this row never
		// touches the verb that fails SILENTLY when the client is focused on a plugin pane (the trap
		// the file header documents, and the one this suite flakes on). The float is anchored on a
		// terminal pane with `from` for the same reason; the unanchored default is the row above's.
		//
		// The float is identified by LABEL, never by id, and that is not fussiness: `new-pane` prints
		// the prefixed `terminal_N` while the listing reports the bare `N`, AND a zellij pane id is not
		// unique across plugin and terminal panes — a live 0.44.3 session reports `0` for both its
		// suppressed `zellij:link` plugin pane and its first terminal pane, which `listPanes` collapses
		// onto one `LivePane.id`. A name given at birth is the one unambiguous handle this backend
		// offers, and the `rename()` row already pins that a name survives into the listing.
		it('listPanes() tells a real float from a real tiled pane', async () => {
			adapter.open(exec, { cwd, at: 'pane:float', from: { id: base }, label: 'cm-float' })
			// Polled for the same reason the rename row is: a name given at birth reaches the listing a
			// beat after `new-pane` returns, and this row addresses the float BY that name.
			await pollUntil(
				() => String(adapter.listPanes(exec).filter((p) => p.label === 'cm-float').length),
				(out) => out === '1',
			)
			const panes = adapter.listPanes(exec)
			// Found at all, and exactly once, before the flag is read — so a failed open is reported as a
			// miss rather than as a wrong answer.
			expect(panes.filter((p) => p.label === 'cm-float').length).toBe(1)
			expect(panes.find((p) => p.label === 'cm-float')?.floating).toBe(true)
			// And the contrast, which is what keeps an adapter hardcoding `true` from passing: the same
			// listing still reports tiled panes as tiled.
			expect(panes.some((p) => !p.floating)).toBe(true)
		})

		// The identity hazard, at the boundary that produces it: a live 0.44.3 session really does report
		// the number 0 twice — once for its suppressed `zellij:link` PLUGIN pane and once for its first
		// terminal pane. No fixture can prove that; only the binary can. What the adapter owes is a
		// listing in which no two panes answer to the same id.
		it('lookup-listing-id-names-one-pane', async () => {
			// Polled for a NON-EMPTY listing first, and for the same reason the cwd row polls: an empty
			// `list-panes` reply under load would otherwise read as "this session has no plugin pane",
			// which is a different finding from the one under test.
			const listed = await pollUntil(
				() => JSON.stringify(adapter.listPanes(exec).map((p) => p.id)),
				(out) => out !== '[]',
			)
			const ids = JSON.parse(listed) as string[]
			expect(ids.length).toBeGreaterThan(0)
			expect(new Set(ids).size).toBe(ids.length)
			// And the collision is real rather than hypothetical here: both kinds are present, and at least
			// one number is carried by a pane of each kind.
			const numberOf = (id: string) => id.replace(/^(terminal|plugin)_/, '')
			const plugins = ids.filter((id) => id.startsWith('plugin_')).map(numberOf)
			const terminals = ids.filter((id) => id.startsWith('terminal_')).map(numberOf)
			expect(plugins.length).toBeGreaterThan(0)
			expect(terminals.length).toBeGreaterThan(0)
			expect(plugins.some((n) => terminals.includes(n))).toBe(true)
		})

		it('submit()/read() actually run a command in and capture from a real pane', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			adapter.submit(exec, target, 'echo cyber-mux-zj-marker')
			const output = await pollUntil(
				() => adapter.read(exec, target).text,
				(out) => out.includes('cyber-mux-zj-marker'),
			)
			expect(output).toContain('cyber-mux-zj-marker')
		})

		it('open() honors cwd — proven by asking the real shell where it is', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			adapter.submit(exec, target, 'pwd')
			const output = await pollUntil(
				() => adapter.read(exec, target).text,
				(out) => out.includes(cwd),
			)
			expect(output).toContain(cwd)
		})

		// The READ side of the same directory, at the boundary that owns the answer. `pane_cwd` is a real
		// key on a live 0.44.3 TERMINAL pane record — a mocked exec would only prove the adapter can read
		// its own fixture, and a fixture is exactly how the opposite claim ("no cwd field exists at all")
		// survived: the probe behind it sampled a PLUGIN pane, whose record omits the key. Opening at a
		// known directory and reading it back off the live listing is what tells those apart.
		it('lookup-listing-reports-cwd', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			// Found at all BEFORE the field is read, and polled for rather than read once — the same rule
			// the float row states. `find(...)?.cwd` alone answers `undefined` for a pane that is missing
			// from the listing and for a pane that reports no directory, and those are opposite findings:
			// one is this suite's known flake (a `list-panes` reply that comes back empty under load, #115),
			// the other is the claim under test. Asserting the pane is there first keeps them apart.
			const found = await pollUntil(
				() => JSON.stringify(adapter.listPanes(exec).find((p) => p.id === target.id) ?? null),
				(out) => out !== 'null',
			)
			expect(found, 'the pane just opened never appeared in the live listing').not.toBe('null')
			expect((JSON.parse(found) as { cwd?: string } | null)?.cwd).toBe(cwd)
		})

		it('rename() at the pane tier actually renames a real pane, and the name survives as a label', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			adapter.rename(exec, target, 'pane', 'cm-renamed')
			// The whole point of the `terminal_command` fix: an AUTHORED name is a label, while an unnamed
			// pane's ambient command-derived title is not. Only a live listing tells those apart.
			//
			// Polled, because `rename-pane` returns as soon as the SERVER accepts it and the listing can
			// still carry the old title on the very next read — caught under load, reporting the pane's
			// ambient `Pane #1` rather than the name just given. Waiting for the name to land is what the
			// row means by "survives"; reading once races it.
			const listed = await pollUntil(
				() => String(adapter.listPanes(exec).find((p) => p.id === target.id)?.label),
				(out) => out === 'cm-renamed',
			)
			expect(listed).toBe('cm-renamed')
		})

		it('focus()/isPaneFocused() answer a real focus value, not a guess', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			adapter.focus(exec, target)
			// Same beat as the rename row: `focus-pane-id` is accepted before `is_focused` moves in the
			// listing, so the read that proves it waits for it.
			const focused = await pollUntil(
				() => String(adapter.isPaneFocused(exec, target)),
				(out) => out === 'true',
			)
			expect(focused).toBe('true')
			// Unresolvable stays `undefined` rather than a false `false` — a caller cannot tell "not focused"
			// from "pane gone", so it must fail open.
			expect(adapter.isPaneFocused(exec, { id: 'terminal_99999' })).toBeUndefined()
		})

		it('teardown() actually kills the real pane', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			expect(await existsEventually(target)).toBe('true')
			adapter.teardown(exec, target)
			// Polled, not read once: `close-pane` returns as soon as the server has accepted it, and under
			// load the pane can still be in the next listing. That lag is the pane dying, not the teardown
			// failing — so the row waits for the removal it asked for instead of racing it.
			const gone = await pollUntil(
				() => String(adapter.paneExists(exec, target)),
				(out) => out === 'false',
			)
			expect(gone).toBe('false')
		})

		it('read({ lines }) trims a real capture and reports the rows it dropped', async () => {
			const target = adapter.open(exec, { cwd, at: 'tab' })
			adapter.submit(exec, target, 'for i in 1 2 3 4 5 6 7 8; do echo row-$i; done')
			await pollUntil(
				() => adapter.read(exec, target).text,
				(out) => out.includes('row-8'),
			)
			// Gated on the capture having ARRIVED before anything is concluded from it. A `lines` read is one
			// `dump-screen --full` trimmed client-side, and a dump-screen reply that came back empty — the
			// same misdelivery this suite works around elsewhere — trims to nothing and truthfully reports
			// that nothing was dropped. Waiting for a dump that carries the rows keeps a lost reply from
			// reading as a `truncated: false` finding about the adapter.
			const captured = await pollUntil(
				() => JSON.stringify(adapter.read(exec, target, { lines: 2, truncation: true })),
				(out) => (JSON.parse(out) as { text: string }).text.trim() !== '',
			)
			const trimmed = JSON.parse(captured) as { text: string; truncated: boolean }
			expect(trimmed.text.trim(), 'the capture came back empty — the dump-screen reply was lost').not.toBe('')
			expect(trimmed.text.split('\n').length).toBeLessThanOrEqual(2)
			// Zellij has no trailing-N primitive, so this is a full-scrollback dump trimmed client-side —
			// and the rows it dropped are exactly what `truncated` reports.
			expect(trimmed.truncated).toBe(true)
		})
	})
})
