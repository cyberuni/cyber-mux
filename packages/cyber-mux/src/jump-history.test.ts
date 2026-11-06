import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMux } from './backend.ts'
import type { Exec } from './exec.ts'
import {
	focusAndRecord,
	focusBack,
	JumpBackError,
	type JumpStore,
	jumpStatePath,
	nodeJumpStore,
	withJumpHistory,
} from './jump-history.ts'
import { tmuxMuxAdapter } from './mux.tmux.ts'
import type { LivePane, MuxAdapter } from './mux.ts'

const exec: Exec = () => null

function memoryStore(): JumpStore & { contents: string | null } {
	return {
		contents: null,
		read() {
			return this.contents
		},
		write(contents) {
			this.contents = contents
		},
	}
}

/**
 * A tmux server with live panes, a view that moves when focused, and one shared history file. `jump`
 * is a focus run in `from` (the pane the CLI or a unit is called in); `back` is `focus --back` run in
 * `from`. `restart` brings up a new server on the same socket — same pane ids, new pid (S10).
 */
function world(...panes: string[]) {
	const live = new Set(panes)
	const views: string[] = []
	const store = memoryStore()
	let pid = 100
	let clock = 0
	const adapter = {
		name: 'tmux',
		focus(_exec: Exec, target: { id: string }) {
			if (!live.has(target.id)) throw new Error(`can't find pane: ${target.id}`)
			views.push(target.id)
		},
		listPanes: () => [...live].map((id) => ({ id, mux: 'tmux' }) as LivePane),
		paneExists: (_exec: Exec, target: { id: string }) => live.has(target.id),
	} as unknown as MuxAdapter
	const ctx = (pane: string) => ({
		env: { TMUX: `/tmp/tmux-1000/default,${pid},0`, TMUX_PANE: pane },
		store,
		now: () => ++clock,
	})
	return {
		store,
		views,
		jump(from: string, to: string) {
			focusAndRecord(adapter, exec, { id: to }, ctx(from))
		},
		back(from: string): string {
			return focusBack(adapter, exec, ctx(from)).to
		},
		backError(from: string): JumpBackError {
			try {
				focusBack(adapter, exec, ctx(from))
			} catch (err) {
				if (err instanceof JumpBackError) return err
				throw err
			}
			throw new Error(`back from ${from} succeeded`)
		},
		close(pane: string) {
			live.delete(pane)
		},
		restart() {
			pid++
		},
	}
}

