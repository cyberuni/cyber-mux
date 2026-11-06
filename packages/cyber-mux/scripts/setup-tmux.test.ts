// The setup-tmux skill's back key: `assets/cyber-mux.sh`, the wrapper its binding runs.
//
// A tmux binding runs in the tmux server, not in the pane: no `$TMUX_PANE`, no interactive shell,
// only the PATH the server started with. These tests run the wrapper under `sh` with a PATH that
// holds stubs and the few utilities it needs, so they prove where it looks for cyber-mux without
// any real tmux, node, or cyber-mux on the machine being reachable.

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const assets = join(pkgDir, 'skills/setup-tmux/assets')
const script = join(assets, 'cyber-mux.sh')
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }

/** The utilities the wrapper may call, linked into a private dir so nothing else on PATH leaks in. */
const UTILS = ['sh', 'sed', 'head', 'sort', 'tail']

let root: string
let home: string
let sys: string
let log: string

function stub(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `#!/bin/sh\n${body}\n`)
	chmodSync(path, 0o755)
}

/** A stub that logs its name, the pane env it was given, and its argv, then exits as `$STUB_EXIT`. */
function cli(path: string, name: string): void {
	stub(
		path,
		`printf '%s CYBER_MUX=%s CYBER_MUX_PANE=%s args=%s\\n' ${name} "$CYBER_MUX" "$CYBER_MUX_PANE" "$*" >> "${log}"
[ -n "$STUB_OUT" ] && printf '%s\\n' "$STUB_OUT"
exit "\${STUB_EXIT:-0}"`,
	)
}

function run(env: Record<string, string> = {}, args = ['%7', 'focus', '--back']) {
	const stdout = execFileSync(join(sys, 'sh'), [script, ...args], {
		env: { HOME: home, PATH: sys, ...env },
		encoding: 'utf8',
	})
	let calls = ''
	try {
		calls = readFileSync(log, 'utf8')
	} catch {}
	return { stdout, calls: calls.trim().split('\n').filter(Boolean) }
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'cyber-mux-back-'))
	home = join(root, 'home')
	sys = join(root, 'sys')
	log = join(root, 'calls.log')
	mkdirSync(home, { recursive: true })
	mkdirSync(sys, { recursive: true })
	for (const util of UTILS) {
		const real = execFileSync('/bin/sh', ['-c', `command -v ${util}`], { encoding: 'utf8' }).trim()
		symlinkSync(real, join(sys, util))
	}
	stub(join(sys, 'tmux'), `printf 'tmux %s\\n' "$*" >> "${log}"`)
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('setup-tmux back key wrapper', () => {
	it('runs cyber-mux from the PATH for the pane it is given, as a tmux pane', () => {
		cli(join(sys, 'cyber-mux'), 'path')
		const { stdout, calls } = run()
		expect(calls).toEqual(['path CYBER_MUX=tmux CYBER_MUX_PANE=%7 args=focus --back'])
		expect(stdout).toBe('')
	})

	it('runs $CYBER_MUX_BIN before anything on the PATH', () => {
		cli(join(sys, 'cyber-mux'), 'path')
		cli(join(root, 'override/run'), 'override')
		const { calls } = run({ CYBER_MUX_BIN: `${join(root, 'override/run')} --extra` })
		expect(calls).toEqual(['override CYBER_MUX=tmux CYBER_MUX_PANE=%7 args=--extra focus --back'])
	})

	it.each([
		['~/.local/bin', '.local/bin'],
		['~/.local/share/mise/shims', '.local/share/mise/shims'],
		['pnpm global bin', '.local/share/pnpm'],
		['the newest nvm node', '.nvm/versions/node/v22.11.0/bin'],
	])('finds cyber-mux in %s when the server PATH lacks it', (_, dir) => {
		cli(join(home, dir, 'cyber-mux'), 'home')
		const { calls } = run()
		expect(calls).toEqual(['home CYBER_MUX=tmux CYBER_MUX_PANE=%7 args=focus --back'])
	})

	it('prefers the newest nvm node over an older one', () => {
		cli(join(home, '.nvm/versions/node/v9.0.0/bin/cyber-mux'), 'old')
		cli(join(home, '.nvm/versions/node/v22.11.0/bin/cyber-mux'), 'new')
		expect(run().calls).toEqual(['new CYBER_MUX=tmux CYBER_MUX_PANE=%7 args=focus --back'])
	})

	it('prefers a numbered mise node over its lts and latest aliases', () => {
		cli(join(home, '.local/share/mise/installs/node/lts/bin/cyber-mux'), 'alias')
		cli(join(home, '.local/share/mise/installs/node/24.15.0/bin/cyber-mux'), 'numbered')
		expect(run().calls).toEqual(['numbered CYBER_MUX=tmux CYBER_MUX_PANE=%7 args=focus --back'])
	})

	it('falls back to npx with the pinned package version', () => {
		cli(join(home, '.local/bin/npx'), 'npx')
		const { calls } = run()
		expect(calls).toEqual([`npx CYBER_MUX=tmux CYBER_MUX_PANE=%7 args=--yes cyber-mux@${version} focus --back`])
	})

	it('shows the first line of a failure as a tmux message on that pane, not in it', () => {
		cli(join(sys, 'cyber-mux'), 'path')
		const { stdout, calls } = run({
			STUB_EXIT: '1',
			STUB_OUT: 'error: no-jump: no jump into %7 #{x}\nhelp: the last jump came from %3',
		})
		expect(stdout).toBe('')
		expect(calls).toEqual([
			'path CYBER_MUX=tmux CYBER_MUX_PANE=%7 args=focus --back',
			'tmux display-message -t %7 cyber-mux: error: no-jump: no jump into %7 ##{x}',
		])
	})

	it('says how to point it at cyber-mux when none is found', () => {
		const { stdout, calls } = run()
		expect(stdout).toBe('')
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatch(/^tmux display-message -t %7 cyber-mux: not found.*CYBER_MUX_BIN/)
	})
})

describe('setup-tmux back key binding', () => {
	const binding = readFileSync(join(assets, 'cyber-mux.conf'), 'utf8')

	it('binds prefix+B to focus --back for the pane the key was pressed in, in the background', () => {
		expect(binding).toMatch(/^bind B run-shell -b '~\/\.config\/tmux\/cyber-mux\.sh "#\{pane_id\}" focus --back'$/m)
	})

	it('is loaded by the full config', () => {
		expect(readFileSync(join(assets, 'tmux.conf'), 'utf8')).toMatch(
			/^source-file -q ~\/\.config\/tmux\/cyber-mux\.conf$/m,
		)
	})
})
