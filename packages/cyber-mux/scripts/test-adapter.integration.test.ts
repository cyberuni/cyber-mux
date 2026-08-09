import { execFileSync } from 'node:child_process'
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The real-boundary suite for `--all` — the runner driven as an actual subprocess, spawning real
 * vitest against real suite files, with nothing mocked.
 *
 * `--all`'s whole job is composition: detect the installed adapters and call each one's real
 * suites. Verifying that over a faked dependency seam would assert only that a fake fan-out fans
 * out — the "green that verified nothing" this entire tool exists to refuse. So it is verified here
 * or not at all.
 *
 * **The world is constructed, not observed.** An earlier draft of this file read whatever
 * multiplexers happened to be on the developer's machine and asserted an implication over them;
 * that made the outcome of the test a property of the machine rather than of the runner. Instead,
 * each test below builds a throwaway `PATH` containing only the binaries it wants the runner to
 * find, and strips the multiplexer env vars from the subprocess — so the runner sees exactly the
 * world the scenario names, on any machine, including CI.
 *
 * **Nothing here touches a live multiplexer.** Only tmux is ever really driven, and its own
 * integration suite runs against a private `-L` socket rather than the ambient server. herdr is
 * deliberately never made visible: it has no throwaway-server mode, so driving it would mean
 * driving the operator's one real session.
 */

const RUNNER = fileURLToPath(new URL('./test-adapter.ts', import.meta.url))
const PKG = fileURLToPath(new URL('..', import.meta.url))
const NODE_BIN = dirname(process.execPath)

const worlds: string[] = []
afterAll(() => {
	for (const dir of worlds) rmSync(dir, { recursive: true, force: true })
})

/** Where a binary really lives on this machine's ambient PATH, or undefined if it does not. */
function resolveOnPath(name: string): string | undefined {
	for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
		if (!dir) continue
		const candidate = join(dir, name)
		try {
			accessSync(candidate, constants.X_OK)
			return candidate
		} catch {
			// keep looking
		}
	}
	return undefined
}

/** How a constructed world presents one adapter's binary. */
type Presence =
	/** the real binary — its suite runs for real */
	| 'real'
	/** on PATH but broken: `-V` fails, so the suite's own gate skips every test */
	| 'broken'
	/** on PATH and answering `-V`, but failing every real command, so its suite runs and fails */
	| 'failing'

/**
 * Build a throwaway `bin/` holding exactly the named adapters (plus the node toolchain the runner
 * needs to spawn vitest) and return it. An adapter absent from `adapters` is absent from `PATH`,
 * which is what makes it read as "not installed" — `onPath` tests executability, so shadowing a
 * binary with a failing stub would NOT hide it.
 */
function makeWorld(adapters: Record<string, Presence>): string {
	const dir = mkdtempSync(join(tmpdir(), 'cyber-mux-world-'))
	worlds.push(dir)

	// npx resolves vitest, and npx itself needs node — both from the running interpreter's own dir,
	// not from a version-manager shim that would need the PATH we are about to replace.
	for (const tool of ['node', 'npx']) symlinkSync(join(NODE_BIN, tool), join(dir, tool))

	for (const [name, presence] of Object.entries(adapters)) {
		const target = join(dir, name)
		if (presence === 'real') {
			const real = resolveOnPath(name)
			if (!real) expect.unreachable(`${name} must be installed to build this world`)
			symlinkSync(real as string, target)
			continue
		}
		// `broken` fails everything, including the suite's `-V` gate, so the suite skips every test
		// and the run reports `no-coverage`.
		//
		// `failing` has to work harder, and the reason is worth stating: a shim that merely fails
		// everything after `-V` makes the suite's `beforeAll` throw, and vitest then reports its
		// tests as PENDING rather than failed — which the runner correctly reads as `no-coverage`,
		// not `fail`. To produce a real `fail` the fixture must let setup succeed and only then
		// misbehave, so it answers the two commands the tmux suite's `beforeAll` issues
		// (`new-session`, then `display-message` for the `$TMUX` triple) and fails every command
		// after that. The tests then genuinely execute and genuinely fail.
		const script =
			presence === 'broken'
				? '#!/bin/sh\nexit 1\n'
				: [
						'#!/bin/sh',
						'case "$1" in -V|--version) exit 0 ;; esac',
						'[ "$1" = "-L" ] && shift 2', // drop the private-socket flag the suite passes
						'case "$1" in',
						'  new-session) exit 0 ;;',
						'  display-message) echo "/tmp/cyber-mux-fixture-sock,1234,1"; exit 0 ;;',
						'esac',
						'exit 1',
						'',
					].join('\n')
		writeFileSync(target, script)
		chmodSync(target, 0o755)
	}
	return dir
}

/** The env vars that would make the runner think it is inside a multiplexer, plus the overrides. */
const MUX_ENV = [
	'TMUX',
	'TMUX_PANE',
	'HERDR_ENV',
	'HERDR_PANE_ID',
	'HERDR_SOCKET_PATH',
	'HERDR_TAB_ID',
	'HERDR_WORKSPACE_ID',
	'WEZTERM_PANE',
	'ZELLIJ',
	'ZELLIJ_PANE_ID',
	'ZELLIJ_SESSION_NAME',
	'CMUX_SURFACE_ID',
	'CMUX_WORKSPACE_ID',
	'OTTY_PANE_ID',
	'OTTY_SOCKET',
	'CYBER_MUX',
	'CYBER_MUX_PANE',
]