describe('jump history: focus records target ← source, focus --back follows it', () => {
	it('S1: A→B, back in B goes to A', () => {
		const w = world('A', 'B')
		w.jump('A', 'B')
		expect(w.back('B')).toBe('A')
		expect(w.views).toEqual(['B', 'A'])
	})

	it('S2: A→B→C, back in C then B goes to B then A', () => {
		const w = world('A', 'B', 'C')
		w.jump('A', 'B')
		w.jump('B', 'C')
		expect(w.back('C')).toBe('B')
		expect(w.back('B')).toBe('A')
	})

	it('S3: A→B, a manual move to C, C→D — back in B goes to A, back in D goes to C', () => {
		const w = world('A', 'B', 'C', 'D')
		w.jump('A', 'B')
		// The manual move from B to C goes through no focus call, so nothing is recorded for it.
		w.jump('C', 'D')
		expect(w.back('B')).toBe('A')
		expect(w.back('D')).toBe('C')
	})

	it('S4: A→B then C→B — back in B goes to C; the latest entry wins and A is no longer reachable', () => {
		const w = world('A', 'B', 'C')
		w.jump('A', 'B')
		w.jump('C', 'B')
		expect(w.back('B')).toBe('C')
		expect(w.store.contents).not.toContain('"A"')
	})

	it('S5: no jump into X fails, and the hint names the last jump origin', () => {
		const w = world('A', 'B', 'C', 'X')
		w.jump('A', 'B')
		w.jump('C', 'B')
		const err = w.backError('X')
		expect(err.code).toBe('no-jump')
		expect(err.message).toBe('no jump into X')
		expect(err.lastOrigin).toBe('C')
		expect(w.views).toEqual(['B', 'B'])
	})

	it('S5: with no history at all there is no origin to name', () => {
		const w = world('X')
		const err = w.backError('X')
		expect(err.code).toBe('no-jump')
		expect(err.lastOrigin).toBeUndefined()
	})

	it('S6: A→A records nothing', () => {
		const w = world('A')
		w.jump('A', 'A')
		expect(w.store.contents).toBeNull()
		expect(w.backError('A').code).toBe('no-jump')
	})

	it('S7: A→B then B→A as a jump — back in A goes to B, then back in B goes to A (a toggle)', () => {
		const w = world('A', 'B')
		w.jump('A', 'B')
		w.jump('B', 'A')
		expect(w.back('A')).toBe('B')
		expect(w.back('B')).toBe('A')
	})

	it('S8: A→B→C, then B closes — back in C skips B and follows its stored link to A', () => {
		const w = world('A', 'B', 'C')
		w.jump('A', 'B')
		w.jump('B', 'C')
		w.close('B')
		expect(w.back('C')).toBe('A')
	})

	it('S8: fails when every pane up the chain is gone', () => {
		const w = world('A', 'B', 'C')
		w.jump('A', 'B')
		w.jump('B', 'C')
		w.close('B')
		w.close('A')
		const err = w.backError('C')
		expect(err.code).toBe('chain-gone')
		expect(err.message).toBe('every pane back from C is gone')
		expect(w.views).toEqual(['B', 'C'])
	})

	it('S9: A→B, back to A — back in A goes to A own origin, not B; back records nothing', () => {
		const w = world('Z', 'A', 'B')
		w.jump('Z', 'A')
		w.jump('A', 'B')
		const before = w.store.contents
		expect(w.back('B')).toBe('A')
		expect(w.store.contents).toBe(before)
		expect(w.back('A')).toBe('Z')
	})

	it('S9: back into a pane with no origin of its own fails rather than returning to B', () => {
		const w = world('A', 'B')
		w.jump('A', 'B')
		expect(w.back('B')).toBe('A')
		expect(w.backError('A').code).toBe('no-jump')
	})

	it('S10: after the multiplexer restarts and reuses pane ids, links from the old server are ignored', () => {
		const w = world('A', 'B')
		w.jump('A', 'B')
		w.restart()
		expect(w.backError('B').code).toBe('no-jump')
		// The old server's links are dropped, not just skipped: a socket hosts one server at a time.
		w.jump('B', 'A')
		const servers = JSON.parse(w.store.contents!).servers
		expect(servers).toHaveLength(1)
		expect(servers[0].run).toBe('101')
	})

	it('S11: two terminals attached to one session — the latest entry into B wins, as in S4', () => {
		const w = world('A', 'B', 'C')
		// Terminal 1 jumps A→B, terminal 2 jumps C→B; history is not kept per terminal.
		w.jump('A', 'B')
		w.jump('C', 'B')
		expect(w.back('B')).toBe('C')
	})

	it('removes links to panes that no longer exist on read, keeping chains through them intact', () => {
		const w = world('A', 'B', 'C', 'D', 'E')
		w.jump('A', 'B')
		w.jump('B', 'C')
		w.jump('D', 'E')
		w.close('B')
		w.close('E')
		expect(w.back('C')).toBe('A')
		const links = JSON.parse(w.store.contents!).servers[0].links
		expect(Object.keys(links).sort()).toEqual(['C'])
		expect(links.C.from).toBe('A')
	})

	it('records nothing when the focus is not called from a pane of the same multiplexer', () => {
		const store = memoryStore()
		const adapter = { name: 'tmux', focus: () => {} } as unknown as MuxAdapter
		focusAndRecord(adapter, exec, { id: 'B' }, { env: {}, store })
		focusAndRecord(adapter, exec, { id: 'B' }, { env: { HERDR_PANE_ID: 'w1:p1' }, store })
		expect(store.contents).toBeNull()
	})

	it('a failed focus records nothing', () => {
		const w = world('A')
		expect(() => w.jump('A', 'gone')).toThrow()
		expect(w.store.contents).toBeNull()
	})

	it('reads an unreadable or foreign history file as empty instead of failing', () => {
		const w = world('A', 'B')
		w.store.contents = '{not json'
		w.jump('A', 'B')
		expect(w.back('B')).toBe('A')
	})

	it('back needs a caller pane', () => {
		const adapter = { name: 'tmux', focus: () => {} } as unknown as MuxAdapter
		expect(() => focusBack(adapter, exec, { env: {}, store: memoryStore() })).toThrow(
			expect.objectContaining({ code: 'no-caller-pane' }),
		)
	})
})

