import { resolve } from 'node:path'
import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import type {
	LivePane,
	OpenedPane,
	RegionPane,
	SessionAdapter,
	SessionReadOptions,
	WorkspaceTab,
	WorktreeWorkspace,
	WorktreeWorkspaceCapability,
} from './session.ts'
import { normalizeWorktreePath } from './worktree.ts'

/**
 * herdr backend — detected via `$HERDR_ENV`. herdr (https://herdr.dev) is an agent-aware terminal
 * multiplexer that also reports real busy-state (working / idle / blocked / done); this adapter
 * only drives its pane lifecycle, not the state feed. Talks to herdr's own CLI (`herdr pane ...`)
 * rather than its Unix-socket API, so it composes with this codebase's synchronous `Exec`
 * convention exactly like the tmux adapter — no new client/transport needed.
 *
 * The pane lifecycle (split/run/read/close) is verified against a live herdr binary; `pane split`
 * returns a JSON `pane_info` envelope whose id is extracted in `parsePaneId`.
 */
export const herdrSessionAdapter: SessionAdapter = {
	name: 'herdr',

	// `pane split --ratio` sizes a split — and sizes the ORIGINAL pane, which is the seam's own
	// convention, so it passes through unconverted (unlike tmux's `-l`). Verified against 0.7.4.
	canSizeSplits: true,

	open(exec, opts) {
		const at = opts.at ?? 'tab'
		// herdr takes a label at birth for a workspace and a tab, but not for a split — a pane is
		// named afterwards, via `pane rename`.
		const label = opts.label ? ['--label', opts.label] : []
		// Native at EVERY tier, not just the split: `WorkspaceCreateParams` and `TabCreateParams` both
		// carry an `env` Record in herdr's socket schema (protocol 16), and the CLI takes the same
		// repeatable `--env KEY=VALUE` there as `pane split` does — verified against 0.7.4. That
		// matters because a template's root pane is born by the region open rather than by a split, so
		// scoping env to the split path would silently drop that pane's env.
		const env = envFlags(opts.env)
		// `opts.workspaceGroup` is deliberately unread here, and that IS this adapter's answer to it:
		// herdr's workspace is a real tier and every pane and tab record already carries its
		// `workspace_id`, so the tier already IS the group. No grouping flag reaches herdr — a second
		// grouping would duplicate a fact the backend never reads, and herdr would have to be taught to
		// read it. The seam's group id exists for a backend with no workspace tier to group in (tmux);
		// an adapter ignoring a new optional member still satisfies the contract.
		let opened: OpenedPane
		if (at === 'workspace') {
			// A genuinely separate workspace, not a pane inside the caller's current one — `--no-focus`
			// so spawning doesn't steal the caller's attention/focus.
			const out = exec('herdr', ['workspace', 'create', '--cwd', opts.cwd, ...label, ...env, '--no-focus'])
			if (!out) throw new Error(withReason(exec, 'herdr workspace create failed'))
			opened = parseRootPaneId(out, 'herdr workspace create')
		} else if (at === 'tab') {
			// A real tab in the current window, not a split pane — `--no-focus` so spawning doesn't
			// steal the caller's attention/focus, matching workspace/worktree spawns.
			//
			// `--workspace` whenever the caller names one, and the omission is NOT harmless: without it
			// `tab create` resolves the workspace the same way `--current` resolves a pane — from the
			// UI-focused space — so a caller filling a workspace it just opened would put its first tab
			// in the new space and every later one beside the pane it was RUN from. Verified against
			// 0.7.4, whose `tab create` takes `--workspace <workspace_id>` natively.
			const within = opts.within ? ['--workspace', opts.within] : []
			const out = exec('herdr', ['tab', 'create', ...within, '--cwd', opts.cwd, ...label, ...env, '--no-focus'])
			if (!out) throw new Error(withReason(exec, 'herdr tab create failed'))
			opened = parseRootPaneId(out, 'herdr tab create')
		} else {
			const direction = at === 'pane:down' ? 'down' : 'right'
			// Name the pane whenever the caller knows it. herdr's `--current` is not "the pane that
			// called me": it reads `$HERDR_PANE_ID` and, when that is unset, resolves to the UI-FOCUSED
			// pane instead — silently, so an unidentified caller splits whatever the user happens to be
			// looking at. Verified against herdr 0.7.4. `--current` is kept only as the last resort for
			// a caller that could not identify itself, where herdr's guess is still better than failing.
			// Native means no command-prefix fallback is needed, so a pane with env and NO command still
			// gets its env.
			const from = opts.from ? [opts.from.id] : ['--current']
			// `--ratio` takes the seam's number VERBATIM: it sizes the original pane, which is exactly
			// what `ratio` means. tmux's `-l` sizes the new pane and therefore inverts — the one place
			// the two backends convert in opposite directions. Measured against 0.7.4 (splitting a
			// 201-column region at `--ratio 0.333` left the original 67 columns), not documented.
			const size = opts.ratio != null ? ['--ratio', String(opts.ratio)] : []
			const out = exec('herdr', [
				'pane',
				'split',
				...from,
				'--direction',
				direction,
				'--cwd',
				opts.cwd,
				...size,
				...env,
			])
			if (!out) throw new Error(withReason(exec, 'herdr pane split failed'))
			opened = parsePaneId(out)
			// Through `rename`, not a second `pane rename` spelled here: post-birth pane naming and the
			// seam's rename are the same act, so one spelling per backend is the only way the two cannot
			// drift.
			if (opts.label) herdrSessionAdapter.rename(exec, opened, 'pane', opts.label)
		}
		// `submit`, not `sendText` — a launch command has to actually run, and `submit` is the only
		// verb that supplies the Enter.
		if (opts.launch) herdrSessionAdapter.submit(exec, opened, opts.launch)
		return opened
	},

	rename(exec, target, tier, name) {
		// herdr spells both tiers the same way — `<tier> rename <id> <name>` — so the tier selects the
		// noun and nothing else. Neither verb focuses what it names, and neither creates anything.
		// `tab rename` is what makes a new workspace's root tab nameable at all: `workspace create`
		// labels that tab `1` and takes no flag for it (verified against 0.7.4).
		exec('herdr', [tier, 'rename', target.id, name])
	},

	group() {
		// Deliberately empty, and that IS this backend's complete answer — not a stub and not a
		// degrade. herdr's workspace is a REAL tier: every pane and tab record already carries its
		// `workspace_id`, so the tier already is the group; and its tab label is the tab's own name,
		// never a composed display name, because its UI groups by the real workspace label and the walk
		// therefore composes nothing to prefix. Both facts the backend already holds, so no grouping
		// flag and no name flag reach herdr — storing either would duplicate a fact it never reads, and
		// herdr would have to be taught to read it. Same answer, and the same reason, as `open`'s unread
		// `workspaceGroup`.
	},

	worktree: herdrWorktreeCapability(),

	sendText(exec, target, text) {
		// herdr splits the two intents at its own CLI, so this maps straight onto `send-text` — no
		// literal-escaping flag needed (unlike tmux, whose one `send-keys` guesses between them).
		exec('herdr', ['pane', 'send-text', target.id, text])
	},

	sendKeys(exec, target, keys) {
		// Verbatim: every core key is already herdr's own name for it, so there is nothing to rename.
		// herdr refuses a key it does not know (`unsupported key <k>`) rather than typing it — so at
		// THIS boundary the divergence is loud, unlike tmux, which types an unknown token instead.
		// That loudness stops here, though: `Exec` discards stderr and reports a failed command as
		// `null`, which this ignores, so the caller sees exit 0 either way. Surfacing it is the
		// `Exec` seam's job (it affects every verb), not this method's — a follow-up owns it.
		exec('herdr', ['pane', 'send-keys', target.id, ...keys])
	},

	submit(exec, target, text) {
		// A bare Enter keystroke is the only form that types nothing by construction, which is what the
		// flush contract requires. (`pane run <id> ""` also presses Enter — verified against a live
		// herdr — so it would work; `send-keys Enter` says what it means.)
		if (!text) {
			exec('herdr', ['pane', 'send-keys', target.id, 'Enter'])
			return
		}
		// `pane run` submits text plus Enter atomically — herdr's documented preference over
		// send-text + send-keys Enter, and it types the text literally (a command named `Up` is typed,
		// not interpreted), which is exactly submit's guarantee.
		exec('herdr', ['pane', 'run', target.id, text])
	},

	read(exec, target, opts?: SessionReadOptions) {
		const args = ['pane', 'read', target.id, '--source', 'visible']
		if (opts?.lines != null) args.push('--lines', String(opts.lines))
		return exec('herdr', args) ?? ''
	},

	focus(exec, target) {
		// `herdr pane focus` only accepts `--direction` (no by-id form), and a peer's pane can sit in
		// a different workspace/tab than the attached client — a single pane-level command can't beam
		// the client there. Resolve the pane's own workspace/tab from the backend first (`pane get`)
		// and drive the beam in order: workspace focus, then tab focus. A tab's active pane IS the
		// pane, so landing on the tab lands input focus on it — herdr has no separate by-id pane
		// focus to reach for. Resolution is attempted BEFORE any switch is issued, so an unresolvable
		// pane throws instead of a partial or false-success beam.
		const out = exec('herdr', ['pane', 'get', target.id])
		const { workspaceId, tabId } = parsePaneLocation(out, target.id)
		exec('herdr', ['workspace', 'focus', workspaceId])
		exec('herdr', ['tab', 'focus', tabId])
	},

	teardown(exec, target) {
		exec('herdr', ['pane', 'close', target.id])
	},

	paneExists(exec, target) {
		// `pane read` returns the pane's content for a live pane (empty string when the pane is empty),
		// and fails — Exec yields null — when the pane id no longer names a pane. A live pane is exactly
		// the non-null case; an empty live pane ('') must NOT read as gone.
		return exec('herdr', ['pane', 'read', target.id, '--source', 'visible']) !== null
	},

	isPaneFocused(exec, target) {
		// `herdr pane get <id>` prints `{"result":{"pane":{...,"focused":true|false,...}}}` on success,
		// or `{"error":{"code":"pane_not_found",...}}` when the pane can no longer be resolved. Parse
		// defensively: a missing/non-boolean `focused`, an error envelope, null output, or a JSON parse
		// failure all fall through to unknown rather than a false `false`.
		const out = exec('herdr', ['pane', 'get', target.id])
		if (out == null) return undefined
		try {
			const focused = JSON.parse(out)?.result?.pane?.focused
			return typeof focused === 'boolean' ? focused : undefined
		} catch {
			return undefined
		}
	},

	listPanes(exec): LivePane[] {
		const out = exec('herdr', ['pane', 'list'])
		if (!out) return []
		let panes: unknown
		try {
			panes = JSON.parse(out)?.result?.panes
		} catch {
			return []
		}
		if (!Array.isArray(panes)) return []
		return panes
			.filter(
				(p): p is { pane_id: string; agent?: string; cwd?: string; label?: string } => typeof p?.pane_id === 'string',
			)
			.map((p) => ({
				id: p.pane_id,
				mux: 'herdr' as const,
				harness: p.agent || undefined,
				cwd: p.cwd,
				// Verbatim, and no comparison rule to tell an unnamed pane apart: herdr has no default
				// label — the key is absent from `pane list` until `pane rename` — so an omitted key IS
				// "nobody named it". `|| undefined` only collapses an empty-string label to absent, the
				// same normalization `harness` above takes. tmux needs a title-vs-host heuristic here
				// precisely because it lacks this primitive.
				label: p.label || undefined,
			}))
	},

	describeRegion(exec, target) {
		// Two calls, because herdr splits the answer across two verbs: `pane layout` reports the
		// region's rects (`layout.panes[].rect`) but carries no cwd and no label, while `pane list`
		// carries both and no geometry. Neither alone can build a template.
		//
		// `layout.splits[]` is deliberately ignored even though it reports `direction` and `ratio`
		// outright. It is FLAT — `[{id:"split_0_root",...},{id:"split_1_0",...}]` — so the tree is
		// recoverable only by parsing the parent out of that id string, a convention herdr's CLI help
		// never documents and could respell without warning. The rects say the same thing in a fact
		// herdr does promise, so the derivation runs off those; see `describeRegion` in `session.ts`.
		// Best-effort: a region whose geometry is known is still worth exporting when the cwd/label
		// lookup fails — the geometry is the verbose part, and the missing dirs are visibly absent.
		return herdrRegionPanes(exec, target.id, herdrPaneDetails(exec))
	},

	/**
	 * herdr HAS a workspace tier, so the workspace is a fact the backend holds rather than one
	 * cyber-mux has to reconstruct: the caller's pane names its `workspace_id`, `tab list --workspace`
	 * enumerates that workspace's tabs, and `pane list --workspace` hands back every pane already
	 * stamped with the tab it sits in. No grouping tag is read here and none is written — the tier IS
	 * the group, which is exactly why `open` ignores `workspaceGroup` on this backend.
	 *
	 * The one indirection: geometry is per-PANE (`pane layout --pane`), never per-tab, so each tab's
	 * rects are fetched through any one pane that sits in it. That is safe and race-free, and both
	 * halves were established against 0.7.4: `pane layout` reports live geometry for an UNFOCUSED tab
	 * in a DIFFERENT workspace, so nothing has to be focused first and nothing moves while this runs.
	 *
	 * herdr's own native per-tab layout export would be the obvious road — it takes a `tab_id` — but
	 * `layout` is NOT a CLI verb in 0.7.4; it is socket-API-only, and this adapter speaks the CLI by
	 * design (so it composes with the synchronous `Exec` seam). The road is closed, hence the pane
	 * indirection.
	 */
	describeWorkspace(exec, target) {
		const { workspaceId } = parsePaneRecord(exec('herdr', ['pane', 'get', target.id]))
		if (!workspaceId) {
			throw new Error(withReason(exec, `herdr could not resolve the workspace around pane ${target.id}`))
		}
		const out = exec('herdr', ['tab', 'list', '--workspace', workspaceId])
		if (!out) throw new Error(withReason(exec, `herdr could not enumerate the tabs of workspace ${workspaceId}`))
		let reported: unknown
		try {
			reported = JSON.parse(out)?.result?.tabs
		} catch {
			throw new Error(`herdr tab list returned unparseable output: ${out.slice(0, 200)}`)
		}
		if (!Array.isArray(reported) || reported.length === 0) {
			throw new Error(`herdr reported no tabs in workspace ${workspaceId}: ${out.slice(0, 200)}`)
		}
		// Scoped to the workspace, so a busy machine's other workspaces never reach the capture. Every
		// pane arrives stamped with its `tab_id`, which is what makes ONE call enough for every tab.
		const details = herdrPaneDetails(exec, workspaceId)
		const tabs: WorkspaceTab[] = []
		for (const reportedTab of reported) {
			if (typeof reportedTab?.tab_id !== 'string') continue
			const tabId: string = reportedTab.tab_id
			// Any pane of the tab will do — `pane layout` reports the whole region the pane sits in, so
			// which one is asked is immaterial.
			const anchor = [...details].find(([, detail]) => detail.tab === tabId)?.[0]
			if (!anchor) throw new Error(`herdr reported no panes in tab ${tabId} of workspace ${workspaceId}`)
			const tab: WorkspaceTab = { id: tabId, panes: herdrRegionPanes(exec, anchor, details) }
			// Verbatim, never parsed: herdr labels a tab with the tab's own name because the real
			// workspace tier already carries the grouping, so there is nothing composed to take apart.
			if (typeof reportedTab.label === 'string' && reportedTab.label !== '') tab.label = reportedTab.label
			tabs.push(tab)
		}
		if (tabs.length === 0)
			throw new Error(`herdr reported no usable tabs in workspace ${workspaceId}: ${out.slice(0, 200)}`)
		return tabs
	},
}

