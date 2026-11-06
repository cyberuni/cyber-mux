// The setup-tmux back key against a real tmux: the installed config binds prefix+B, and pressing it
// in a pane that was jumped into returns to the pane the jump came from, from a busy pane and from a
// plain shell pane, without typing anything into either.
//
// A detached server has no client to press keys on, so the test runs the command bound to the key
// with `source-file`. tmux resolves `#{pane_id}` in it against the active pane, exactly as for a
// keypress in that pane. It drives this package's own build (`bin/cyber-mux.mjs`, so it needs
// `pnpm build`) through `$CYBER_MUX_BIN`; where the wrapper looks without it is covered by
// `setup-tmux.test.ts`.

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const assets = join(pkgDir, 'skills/setup-tmux/assets')

function which(bin: string): string | undefined {
	try {
		return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || undefined
	} catch {
		return undefined
	}
}

const tmuxBin = which('tmux')
const socket = `cyber-mux-back-${process.pid}`

let root: string
let env: NodeJS.ProcessEnv

function tmux(...args: string[]): string {
	return execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8' }).trim()
}

function activePane(): string {
	return tmux('display-message', '-p', '#{pane_id}')
}

/** Press prefix+B in the active pane: run the command the server has bound to it. */
function pressBack(): void {
	const line = tmux('list-keys', '-T', 'prefix')
		.split('\n')
		.find((l) => /^bind-key +(-r +)?-T prefix +B /.test(l))
	if (!line) throw new Error('prefix+B is not bound')
	const file = join(root, 'press.conf')
	writeFileSync(file, `${line.replace(/^bind-key +(-r +)?-T prefix +B +/, '')}\n`)
	tmux('source-file', file)
}

/** Record a jump into `to` from `from`, the way `cyber-mux focus` run in `from` does. */
function jump(from: string, to: string): void {
	tmux('run-shell', '-t', from, `CYBER_MUX=tmux CYBER_MUX_PANE='#{pane_id}' $CYBER_MUX_BIN focus ${to}`)
}

async function waitForActive(pane: string): Promise<string> {
	let seen = ''
	for (let i = 0; i < 100; i++) {
		seen = activePane()
		if (seen === pane) return seen
		await new Promise((r) => setTimeout(r, 50))
	}
	return seen
}

describe.skipIf(!tmuxBin)('setup-tmux back key (real tmux)', () => {
	let shellPane: string
	let busyPane: string

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'cyber-mux-back-int-'))
		const home = join(root, 'home')
		mkdirSync(join(home, '.config/tmux'), { recursive: true })
		copyFileSync(join(assets, 'cyber-mux.sh'), join(home, '.config/tmux/cyber-mux.sh'))
		// The skill installs the wrapper with `chmod +x`: the repo copy is not executable.
		chmodSync(join(home, '.config/tmux/cyber-mux.sh'), 0o755)
		copyFileSync(join(assets, 'cyber-mux.conf'), join(home, '.config/tmux/cyber-mux.conf'))
		// The server gets no user PATH: only where tmux and the system utilities live.
		const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env
		env = {
			...rest,
			HOME: home,
			PATH: [dirname(tmuxBin as string), '/usr/bin', '/bin'].join(':'),
			CYBER_MUX_BIN: `${process.execPath} ${join(pkgDir, 'bin/cyber-mux.mjs')}`,
			CYBER_MUX_STATE_DIR: join(root, 'state'),
		}
		// The full installed config, without herdr.sh: its sidebar hooks fail quietly, so no extra pane.
		shellPane = tmux(
			'-f',
			join(assets, 'tmux.conf'),
			'new-session',
			'-d',
			'-x',
			'120',
			'-y',
			'30',
			'-P',
			'-F',
			'#{pane_id}',
		)
		busyPane = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', 'sh -c "echo busy; exec sleep 600"')
	})

	afterAll(() => {
		try {
			tmux('kill-server')
		} catch {}
		rmSync(root, { recursive: true, force: true })
	})

	it('binds prefix+B to cyber-mux focus --back through the wrapper', () => {
		expect(tmux('list-keys', '-T', 'prefix')).toMatch(
			/^bind-key +-T prefix +B +run-shell -b .*cyber-mux\.sh .*#\{pane_id\}.* focus --back/m,
		)
	})

	it('returns from a busy pane to the pane it was jumped into from, typing nothing into it', async () => {
		jump(shellPane, busyPane)
		expect(await waitForActive(busyPane)).toBe(busyPane)
		const before = tmux('capture-pane', '-p', '-t', busyPane)

		pressBack()

		expect(await waitForActive(shellPane)).toBe(shellPane)
		expect(tmux('capture-pane', '-p', '-t', busyPane)).toBe(before)
	})

	it('returns from a plain shell pane', async () => {
		jump(busyPane, shellPane)
		expect(await waitForActive(shellPane)).toBe(shellPane)

		pressBack()

		expect(await waitForActive(busyPane)).toBe(busyPane)
	})
})
