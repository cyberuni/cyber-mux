import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Exec } from './exec.ts'
import type { LayoutTemplate } from './layout.ts'
import { applyLayoutToRegion, LayoutApplyError, openLayout } from './layout-session.ts'
import { herdrSessionAdapter } from './session.herdr.ts'
import { tmuxSessionAdapter } from './session.tmux.ts'
import type { SessionAdapter, SessionOpenOptions, SessionTarget } from './session.ts'

/** Every dir the walk asks about exists, unless a test says otherwise. */
const anyDir = () => true

/** tmux, handing out a fresh pane id per window/split so geometry is traceable in the argv. */
function tmuxExec(calls: string[][]): Exec {
	let n = 0
	return (_cmd, args) => {
		calls.push(args)
		if (args[0] === 'new-window' || args[0] === 'split-window') return `%${n++}`
		return ''
	}
}

/** herdr, same idea through its JSON envelopes. */
function herdrExec(calls: string[][]): Exec {
	let n = 0
	return (_cmd, args) => {
		calls.push(args)
		const key = args.slice(0, 2).join(' ')
		if (key === 'pane split') return JSON.stringify({ result: { pane: { pane_id: `w1:p${n++}` } } })
		if (key === 'workspace create' || key === 'tab create') {
			return JSON.stringify({ result: { root_pane: { pane_id: `w1:p${n++}` } } })
		}
		return ''
	}
}

interface Recorded {
	opens: SessionOpenOptions[]
	submits: { pane: string; text: string | undefined }[]
	teardowns: string[]
}

/**
 * A backend recorded at the SEAM rather than at the argv — for the claims that are about what the
 * walk asks of a backend (no launch, a named `from`, a ratio) rather than how a backend spells it.
 */
/**
 * `workspace` models a backend WITH a workspace tier: its `open` reports the workspace the pane
 * landed in. Omit it for a backend that has none (tmux), which reports absent.
 */
function fakeAdapter(opts: { canSizeSplits?: boolean; failOnOpen?: number; workspace?: string } = {}) {
	const calls: Recorded = { opens: [], submits: [], teardowns: [] }
	let n = 0
	const adapter: SessionAdapter = {
		name: 'fake',
		...(opts.canSizeSplits === false ? {} : { canSizeSplits: true }),
		open(_exec, options) {
			calls.opens.push(options)
			n++
			if (opts.failOnOpen === n) throw new Error('backend refused the split')
			return opts.workspace ? { id: `p${n}`, workspace: opts.workspace } : { id: `p${n}` }
		},
		submit(_exec, target, text) {
			calls.submits.push({ pane: target.id, text })
		},
		teardown(_exec, target) {
			calls.teardowns.push(target.id)
		},
		sendText: () => undefined,
		sendKeys: () => undefined,
		read: () => '',
		focus: () => undefined,
		paneExists: () => true,
		isPaneFocused: () => undefined,
		listPanes: () => [],
		describeRegion: () => {
			throw new Error('not used')
		},
	}
	return { adapter, calls }
}

const noExec: Exec = () => null

/** One planner over two workers — the tree form, written out. */
const agentPool3: LayoutTemplate = {
	name: 'agent-pool-3',
	root: {
		type: 'split',
		direction: 'right',
		ratio: 0.5,
		first: { type: 'pane', label: 'planner', command: 'claude' },
		second: {
			type: 'split',
			direction: 'down',
			ratio: 0.5,
			first: { type: 'pane', label: 'worker-a', command: 'claude' },
			second: { type: 'pane', label: 'worker-b', command: 'claude' },
		},
	},
}

const pool4: LayoutTemplate = {
	name: 'pool-4',
	arrange: 'tiled',
	panes: [{ label: 'w1' }, { label: 'w2' }, { label: 'w3' }, { label: 'w4' }],
}

/** A split's (direction, ratio) as tmux received it — `-l` inverted back to the seam's convention. */
function tmuxSplits(calls: string[][]) {
	return calls
		.filter((c) => c[0] === 'split-window')
		.map((c) => {
			const size = c.indexOf('-l')
			return {
				direction: c[1] === '-v' ? 'down' : 'right',
				ratio: size === -1 ? null : 1 - Number.parseInt(c[size + 1]!, 10) / 100,
			}
		})
}