/**
 * The rects of the region `paneId` sits in, joined with the cwd/label half.
 *
 * Two sources, because herdr splits the answer across two verbs: `pane layout` reports the region's
 * rects (`layout.panes[].rect`) but carries no cwd and no label, while `pane list` carries both and
 * no geometry. Neither alone can build a template — hence `details` is passed IN, so a caller reading
 * many tabs pays for that list once rather than once per tab.
 *
 * `layout.splits[]` is deliberately ignored even though it reports `direction` and `ratio` outright.
 * It is FLAT — `[{id:"split_0_root",...},{id:"split_1_0",...}]` — so the tree is recoverable only by
 * parsing the parent out of that id string, a convention herdr's CLI help never documents and could
 * respell without warning. The rects say the same thing in a fact herdr does promise, so the
 * derivation runs off those; see `describeRegion` in `session.ts`.
 */
function herdrRegionPanes(exec: Exec, paneId: string, details: Map<string, HerdrPaneDetail>): RegionPane[] {
	const out = exec('herdr', ['pane', 'layout', '--pane', paneId])
	if (!out) throw new Error(withReason(exec, `herdr could not describe the region around pane ${paneId}`))
	let reported: unknown
	try {
		reported = JSON.parse(out)?.result?.layout?.panes
	} catch {
		throw new Error(`herdr pane layout returned unparseable output: ${out.slice(0, 200)}`)
	}
	if (!Array.isArray(reported) || reported.length === 0) {
		throw new Error(`herdr pane layout reported no panes for ${paneId}: ${out.slice(0, 200)}`)
	}
	return reported
		.filter((p): p is { pane_id: string; rect: Record<string, number> } => typeof p?.pane_id === 'string')
		.map((p) => {
			const detail = details.get(p.pane_id)
			const pane: RegionPane = {
				id: p.pane_id,
				// Screen-absolute, unlike tmux's window-relative origin — which is why nothing downstream
				// may assume a region starts at 0,0. See `PaneRect`.
				rect: { x: p.rect?.x ?? 0, y: p.rect?.y ?? 0, width: p.rect?.width ?? 0, height: p.rect?.height ?? 0 },
			}
			if (detail?.cwd) pane.cwd = detail.cwd
			// herdr has no default label — the key is absent until `pane rename`, so whatever is here
			// is one the author set. No hostname filtering needed, unlike tmux.
			if (detail?.label) pane.label = detail.label
			return pane
		})
}

