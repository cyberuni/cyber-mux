/// <reference types="node" />

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The CLI at its real boundary: the built bin, and the built `mux` plugin mounted in a real clibuilder
 * host, each run as a child process.
 *
 * Help is printed by clibuilder through a console its logger binds once per process, so no in-process
 * spy can see it — the stream and the exit status are only observable from outside.
 */
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(pkgDir, 'bin', 'cyber-mux.mjs')
// No ancestry walk and no multiplexer: every case here is decided before a backend is reached.
const env = { ...process.env, CYBER_MUX: 'none' }

function cyberMux(...args: string[]) {
	return spawnSync(process.execPath, [bin, ...args], { cwd: pkgDir, env, encoding: 'utf8' })
}

/** A minimal host CLI that mounts the plugin exactly as clibuilder's plugin loader does. */
const HOST = `
import { cli } from 'clibuilder'
import { activate } from 'cyber-mux/plugin'
const commands = []
activate({
	addCommand: (c) => commands.push(c),
	register() {},
	get() {},
	has: () => false,
	host: { name: 'host', version: '1.0.0' },
})
const app = cli({ name: 'host', version: '1.0.0' }).default({ commands })
await app.parse(['node', 'host', ...process.argv.slice(1)])
`

function host(...args: string[]) {
	return spawnSync(process.execPath, ['--input-type=module', '-e', HOST, '--', ...args], {
		cwd: pkgDir,
		env,
		encoding: 'utf8',
	})
}

describe('spec:cyber-mux/cli — built bin', () => {
	it('@id:driving-send-bare-group — a bare group prints its subcommands on stdout and exits 2', () => {
		const r = cyberMux('send')
		expect(r.status).toBe(2)
		expect(r.stdout).toContain('text')
		expect(r.stdout).toContain('keys')
	})

	it('@id:lookup-help-never-unknown-flag — --help is help on stdout, exit 0', () => {
		const r = cyberMux('list', '--help')
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('--format')
		expect(`${r.stdout}${r.stderr}`).not.toContain('unknown')
	})

	it('a flag before a positional takes only its own value', () => {
		// `--lines 5 %1`: the 5 is the flag's, `%1` is the pane — so the invocation parses and fails later,
		// on the missing multiplexer, rather than as a usage error.
		const r = cyberMux('read', '--lines', '5', '%1')
		expect(r.status).toBe(1)
		expect(r.stdout).toContain('no-mux')
	})

	it('reports its package version', () => {
		const r = cyberMux('--version')
		expect(r.status).toBe(0)
		expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
	})
})

describe('spec:cyber-mux/cli — mux plugin', () => {
	it('mounts every verb under `mux` in the host', () => {
		const r = host('mux', 'mode')
		expect(r.status).toBe(0)
		expect(r.stdout.trim()).toBe('none')
	})

	it('reports a usage error on the coded surface, spelled through the host', () => {
		const r = host('mux', 'list', '--nope')
		expect(r.status).toBe(2)
		expect(r.stdout).toContain('unknown-flag')
		expect(r.stdout).toContain('--format')
		const missing = host('mux', 'worktree', 'open')
		expect(missing.status).toBe(2)
		expect(missing.stdout).toContain('host mux worktree open <path>')
	})

	it('answers a bare `mux` with its verbs and exit 2', () => {
		const r = host('mux')
		expect(r.status).toBe(2)
		expect(r.stdout).toContain('worktree')
	})
})