/**
 * Run the real runner inside a constructed world. Stripping `MUX_ENV` is what lets this suite run
 * from anywhere — the refusal guard is correct to fire in a real shell inside a multiplexer, but
 * here the subprocess genuinely is not in one, so refusing would be the wrong answer.
 */
function runInWorld(bin: string, ...args: string[]): { stdout: string; code: number } {
	// The world dir comes FIRST so its entries shadow any real install (tmux, for instance, is
	// commonly present at /bin/tmux as well as in a package manager's prefix). `/usr/bin` and `/bin`
	// follow because `npx` — which the runner uses to spawn vitest — needs a working base
	// environment and fails obscurely without one. They are safe to include: no multiplexer this
	// project drives installs there other than tmux, which every test below wants visible anyway,
	// and `assertAbsent` re-checks that per test rather than trusting this reasoning.
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: [bin, '/usr/bin', '/bin'].join(':') }
	for (const key of MUX_ENV) delete env[key]
	try {
		const stdout = execFileSync(join(bin, 'npx'), ['tsx', RUNNER, ...args], {
			cwd: PKG,
			encoding: 'utf8',
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		return { stdout, code: 0 }
	} catch (err) {
		const e = err as { stdout?: string; status?: number }
		return { stdout: e.stdout ?? '', code: e.status ?? 1 }
	}
}

/** The line `--all` printed for one adapter. */
function lineFor(stdout: string, name: string): string {
	return stdout.split('\n').find((l) => l.startsWith(name)) ?? ''
}

/**
 * Fail loudly if an adapter a scenario needs ABSENT is reachable anyway on this machine. Without
 * this, a host that ships one of them somewhere on the base PATH would silently turn a `skip`
 * assertion into a different outcome and the test would report on a world it did not build.
 */
function assertAbsent(stdout: string, names: readonly string[]): void {
	for (const name of names) {
		expect(lineFor(stdout, name), `${name} was expected absent from the constructed world`).toContain('skip')
	}
}

describe('spec:cyber-mux/conformance', () => {
	describe('--all — the real boundary, in a constructed world', () => {
		it('conformance-all-reports-each-and-summarizes', () => {
			// tmux really passes, wezterm is installed with no suite (gap), everything else is absent
			// (skip) — the frozen scenario's exact shape, built rather than hoped for.
			const bin = makeWorld({ tmux: 'real', wezterm: 'real' })
			const { stdout } = runInWorld(bin, '--all')

			expect(lineFor(stdout, 'tmux')).toContain('pass')
			expect(lineFor(stdout, 'wezterm')).toContain('gap')
			assertAbsent(stdout, ['herdr', 'zellij', 'cmux', 'otty'])

			// Every adapter on its own line, then the summary of the counts.
			const summary = stdout.trimEnd().split('\n').at(-1) ?? ''
			expect(summary).toMatch(/^6 adapters — /)
			expect(summary).toContain('pass=1')
			expect(summary).toContain('gap=1')
			expect(summary).toContain('skip=4')
		})

		it('conformance-all-exits-nonzero-on-any-bad-outcome', () => {
			// Row 1 — gap, paired with a genuine pass, so this row also proves a passing adapter does
			// not mask a failing neighbour.
			const gap = runInWorld(makeWorld({ tmux: 'real', wezterm: 'real' }), '--all')
			expect(lineFor(gap.stdout, 'tmux')).toContain('pass')
			expect(lineFor(gap.stdout, 'wezterm')).toContain('gap')
			expect(gap.code).toBe(1)

			// Row 2 — no-coverage: tmux is on PATH but broken, so its suite's own gate skips every
			// test and vitest still exits 0 reporting success. This is the case the whole tool exists
			// for, driven end to end.
			const nocov = runInWorld(makeWorld({ tmux: 'broken' }), '--all')
			expect(lineFor(nocov.stdout, 'tmux')).toContain('no-coverage')
			expect(nocov.code).toBe(1)

			// Row 3 — fail: tmux answers `-V` so the suite's gate opens, then fails every real
			// command, so tests genuinely execute and genuinely fail.
			const fail = runInWorld(makeWorld({ tmux: 'failing' }), '--all')
			expect(lineFor(fail.stdout, 'tmux')).toContain('fail')
			expect(fail.code).toBe(1)

			// NOTE: rows 2 and 3 carry no passing partner. Only tmux can be made to pass safely — its
			// suite runs against a private `-L` socket — and herdr, the only other suite-carrying
			// adapter, has no throwaway server, so pairing against it would drive the operator's live
			// session. Row 1 covers the does-a-pass-mask-a-bad-neighbour half; rows 2 and 3 cover only
			// that their own outcome reaches the exit code.
		})

		it('conformance-all-exits-zero-when-nothing-bad', () => {
			// tmux passes and every other adapter is absent, so nothing is bad. wezterm is deliberately
			// NOT in this world: it is suiteless, so its presence would force a gap and make exit 0
			// unreachable — which is precisely why the world has to be built rather than observed.
			const bin = makeWorld({ tmux: 'real' })
			const { stdout, code } = runInWorld(bin, '--all')

			expect(lineFor(stdout, 'tmux')).toContain('pass')
			assertAbsent(stdout, ['herdr', 'wezterm', 'zellij', 'cmux', 'otty'])
			// Skip must not be able to fail the run, or a machine with one multiplexer could never
			// report success.
			expect(code).toBe(0)
		})
	})
})