describe('the state file', () => {
	let dir: string | undefined

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true })
		dir = undefined
		vi.unstubAllEnvs()
	})

	it('lives at ~/.agents/cyber-mux/jumps.json unless CYBER_MUX_STATE_DIR moves it', () => {
		expect(jumpStatePath({})).toMatch(/\.agents\/cyber-mux\/jumps\.json$/)
		expect(jumpStatePath({ CYBER_MUX_STATE_DIR: '/state' })).toBe('/state/jumps.json')
	})

	it('is written atomically, creating its directory, with no temp file left behind', () => {
		dir = mkdtempSync(join(tmpdir(), 'cyber-mux-jumps-'))
		const path = join(dir, 'nested', 'jumps.json')
		const store = nodeJumpStore(path)
		expect(store.read()).toBeNull()
		store.write('{"version":1}')
		store.write('{"version":1,"servers":[]}')
		expect(readFileSync(path, 'utf8')).toBe('{"version":1,"servers":[]}')
		expect(readdirSync(join(dir, 'nested'))).toEqual(['jumps.json'])
	})

	it('the adapter focus the library exports records too, the API cyberlegion calls', () => {
		dir = mkdtempSync(join(tmpdir(), 'cyber-mux-jumps-'))
		vi.stubEnv('CYBER_MUX_STATE_DIR', dir)
		vi.stubEnv('CYBER_MUX_PANE', '')
		vi.stubEnv('TMUX', '/tmp/tmux-1000/default,100,0')
		vi.stubEnv('TMUX_PANE', '%1')
		const tmux: Exec = (_cmd, args) => (args.includes('list-panes') ? '%2 main @1' : '')
		tmuxMuxAdapter.focus(tmux, { id: '%2' })
		const file = JSON.parse(readFileSync(join(dir, 'jumps.json'), 'utf8'))
		expect(file.servers[0].links['%2'].from).toBe('%1')
	})

	it('a MuxSession records with the env it was resolved from', () => {
		dir = mkdtempSync(join(tmpdir(), 'cyber-mux-jumps-'))
		const env = { TMUX: '/tmp/tmux-1000/default,100,0', TMUX_PANE: '%1', CYBER_MUX_STATE_DIR: dir }
		const tmux: Exec = (cmd, args) => (cmd !== 'tmux' ? null : args.includes('list-panes') ? '%2 main @1' : '')
		resolveMux(env, { exec: tmux }).focus({ id: '%2' })
		const file = JSON.parse(readFileSync(join(dir, 'jumps.json'), 'utf8'))
		expect(file.servers[0].links['%2'].from).toBe('%1')
	})

	it('a history write that fails never fails the focus it rides on', () => {
		dir = mkdtempSync(join(tmpdir(), 'cyber-mux-jumps-'))
		// A FILE where the state directory should be, so creating the directory fails.
		const blocked = join(dir, 'blocked')
		writeFileSync(blocked, '')
		const focus = vi.fn()
		const wrapped = withJumpHistory({ name: 'tmux', focus } as unknown as MuxAdapter)
		vi.stubEnv('CYBER_MUX_STATE_DIR', join(blocked, 'state'))
		vi.stubEnv('CYBER_MUX_PANE', '')
		vi.stubEnv('TMUX_PANE', '%1')
		expect(() => wrapped.focus(exec, { id: '%2' })).not.toThrow()
		expect(focus).toHaveBeenCalledOnce()
		expect(existsSync(join(blocked, 'state'))).toBe(false)
	})
})
