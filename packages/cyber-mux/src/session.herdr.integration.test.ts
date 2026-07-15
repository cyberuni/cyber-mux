import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrSessionAdapter } from './session.herdr.ts'

function hasHerdr(): boolean {
	try {
		execFileSync('herdr', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/**
 * Unlike tmux, herdr has no throwaway-server mode (`-L`) — every command hits the ONE real, shared
 * server (`herdr status` — one socket, all workspaces). `open({at:'workspace'})` is genuinely
 * isolated (a brand new workspace, untouched by the caller's own context), so it's safe to run for
 * real even from inside a live herdr pane.
 *
 * `tab create` (no `--workspace` target), `pane split --current`, `focus()` (beams the ATTACHED
 * CLIENT's view), and `openInNewWorktree` all resolve against the CALLER's own current
 * pane/workspace/tab — running those for real from inside a herdr pane would touch (add a tab to,
 * split, or yank focus away from) that very pane, potentially this very session's own. They are
 * gated behind `insideHerdrPane` and only actually execute when this suite is run from a plain
 * shell outside any herdr pane (`HERDR_PANE_ID` unset) — e.g. `pnpm test:integration` from a
 * terminal that isn't itself a herdr pane.
 */
const insideHerdrPane = Boolean(process.env.HERDR_PANE_ID)

const realExec: Exec = (cmd, args) => {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	} catch {
		return null
	}
}

function paneLocation(id: string): { workspaceId?: string; tabId?: string } {
	const out = realExec('herdr', ['pane', 'get', id])
	try {
		const pane = JSON.parse(out ?? '')?.result?.pane
		return { workspaceId: pane?.workspace_id, tabId: pane?.tab_id }
	} catch {
		return {}
	}
}

async function pollUntil(read: () => string, done: (out: string) => boolean, timeoutMs = 2000): Promise<string> {
	const start = Date.now()
	let out = read()
	while (!done(out) && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 50))
		out = read()
	}
	return out
}

describe.skipIf(!hasHerdr())('spec:cyber-mux/mux', () => {
	describe('herdrSessionAdapter — real herdr boundary (isolated workspace, always safe)', () => {
		let cwd: string
		let target: { id: string }
		let workspaceId: string | undefined

		beforeAll(() => {
			cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-itest-'))
			target = herdrSessionAdapter.open(realExec, { cwd, launch: 'sh', at: 'workspace' })
			workspaceId = paneLocation(target.id).workspaceId
		})

		afterAll(() => {
			try {
				herdrSessionAdapter.teardown(realExec, target)
			} catch {
				// already gone
			}
			if (workspaceId) {
				try {
					execFileSync('herdr', ['workspace', 'close', workspaceId], { stdio: 'ignore' })
				} catch {
					// already gone
				}
			}
			rmSync(cwd, { recursive: true, force: true })
		})

		it("open({at:'workspace'}) actually creates a real, separate workspace the real herdr binary reports back", () => {
			expect(target.id).toMatch(/^w\S+:p\S+$/)
			expect(herdrSessionAdapter.paneExists(realExec, target)).toBe(true)
		})

		it('listPanes() runs against the real server and returns the live shape', () => {
			const panes = herdrSessionAdapter.listPanes(realExec)
			expect(Array.isArray(panes)).toBe(true)
		})

		it('send()/read() actually type into and capture from a real pane', async () => {
			herdrSessionAdapter.send(realExec, target, 'echo cyber-mux-itest-marker')
			const output = await pollUntil(
				() => herdrSessionAdapter.read(realExec, target),
				(out) => out.includes('cyber-mux-itest-marker'),
			)
			expect(output).toContain('cyber-mux-itest-marker')
		})

		it('teardown() actually closes the real pane', () => {
			herdrSessionAdapter.teardown(realExec, target)
			expect(herdrSessionAdapter.paneExists(realExec, target)).toBe(false)
		})
	})

	describe.skipIf(insideHerdrPane)(
		'herdrSessionAdapter — real herdr boundary (current-pane context, run outside a herdr pane only)',
		() => {
			let cwd: string

			beforeAll(() => {
				cwd = mkdtempSync(join(tmpdir(), 'cyber-mux-itest-'))
			})

			afterAll(() => {
				rmSync(cwd, { recursive: true, force: true })
			})

			it("open({at:'tab'}) actually creates a real tab", () => {
				const target = herdrSessionAdapter.open(realExec, { cwd, launch: 'sh', at: 'tab' })
				expect(target.id).toMatch(/^w\S+:p\S+$/)
				expect(herdrSessionAdapter.paneExists(realExec, target)).toBe(true)
				const { tabId } = paneLocation(target.id)
				herdrSessionAdapter.teardown(realExec, target)
				if (tabId) {
					try {
						execFileSync('herdr', ['tab', 'close', tabId], { stdio: 'ignore' })
					} catch {
						// already gone
					}
				}
			})

			it("open({at:'pane:right'}) actually splits the caller's current pane", () => {
				const target = herdrSessionAdapter.open(realExec, { cwd, launch: 'sh', at: 'pane:right' })
				expect(target.id).toMatch(/^w\S+:p\S+$/)
				expect(herdrSessionAdapter.paneExists(realExec, target)).toBe(true)
				herdrSessionAdapter.teardown(realExec, target)
			})

			it('openInNewWorktree() actually creates a real git worktree and opens it', () => {
				const repoRoot = mkdtempSync(join(tmpdir(), 'cyber-mux-itest-repo-'))
				execFileSync('git', ['init', '-q', repoRoot])
				execFileSync('git', [
					'-C',
					repoRoot,
					'-c',
					'user.email=itest@cyber-mux.local',
					'-c',
					'user.name=cyber-mux itest',
					'commit',
					'-q',
					'--allow-empty',
					'-m',
					'init',
				])
				const worktreePath = join(tmpdir(), `cyber-mux-itest-wt-${process.pid}`)
				try {
					const result = herdrSessionAdapter.openInNewWorktree?.(realExec, {
						primaryRoot: repoRoot,
						branch: 'cyber-mux/itest',
						path: worktreePath,
						launch: 'sh',
					})
					expect(result?.target.id).toMatch(/^w\S+:p\S+$/)
					expect(result?.worktree.root).toBe(worktreePath)
					if (result) herdrSessionAdapter.teardown(realExec, result.target)
				} finally {
					rmSync(worktreePath, { recursive: true, force: true })
					rmSync(repoRoot, { recursive: true, force: true })
				}
			})
		},
	)
})
