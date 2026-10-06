import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError, reportError } from './cli-error.ts'
import { isAutomatedOutput, output, tildify } from './output.ts'

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

describe('output --format', () => {
	let logs: string[]
	const original = process.argv

	function withFormat(...argv: string[]) {
		process.argv = ['node', 'cyber-mux', 'list', ...argv]
	}

	beforeEach(() => {
		logs = []
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			logs.push(line)
		})
	})

	afterEach(() => {
		process.argv = original
		vi.restoreAllMocks()
	})

	const data = { panes: [{ id: 'p1', label: 'a' }] }

	it('renders the human form by default', () => {
		withFormat()
		output(data, () => console.log('human'))
		expect(logs).toEqual(['human'])
		expect(isAutomatedOutput()).toBe(false)
	})

	it('encodes json through axi', () => {
		withFormat('--format', 'json')
		output(data, () => console.log('human'))
		expect(JSON.parse(logs.join('\n'))).toEqual(data)
		expect(isAutomatedOutput()).toBe(true)
	})

	it('keeps the hidden --json alias', () => {
		withFormat('--json')
		output(data, () => console.log('human'))
		expect(JSON.parse(logs.join('\n'))).toEqual(data)
	})

	it('encodes agent as TOON', () => {
		withFormat('--format', 'agent')
		output(data, () => console.log('human'))
		expect(logs.join('\n')).toBe('panes[1]{id,label}:\n  p1,a')
		expect(isAutomatedOutput()).toBe(true)
	})

	it('encodes a structured error as TOON under agent', () => {
		withFormat('--format', 'agent')
		vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		reportError(new CliError('pane-not-found', 'no pane p9', 'list the live panes with: cyber-mux list', 1))
		expect(logs.join('\n')).toBe(
			'error:\n  code: pane-not-found\n  message: no pane p9\n  help: "list the live panes with: cyber-mux list"',
		)
		expect(process.exit).toHaveBeenCalledWith(1)
	})
})
