import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.ts'
import type { Exec } from './exec.ts'

/** No ancestry available — forces every probe onto the env fast-path/hint, deterministic in CI. */
const noAncestry: Exec = () => null

function run(program: Command, args: string[]) {
	return program.parseAsync(args, { from: 'user' })
}

describe('spec:cyber-mux/mux', () => {
	describe('cli', () => {
		let logs: string[]

		beforeEach(() => {
			logs = []
			vi.spyOn(console, 'log').mockImplementation((line: string) => {
				logs.push(line)
			})
		})

		afterEach(() => {
			vi.restoreAllMocks()
		})

		it('doctor reports the detected mux and prints a pin hint', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'tmux', CYBER_MUX_PANE: '%3' }, exec: noAncestry })
			await run(program, ['doctor'])
			const out = logs.join('\n')
			expect(out).toContain('tmux')
			expect(out).toContain('%3')
			expect(out).toContain('backend')
			expect(out).toContain('export CYBER_MUX=tmux CYBER_MUX_PANE=%3')
		})

		it('mode reports the detected session backend', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
			await run(program, ['mode'])
			expect(logs).toEqual(['tmux'])
		})

		it('mode reports none when no backend is selectable', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'none' }, exec: noAncestry })
			await expect(run(program, ['mode'])).resolves.toBeDefined()
			expect(logs).toEqual(['none'])
		})

		it('--at accepts only pane:right, pane:down, tab, and workspace', async () => {
			const program = buildProgram({ env: { CYBER_MUX: 'tmux' }, exec: noAncestry })
			await expect(run(program, ['open', '--launch', 'claude', '--at', 'bogus'])).rejects.toThrow()
		})
	})
})