/** What `pane list` knows and `pane layout` does not: a pane's cwd, its label, and the tab it sits in. */
interface HerdrPaneDetail {
	cwd?: string
	label?: string
	/** The tab this pane sits in — herdr stamps every pane record with it. */
	tab?: string
}

/**
 * Each pane's cwd, label and tab, keyed by pane id — the half `pane layout` does not report.
 *
 * `workspace` scopes the list to one workspace when the caller has one to scope by; omitting it lists
 * every pane herdr can see, which is what a single-region read wants (it keys by pane id and never
 * cares which workspace a pane came from).
 */
function herdrPaneDetails(exec: Exec, workspace?: string): Map<string, HerdrPaneDetail> {
	const details = new Map<string, HerdrPaneDetail>()
	const out = exec('herdr', ['pane', 'list', ...(workspace ? ['--workspace', workspace] : [])])
	if (!out) return details
	let panes: unknown
	try {
		panes = JSON.parse(out)?.result?.panes
	} catch {
		return details
	}
	if (!Array.isArray(panes)) return details
	for (const pane of panes) {
		if (typeof pane?.pane_id !== 'string') continue
		details.set(pane.pane_id, { cwd: pane.cwd, label: pane.label, tab: pane.tab_id })
	}
	return details
}

/**
 * herdr's repeatable `--env KEY=VALUE` — spelled the same way by exactly three verbs: `pane split`,
 * `workspace create` and `tab create`, each backed by a native `env` Record in the socket schema
 * (protocol 16).
 *
 * `worktree create`/`worktree open` are deliberately NOT in that list: their params are
 * `[base, branch, cwd, focus, label, path, workspace_id]` and
 * `[branch, cwd, focus, label, path, workspace_id]` — no `env` — and 0.7.4 rejects the flag with
 * `unknown option: --env`. A caller needing env on that route uses the command-prefix fallback.
 */
