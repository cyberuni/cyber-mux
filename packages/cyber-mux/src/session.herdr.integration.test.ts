import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
 * `tab create` (no `--workspace` target), `pane split --current`, and `focus()` (beams the ATTACHED
 * CLIENT's view) all resolve against the CALLER's own current pane/workspace/tab — running those for
 * real from inside a herdr pane would touch (add a tab to, split, or yank focus away from) that very
 * pane, potentially this very session's own. They are gated behind `insideHerdrPane` and only
 * actually execute when this suite is run from a plain shell outside any herdr pane
 * (`HERDR_PANE_ID` unset) — e.g. `pnpm test:integration` from a terminal that isn't itself a herdr
 * pane.
 *
 * The `worktree` capability is NOT gated: every call pins its source with `--cwd <primaryRoot>` — a
 * scratch repo here — and opens `--no-focus`, so like `open({at:'workspace'})` it resolves against
 * nothing the caller owns.
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
		},
	)

	/**
	 * The whole design rests on facts about herdr that no mocked `Exec` can check: that only the
	 * `worktree` route binds a workspace to a repo, and that closing a workspace releases the binding
	 * WITHOUT deleting the checkout (which is what lets `removeWorktree` keep its own gates and still
	 * hand the removal to git). Pin them here as executable facts rather than as prose.
	 */
	describe('herdrSessionAdapter.worktree — real herdr boundary (scratch repo, no caller context)', () => {
		const worktree = herdrSessionAdapter.worktree

		function scratchRepo(): string {
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
			return repoRoot
		}

		/** The `worktree` block herdr puts on a workspace it has bound to a repo — the group itself. */
		function workspaceBinding(workspace: string): { repo_root?: string; checkout_path?: string } | undefined {
			const out = realExec('herdr', ['workspace', 'get', workspace])
			try {
				return JSON.parse(out ?? '')?.result?.workspace?.worktree
			} catch {
				return undefined
			}
		}

		/**
		 * Close every workspace herdr has bound to this repo. Creating a worktree implicitly opens a
		 * workspace for the SOURCE checkout too — a group needs its parent — so releasing only the
		 * worktree's own workspace leaks the source's. `bindings` sees both (the primary is a worktree
		 * as far as git is concerned), which makes it the honest way to sweep.
		 */
		function releaseAll(repoRoot: string): void {
			for (const workspace of worktree!.bindings(realExec, { primaryRoot: repoRoot }).values()) {
				worktree!.releaseWorkspace(realExec, workspace)
			}
		}

		it('is implemented — herdr binds worktrees to workspaces', () => {
			expect(worktree).toBeDefined()
		})

		it('createInWorkspace() creates a real worktree whose workspace herdr has BOUND to the repo', () => {
			const repoRoot = scratchRepo()
			const path = join(tmpdir(), `cyber-mux-itest-wt-${process.pid}`)
			try {
				const created = worktree!.createInWorkspace(realExec, {
					primaryRoot: repoRoot,
					branch: 'cyber-mux/itest',
					path,
					launch: 'sh',
				})
				expect(created.target.id).toMatch(/^w\S+:p\S+$/)
				expect(created.worktree.root).toBe(path)
				// The binding — what `git worktree add` + `workspace create --cwd` does NOT produce, and
				// the entire reason this capability exists.
				expect(workspaceBinding(created.workspace)).toMatchObject({ repo_root: repoRoot, checkout_path: path })
				// ...and the repo can see which workspace its worktree is open in.
				expect(worktree!.bindings(realExec, { primaryRoot: repoRoot }).get(path)).toBe(created.workspace)
			} finally {
				releaseAll(repoRoot)
				execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], { stdio: 'ignore' })
				rmSync(path, { recursive: true, force: true })
				rmSync(repoRoot, { recursive: true, force: true })
			}
		})

		it('releaseWorkspace() drops the binding and LEAVES the checkout on disk for git to remove', () => {
			const repoRoot = scratchRepo()
			const path = join(tmpdir(), `cyber-mux-itest-wt-release-${process.pid}`)
			try {
				const created = worktree!.createInWorkspace(realExec, { primaryRoot: repoRoot, branch: 'cyber-mux/rel', path })
				worktree!.releaseWorkspace(realExec, created.workspace)
				// The binding is gone...
				expect(worktree!.bindings(realExec, { primaryRoot: repoRoot }).has(path)).toBe(false)
				// ...but the checkout is untouched, which is what lets removeWorktree keep its own gates
				// and still hand the actual removal to git.
				expect(existsSync(join(path, '.git'))).toBe(true)
			} finally {
				releaseAll(repoRoot)
				execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], { stdio: 'ignore' })
				rmSync(path, { recursive: true, force: true })
				rmSync(repoRoot, { recursive: true, force: true })
			}
		})

		it('openInWorkspace() binds a worktree that plain git created — the add-now-group-later remedy', () => {
			const repoRoot = scratchRepo()
			const path = join(tmpdir(), `cyber-mux-itest-wt-open-${process.pid}`)
			try {
				// Created the plain way: no herdr involvement, so nothing is bound yet.
				execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '-b', 'cyber-mux/plain', path])
				expect(worktree!.bindings(realExec, { primaryRoot: repoRoot }).has(path)).toBe(false)

				const opened = worktree!.openInWorkspace(realExec, { primaryRoot: repoRoot, path })
				expect(opened.worktree.root).toBe(path)
				expect(workspaceBinding(opened.workspace)).toMatchObject({ repo_root: repoRoot, checkout_path: path })
			} finally {
				releaseAll(repoRoot)
				execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], { stdio: 'ignore' })
				rmSync(path, { recursive: true, force: true })
				rmSync(repoRoot, { recursive: true, force: true })
			}
		})

		it('bindings() reports nothing for a repo herdr has never opened', () => {
			const repoRoot = scratchRepo()
			try {
				expect(worktree!.bindings(realExec, { primaryRoot: repoRoot }).size).toBe(0)
			} finally {
				rmSync(repoRoot, { recursive: true, force: true })
			}
		})
	})
})
