import { describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { type LayoutStore, layoutDirs, listLayouts, resolveLayout } from './layout-store.ts'

const REPO_DIR = '/primary/.cyber-mux/layouts'
const USER_DIR = '/home/u/.config/cyber-mux/layouts'

/** The env every test resolves the user directory from — pinned, never the runner's real HOME. */
const ENV: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/home/u/.config' }

/**
 * git, answering only what `resolvePrimaryRoot` asks. The caller's cwd is deliberately irrelevant
 * here — that is the property the repo directory is supposed to have.
 */
const gitExec: Exec = (_cmd, args) => (args[0] === 'rev-parse' ? '/primary/.git' : null)

interface Recorder {
	reads: string[]
	lists: string[]
}

/** A `LayoutStore` over an in-memory file map, recording every path it is asked for. */
function fakeStore(files: Record<string, string>): LayoutStore & { calls: Recorder } {
	const calls: Recorder = { reads: [], lists: [] }
	return {
		calls,
		read(path) {
			calls.reads.push(path)
			return files[path] ?? null
		},
		list(dir) {
			calls.lists.push(dir)
			return Object.keys(files)
				.filter((path) => path.startsWith(`${dir}/`) && path.endsWith('.json'))
				.map((path) => path.slice(dir.length + 1, -'.json'.length))
				.sort()
		},
		dirExists: () => true,
		write(path, contents) {
			files[path] = contents
		},
	}
}

function template(name: string): string {
	return JSON.stringify({ name, panes: [{ label: 'a' }, { label: 'b' }] })
}

describe('spec:cyber-mux/layout', () => {
	describe('layoutDirs', () => {
		it('resolves the repo directory through the primary checkout, not the caller’s cwd', () => {
			// Load-bearing rather than incidental: cyber-mux is used across many worktrees of one project,
			// and a worktree branched from a commit that predates a template would otherwise see a stale
			// template, or none at all. `resolvePrimaryRoot` gives one canonical answer from every worktree.
			expect(layoutDirs(gitExec, ENV)).toEqual({ repo: REPO_DIR, user: USER_DIR })
		})

		it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
			expect(layoutDirs(gitExec, { HOME: '/home/u' }).user).toBe(USER_DIR)
		})
	})

	describe('resolveLayout', () => {
		it('--file skips resolution entirely — neither layouts directory is consulted', () => {
			const store = fakeStore({ './scratch/pool.json': template('pool') })
			const resolved = resolveLayout({ file: './scratch/pool.json', store, exec: gitExec, env: ENV })
			expect(resolved.source).toBe('file')
			expect(resolved.path).toBe('./scratch/pool.json')
			expect(resolved.raw).toBe(template('pool'))
			// The escape hatch is only an escape hatch if it actually escapes: no repo read, no user read.
			expect(store.calls.reads).toEqual(['./scratch/pool.json'])
			expect(store.calls.lists).toEqual([])
		})

		it('--file that cannot be read fails naming the path', () => {
			const store = fakeStore({})
			expect(() => resolveLayout({ file: './scratch/gone.json', store, exec: gitExec, env: ENV })).toThrow(
				/cannot read layout template: \.\/scratch\/gone\.json/,
			)
		})

		it('a repo template shadows a user template of the same name', () => {
			// Deliberate: a project that ships a layout is making a statement about how the project is
			// worked on, and a personal template of the same name must not silently displace it.
			const store = fakeStore({
				[`${REPO_DIR}/pool-4.json`]: template('pool-4'),
				[`${USER_DIR}/pool-4.json`]: JSON.stringify({ name: 'pool-4', panes: [{ label: 'mine' }] }),
			})
			const resolved = resolveLayout({ name: 'pool-4', store, exec: gitExec, env: ENV })
			expect(resolved.source).toBe('repo')
			expect(resolved.path).toBe(`${REPO_DIR}/pool-4.json`)
			expect(resolved.raw).toBe(template('pool-4'))
			// Repo won on the first read, so the user copy was never even opened.
			expect(store.calls.reads).toEqual([`${REPO_DIR}/pool-4.json`])
		})

		it('a user template resolves when the repo has none of that name', () => {
			const store = fakeStore({ [`${USER_DIR}/scratch.json`]: template('scratch') })
			const resolved = resolveLayout({ name: 'scratch', store, exec: gitExec, env: ENV })
			expect(resolved.source).toBe('user')
			expect(resolved.path).toBe(`${USER_DIR}/scratch.json`)
			// Repo first, then user — the order is the contract, so the miss is asserted too.
			expect(store.calls.reads).toEqual([`${REPO_DIR}/scratch.json`, `${USER_DIR}/scratch.json`])
		})

		it('the primary checkout’s template resolves from a worktree whose branch predates it', () => {
			// Reading ./.cyber-mux relative to the caller's cwd would report not-found here. The store
			// holds the file ONLY under the primary checkout, which is exactly the worktree case.
			const store = fakeStore({ [`${REPO_DIR}/pool-4.json`]: template('pool-4') })
			expect(resolveLayout({ name: 'pool-4', store, exec: gitExec, env: ENV }).path).toBe(`${REPO_DIR}/pool-4.json`)
		})

		it('a name that resolves nowhere lists both directories it searched', () => {
			const store = fakeStore({})
			expect(() => resolveLayout({ name: 'pool-9', store, exec: gitExec, env: ENV })).toThrow(
				new RegExp(`${REPO_DIR}.*${USER_DIR}`),
			)
		})

		// The stem rule is what makes traversal unreachable, and it must bite BEFORE a path is built
		// from the name — otherwise the rejection is decoration over a read that already happened.
		it.each([
			'../../../etc/pwd',
			'pool/../../out',
			'Pool-4',
			'-pool',
			'pool_4',
		])('refuses the name "%s" before any file is read', (name) => {
			const store = fakeStore({})
			expect(() => resolveLayout({ name, store, exec: gitExec, env: ENV })).toThrow(/invalid layout name/)
			expect(store.calls.reads).toEqual([])
			expect(store.calls.lists).toEqual([])
		})

		it('refuses a traversing name without even resolving the primary checkout', () => {
			// Nothing at all runs first — not git, not the store.
			const calls: string[][] = []
			const recordingExec: Exec = (_cmd, args) => {
				calls.push(args)
				return '/primary/.git'
			}
			expect(() =>
				resolveLayout({ name: '../../../etc/pwd', store: fakeStore({}), exec: recordingExec, env: ENV }),
			).toThrow(/invalid layout name/)
			expect(calls).toEqual([])
		})
	})

	describe('listLayouts', () => {
		it('reports each name’s source, marking the user template a repo template shadows', () => {
			const store = fakeStore({
				[`${REPO_DIR}/agent-pool-3.json`]: template('agent-pool-3'),
				[`${REPO_DIR}/pool-4.json`]: template('pool-4'),
				[`${USER_DIR}/pool-4.json`]: template('pool-4'),
				[`${USER_DIR}/scratch.json`]: template('scratch'),
			})
			expect(listLayouts(store, { repo: REPO_DIR, user: USER_DIR })).toEqual([
				{ name: 'agent-pool-3', source: 'repo', path: `${REPO_DIR}/agent-pool-3.json`, shadowed: false },
				{ name: 'pool-4', source: 'repo', path: `${REPO_DIR}/pool-4.json`, shadowed: false },
				// Reported, not omitted: a user whose pool-4 stopped being used deserves to be told why.
				{ name: 'pool-4', source: 'user', path: `${USER_DIR}/pool-4.json`, shadowed: true },
				{ name: 'scratch', source: 'user', path: `${USER_DIR}/scratch.json`, shadowed: false },
			])
		})

		it('reports a user template as unshadowed when the repo has none of that name', () => {
			const store = fakeStore({ [`${USER_DIR}/scratch.json`]: template('scratch') })
			expect(listLayouts(store, { repo: REPO_DIR, user: USER_DIR })).toEqual([
				{ name: 'scratch', source: 'user', path: `${USER_DIR}/scratch.json`, shadowed: false },
			])
		})

		it('reports nothing when neither directory holds a template', () => {
			expect(listLayouts(fakeStore({}), { repo: REPO_DIR, user: USER_DIR })).toEqual([])
		})
	})
})
