import { CliError, cli } from 'clibuilder'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answer, fields, step, table, tildify } from './output.ts'

describe('tildify', () => {
	it('collapses the home prefix so a table spends no width on it', () => {
		expect(tildify('/home/ann/code/app', '/home/ann')).toBe('~/code/app')
	})

	it('collapses the home directory itself', () => {
		expect(tildify('/home/ann', '/home/ann')).toBe('~')
	})

	it('leaves a path that merely STARTS with the same string alone', () => {
		// `/home/annex` is not under `/home/ann` — the match is on a path boundary, not a prefix.
		expect(tildify('/home/annex/code', '/home/ann')).toBe('/home/annex/code')
	})

	it('leaves a path outside home alone', () => {
		expect(tildify('/srv/repo', '/home/ann')).toBe('/srv/repo')
	})

	it('collapses nothing when home is the root, which would swallow every absolute path', () => {
		expect(tildify('/srv/repo', '/')).toBe('/srv/repo')
	})
})

describe('fields', () => {
	it('aligns the keys and drops nullish entries', () => {
		expect(fields({ pane: '%1', workspace: null, branch: 'main' })).toBe('pane    %1\nbranch  main')
	})
})

describe('table', () => {
	it('prints an upper-case header and a rule', () => {
		expect(table([{ id: 'p1' }], [{ label: 'pane', get: (r) => r.id }])).toBe('PANE\n----\np1  ')
	})

	it('says (none) for no rows', () => {
		expect(table([], [{ label: 'pane', get: () => '' }])).toBe('(none)')
	})
})

describe('answers and errors through core --format', () => {
	let out: string[]

	beforeEach(() => {
		out = []
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			out.push(String(chunk))
			return true
		})
	})

	afterEach(() => {
		process.exitCode = undefined
		vi.restoreAllMocks()
	})

	const data = { panes: [{ id: 'p1', label: 'a' }] }

	function program(run: () => unknown) {
		return cli({ name: 'cyber-mux', version: '0.0.0', description: 'test', output: 'axi', format: 'text' }).default({
			description: 'test',
			run,
		})
	}

	it('renders the text form by default', async () => {
		await program(() => answer(data, () => 'human')).parse(['node', 'cyber-mux'])
		expect(out.join('')).toBe('human\n')
	})

	it('encodes json with core', async () => {
		await program(() => answer(data, () => 'human')).parse(['node', 'cyber-mux', '--format', 'json'])
		expect(JSON.parse(out.join(''))).toEqual(data)
	})

	it('encodes toon with core', async () => {
		await program(() => answer(data, () => 'human')).parse(['node', 'cyber-mux', '--format', 'toon'])
		expect(out.join('')).toBe('panes[1]{id,label}:\n  p1,a\n')
	})

	it('puts a step inside the answer as a help line', async () => {
		await program(() => answer(data, () => 'human', [step('see one', 'cyber-mux read p1')])).parse([
			'node',
			'cyber-mux',
			'--format',
			'json',
		])
		expect(JSON.parse(out.join(''))).toEqual({ ...data, help: ['see one — run `cyber-mux read p1`'] })
	})

	it('reports a CliError as a flat coded error in toon', async () => {
		await program(() => {
			throw new CliError({
				code: 'pane-not-found',
				message: 'no pane p9',
				help: 'list the live panes with: cyber-mux list',
			})
		}).parse(['node', 'cyber-mux', '--format', 'toon'])
		expect(out.join('')).toBe(
			'error: no pane p9\ncode: pane-not-found\nhelp[1]: "list the live panes with: cyber-mux list"\n',
		)
		expect(process.exitCode).toBe(1)
	})
})