/** The same, as herdr received it — `--ratio` needs no un-inverting, which is the whole point. */
function herdrSplits(calls: string[][]) {
	return calls
		.filter((c) => c[0] === 'pane' && c[1] === 'split')
		.map((c) => {
			const size = c.indexOf('--ratio')
			return {
				direction: c[c.indexOf('--direction') + 1],
				ratio: size === -1 ? null : Number(c[size + 1]!),
			}
		})
}

describe('spec:cyber-mux/layout', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('the walk', () => {
		it('opens the region blank and makes its pane the tree’s root, never a pane to close', () => {
			// `open`'s `launch` couples creation to launching, so reusing it would mean splitting a pane
			// already running an interactive agent — the split lands mid-render. The root pane is not a
			// wasted pane either: it is the region the walk splits INTO.
			const { adapter, calls } = fakeAdapter()
			const manifest = openLayout(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			expect(calls.opens[0]?.launch).toBeUndefined()
			expect(calls.opens[0]?.at).toBe('workspace')
			// The pane the region open returned IS the first leaf's pane, and it is never torn down.
			expect(manifest.panes[0]).toMatchObject({ label: 'planner', pane: 'p1' })
			expect(calls.teardowns).toEqual([])
		})

		// The bug this CR fixes: the manifest is framed as the complete machine-readable answer to
		// "which panes exist and what are they for", but its workspace was a hardcoded null, so a
		// consumer grouping panes by workspace had nothing to group on — even on a backend that had
		// just opened a real workspace and said so.
		it('the manifest carries the workspace the region opened in', () => {
			const { adapter } = fakeAdapter({ workspace: 'w45' })
			const manifest = openLayout(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			expect(manifest.workspace).toBe('w45')
		})

		// tmux has no workspace tier, so its `open` reports absent and the manifest has nothing to carry.
		// `null` is the manifest's JSON-boundary spelling of that — the one place absent becomes null.
		it('the manifest’s workspace is null on a backend with no workspace tier', () => {
			const { adapter } = fakeAdapter()
			const manifest = openLayout(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			expect(manifest.workspace).toBeNull()
		})

		it('builds every split before the first command is submitted', () => {
			const calls: string[][] = []
			const exec = tmuxExec(calls)
			openLayout(exec, tmuxSessionAdapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			const lastSplit = calls.map((c) => c[0]).lastIndexOf('split-window')
			const firstSubmit = calls.map((c) => c[0]).indexOf('send-keys')
			expect(lastSplit).toBeGreaterThanOrEqual(0)
			expect(firstSubmit).toBeGreaterThanOrEqual(0)
			expect(lastSplit).toBeLessThan(firstSubmit)
		})

		it('names the pane every split splits, never relying on the backend’s own default', () => {
			// The defaults disagree and both track the USER: herdr's `--current` falls back to the
			// UI-focused pane, tmux always splits the session's active pane. A tree walk must also split a
			// pane created two steps earlier, which no default can express.
			const { adapter, calls } = fakeAdapter()
			openLayout(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			const splits = calls.opens.filter((o) => o.at === 'pane:right' || o.at === 'pane:down')
			expect(splits).toHaveLength(2)
			for (const split of splits) expect(split.from).toBeDefined()
			// The second split targets the pane the FIRST split created two steps earlier, not the root.
			expect(splits[0]?.from).toEqual({ id: 'p1' })
			expect(splits[1]?.from).toEqual({ id: 'p2' })
		})

		it('submits commands last, in template order', () => {
			const { adapter, calls } = fakeAdapter()
			openLayout(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			expect(calls.submits).toEqual([
				{ pane: 'p1', text: 'claude' },
				{ pane: 'p2', text: 'claude' },
				{ pane: 'p3', text: 'claude' },
			])
		})

		it('a pane with no command opens a blank shell and gets no submit', () => {
			const { adapter, calls } = fakeAdapter()
			const template: LayoutTemplate = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor', command: 'nvim' },
					second: { type: 'pane', label: 'spare' },
				},
			}
			const manifest = openLayout(noExec, adapter, template, { cwd: '/target', dirExists: anyDir })
			// Created — it is in the manifest with a real pane id...
			expect(manifest.panes.map((p) => p.label)).toEqual(['editor', 'spare'])
			expect(manifest.panes[1]?.command).toBeNull()
			// ...and nothing was typed into it.
			expect(calls.submits).toEqual([{ pane: 'p1', text: 'nvim' }])
		})

		it('joins dir onto the apply-time cwd', () => {
			const { adapter, calls } = fakeAdapter()
			const template: LayoutTemplate = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'down',
					first: { type: 'pane', label: 'editor' },
					second: { type: 'pane', label: 'watcher', dir: 'services/api/logs' },
				},
			}
			const manifest = openLayout(noExec, adapter, template, { cwd: '/target/root', dirExists: anyDir })
			// The pane OPENS there — the split carries the joined path as its cwd...
			expect(calls.opens[1]?.cwd).toBe('/target/root/services/api/logs')
			// ...and the manifest reports the same resolved path.
			expect(manifest.panes[1]?.dir).toBe('/target/root/services/api/logs')
			// A pane with no dir sits at the injected target itself.
			expect(manifest.panes[0]?.dir).toBe('/target/root')
			// Nothing about the target was ever in the template.
			expect(manifest.cwd).toBe('/target/root')
		})

		it('a dir absent from this worktree fails naming the pane and the resolved path, opening nothing', () => {
			// A branch that predates a directory is a real case, so the error has to be actionable.
			const { adapter, calls } = fakeAdapter()
			const template: LayoutTemplate = {
				name: 'build-trio',
				panes: [{ label: 'editor' }, { label: 'watcher', dir: 'services/api/logs' }],
			}
			const dirExists = (path: string) => path === '/target'
			expect(() => openLayout(noExec, adapter, template, { cwd: '/target', dirExists })).toThrow(
				/"watcher".*\/target\/services\/api\/logs/,
			)
			// Checked before the region is opened, so a predictable error costs no half-built pool.
			expect(calls.opens).toEqual([])
		})

		it('the root leaf’s dir rides in on the region open, since no split ever births that pane', () => {
			const { adapter, calls } = fakeAdapter()
			const template: LayoutTemplate = {
				name: 'build-trio',
				panes: [{ label: 'editor', dir: 'apps/web' }, { label: 'spare' }],
			}
			const manifest = openLayout(noExec, adapter, template, { cwd: '/target', dirExists: anyDir })
			expect(calls.opens[0]?.cwd).toBe('/target/apps/web')
			// And the manifest's claim matches where the pane was actually put.
			expect(manifest.panes[0]).toMatchObject({ label: 'editor', dir: '/target/apps/web' })
		})

		it('the root leaf’s env rides in on the region open too, or nothing would ever set it', () => {
			// Native at every tier on both backends, so this route honors it exactly — no degrade.
			const { adapter, calls } = fakeAdapter()
			const template: LayoutTemplate = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor', env: { ROLE: 'planner' }, command: 'nvim' },
					second: { type: 'pane', label: 'runner', env: { ROLE: 'worker' } },
				},
			}
			openLayout(noExec, adapter, template, { cwd: '/target', dirExists: anyDir })
			expect(calls.opens[0]?.env).toEqual({ ROLE: 'planner' })
			expect(calls.opens[1]?.env).toEqual({ ROLE: 'worker' })
		})

		it('open --layout sets the root pane’s env natively on both backends’ region tier', () => {
			const template: LayoutTemplate = {
				name: 'render-farm',
				panes: [{ label: 'dispatcher', env: { TIER: 'gpu' } }, { label: 'spare' }],
			}
			const tmuxCalls: string[][] = []
			openLayout(tmuxExec(tmuxCalls), tmuxSessionAdapter, template, { cwd: '/target', dirExists: anyDir })
			expect(tmuxCalls.find((c) => c[0] === 'new-window')!.join(' ')).toContain('-e TIER=gpu')

			const herdrCalls: string[][] = []
			openLayout(herdrExec(herdrCalls), herdrSessionAdapter, template, { cwd: '/target', dirExists: anyDir })
			expect(herdrCalls.find((c) => c[0] === 'workspace' && c[1] === 'create')!.join(' ')).toContain('--env TIER=gpu')
		})
	})

	describe('ratio and env: degrade, never reject', () => {
		// The single most error-prone line in the feature. Template `ratio` is the fraction kept by
		// `first` — the ORIGINAL pane. herdr's `--ratio` sizes the original, so it passes through
		// unconverted; tmux's `-l` sizes the NEW pane, so it takes 1 - ratio. Applying the inversion to
		// both backends, or to neither, fails exactly one of these two.
		const skewed: LayoutTemplate = {
			name: 'build-trio',
			root: {
				type: 'split',
				direction: 'right',
				ratio: 0.333,
				first: { type: 'pane', label: 'editor' },
				second: { type: 'pane', label: 'tests' },
			},
		}

		it('herdr receives --ratio 0.333 — its flag sizes the original pane, so it is unconverted', () => {
			const calls: string[][] = []
			openLayout(herdrExec(calls), herdrSessionAdapter, skewed, { cwd: '/target', dirExists: anyDir })
			const split = calls.find((c) => c[0] === 'pane' && c[1] === 'split')!
			expect(split.join(' ')).toContain('--ratio 0.333')
		})

		it('tmux receives -l 67% — its flag sizes the new pane, so it inverts', () => {
			const calls: string[][] = []
			openLayout(tmuxExec(calls), tmuxSessionAdapter, skewed, { cwd: '/target', dirExists: anyDir })
			const split = calls.find((c) => c[0] === 'split-window')!
			expect(split.join(' ')).toContain('-l 67%')
			// Never the un-inverted number, which is what a double- or missing inversion would emit.
			expect(split.join(' ')).not.toContain('33%')
		})

		it('a split carrying no ratio is left to the backend’s own even default', () => {
			const calls: string[][] = []
			const even: LayoutTemplate = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor' },
					second: { type: 'pane', label: 'tests' },
				},
			}
			openLayout(tmuxExec(calls), tmuxSessionAdapter, even, { cwd: '/target', dirExists: anyDir })
			expect(calls.find((c) => c[0] === 'split-window')).not.toContain('-l')

			const herdrCalls: string[][] = []
			openLayout(herdrExec(herdrCalls), herdrSessionAdapter, even, { cwd: '/target', dirExists: anyDir })
			expect(herdrCalls.find((c) => c[0] === 'pane' && c[1] === 'split')).not.toContain('--ratio')
		})

		const withEnv: LayoutTemplate = {
			name: 'build-trio',
			root: {
				type: 'split',
				direction: 'right',
				first: { type: 'pane', label: 'editor', command: 'nvim' },
				second: { type: 'pane', label: 'runner', env: { ROLE: 'worker' }, command: 'claude' },
			},
		}

		it('herdr sets env natively at the pane’s birth via --env', () => {
			const calls: string[][] = []
			openLayout(herdrExec(calls), herdrSessionAdapter, withEnv, { cwd: '/target', dirExists: anyDir })
			expect(calls.find((c) => c[0] === 'pane' && c[1] === 'split')!.join(' ')).toContain('--env ROLE=worker')
		})

		it('tmux sets env natively at the pane’s birth via -e', () => {
			const calls: string[][] = []
			openLayout(tmuxExec(calls), tmuxSessionAdapter, withEnv, { cwd: '/target', dirExists: anyDir })
			expect(calls.find((c) => c[0] === 'split-window')!.join(' ')).toContain('-e ROLE=worker')
		})

		it('a pane with env and no command is valid: the env is set, and nothing is submitted to it', () => {
			// A coherent warm pane for something to attach to later. Both backends set env natively, so
			// the command-prefix fallback the env rule once rested on has no customer.
			const template: LayoutTemplate = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor', command: 'nvim' },
					second: { type: 'pane', label: 'warm', env: { ROLE: 'worker' } },
				},
			}
			const calls: string[][] = []
			const manifest = openLayout(herdrExec(calls), herdrSessionAdapter, template, {
				cwd: '/target',
				dirExists: anyDir,
			})
			const split = calls.find((c) => c[0] === 'pane' && c[1] === 'split')!
			expect(split.join(' ')).toContain('--env ROLE=worker')
			const warm = manifest.panes.find((p) => p.label === 'warm')!
			expect(warm.command).toBeNull()
			// `pane run` is herdr's submit — it never fires for the warm pane.
			expect(calls.filter((c) => c[0] === 'pane' && c[1] === 'run').map((c) => c[2])).toEqual([manifest.panes[0]?.pane])
		})

		it('a backend that cannot size a split warns exactly once and still builds every pane', () => {
			// Degrade, never reject: the schema is backend-agnostic, so a template's validity cannot
			// depend on which multiplexer happens to be running. A wrong-looking split is not worth
			// failing an otherwise-correct pool over.
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
			const { adapter, calls } = fakeAdapter({ canSizeSplits: false })
			const manifest = openLayout(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			// Every pane the template names is still created...
			expect(manifest.panes.map((p) => p.label)).toEqual(['planner', 'worker-a', 'worker-b'])
			// ...the ratios were dropped rather than passed to a backend that cannot honor them...
			for (const open of calls.opens) expect(open.ratio).toBeUndefined()
			// ...and both ratio-carrying splits produced ONE warning between them.
			expect(stderr).toHaveBeenCalledTimes(1)
			expect(String(stderr.mock.calls[0]![0])).toContain('cannot size a split')
			// stdout stays machine-readable — the warning never lands there.
			expect(stdout).not.toHaveBeenCalled()
		})

		it('a backend that can size a split passes the ratio through and warns about nothing', () => {
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const { adapter, calls } = fakeAdapter()
			openLayout(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir })
			expect(calls.opens.filter((o) => o.ratio === 0.5)).toHaveLength(2)
			expect(stderr).not.toHaveBeenCalled()
		})
	})

	describe('one template, one geometry, every backend', () => {
		it('tmux and herdr receive the same splits, in the same order, with the same directions and ratios', () => {
			const tmuxCalls: string[][] = []
			openLayout(tmuxExec(tmuxCalls), tmuxSessionAdapter, pool4, { cwd: '/target', dirExists: anyDir })
			const herdrCalls: string[][] = []
			openLayout(herdrExec(herdrCalls), herdrSessionAdapter, pool4, { cwd: '/target', dirExists: anyDir })

			const expected = [
				{ direction: 'right', ratio: 0.5 },
				{ direction: 'down', ratio: 0.5 },
				{ direction: 'down', ratio: 0.5 },
			]
			expect(tmuxSplits(tmuxCalls)).toEqual(expected)
			expect(herdrSplits(herdrCalls)).toEqual(expected)
			expect(tmuxSplits(tmuxCalls)).toEqual(herdrSplits(herdrCalls))
		})

		it('tmux’s own select-layout is never invoked', () => {
			// It implements tmux's grid algorithm, which herdr has no equivalent of — using it would give
			// the same template a different geometry per backend.
			const calls: string[][] = []
			openLayout(tmuxExec(calls), tmuxSessionAdapter, pool4, { cwd: '/target', dirExists: anyDir })
			expect(calls.some((c) => c[0] === 'select-layout')).toBe(false)
		})
	})

	describe('apply does not roll back', () => {
		it('a throw mid-walk reports what was built, kills nothing, and surfaces the failure', () => {
			// A kill is not obviously safer than a half-built layout the caller can see and finish. This is
			// the price of owning the engine rather than delegating to an atomic tree-apply, and it is
			// paid uniformly — a guarantee only herdr could make is not one cyber-mux can offer.
			const template: LayoutTemplate = {
				name: 'render-farm',
				arrange: 'even-horizontal',
				panes: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
			}
			// Opens: 1 = the region, 2..4 = the three splits. The THIRD split is open #4.
			const { adapter, calls } = fakeAdapter({ failOnOpen: 4 })
			let thrown: unknown
			try {
				openLayout(noExec, adapter, template, { cwd: '/target', dirExists: anyDir })
			} catch (err) {
				thrown = err
			}
			expect(thrown).toBeInstanceOf(LayoutApplyError)
			const { manifest } = thrown as LayoutApplyError
			// The panes built before the failure are reported, with their real ids.
			expect(manifest.panes.map((p) => p.label)).toEqual(['a', 'b', 'c'])
			expect(manifest.panes.map((p) => p.pane)).toEqual(['p1', 'p2', 'p3'])
			expect(manifest.layout).toBe('render-farm')
			// Nothing is killed, and no command is typed into a half-built pool.
			expect(calls.teardowns).toEqual([])
			expect(calls.submits).toEqual([])
		})
	})

	describe('the manifest', () => {
		it('reports the layout, the injected cwd, the workspace, and one entry per pane', () => {
			const { adapter } = fakeAdapter()
			const manifest = openLayout(noExec, adapter, agentPool3, { cwd: '/w/feat-x', dirExists: anyDir })
			expect(manifest).toEqual({
				layout: 'agent-pool-3',
				cwd: '/w/feat-x',
				workspace: null,
				panes: [
					{ label: 'planner', pane: 'p1', dir: '/w/feat-x', command: 'claude' },
					{ label: 'worker-a', pane: 'p2', dir: '/w/feat-x', command: 'claude' },
					{ label: 'worker-b', pane: 'p3', dir: '/w/feat-x', command: 'claude' },
				],
			})
		})

		it('reports an unlabeled pane with a null label rather than dropping it', () => {
			const { adapter } = fakeAdapter()
			const template: LayoutTemplate = { name: 'render-farm', panes: [{ command: 'top' }] }
			const manifest = openLayout(noExec, adapter, template, { cwd: '/target', dirExists: anyDir })
			expect(manifest.panes).toEqual([{ label: null, pane: 'p1', dir: '/target', command: 'top' }])
		})
	})

	describe('applyLayoutToRegion', () => {
		it('builds into a region someone else already opened, reporting its workspace', () => {
			// The worktree flow: the worktree's own workspace IS the region, and its root pane is the
			// tree's root — so the walk splits into it rather than opening a second space.
			const { adapter, calls } = fakeAdapter()
			const root: SessionTarget = { id: 'w9:p1' }
			const manifest = applyLayoutToRegion(noExec, adapter, agentPool3, {
				root,
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
			})
			expect(manifest.workspace).toBe('w9')
			expect(manifest.cwd).toBe('/repo.worktrees/feat-x')
			// The pre-opened pane is the tree's root, so only the two splits are opened here.
			expect(calls.opens).toHaveLength(2)
			expect(calls.opens[0]?.from).toEqual(root)
			expect(manifest.panes[0]).toMatchObject({ label: 'planner', pane: 'w9:p1' })
		})

		it('reports the root pane’s ACTUAL dir, never the dir the template asked for', () => {
			// The region was opened by a caller whose contract fixed its cwd — a worktree's workspace
			// opens at the worktree root, because that is what the binding pins. Claiming the root pane
			// sits at cwd + dir would make the manifest describe a location nothing ever opened, and the
			// manifest is precisely the answer to "which panes exist and what are they for".
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const { adapter } = fakeAdapter()
			const template: LayoutTemplate = {
				name: 'build-trio',
				panes: [{ label: 'editor', dir: 'apps/web' }, { label: 'spare' }],
			}
			const manifest = applyLayoutToRegion(noExec, adapter, template, {
				root: { id: 'w9:root' },
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
			})
			// Where it really is — not /repo.worktrees/feat-x/apps/web.
			expect(manifest.panes[0]).toEqual({
				label: 'editor',
				pane: 'w9:root',
				dir: '/repo.worktrees/feat-x',
				command: null,
			})
			// Degrade and warn, never silently drop: the caller is told which pane lost its dir.
			expect(stderr).toHaveBeenCalledTimes(1)
			const warning = String(stderr.mock.calls[0]![0])
			expect(warning).toContain('editor')
			expect(warning).toContain('apps/web')
		})

		it('a split-born pane’s dir is still honored on this route — only the root pane degrades', () => {
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const { adapter, calls } = fakeAdapter()
			const template: LayoutTemplate = {
				name: 'build-trio',
				panes: [{ label: 'editor' }, { label: 'watcher', dir: 'apps/web' }],
			}
			const manifest = applyLayoutToRegion(noExec, adapter, template, {
				root: { id: 'w9:root' },
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
			})
			expect(calls.opens[0]?.cwd).toBe('/repo.worktrees/feat-x/apps/web')
			expect(manifest.panes[1]?.dir).toBe('/repo.worktrees/feat-x/apps/web')
		})

		it('warns about nothing when the root pane asks for no dir', () => {
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const { adapter } = fakeAdapter()
			const manifest = applyLayoutToRegion(noExec, adapter, agentPool3, {
				root: { id: 'w9:root' },
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
			})
			expect(stderr).not.toHaveBeenCalled()
			expect(manifest.panes[0]?.dir).toBe('/repo.worktrees/feat-x')
		})

		describe('the env-prefix fallback — design §7.3 Gap C’s first real customer', () => {
			const farm: LayoutTemplate = {
				name: 'render-farm',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'dispatcher', env: { TIER: 'gpu' }, command: 'render' },
					second: { type: 'pane', label: 'encoder', env: { TIER: 'cpu' }, command: 'encode' },
				},
			}

			it('prefixes the root pane’s command when the region open could not carry its env', () => {
				const { adapter, calls } = fakeAdapter()
				applyLayoutToRegion(noExec, adapter, farm, {
					root: { id: 'w9:root' },
					cwd: '/repo.worktrees/feat-x',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
				})
				// It is just a command line, so it works on any backend — the fallback's whole appeal.
				expect(calls.submits[0]).toEqual({ pane: 'w9:root', text: "env TIER='gpu' render" })
				// The split-born pane got its env natively, so it is NEVER prefixed on top of that.
				expect(calls.submits[1]).toEqual({ pane: 'p1', text: 'encode' })
			})

			it('never prefixes when the region open already set the env natively', () => {
				// The double-application guard: prefixing here would set TIER twice and lie about which won.
				const { adapter, calls } = fakeAdapter()
				applyLayoutToRegion(noExec, adapter, farm, {
					root: { id: 'w9:root' },
					cwd: '/repo.worktrees/feat-x',
					workspace: 'w9',
					rootEnvHonored: true,
					dirExists: anyDir,
				})
				expect(calls.submits[0]).toEqual({ pane: 'w9:root', text: 'render' })
			})

			it('open --layout sets env natively and prefixes nothing, on either backend', () => {
				for (const [adapter, exec] of [
					[tmuxSessionAdapter, tmuxExec([])],
					[herdrSessionAdapter, herdrExec([])],
				] as const) {
					const calls: string[][] = []
					const recording: Exec = (cmd, args) => {
						calls.push(args)
						return exec(cmd, args)
					}
					openLayout(recording, adapter, farm, { cwd: '/target', dirExists: anyDir })
					// Whatever this backend's submit spells, it carries the bare command — never `env ...`.
					expect(calls.filter((c) => c.some((a) => a.startsWith('env ')))).toEqual([])
					expect(calls.some((c) => c.includes('render'))).toBe(true)
				}
			})

			it('shell-quotes a value carrying spaces or quotes, so the command line cannot break', () => {
				const { adapter, calls } = fakeAdapter()
				const template: LayoutTemplate = {
					name: 'render-farm',
					panes: [{ label: 'dispatcher', env: { NOTE: "it's a big one", FLAGS: '--x 1' }, command: 'render' }],
				}
				applyLayoutToRegion(noExec, adapter, template, {
					root: { id: 'w9:root' },
					cwd: '/target',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
				})
				// A bare value would split into extra words; a bare quote would unbalance the line.
				expect(calls.submits[0]?.text).toBe("env NOTE='it'\\''s a big one' FLAGS='--x 1' render")
			})

			it('warns once, and prefixes nothing, when the root pane has env but no command', () => {
				// The fallback can only ride on a command line — there is nothing to ride here.
				const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
				const { adapter, calls } = fakeAdapter()
				const template: LayoutTemplate = {
					name: 'render-farm',
					panes: [{ label: 'dispatcher', env: { TIER: 'gpu' } }, { label: 'encoder' }],
				}
				applyLayoutToRegion(noExec, adapter, template, {
					root: { id: 'w9:root' },
					cwd: '/target',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
				})
				expect(calls.submits).toEqual([])
				expect(stderr).toHaveBeenCalledTimes(1)
				const warning = String(stderr.mock.calls[0]![0])
				expect(warning).toContain('dispatcher')
				expect(warning).toContain('TIER')
			})

			it('says nothing when the root pane has no env to lose', () => {
				const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
				const { adapter } = fakeAdapter()
				applyLayoutToRegion(noExec, adapter, agentPool3, {
					root: { id: 'w9:root' },
					cwd: '/target',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
				})
				expect(stderr).not.toHaveBeenCalled()
			})
		})

		it('reports a null workspace on a backend that binds none', () => {
			const { adapter } = fakeAdapter()
			const manifest = applyLayoutToRegion(noExec, adapter, pool4, {
				root: { id: '%0' },
				cwd: '/target',
				workspace: null,
				rootEnvHonored: true,
				dirExists: anyDir,
			})
			expect(manifest.workspace).toBeNull()
		})
	})
})
