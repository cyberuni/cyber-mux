import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Exec } from './exec.ts'
import { herdrMuxAdapter } from './mux.herdr.ts'
import { TMUX_WORKSPACE_GROUP_OPTION, tmuxMuxAdapter } from './mux.tmux.ts'
import type { MuxAdapter, MuxOpenOptions, OpenedPane } from './mux.ts'
import type { Template } from './template.ts'
import { applyTemplateToRegion, openTemplate, TemplateApplyError } from './template-session.ts'

/** Every dir the walk asks about exists, unless a test says otherwise. */
const anyDir = () => true
const fakeNewId = () => 'grp-0000'

/** tmux, handing out a fresh pane id per window/split so geometry is traceable in the argv. */
function tmuxExec(calls: string[][]): Exec {
	let n = 0
	return (_cmd, args) => {
		calls.push(args)
		if (args[0] === 'new-window' || args[0] === 'split-window') {
			const id = n++
			// EVERY open asks for the new window's id alongside the pane's, in one tab-separated report:
			// the window is the pane's tab, which `OpenedPane.tab` always carries, and it is also what a
			// grouping open tags. Answer the format tmux was actually asked for.
			return `%${id}\t@${id}`
		}
		return ''
	}
}

/**
 * herdr, same idea through its JSON envelopes.
 *
 * Modeled on the real 0.7.4's, verified against a live server: every route reports `workspace_id` and
 * `tab_id` beside the pane id, a create makes a NEW tab, and a split reports the tab it landed IN
 * rather than a new one. The distinct ids are load-bearing — a walk that confused a tab id for a pane
 * id (or one tab's for another's) would pass against a fixture that spelled them all alike.
 */
function herdrExec(calls: string[][]): Exec {
	let n = 0
	let tab = 0
	return (_cmd, args) => {
		calls.push(args)
		const key = args.slice(0, 2).join(' ')
		if (key === 'pane split') {
			return JSON.stringify({ result: { pane: { pane_id: `w1:p${n++}`, tab_id: `w1:t${tab}`, workspace_id: 'w1' } } })
		}
		if (key === 'workspace create' || key === 'tab create') {
			tab++
			return JSON.stringify({
				result: { root_pane: { pane_id: `w1:p${n++}`, tab_id: `w1:t${tab}`, workspace_id: 'w1' } },
			})
		}
		return ''
	}
}

interface Recorded {
	opens: MuxOpenOptions[]
	submits: { pane: string; text: string | undefined }[]
	teardowns: string[]
	focuses: string[]
	/**
	 * Every `group` call: the TAB it addressed, the group id, and the tab's own name. Recorded at the
	 * seam because the claim is about what the walk asks of a backend — every tab grouped alike, under
	 * the name the template gave it — not about how a backend spells the storing.
	 */
	groups: { tab: string; group: string; name: string | undefined }[]
	/** Every seam call in the order it was made — for the claims that are about ORDER across verbs. */
	log: ('open' | 'submit' | 'focus' | 'rename' | 'group')[]
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
	const calls: Recorded = { opens: [], submits: [], teardowns: [], focuses: [], groups: [], log: [] }
	let n = 0
	const adapter: MuxAdapter = {
		name: 'fake',
		...(opts.canSizeSplits === false ? {} : { canSizeSplits: true }),
		rename: () => {
			calls.log.push('rename')
		},
		open(_exec, options) {
			calls.opens.push(options)
			calls.log.push('open')
			n++
			if (opts.failOnOpen === n) throw new Error('backend refused the split')
			// `tab` is required on `OpenedPane` — every multiplexer has the Tab level, so a backend never
			// reports it absent (unlike `workspace`, which only some have a tier for). A distinct id per
			// open, so a caller that mixes up pane and tab ids cannot pass by coincidence.
			return opts.workspace ? { id: `p${n}`, tab: `t${n}`, workspace: opts.workspace } : { id: `p${n}`, tab: `t${n}` }
		},
		group(_exec, target, group, name) {
			calls.groups.push({ tab: target.id, group, name })
			calls.log.push('group')
		},
		submit(_exec, target, text) {
			calls.submits.push({ pane: target.id, text })
			calls.log.push('submit')
		},
		teardown(_exec, target) {
			calls.teardowns.push(target.id)
		},
		sendText: () => undefined,
		sendKeys: () => undefined,
		read: () => '',
		focus: (_exec, target) => {
			calls.focuses.push(target.id)
			calls.log.push('focus')
		},
		paneExists: () => true,
		isPaneFocused: () => undefined,
		listPanes: () => [],
	}
	return { adapter, calls }
}

const noExec: Exec = () => null