function envFlags(env: Record<string, string> | undefined): string[] {
	return env ? Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]) : []
}

/**
 * Launch a command in a worktree's root pane, carrying env the worktree verb could not set at birth.
 * The prefix-or-warn rule is the seam's (`env-fallback.ts`); this is the one route that invokes it,
 * because it is the one route that loses env. With a command, env rides in as a prefix; with none and
 * env asked for, it warns to stderr (stdout stays machine-readable) rather than dropping in silence.
 */
function carryLaunch(exec: Exec, target: OpenedPane, env: Record<string, string> | undefined, launch?: string): void {
	const fallback = envFallback(env, launch)
	if (fallback.kind === 'dropped') {
		process.stderr.write(
			`env (${fallback.variables.join(', ')}) could not be set on this worktree's workspace and ` +
				'no command was given to carry it — herdr worktree create/open take no env parameter\n',
		)
		return
	}
	if (fallback.command !== undefined) herdrSessionAdapter.submit(exec, target, fallback.command)
}

/**
 * `herdr pane split` emits a JSON envelope, not a bare id:
 * `{"id":"cli:pane:split","result":{"pane":{"pane_id":"w3:pB", ...},"type":"pane_info"}}`.
 * The pane id herdr's other `pane` subcommands accept lives at `.result.pane.pane_id`. Extract it —
 * passing the whole blob downstream lands it in a filename and blows the path length limit.
 */