/** One planner over two workers — the tree form, written out. */
const agentPool3: Template = {
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

const pool4: Template = {
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

describe('spec:cyber-mux/template', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('the walk', () => {
		it('opens the region blank and makes its pane the tree’s root, never a pane to close', () => {
			// `open`'s `launch` couples creation to launching, so reusing it would mean splitting a pane
			// already running an interactive agent — the split lands mid-render. The root pane is not a
			// wasted pane either: it is the region the walk splits INTO.
			const { adapter, calls } = fakeAdapter()
			const manifest = openTemplate(noExec, adapter, agentPool3, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
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
			const manifest = openTemplate(noExec, adapter, agentPool3, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(manifest.workspace).toBe('w45')
		})

		// tmux has no workspace tier, so its `open` reports absent and the manifest has nothing to carry.
		// `null` is the manifest's JSON-boundary spelling of that — the one place absent becomes null.
		it('the manifest’s workspace is null on a backend with no workspace tier', () => {
			const { adapter } = fakeAdapter()
			const manifest = openTemplate(noExec, adapter, agentPool3, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(manifest.workspace).toBeNull()
		})

		it('builds every split before the first command is submitted', () => {
			const calls: string[][] = []
			const exec = tmuxExec(calls)
			openTemplate(exec, tmuxMuxAdapter, agentPool3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
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
			openTemplate(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			const splits = calls.opens.filter((o) => o.at === 'pane:right' || o.at === 'pane:down')
			expect(splits).toHaveLength(2)
			for (const split of splits) expect(split.from).toBeDefined()
			// The second split targets the pane the FIRST split created two steps earlier, not the root.
			expect(splits[0]?.from).toEqual({ id: 'p1' })
			expect(splits[1]?.from).toEqual({ id: 'p2' })
		})

		it('submits commands last, in template order', () => {
			const { adapter, calls } = fakeAdapter()
			openTemplate(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.submits).toEqual([
				{ pane: 'p1', text: 'claude' },
				{ pane: 'p2', text: 'claude' },
				{ pane: 'p3', text: 'claude' },
			])
		})

		it('a pane with no command opens a blank shell and gets no submit', () => {
			const { adapter, calls } = fakeAdapter()
			const template: Template = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor', command: 'nvim' },
					second: { type: 'pane', label: 'spare' },
				},
			}
			const manifest = openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			// Created — it is in the manifest with a real pane id...
			expect(manifest.panes.map((p) => p.label)).toEqual(['editor', 'spare'])
			expect(manifest.panes[1]?.command).toBeNull()
			// ...and nothing was typed into it.
			expect(calls.submits).toEqual([{ pane: 'p1', text: 'nvim' }])
		})

		it('joins dir onto the apply-time cwd', () => {
			const { adapter, calls } = fakeAdapter()
			const template: Template = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'down',
					first: { type: 'pane', label: 'editor' },
					second: { type: 'pane', label: 'watcher', dir: 'services/api/logs' },
				},
			}
			const manifest = openTemplate(noExec, adapter, template, {
				cwd: '/target/root',
				dirExists: anyDir,
				newId: fakeNewId,
			})
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
			const template: Template = {
				name: 'build-trio',
				panes: [{ label: 'editor' }, { label: 'watcher', dir: 'services/api/logs' }],
			}
			const dirExists = (path: string) => path === '/target'
			expect(() => openTemplate(noExec, adapter, template, { cwd: '/target', dirExists, newId: fakeNewId })).toThrow(
				/"watcher".*\/target\/services\/api\/logs/,
			)
			// Checked before the region is opened, so a predictable error costs no half-built pool.
			expect(calls.opens).toEqual([])
		})

		it('the root leaf’s dir rides in on the region open, since no split ever births that pane', () => {
			const { adapter, calls } = fakeAdapter()
			const template: Template = {
				name: 'build-trio',
				panes: [{ label: 'editor', dir: 'apps/web' }, { label: 'spare' }],
			}
			const manifest = openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.opens[0]?.cwd).toBe('/target/apps/web')
			// And the manifest's claim matches where the pane was actually put.
			expect(manifest.panes[0]).toMatchObject({ label: 'editor', dir: '/target/apps/web' })
		})

		it('the root leaf’s env rides in on the region open too, or nothing would ever set it', () => {
			// Native at every tier on both backends, so this route honors it exactly — no degrade.
			const { adapter, calls } = fakeAdapter()
			const template: Template = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor', env: { ROLE: 'planner' }, command: 'nvim' },
					second: { type: 'pane', label: 'runner', env: { ROLE: 'worker' } },
				},
			}
			openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.opens[0]?.env).toEqual({ ROLE: 'planner' })
			expect(calls.opens[1]?.env).toEqual({ ROLE: 'worker' })
		})

		it('open --template sets the root pane’s env natively on both backends’ region tier', () => {
			const template: Template = {
				name: 'render-farm',
				panes: [{ label: 'dispatcher', env: { TIER: 'gpu' } }, { label: 'spare' }],
			}
			const tmuxCalls: string[][] = []
			openTemplate(tmuxExec(tmuxCalls), tmuxMuxAdapter, template, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(tmuxCalls.find((c) => c[0] === 'new-window')!.join(' ')).toContain('-e TIER=gpu')

			const herdrCalls: string[][] = []
			openTemplate(herdrExec(herdrCalls), herdrMuxAdapter, template, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(herdrCalls.find((c) => c[0] === 'workspace' && c[1] === 'create')!.join(' ')).toContain('--env TIER=gpu')
		})
	})

	describe('the walk, across tabs', () => {
		/** Three tabs of one pane each — the shape that makes every open a TAB open, nothing else. */
		const tabs3: Template = {
			name: 'pool',
			tabs: [
				{ label: 'editor', panes: [{ label: 'edit', command: 'nvim' }] },
				{ label: 'logs', panes: [{ label: 'tail', command: 'tail -f log' }] },
				{ label: 'shell', panes: [{ label: 'sh' }] },
			],
		}

		it('the first tab opens the workspace and every later tab opens inside it', () => {
			// A workspace is what a set of tabs needs to live in; every later tab belongs INSIDE it. A
			// `pane:*` placement anywhere here would make a tab a split of the tab before it.
			const { adapter, calls } = fakeAdapter({ workspace: 'w7' })
			openTemplate(noExec, adapter, tabs3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.opens.map((o) => o.at)).toEqual(['workspace', 'tab', 'tab'])
			// No tab is a split of another tab's pane — and nothing was placed against a pane at all.
			expect(calls.opens.filter((o) => o.at === 'pane:right' || o.at === 'pane:down')).toEqual([])
			expect(calls.opens.slice(1).map((o) => o.from)).toEqual([undefined, undefined])
		})

		it('every later tab is ANCHORED to the workspace the first tab landed in', () => {
			// The `at: 'tab'` placement alone is not enough: every backend resolves a bare tab open against
			// the space the USER is looking at, so without the anchor the first tab opened the new
			// workspace and tabs 2..N appeared beside the pane the command was RUN from.
			const { adapter, calls } = fakeAdapter({ workspace: 'w7' })
			openTemplate(noExec, adapter, tabs3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.opens.map((o) => o.within)).toEqual([undefined, 'w7', 'w7'])
		})

		it('a backend with no workspace tier anchors nothing, having no second space to land in', () => {
			// tmux collapses workspace and tab onto one Window, so there is no space for a tab to land in
			// the wrong one of — the grouping tag, not an anchor, is what makes its tabs one pool.
			const { adapter, calls } = fakeAdapter()
			openTemplate(noExec, adapter, tabs3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.opens.map((o) => o.within)).toEqual([undefined, undefined, undefined])
		})

		it('herdr names the workspace on every later tab create', () => {
			// At the argv, on the backend the bug was reported on: `tab create --workspace <id>`.
			const calls: string[][] = []
			openTemplate(herdrExec(calls), herdrMuxAdapter, tabs3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			const creates = calls.filter((c) => c[0] === 'tab' && c[1] === 'create')
			expect(creates).toHaveLength(2)
			for (const create of creates) expect(create.slice(0, 4)).toEqual(['tab', 'create', '--workspace', 'w1'])
		})

		it("each tab's tree is built against that tab's own root pane", () => {
			// The same rule the single-tab walk holds: a split names its pane rather than trusting the
			// backend's default, which tracks the user rather than the caller. Across tabs it also keeps a
			// tab's splits inside that tab.
			const { adapter, calls } = fakeAdapter({ workspace: 'w7' })
			const template: Template = {
				name: 'pool',
				tabs: [
					{ label: 'editor', panes: [{ label: 'edit' }] },
					{
						label: 'workers',
						root: {
							type: 'split',
							direction: 'right',
							first: { type: 'pane', label: 'worker-a' },
							second: { type: 'pane', label: 'worker-b' },
						},
					},
				],
			}
			openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			// Opens: 1 = the workspace (tab 1's root), 2 = tab 2's root, 3 = tab 2's split.
			const splits = calls.opens.filter((o) => o.at === 'pane:right' || o.at === 'pane:down')
			expect(splits).toHaveLength(1)
			// p2 is the SECOND tab's root pane — never p1, the first tab's.
			expect(splits[0]?.from).toEqual({ id: 'p2' })
		})

		it('geometry is built across every tab before any command is submitted', () => {
			// The single-tab reason scales: a split lands mid-render if it targets a pane already running
			// an interactive agent, and a tab is opened blank for the same reason a region is.
			const { adapter, calls } = fakeAdapter({ workspace: 'w7' })
			const template: Template = {
				name: 'pool',
				tabs: [
					{
						label: 'editor',
						root: {
							type: 'split',
							direction: 'right',
							first: { type: 'pane', label: 'edit', command: 'nvim' },
							second: { type: 'pane', label: 'test', command: 'vitest' },
						},
					},
					{
						label: 'agents',
						root: {
							type: 'split',
							direction: 'down',
							first: { type: 'pane', label: 'planner', command: 'claude' },
							second: { type: 'pane', label: 'worker', command: 'claude' },
						},
					},
				],
			}
			openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			// EVERY open — both tab opens and both splits — precedes the first submit.
			expect(calls.log.lastIndexOf('open')).toBeLessThan(calls.log.indexOf('submit'))
			expect(calls.opens).toHaveLength(4)
			// And the commands land in template order, tab by tab: tab 1's two panes (p1, p2), then tab
			// 2's (p3, p4).
			expect(calls.submits).toEqual([
				{ pane: 'p1', text: 'nvim' },
				{ pane: 'p2', text: 'vitest' },
				{ pane: 'p3', text: 'claude' },
				{ pane: 'p4', text: 'claude' },
			])
		})

		it('apply never steals focus, and a tabs template cannot ask it to', () => {
			// Unchanged from every spawn path: a caller who wants to land somewhere calls focus with a pane
			// id from the manifest. A multi-tab apply lands MORE spaces at once, which makes stealing focus
			// worse rather than more justified.
			const { adapter, calls } = fakeAdapter({ workspace: 'w7' })
			openTemplate(noExec, adapter, tabs3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.focuses).toEqual([])
			expect(calls.log).not.toContain('focus')

			// And there is no field to ask with: a template carrying one names nothing the walk reads, so
			// the stray key changes not one call.
			const { adapter: b, calls: asking } = fakeAdapter({ workspace: 'w7' })
			const withFocusField = {
				...tabs3,
				focus: 'logs',
				tabs: tabs3.tabs!.map((tab) => ({ ...tab, focus: true })),
			} as Template
			openTemplate(noExec, b, withFocusField, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(asking.focuses).toEqual([])
			expect(asking.log).toEqual(calls.log)
		})

		it('a throw part-way through a tabs walk reports the tabs already built and kills nothing', () => {
			// Apply does not roll back, and adding a level does not buy an atomicity the node never
			// offered.
			// Opens: 1 = tab 1's workspace, 2 = tab 2's root — which is the one that fails.
			const { adapter, calls } = fakeAdapter({ workspace: 'w7', failOnOpen: 2 })
			let thrown: unknown
			try {
				openTemplate(noExec, adapter, tabs3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			} catch (err) {
				thrown = err
			}
			// It exits 1 — the CLI's own exit path for this error — carrying what WAS built.
			expect(thrown).toBeInstanceOf(TemplateApplyError)
			const { manifest } = thrown as TemplateApplyError
			expect(manifest.panes).toEqual([{ label: 'edit', pane: 'p1', dir: '/target', command: 'nvim', tab: 0 }])
			// Nothing is killed, and no command is typed into a half-built workspace.
			expect(calls.teardowns).toEqual([])
			expect(calls.submits).toEqual([])
		})

		it('the manifest reports which tab each pane landed in', () => {
			// A consumer grouping panes by tab needs something to group on, exactly as it needs workspace
			// to group by space.
			const { adapter } = fakeAdapter({ workspace: 'w7' })
			const template: Template = {
				name: 'pool',
				tabs: [
					{ label: 'editor', panes: [{ label: 'edit' }, { label: 'test' }], arrange: 'even-horizontal' },
					{ label: 'logs', panes: [{ label: 'tail' }] },
				],
			}
			const manifest = openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(manifest.panes.map((p) => ({ label: p.label, tab: p.tab }))).toEqual([
				{ label: 'edit', tab: 0 },
				{ label: 'test', tab: 0 },
				{ label: 'tail', tab: 1 },
			])
			// ONE FLAT LIST of every pane the apply created — the tab is a field on each pane, never a
			// second nesting a consumer has to walk.
			expect(Array.isArray(manifest.panes)).toBe(true)
			expect(manifest.panes).toHaveLength(3)
			for (const pane of manifest.panes) expect(pane).not.toHaveProperty('panes')
		})

		it('a pane from a single-tab template reports no tab', () => {
			// Absent rather than false: there is no tab structure to report, and inventing one would claim
			// the template said something it did not.
			const { adapter } = fakeAdapter()
			const manifest = openTemplate(noExec, adapter, agentPool3, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(manifest.panes.map((p) => p.tab)).toEqual([null, null, null])
		})

		/** A workspace named `pool`, whose first tab is `editor` and whose second is `logs`. */
		const pool: Template = {
			name: 'pool',
			tabs: [
				{ label: 'editor', panes: [{ label: 'edit' }] },
				{ label: 'logs', panes: [{ label: 'tail' }] },
			],
		}

		it('on a backend with no workspace tier, a tab is labeled with its workspace and its own name', () => {
			// tmux collapses workspace and tab onto the same Window, so a template's tabs would otherwise be
			// an unlabeled pile — the prefix is what keeps them recognizable as a group in the status bar.
			const calls: string[][] = []
			openTemplate(tmuxExec(calls), tmuxMuxAdapter, pool, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			// The first tab's window is named after birth — at its birth the name went to the workspace,
			// which on tmux is the same Window.
			expect(calls.filter((c) => c[0] === 'rename-window')).toEqual([['rename-window', '-t', '@0', 'pool - editor']])
			// The second is named at birth, and carries the same prefix.
			expect(calls.find((c) => c[0] === 'new-window' && c.includes('pool - logs'))).toBeDefined()
			// Never the bare tab name as either window's NAME — that is the label that would lose the
			// group. Scoped to the naming verbs on purpose: the bare name is not absent from the apply
			// altogether, and must not be. `set-option @cm_tab editor` carries it deliberately, because
			// composing the display name destroyed the original and capture has to read it back from
			// somewhere that is not a split of "pool - editor".
			const naming = calls.filter((c) => c[0] === 'rename-window' || (c[0] === 'new-window' && c.includes('-n')))
			expect(naming.some((c) => c.includes('editor') || c.includes('logs'))).toBe(false)
		})

		it('on a backend with a real workspace tier, a tab carries its own label unprefixed', () => {
			// herdr's UI already groups by the real workspace label, so a prefix would be redundant noise —
			// the concept maps onto what the backend actually has.
			const calls: string[][] = []
			openTemplate(herdrExec(calls), herdrMuxAdapter, pool, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			// The workspace carries the workspace's name...
			expect(calls.find((c) => c[0] === 'workspace' && c[1] === 'create')).toEqual(
				expect.arrayContaining(['--label', 'pool']),
			)
			// ...and each tab carries its OWN label, whichever way it is named.
			expect(calls.find((c) => c[0] === 'tab' && c[1] === 'rename')).toEqual(['tab', 'rename', 'w1:t1', 'editor'])
			expect(calls.find((c) => c[0] === 'tab' && c[1] === 'create')).toEqual(
				expect.arrayContaining(['--label', 'logs']),
			)
			// No prefix reaches herdr anywhere — the workspace label is never composed into a tab's.
			expect(calls.flat().some((arg) => arg.includes(' - '))).toBe(false)
		})

		/**
		 * The same two claims, on the OTHER route — a second binding to each scenario rather than a new
		 * scenario, because the scenarios say "when it is applied" and name no route.
		 *
		 * `worktree add --template` has its region opened by the worktree verbs BEFORE the walk runs, so
		 * its first tab is the one a route-specific implementation forgets. It was forgotten: the first
		 * tab kept the workspace's own label and the tmux scenario was silently false here while passing
		 * on `open --template`. That is the third time in this CR a route-agnostic claim was implemented on
		 * one route and tested there — which is why the naming now lives in the walk both routes share,
		 * and why both routes are bound.
		 */
		describe('applied on the route whose region the worktree verbs already opened', () => {
			it('on a backend with no workspace tier, a tab is labeled with its workspace and its own name', () => {
				const calls: string[][] = []
				// The region already exists — the worktree's own workspace, opened under the label `pool`.
				applyTemplateToRegion(tmuxExec(calls), tmuxMuxAdapter, pool, {
					root: { id: '%0', tab: '@0' },
					cwd: '/repo.worktrees/feat-x',
					// tmux: no workspace tier, so the workspace must be carried into every tab's name.
					workspace: null,
					rootEnvHonored: true,
					label: 'pool',
					dirExists: anyDir,
					newId: fakeNewId,
				})
				// The first tab is renamed even though this route did not open it — the window it was
				// handed is named `pool`, and the tab in it is `editor`.
				expect(calls.filter((c) => c[0] === 'rename-window')).toEqual([['rename-window', '-t', '@0', 'pool - editor']])
				// The later tab is named at birth, carrying the same prefix.
				expect(calls.find((c) => c[0] === 'new-window' && c.includes('pool - logs'))).toBeDefined()
			})

			it('on a backend with a real workspace tier, a tab carries its own label unprefixed', () => {
				const calls: string[][] = []
				applyTemplateToRegion(herdrExec(calls), herdrMuxAdapter, pool, {
					root: { id: 'w1:p0', tab: 'w1:t1' },
					cwd: '/repo.worktrees/feat-x',
					// herdr: the tier IS the group, so its UI already shows the workspace and no tab is
					// prefixed. The region's workspace is known from the caller that opened it.
					workspace: 'w1',
					rootEnvHonored: true,
					label: 'pool',
					dirExists: anyDir,
					newId: fakeNewId,
				})
				// The first tab carries its OWN label — named, but never prefixed.
				expect(calls.find((c) => c[0] === 'tab' && c[1] === 'rename')).toEqual(['tab', 'rename', 'w1:t1', 'editor'])
				expect(calls.find((c) => c[0] === 'tab' && c[1] === 'create')).toEqual(
					expect.arrayContaining(['--label', 'logs']),
				)
				// No prefix reaches herdr anywhere, on this route either.
				expect(calls.flat().some((arg) => arg.includes(' - '))).toBe(false)
			})
		})

		it('the workspace label is never shortened, so two workspaces never collide by shortening', () => {
			// Two labels that any shortening rule would collapse onto the same prefix. The label is the one
			// the caller already chose, so the caller owns its length — and not shortening is what makes the
			// collision impossible rather than merely handled.
			const labels = ['acme-platform-migration-2026-phase-two', 'acme-platform-migration-2026-phase-three']
			const named = labels.map((label) => {
				const calls: string[][] = []
				openTemplate(tmuxExec(calls), tmuxMuxAdapter, pool, {
					cwd: '/target',
					label,
					dirExists: anyDir,
					newId: fakeNewId,
				})
				return calls.find((c) => c[0] === 'rename-window')![3]!
			})
			// Each workspace label appears in its tab's label IN FULL, verbatim...
			expect(named).toEqual([`${labels[0]} - editor`, `${labels[1]} - editor`])
			for (const [i, name] of named.entries()) expect(name).toContain(labels[i]!)
			// ...so the two never collide, which is the whole point of not shortening.
			expect(named[0]).not.toBe(named[1])
		})

		it("herdr's root tab is named after birth, because it is the one tab that cannot be named at birth", () => {
			// herdr labels a new workspace's root tab `1` with no flag to change it; `tab create --label`
			// names every subsequent tab at birth.
			const calls: string[][] = []
			openTemplate(herdrExec(calls), herdrMuxAdapter, pool, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			const verbs = calls.map((c) => c.slice(0, 2).join(' '))
			// The workspace is created, and its own create names the WORKSPACE — never the tab under it.
			const create = calls.find((c) => c[0] === 'workspace' && c[1] === 'create')!
			expect(create).toEqual(expect.arrayContaining(['--label', 'pool']))
			expect(create).not.toContain('editor')
			// The root tab's name arrives by a rename, issued AFTER the workspace (and so its tab) exists...
			const renames = calls.filter((c) => c[0] === 'tab' && c[1] === 'rename')
			expect(renames).toEqual([['tab', 'rename', 'w1:t1', 'editor']])
			expect(verbs.indexOf('workspace create')).toBeLessThan(verbs.indexOf('tab rename'))
			// ...addressed by the TAB's id, never the pane's — herdr answers a pane id with `tab_not_found`
			// and the failure is discarded, so the tab would silently keep the name `1`.
			expect(renames[0]![2]).not.toMatch(/:p/)
			// Every later tab is named AT birth: its own create carries the label, and it is never renamed.
			expect(calls.find((c) => c[0] === 'tab' && c[1] === 'create')).toEqual(
				expect.arrayContaining(['--label', 'logs']),
			)
			expect(renames).toHaveLength(1)
		})

		it("the manifest's workspace is still null on tmux even when tabs are grouped", () => {
			// The grouping tag is cyber-mux's own bookkeeping, not a workspace tier. Reporting it as the
			// workspace would claim a tier tmux does not have.
			const calls: string[][] = []
			const manifest = openTemplate(tmuxExec(calls), tmuxMuxAdapter, tabs3, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(manifest.workspace).toBeNull()
			// The tabs really WERE grouped — so the null is the convention holding, not the tag missing.
			const tagged = calls.filter((c) => c[0] === 'set-option' && c.includes(TMUX_WORKSPACE_GROUP_OPTION))
			expect(tagged).toHaveLength(3)
			// One group, every window: the same opaque id on all three, and never the label.
			const ids = new Set(tagged.map((c) => c[c.length - 1]))
			expect(ids.size).toBe(1)
			expect([...ids][0]).not.toBe('pool')
		})
	})

	describe('ratio and env: degrade, never reject', () => {
		// The single most error-prone line in the feature. Template `ratio` is the fraction kept by
		// `first` — the ORIGINAL pane. herdr's `--ratio` sizes the original, so it passes through
		// unconverted; tmux's `-l` sizes the NEW pane, so it takes 1 - ratio. Applying the inversion to
		// both backends, or to neither, fails exactly one of these two.
		const skewed: Template = {
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
			openTemplate(herdrExec(calls), herdrMuxAdapter, skewed, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			const split = calls.find((c) => c[0] === 'pane' && c[1] === 'split')!
			expect(split.join(' ')).toContain('--ratio 0.333')
		})

		it('tmux receives -l 67% — its flag sizes the new pane, so it inverts', () => {
			const calls: string[][] = []
			openTemplate(tmuxExec(calls), tmuxMuxAdapter, skewed, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			const split = calls.find((c) => c[0] === 'split-window')!
			expect(split.join(' ')).toContain('-l 67%')
			// Never the un-inverted number, which is what a double- or missing inversion would emit.
			expect(split.join(' ')).not.toContain('33%')
		})

		it('a split carrying no ratio is left to the backend’s own even default', () => {
			const calls: string[][] = []
			const even: Template = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor' },
					second: { type: 'pane', label: 'tests' },
				},
			}
			openTemplate(tmuxExec(calls), tmuxMuxAdapter, even, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.find((c) => c[0] === 'split-window')).not.toContain('-l')

			const herdrCalls: string[][] = []
			openTemplate(herdrExec(herdrCalls), herdrMuxAdapter, even, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(herdrCalls.find((c) => c[0] === 'pane' && c[1] === 'split')).not.toContain('--ratio')
		})

		const withEnv: Template = {
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
			openTemplate(herdrExec(calls), herdrMuxAdapter, withEnv, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.find((c) => c[0] === 'pane' && c[1] === 'split')!.join(' ')).toContain('--env ROLE=worker')
		})

		it('tmux sets env natively at the pane’s birth via -e', () => {
			const calls: string[][] = []
			openTemplate(tmuxExec(calls), tmuxMuxAdapter, withEnv, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.find((c) => c[0] === 'split-window')!.join(' ')).toContain('-e ROLE=worker')
		})

		it('a pane with env and no command is valid: the env is set, and nothing is submitted to it', () => {
			// A coherent warm pane for something to attach to later. Both backends set env natively, so
			// the command-prefix fallback the env rule once rested on has no customer.
			const template: Template = {
				name: 'build-trio',
				root: {
					type: 'split',
					direction: 'right',
					first: { type: 'pane', label: 'editor', command: 'nvim' },
					second: { type: 'pane', label: 'warm', env: { ROLE: 'worker' } },
				},
			}
			const calls: string[][] = []
			const manifest = openTemplate(herdrExec(calls), herdrMuxAdapter, template, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
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
			const manifest = openTemplate(noExec, adapter, agentPool3, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})
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
			openTemplate(noExec, adapter, agentPool3, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.opens.filter((o) => o.ratio === 0.5)).toHaveLength(2)
			expect(stderr).not.toHaveBeenCalled()
		})
	})

	describe('one template, one geometry, every backend', () => {
		it('tmux and herdr receive the same splits, in the same order, with the same directions and ratios', () => {
			const tmuxCalls: string[][] = []
			openTemplate(tmuxExec(tmuxCalls), tmuxMuxAdapter, pool4, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			const herdrCalls: string[][] = []
			openTemplate(herdrExec(herdrCalls), herdrMuxAdapter, pool4, {
				cwd: '/target',
				dirExists: anyDir,
				newId: fakeNewId,
			})

			const expected = [
				{ direction: 'right', ratio: 0.5 },
				{ direction: 'down', ratio: 0.5 },
				{ direction: 'down', ratio: 0.5 },
			]
			expect(tmuxSplits(tmuxCalls)).toEqual(expected)
			expect(herdrSplits(herdrCalls)).toEqual(expected)
			expect(tmuxSplits(tmuxCalls)).toEqual(herdrSplits(herdrCalls))
		})

		it('tmux’s own select-template is never invoked', () => {
			// It implements tmux's grid algorithm, which herdr has no equivalent of — using it would give
			// the same template a different geometry per backend.
			const calls: string[][] = []
			openTemplate(tmuxExec(calls), tmuxMuxAdapter, pool4, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(calls.some((c) => c[0] === 'select-template')).toBe(false)
		})
	})

	describe('apply does not roll back', () => {
		it('a throw mid-walk reports what was built, kills nothing, and surfaces the failure', () => {
			// A kill is not obviously safer than a half-built template the caller can see and finish. This is
			// the price of owning the engine rather than delegating to an atomic tree-apply, and it is
			// paid uniformly — a guarantee only herdr could make is not one cyber-mux can offer.
			const template: Template = {
				name: 'render-farm',
				arrange: 'even-horizontal',
				panes: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
			}
			// Opens: 1 = the region, 2..4 = the three splits. The THIRD split is open #4.
			const { adapter, calls } = fakeAdapter({ failOnOpen: 4 })
			let thrown: unknown
			try {
				openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			} catch (err) {
				thrown = err
			}
			expect(thrown).toBeInstanceOf(TemplateApplyError)
			const { manifest } = thrown as TemplateApplyError
			// The panes built before the failure are reported, with their real ids.
			expect(manifest.panes.map((p) => p.label)).toEqual(['a', 'b', 'c'])
			expect(manifest.panes.map((p) => p.pane)).toEqual(['p1', 'p2', 'p3'])
			expect(manifest.template).toBe('render-farm')
			// Nothing is killed, and no command is typed into a half-built pool.
			expect(calls.teardowns).toEqual([])
			expect(calls.submits).toEqual([])
		})
	})

	describe('the manifest', () => {
		it('reports the template, the injected cwd, the workspace, and one entry per pane', () => {
			const { adapter } = fakeAdapter()
			const manifest = openTemplate(noExec, adapter, agentPool3, {
				cwd: '/w/feat-x',
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(manifest).toEqual({
				template: 'agent-pool-3',
				cwd: '/w/feat-x',
				workspace: null,
				panes: [
					// `tab: null` — a single-tab template said nothing about tabs, so there is none to report.
					{ label: 'planner', pane: 'p1', dir: '/w/feat-x', command: 'claude', tab: null },
					{ label: 'worker-a', pane: 'p2', dir: '/w/feat-x', command: 'claude', tab: null },
					{ label: 'worker-b', pane: 'p3', dir: '/w/feat-x', command: 'claude', tab: null },
				],
			})
		})

		it('reports an unlabeled pane with a null label rather than dropping it', () => {
			const { adapter } = fakeAdapter()
			const template: Template = { name: 'render-farm', panes: [{ command: 'top' }] }
			const manifest = openTemplate(noExec, adapter, template, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
			expect(manifest.panes).toEqual([{ label: null, pane: 'p1', dir: '/target', command: 'top', tab: null }])
		})
	})

	describe('applyTemplateToRegion', () => {
		it('builds into a region someone else already opened, reporting its workspace', () => {
			// The worktree flow: the worktree's own workspace IS the region, and its root pane is the
			// tree's root — so the walk splits into it rather than opening a second space.
			const { adapter, calls } = fakeAdapter()
			const root: OpenedPane = { id: 'w9:p1', tab: 'w9:t1' }
			const manifest = applyTemplateToRegion(noExec, adapter, agentPool3, {
				root,
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(manifest.workspace).toBe('w9')
			expect(manifest.cwd).toBe('/repo.worktrees/feat-x')
			// The pre-opened pane is the tree's root, so only the two splits are opened here.
			expect(calls.opens).toHaveLength(2)
			// The pre-opened region's PANE is what the first split targets — a split splits a pane, so the
			// walk names it by its pane handle rather than passing the whole opened region through.
			expect(calls.opens[0]?.from).toEqual({ id: root.id })
			expect(manifest.panes[0]).toMatchObject({ label: 'planner', pane: 'w9:p1' })
		})

		it('anchors every later tab to the workspace the region already lives in', () => {
			// The same anchor `open --template` needs, from the other end: here the workspace was opened
			// by the worktree verbs and is TOLD to the walk, so a tab that trusted the backend's default
			// would land beside the caller instead of in the worktree's own workspace.
			const { adapter, calls } = fakeAdapter({ workspace: 'w9' })
			const template: Template = {
				name: 'pool',
				tabs: [
					{ label: 'editor', panes: [{ label: 'edit' }] },
					{ label: 'logs', panes: [{ label: 'tail' }] },
				],
			}
			applyTemplateToRegion(noExec, adapter, template, {
				root: { id: 'w9:root', tab: 'w9:t1' },
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
				newId: fakeNewId,
			})
			// The region was already open, so the ONLY open here is the second tab's — and it is anchored.
			expect(calls.opens.map((o) => ({ at: o.at, within: o.within }))).toEqual([{ at: 'tab', within: 'w9' }])
		})

		it('reports the root pane’s ACTUAL dir, never the dir the template asked for', () => {
			// The region was opened by a caller whose contract fixed its cwd — a worktree's workspace
			// opens at the worktree root, because that is what the binding pins. Claiming the root pane
			// sits at cwd + dir would make the manifest describe a location nothing ever opened, and the
			// manifest is precisely the answer to "which panes exist and what are they for".
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const { adapter } = fakeAdapter()
			const template: Template = {
				name: 'build-trio',
				panes: [{ label: 'editor', dir: 'apps/web' }, { label: 'spare' }],
			}
			const manifest = applyTemplateToRegion(noExec, adapter, template, {
				root: { id: 'w9:root', tab: 'w9:t1' },
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
				newId: fakeNewId,
			})
			// Where it really is — not /repo.worktrees/feat-x/apps/web.
			expect(manifest.panes[0]).toEqual({
				label: 'editor',
				pane: 'w9:root',
				dir: '/repo.worktrees/feat-x',
				command: null,
				tab: null,
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
			const template: Template = {
				name: 'build-trio',
				panes: [{ label: 'editor' }, { label: 'watcher', dir: 'apps/web' }],
			}
			const manifest = applyTemplateToRegion(noExec, adapter, template, {
				root: { id: 'w9:root', tab: 'w9:t1' },
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(calls.opens[0]?.cwd).toBe('/repo.worktrees/feat-x/apps/web')
			expect(manifest.panes[1]?.dir).toBe('/repo.worktrees/feat-x/apps/web')
		})

		it('warns about nothing when the root pane asks for no dir', () => {
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			const { adapter } = fakeAdapter()
			const manifest = applyTemplateToRegion(noExec, adapter, agentPool3, {
				root: { id: 'w9:root', tab: 'w9:t1' },
				cwd: '/repo.worktrees/feat-x',
				workspace: 'w9',
				rootEnvHonored: true,
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(stderr).not.toHaveBeenCalled()
			expect(manifest.panes[0]?.dir).toBe('/repo.worktrees/feat-x')
		})

		describe('the env-prefix fallback — design §7.3 Gap C’s first real customer', () => {
			const farm: Template = {
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
				applyTemplateToRegion(noExec, adapter, farm, {
					root: { id: 'w9:root', tab: 'w9:t1' },
					cwd: '/repo.worktrees/feat-x',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
					newId: fakeNewId,
				})
				// It is just a command line, so it works on any backend — the fallback's whole appeal.
				expect(calls.submits[0]).toEqual({ pane: 'w9:root', text: "env TIER='gpu' render" })
				// The split-born pane got its env natively, so it is NEVER prefixed on top of that.
				expect(calls.submits[1]).toEqual({ pane: 'p1', text: 'encode' })
			})

			it('never prefixes when the region open already set the env natively', () => {
				// The double-application guard: prefixing here would set TIER twice and lie about which won.
				const { adapter, calls } = fakeAdapter()
				applyTemplateToRegion(noExec, adapter, farm, {
					root: { id: 'w9:root', tab: 'w9:t1' },
					cwd: '/repo.worktrees/feat-x',
					workspace: 'w9',
					rootEnvHonored: true,
					dirExists: anyDir,
					newId: fakeNewId,
				})
				expect(calls.submits[0]).toEqual({ pane: 'w9:root', text: 'render' })
			})

			it('open --template sets env natively and prefixes nothing, on either backend', () => {
				for (const [adapter, exec] of [
					[tmuxMuxAdapter, tmuxExec([])],
					[herdrMuxAdapter, herdrExec([])],
				] as const) {
					const calls: string[][] = []
					const recording: Exec = (cmd, args) => {
						calls.push(args)
						return exec(cmd, args)
					}
					openTemplate(recording, adapter, farm, { cwd: '/target', dirExists: anyDir, newId: fakeNewId })
					// Whatever this backend's submit spells, it carries the bare command — never `env ...`.
					expect(calls.filter((c) => c.some((a) => a.startsWith('env ')))).toEqual([])
					expect(calls.some((c) => c.includes('render'))).toBe(true)
				}
			})

			it('shell-quotes a value carrying spaces or quotes, so the command line cannot break', () => {
				const { adapter, calls } = fakeAdapter()
				const template: Template = {
					name: 'render-farm',
					panes: [{ label: 'dispatcher', env: { NOTE: "it's a big one", FLAGS: '--x 1' }, command: 'render' }],
				}
				applyTemplateToRegion(noExec, adapter, template, {
					root: { id: 'w9:root', tab: 'w9:t1' },
					cwd: '/target',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
					newId: fakeNewId,
				})
				// A bare value would split into extra words; a bare quote would unbalance the line.
				expect(calls.submits[0]?.text).toBe("env NOTE='it'\\''s a big one' FLAGS='--x 1' render")
			})

			it('warns once, and prefixes nothing, when the root pane has env but no command', () => {
				// The fallback can only ride on a command line — there is nothing to ride here.
				const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
				const { adapter, calls } = fakeAdapter()
				const template: Template = {
					name: 'render-farm',
					panes: [{ label: 'dispatcher', env: { TIER: 'gpu' } }, { label: 'encoder' }],
				}
				applyTemplateToRegion(noExec, adapter, template, {
					root: { id: 'w9:root', tab: 'w9:t1' },
					cwd: '/target',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
					newId: fakeNewId,
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
				applyTemplateToRegion(noExec, adapter, agentPool3, {
					root: { id: 'w9:root', tab: 'w9:t1' },
					cwd: '/target',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
					newId: fakeNewId,
				})
				expect(stderr).not.toHaveBeenCalled()
			})

			it('a root pane whose env the region open could not carry has it prefixed onto its command', () => {
				const { adapter, calls } = fakeAdapter()
				applyTemplateToRegion(noExec, adapter, farm, {
					root: { id: 'w9:root', tab: 'w9:t1' },
					cwd: '/repo.worktrees/feat-x',
					workspace: 'w9',
					rootEnvHonored: false,
					dirExists: anyDir,
					newId: fakeNewId,
				})
				// The root pane's command carries its env as a prefix — the only route that lost env at birth.
				expect(calls.submits[0]).toEqual({ pane: 'w9:root', text: "env TIER='gpu' render" })
				// No OTHER pane's command is prefixed: the split-born pane got its env natively.
				expect(calls.submits.slice(1).every((s) => !s.text?.startsWith('env '))).toBe(true)
				expect(calls.submits[1]).toEqual({ pane: 'p1', text: 'encode' })
			})

			it('a root pane whose env could not be carried, with no command to prefix, warns once', () => {
				// Several panes across several tabs, whose root pane has env but no command to ride it in on.
				const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
				const { adapter, calls } = fakeAdapter({ workspace: 'w9' })
				const template: Template = {
					name: 'render-farm',
					tabs: [
						{ label: 'gpu', panes: [{ label: 'dispatcher', env: { TIER: 'gpu' } }, { label: 'encoder' }] },
						{ label: 'cpu', panes: [{ label: 'muxer' }, { label: 'sink' }] },
					],
				}
				applyTemplateToRegion(noExec, adapter, template, {
					root: { id: 'w9:root', tab: 'w9:t1' },
					cwd: '/target',
					workspace: 'w9',
					rootEnvHonored: false,
					label: 'render-farm',
					dirExists: anyDir,
					newId: fakeNewId,
				})
				// Nothing to prefix, so nothing is submitted for the root pane...
				expect(calls.submits).toEqual([])
				// ...and the loss is reported ONCE — not once per pane — naming the pane and its variable.
				expect(stderr).toHaveBeenCalledTimes(1)
				const warning = String(stderr.mock.calls[0]![0])
				expect(warning).toContain('dispatcher')
				expect(warning).toContain('TIER')
			})
		})

		it('reports a null workspace on a backend that binds none', () => {
			const { adapter } = fakeAdapter()
			const manifest = applyTemplateToRegion(noExec, adapter, pool4, {
				root: { id: '%0', tab: '@0' },
				cwd: '/target',
				workspace: null,
				rootEnvHonored: true,
				dirExists: anyDir,
				newId: fakeNewId,
			})
			expect(manifest.workspace).toBeNull()
		})
	})
})