function parsePaneId(out: string): OpenedPane {
	return parseOpenedPane(out, 'herdr pane split', 'pane')
}

/**
 * `herdr pane get <id>` emits `{"result":{"pane":{"workspace_id":...,"tab_id":...,...}}}`, or an
 * error envelope when the id no longer names a live pane. Every unresolvable shape — `out` is null
 * (an Exec failure), the JSON does not parse, or a field is missing/empty/not a string — folds to the
 * field simply being absent, so each caller states its OWN failure rather than inheriting one
 * phrased for somebody else's verb.
 */
function parsePaneRecord(out: string | null): { workspaceId?: string; tabId?: string } {
	if (out == null) return {}
	try {
		const pane = JSON.parse(out)?.result?.pane
		return { workspaceId: nonEmpty(pane?.workspace_id), tabId: nonEmpty(pane?.tab_id) }
	} catch {
		return {}
	}
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The pane's workspace and tab, or a throw — so `focus` never issues a workspace/tab switch against a
 * pane it couldn't actually resolve.
 */
function parsePaneLocation(out: string | null, id: string): { workspaceId: string; tabId: string } {
	const { workspaceId, tabId } = parsePaneRecord(out)
	if (!workspaceId || !tabId) throw new Error(`peer's pane ${id} could not be resolved to beam to`)
	return { workspaceId, tabId }
}

/**
 * herdr binds a git worktree to a workspace as a first-class record, and that binding is what its UI
 * groups a repo's checkouts by. Only `worktree create`/`worktree open` produce it: `git worktree add`
 * followed by `workspace create --cwd <checkout>` yields a workspace herdr does not know is a
 * worktree at all, left out of the group. Hence this capability — see `WorktreeWorkspaceCapability`
 * for what it deliberately does not own.
 *
 * Every call pins the source repo with `--cwd <primaryRoot>` rather than relying on the caller's
 * ambient process cwd (matching how the git adapter always passes `-C <primaryRoot>`), and opens
 * with `--no-focus` so spawning never steals the caller's attention.
 */
function herdrWorktreeCapability(): WorktreeWorkspaceCapability {
	return {
		createInWorkspace(exec, opts) {
			const args = ['worktree', 'create', '--cwd', opts.primaryRoot, '--branch', opts.branch, '--path', opts.path]
			if (opts.base) args.push('--base', opts.base)
			// Without this herdr names the workspace after the checkout path's basename, because we always
			// pass `--path` — it would use the branch if we let it choose the location itself.
			if (opts.label) args.push('--label', opts.label)
			// Deliberately NO `--env`, unlike every other tier: `WorktreeCreateParams` is
			// `[base, branch, cwd, focus, label, path, workspace_id]` — no `env` — and herdr 0.7.4
			// rejects the flag outright (`unknown option: --env`), which `Exec` would turn into a null
			// and this into a thrown "worktree create failed". `opts.env` is NOT emitted to herdr;
			// `carryLaunch` compensates for it on the launch instead — this is the one route that loses
			// env, so it is the one route that invokes the fallback.
			args.push('--no-focus')
			const out = exec('herdr', args)
			if (!out) throw new Error(withReason(exec, 'herdr worktree create failed'))
			const created = parseWorktreeWorkspace(out, 'herdr worktree create')
			// This route could not set env at birth, so it compensates on the launch. `submit`, not
			// `sendText` — a launch command has to actually run, and `submit` is the only verb that
			// supplies the Enter. (It lowers to `pane run`, herdr's atomic text-plus-Enter primitive.)
			carryLaunch(exec, created.target, opts.env, opts.launch)
			return created
		},

		openInWorkspace(exec, opts) {
			const args = ['worktree', 'open', '--cwd', opts.primaryRoot, '--path', opts.path]
			if (opts.label) args.push('--label', opts.label)
			// No `--env` here either — `WorktreeOpenParams` is
			// `[branch, cwd, focus, label, path, workspace_id]`. See `createInWorkspace`.
			args.push('--no-focus')
			const out = exec('herdr', args)
			if (!out) throw new Error(withReason(exec, 'herdr worktree open failed'))
			const opened = parseWorktreeWorkspace(out, 'herdr worktree open')
			// Same env compensation as `createInWorkspace` — `worktree open` is exposed identically,
			// taking no env param, so a caller passing env here would lose it just the same.
			carryLaunch(exec, opened.target, opts.env, opts.launch)
			return opened
		},

		bindings(exec, opts) {
			return parseWorktreeBindings(exec('herdr', ['worktree', 'list', '--cwd', opts.primaryRoot]))
		},

		releaseWorkspace(exec, workspace) {
			// Closes the workspace only — the checkout stays on disk for `git worktree remove` to take
			// under cyber-mux's own gates. Verified against a live herdr: worktrees survive the close.
			exec('herdr', ['workspace', 'close', workspace])
		},
	}
}

/**
 * `herdr workspace create` and `herdr tab create` both emit their new root pane at
 * `.result.root_pane.pane_id` (a different path than `pane split`'s `.result.pane.pane_id`).
 * `label` names the command in error messages (e.g. "herdr workspace create").
 */
function parseRootPaneId(out: string, label: string): OpenedPane {
	return parseOpenedPane(out, label, 'root_pane')
}

/**
 * Every pane herdr emits carries its own `workspace_id` alongside its `pane_id`, on EVERY route —
 * `workspace create` (which reports the workspace it just made), `tab create` (the workspace the tab
 * was created in), and `pane split` (the workspace the split landed in, i.e. the caller's). Verified
 * against herdr 0.7.4. That is why the workspace costs no extra call: it rides in on the same output
 * the pane id is already read from, so probing for it separately would buy nothing and cost a round
 * trip per open.
 *
 * The pane id is required — a route that cannot name its pane has failed. The workspace is NOT: it
 * is read opportunistically and left absent when missing rather than throwing, so a herdr build that
 * stops emitting it degrades to "cannot say" instead of breaking `open` outright. Absent is a
 * meaning this seam already has (`OpenedPane.workspace`); a hard failure here would be inventing a
 * new one for a field no caller is required to use.
 */
function parseOpenedPane(out: string, label: string, key: 'pane' | 'root_pane'): OpenedPane {
	let pane: { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown } | undefined
	try {
		pane = JSON.parse(out)?.result?.[key]
	} catch {
		throw new Error(`${label} returned unparseable output: ${out.slice(0, 200)}`)
	}
	const paneId = pane?.pane_id
	if (typeof paneId !== 'string' || paneId === '') {
		throw new Error(`${label} output had no result.${key}.pane_id: ${out.slice(0, 200)}`)
	}
	// The pane's OWN tab, carried in the same envelope on every route — a created tab reports itself,
	// a created workspace reports its root tab, a split reports the tab it landed in. Read here rather
	// than from the sibling `result.tab`, which only the tab route has, so one spelling serves all
	// three.
	//
	// Throws when absent, unlike `workspace` below: `OpenedPane.tab` is required because every
	// multiplexer has the Tab level, so a herdr envelope with no `tab_id` is herdr failing to answer
	// a question it always answers, not a tier it lacks. Returning a pane with no tab would hand the
	// caller a rename target it could only get wrong.
	const tab = pane?.tab_id
	if (typeof tab !== 'string' || tab === '') {
		throw new Error(`${label} output had no result.${key}.tab_id: ${out.slice(0, 200)}`)
	}
	const workspace = pane?.workspace_id
	return typeof workspace === 'string' && workspace !== '' ? { id: paneId, tab, workspace } : { id: paneId, tab }
}

/**
 * `herdr worktree create` and `herdr worktree open` emit the same envelope: the root pane at
 * `.result.root_pane.pane_id` (as `workspace create` does), the checkout at
 * `.result.worktree.{path,branch}`, and the bound workspace at `.result.workspace.workspace_id`.
 * That workspace id IS the binding — the whole reason to route through these instead of plain git.
 * `label` names the command in error messages (e.g. "herdr worktree create").
 *
 * The root pane is read through `parseOpenedPane`, NOT re-parsed here: `root_pane` is the same record
 * `workspace create` emits, so it carries the same `tab_id`, and one spelling is what keeps the two
 * routes from disagreeing about a field both report. That tab is the region's root tab — what lets a
 * caller handed this workspace group or rename it without reaching for the pane id, which would be
 * green on tmux and silently broken on herdr.
 */
function parseWorktreeWorkspace(out: string, label: string): WorktreeWorkspace {
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		throw new Error(`${label} returned unparseable output: ${out.slice(0, 200)}`)
	}
	const result = (parsed as { result?: unknown })?.result as
		| {
				workspace?: { workspace_id?: unknown }
				worktree?: { path?: unknown; branch?: unknown }
		  }
		| undefined
	// Throws on a missing pane id or tab id, with `parseOpenedPane`'s own message.
	const target = parseOpenedPane(out, label, 'root_pane')
	const workspace = result?.workspace?.workspace_id
	const path = result?.worktree?.path
	const branch = result?.worktree?.branch
	if (typeof path !== 'string' || path === '' || typeof branch !== 'string' || branch === '') {
		throw new Error(`${label} output had no result.worktree.{path,branch}: ${out.slice(0, 200)}`)
	}
	if (typeof workspace !== 'string' || workspace === '') {
		throw new Error(`${label} output had no result.workspace.workspace_id: ${out.slice(0, 200)}`)
	}
	return { target, worktree: { root: resolve(path), branch }, workspace }
}

/**
 * `herdr worktree list` reports every worktree of the repo, each carrying `open_workspace_id` ONLY
 * while a workspace is currently open on it. Everything else it reports (branch, linked, prunable)
 * is herdr re-reading git — deliberately ignored here; git answers those for every backend.
 * Defensive like `listPanes`: a query that cannot be read reports nothing rather than throwing.
 */
function parseWorktreeBindings(out: string | null): Map<string, string> {
	const bindings = new Map<string, string>()
	if (!out) return bindings
	let parsed: unknown
	try {
		parsed = JSON.parse(out)
	} catch {
		return bindings
	}
	const worktrees = ((parsed as { result?: { worktrees?: unknown } })?.result?.worktrees ?? []) as unknown
	if (!Array.isArray(worktrees)) return bindings
	for (const entry of worktrees as { path?: unknown; open_workspace_id?: unknown }[]) {
		const path = entry?.path
		const workspace = entry?.open_workspace_id
		if (typeof path === 'string' && path !== '' && typeof workspace === 'string' && workspace !== '') {
			bindings.set(normalizeWorktreePath(path), workspace)
		}
	}
	return bindings
}
