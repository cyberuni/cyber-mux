import { resolve } from 'node:path'
import { envFallback } from './env-fallback.ts'
import { type Exec, withReason } from './exec.ts'
import { refuseFloatingPane } from './floating.ts'
import type {
	AgentStatus,
	LivePane,
	MuxAdapter,
	MuxReadOptions,
	MuxTarget,
	MuxWaitResult,
	OpenedPane,
	RegionPane,
	WorkspaceTab,
	WorktreeWorkspace,
	WorktreeWorkspaceCapability,
} from './mux.ts'
import { assertRatioInRange } from './ratio.ts'
import { capturedRows, FULL_SCROLLBACK_LINES, isReadTruncated } from './read-window.ts'
import { assertWaitPattern } from './wait-output.ts'
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
 *
 * **Verified against 0.8.2** (protocol 20), re-probed against a live server by re-running
 * `mux.herdr.integration.test.ts` — the real-boundary suite, not a hand check. Everything this
 * adapter drives held: the split/read/run/send-keys lifecycle, `pane wait-output`'s success and
 * error envelopes, `pane list`/`get`/`layout`, `workspace create`/`tab create`, and the `env` and
 * worktree parameter sets below. The per-claim markers that follow name the version each was LAST
 * established against — a claim still reading 0.7.4/0.7.5/0.8.0 is one a later release gave no
 * occasion to re-measure (no attached client, or no live agent in the pane), not one that failed.
 *
 * What 0.8.2 did NOT re-establish, stated so the claim above is not read wider than it is: the two
 * current-pane-context opens (`at:'tab'`, `at:'pane:right'`) skip when the suite runs INSIDE a herdr
 * pane, and they are the only cases that exercise `--current`. 0.8.2 fixed `pane current`, `pane
 * get`, and `pane layout --current` to resolve the CALLING pane rather than another client's focused
 * pane (herdr #2297, #2298) — but that fix names none of `pane split`, which is where this file's one
 * `--current` sits. So the 0.7.4 caveat on it below stands, unmeasured against 0.8.2 rather than
 * re-confirmed.
 */
export const herdrMuxAdapter: MuxAdapter = {
	name: 'herdr',

	// `pane split --ratio` sizes a split — and sizes the ORIGINAL pane, which is the seam's own
	// convention, so it passes through unconverted (unlike tmux's `-l`). Re-verified against 0.8.0.
	canSizeSplits: true,

	open(exec, opts) {
		const at = opts.at ?? 'tab'
		// herdr takes a label at birth for a workspace and a tab, but not for a split — a pane is
		// named afterwards, via `pane rename`.
		const label = opts.label ? ['--label', opts.label] : []
		// Native at EVERY tier, not just the split: `WorkspaceCreateParams` and `TabCreateParams` both
		// carry an `env` Record in herdr's socket schema (still there in protocol 19), and the CLI takes
		// the same repeatable `--env KEY=VALUE` there as `pane split` does — re-verified against 0.8.0,
		// whose `workspace.create`/`tab.create`/`pane.split` params all still list `env`. That
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
			// in the new space and every later one beside the pane it was RUN from. Re-verified against
			// 0.8.0, whose `tab create` still takes `--workspace <workspace_id>` natively.
			const within = opts.within ? ['--workspace', opts.within] : []
			const out = exec('herdr', ['tab', 'create', ...within, '--cwd', opts.cwd, ...label, ...env, '--no-focus'])
			if (!out) throw new Error(withReason(exec, 'herdr tab create failed'))
			opened = parseRootPaneId(out, 'herdr tab create')
		} else if (at === 'pane:float') {
			// herdr has no floating-pane concept: `pane split` always takes a share of the region and
			// resizes its neighbors, and 0.7.5's CLI has no above-the-layout pane verb at all. So this
			// REFUSES by name rather than substituting a split — the substitute would satisfy the caller's
			// pane id and violate the one property they asked for. Refused BEFORE any exec, so a float
			// asked of herdr opens nothing. No `canFloatPanes` on this adapter is the declaration; this is
			// the enforcement, and both are needed for the same reason `agent wait` checks twice.
			refuseFloatingPane(herdrMuxAdapter.name)
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
			// the two backends convert in opposite directions. Measured, not documented — and re-measured
			// against 0.8.0: splitting a 44-column region at `--ratio 0.333` left the original 15 columns
			// (0.7.4: a 201-column region left 67).
			const size = opts.ratio != null ? ['--ratio', toHerdrRatio(opts.ratio)] : []
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
			if (opts.label) herdrMuxAdapter.rename(exec, opened, 'pane', opts.label)
		}
		// `submit`, not `sendText` — a launch command has to actually run, and `submit` is the only
		// verb that supplies the Enter.
		if (opts.launch) herdrMuxAdapter.submit(exec, opened, opts.launch)
		return opened
	},

	rename(exec, target, tier, name) {
		// herdr spells both tiers the same way — `<tier> rename <id> <name>` — so the tier selects the
		// noun and nothing else. Neither verb focuses what it names, and neither creates anything.
		// `tab rename` is what makes a new workspace's root tab nameable at all: `workspace create`
		// labels that tab `1` and takes no flag for it (re-verified against 0.8.0).
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
		// herdr refuses a key it does not know (`{"error":{"code":"invalid_key","message":"unsupported
		// key <k>"}}`, re-verified against 0.8.0) rather than typing it — so at
		// THIS boundary the divergence is loud, unlike tmux, which types an unknown token instead.
		// That loudness stops here, though: `Exec` discards stderr and reports a failed command as
		// `null`, which this ignores, so the caller sees exit 0 either way. Surfacing it is the
		// `Exec` seam's job (it affects every verb), not this method's — a follow-up owns it.
		exec('herdr', ['pane', 'send-keys', target.id, ...keys])
	},

	submit(exec, target, text) {
		// A bare Enter keystroke is the only form that types nothing by construction, which is what the
		// flush contract requires. (`pane run <id> ""` also presses Enter — re-verified against a live
		// 0.8.0 — so it would work; `send-keys Enter` says what it means.)
		if (!text) {
			exec('herdr', ['pane', 'send-keys', target.id, 'Enter'])
			return
		}
		// `pane run` submits text plus Enter atomically — herdr's documented preference over
		// send-text + send-keys Enter, and it types the text literally (a command named `Up` is typed,
		// not interpreted), which is exactly submit's guarantee.
		//
		// Deliberately NOT `agent prompt`, and 0.8.0 is why that matters. Upstream made agent prompts
		// "wait briefly before Enter" (herdr#1878), which sounds like it overlaps `nudge`'s settle
		// heuristic — it does not, because the behavior is scoped to the `agent prompt` verb (whose
		// 0.8.0 help documents the submission wait, an observed-state-change requirement and an
		// `agent_prompt_stalled` code) and nothing here routes through it. `nudge` submits via this
		// method, so it still lowers to `pane run`, whose Enter is immediate and unconditional. That
		// keeps nudge's staged-text check the sole arbiter of whether the turn was taken, on herdr
		// exactly as on every other backend — one heuristic, not two racing ones.
		exec('herdr', ['pane', 'run', target.id, text])
	},

	/**
	 * 0.8.0 added a `truncated` boolean to the read result, and it is REQUIRED in the socket schema's
	 * `PaneReadResult` — but it is not reachable from here, and that is a fact about the CLI rather than
	 * a choice: `herdr pane read` prints the pane's bare TEXT, no envelope, and its only 0.8.0 additions
	 * are `--format`/`--ansi`/`--raw`, which select the text's escaping. There is no `--json`. So the
	 * flag rides the socket API this adapter deliberately does not speak, and the one CLI surface that
	 * does hand back the envelope is `pane wait-output` (`.result.read.truncated` — seen live on 0.8.0).
	 * Surfacing truncation therefore costs a return-shape change, not a flag; see issue #100, which owns
	 * it across all four backends. Noted here so the next reader does not re-derive the dead end.
	 */
	read(exec, target, opts?: MuxReadOptions | undefined) {
		// An unbounded window reads `recent`, not `visible`: `visible` IS the viewport and cannot answer
		// for anything above it, so asking it for the whole scrollback would quietly return one screen.
		if (opts?.lines === 'all') {
			const text = paneRead(exec, target, 'recent', FULL_SCROLLBACK_LINES)
			return opts.truncation ? { text, truncated: false } : { text }
		}
		const text = paneRead(exec, target, 'visible', opts?.lines)
		if (!opts?.truncation) return { text }
		// herdr is the one backend that computes this fact ITSELF — `pane.read` answers `truncated` on
		// the socket API as of 0.8.0 (herdrdev/herdr#1717) — and it is still derived here, because the
		// CLI throws the field away: `print_read_response` prints `result.read.text` and nothing else
		// (read from herdr's 0.8.0 source), and this adapter talks to the CLI by construction, exactly as
		// every other verb does. A transport gap, not a disagreement; the day the CLI surfaces it, this
		// method reads it instead and the seam's contract does not move.
		//
		// The probe reads `recent` rather than `visible`, and that source change is the whole trick:
		// `visible` IS the viewport, so asking it for more rows than the screen holds returns the screen
		// and would report every capture as complete. `recent` is the window that can see above it. One
		// row deeper than what came back — the capture's OWN row count, not `opts.lines`, since a short
		// pane returns fewer rows than asked for and a probe pinned to the request would then find "more"
		// rows that were only ever the ones already in hand.
		const deeper = paneRead(exec, target, 'recent', capturedRows(text) + 1)
		return { text, truncated: isReadTruncated(text, deeper) }
	},

	/**
	 * The one backend with a NATIVE wait: `pane wait-output` blocks in herdr itself (arrived in 0.7.5,
	 * still native in 0.8.0), so no poll loop is run here and no snapshot is pulled across the CLI
	 * boundary on every tick.
	 *
	 * `--source visible` is pinned rather than left to herdr's own default (`recent_unwrapped`, verified
	 * against 0.7.5 — the help still says `recent` in 0.8.0). The seam's rule is that a wait searches exactly what
	 * `read` returns, and `read` pins `visible` here; taking the default would make the same wait mean a
	 * different snapshot on this backend than on every polling one.
	 *
	 * Telling a TIMEOUT (an answer) from a broken wait (a failure) is the whole difficulty, because herdr
	 * spells both the same way: exit 1 with an error envelope on stderr, so `Exec` yields `null` for
	 * either. Two tiers answer it, in order:
	 *
	 * 1. **The envelope's `code`**, when the runner captured stderr into `lastError` (re-verified against
	 *    0.8.0: `{"error":{"code":"timeout",…}}` vs `{"error":{"code":"pane_not_found",…}}`). Exact.
	 * 2. **A live pane that actually consumed the deadline**, when it did not. `Exec.lastError` is
	 *    specified as a diagnostic and NEVER a control-flow signal — a runner that discards stderr must
	 *    still work — so the code cannot be the only answer. Liveness alone is not enough either, and the
	 *    reason is a whole released version of the backend: herdr 0.7.4 has no `pane wait-output` at all,
	 *    so it answers with clap's usage text (not an envelope) INSTANTLY, and a liveness-only rule reads
	 *    that as "timed out" — a silently wrong answer for a wait that never ran. Elapsed time is the fact
	 *    that separates them and needs no stderr: a wait that returns in a fraction of its own timeout did
	 *    not wait. Both must hold — the pane is live AND the deadline was spent — or this throws.
	 *
	 * A timeout costs ONE extra `read`, because herdr's timeout envelope carries no snapshot and the seam
	 * promises the caller the evidence its verdict was reached on. It is taken at the deadline, so it is
	 * the same "last look at the pane" a polling backend returns, one poll interval later.
	 */
	async waitForOutput(exec, target, opts) {
		assertWaitPattern(opts)
		const now = opts.now ?? (() => Date.now())
		const pattern = opts.match != null ? ['--match', opts.match] : ['--regex', opts.regex as string]
		const args = ['pane', 'wait-output', target.id, '--source', 'visible', '--timeout', String(opts.timeoutMs)]
		args.push(...pattern)
		if (opts.lines != null) args.push('--lines', String(opts.lines))
		const started = now()
		const out = exec('herdr', args)
		if (out == null) {
			if (!isHerdrWaitTimeout(exec, target, opts.timeoutMs, now() - started)) {
				throw new Error(withReason(exec, `herdr pane wait-output failed for pane ${target.id}`))
			}
			const readOpts = opts.lines != null ? { lines: opts.lines } : undefined
			return { matched: false, output: herdrMuxAdapter.read(exec, target, readOpts).text }
		}
		return parseWaitOutput(out)
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
				(
					p,
				): p is {
					pane_id: string
					agent?: string | undefined
					agent_status?: unknown | undefined
					cwd?: string | undefined
					label?: string | undefined
				} => typeof p?.pane_id === 'string',
			)
			.map((p): LivePane => {
				const harness = p.agent || undefined
				// Verbatim, and no comparison rule to tell an unnamed pane apart: herdr has no default
				// label — the key is absent from `pane list` until `pane rename` — so an omitted key IS
				// "nobody named it". `|| undefined` only collapses an empty-string label to absent, the
				// same normalization `harness` takes. tmux needs a title-vs-host heuristic here precisely
				// because it lacks this primitive. Each key is OMITTED when absent (conditional spread)
				// rather than carried as an explicit `undefined`, so these stay absent-or-present fields.
				const label = p.label || undefined
				// herdr 0.7.5's per-pane agent-state feed (`agent_status`). Absent/empty/unrecognized folds
				// to OMITTED — never a false `'unknown'` — the same absent-not-false rule `harness`/`label`
				// follow: a missing feed is the field simply not being there. (`'unknown'` IS a valid value,
				// herdr's own for a pane it cannot classify, and passes through when present.)
				const agentStatus = toAgentStatus(p.agent_status)
				return {
					id: p.pane_id,
					mux: 'herdr' as const,
					// `false` BY CONSTRUCTION, not a stub and not a refusal: herdr has no floating-pane
					// concept at all, so every pane it can report really is tiled. The create side refuses a
					// `'pane:float'` open here by NAME because there is no truthful pane to hand back; the
					// read side has a truthful answer, and this is it. Unconditional rather than
					// conditionally-spread like the four fields below it, because `LivePane.floating` is
					// required: absence is not one of its states.
					floating: false,
					...(harness !== undefined ? { harness } : {}),
					...(agentStatus !== undefined ? { agentStatus } : {}),
					...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
					...(label !== undefined ? { label } : {}),
				}
			})
	},

	regions: {
		describeRegion(exec, target) {
			// Two calls, because herdr splits the answer across two verbs: `pane layout` reports the
			// region's rects (`layout.panes[].rect`) but carries no cwd and no label, while `pane list`
			// carries both and no geometry. Neither alone can build a template.
			//
			// `layout.splits[]` is deliberately ignored even though it reports `direction` and `ratio`
			// outright. It is FLAT — `[{id:"split_0_root",...},{id:"split_1_0",...}]` — so the tree is
			// recoverable only by parsing the parent out of that id string, a convention herdr's CLI help
			// never documents and could respell without warning. The rects say the same thing in a fact
			// herdr does promise, so the derivation runs off those; see `RegionInspector.describeRegion` in `mux.ts`.
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
		 * `layout` is still NOT a CLI verb in 0.8.0 (its top-level help lists no such subcommand); it is
		 * socket-API-only, and this adapter speaks the CLI by design (so it composes with the synchronous
		 * `Exec` seam). The road is closed, hence the pane indirection.
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
	},

	agentLifecycle: {
		waitForState(exec, target, opts) {
			// `herdr agent wait <id> [--until <s>]… [--timeout <ms>]`, addressing the pane id directly
			// (verified against 0.7.5: `w3A:p1` worked). 0.8.0's help restates the same shape and its schema
			// still carries `agent_status` on `AgentInfo`, but the live re-probe could not rerun this one:
			// a scratch pane runs no agent, so 0.8.0 answered `agent_not_found`. Unchanged as far as 0.8.0
			// says, last established live on 0.7.5. `--until` is REPEATED once per requested state,
			// and OMITTED entirely when the caller passed none — so herdr's own default set (idle|done|
			// blocked) applies rather than cyber-mux restating it, and a future change to that default is
			// not silently pinned here. `--timeout` is likewise omitted for an indefinite wait, herdr's own
			// no-timeout behavior.
			const until = opts.until ?? []
			const args = [
				'agent',
				'wait',
				target.id,
				...until.flatMap((state) => ['--until', state]),
				...(opts.timeoutMs != null ? ['--timeout', String(opts.timeoutMs)] : []),
			]
			const status = parseReachedAgentStatus(exec('herdr', args))
			if (!status) {
				throw new Error(withReason(exec, `herdr agent wait reported no reached agent_status for pane ${target.id}`))
			}
			return status
		},
	},
}

/**
 * The set of `agent_status` values herdr reports — unchanged through 0.8.0, whose socket schema still
 * declares `AgentStatus` as exactly this enum, and whose `agent wait --until` still lists exactly these
 * five values. The runtime witness of the `AgentStatus`
 * type, so a string read off a herdr envelope can be NARROWED to it rather than cast. A value outside
 * this set is treated as absent (the feed said something this build does not model), never forced into
 * the type.
 */
const AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown']

/** A value narrowed to `AgentStatus`, or `undefined` for anything else (a non-string, an empty string,
 * or a status this build does not model) — the normalization both the listing and the wait share. */
function toAgentStatus(value: unknown): AgentStatus | undefined {
	return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value)
		? (value as AgentStatus)
		: undefined
}

/**
 * The `AgentStatus` a `herdr agent wait` run reached, read defensively from its JSON envelope —
 * `{"result":{"agent":{…,"agent_status":"idle",…},"type":"agent_info"}}` (verified against 0.7.5), so
 * the reached status lives at `.result.agent.agent_status`. Every unresolvable shape — `out` is null
 * (an Exec failure), the JSON does not parse, or the field is missing/empty/unmodeled — folds to
 * `undefined`, exactly as `parsePaneRecord`/`isPaneFocused` fold, so the caller states its own failure.
 */
function parseReachedAgentStatus(out: string | null): AgentStatus | undefined {
	if (out == null) return undefined
	try {
		return toAgentStatus(JSON.parse(out)?.result?.agent?.agent_status)
	} catch {
		return undefined
	}
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
 * derivation runs off those; see `RegionInspector.describeRegion` in `mux.ts`.
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
				rect: {
					x: p.rect?.['x'] ?? 0,
					y: p.rect?.['y'] ?? 0,
					width: p.rect?.['width'] ?? 0,
					height: p.rect?.['height'] ?? 0,
				},
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
	cwd?: string | undefined
	label?: string | undefined
	/** The tab this pane sits in — herdr stamps every pane record with it. */
	tab?: string | undefined
}

/**
 * Each pane's cwd, label and tab, keyed by pane id — the half `pane layout` does not report.
 *
 * `workspace` scopes the list to one workspace when the caller has one to scope by; omitting it lists
 * every pane herdr can see, which is what a single-region read wants (it keys by pane id and never
 * cares which workspace a pane came from).
 */
function herdrPaneDetails(exec: Exec, workspace?: string | undefined): Map<string, HerdrPaneDetail> {
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
 * `[branch, cwd, focus, label, path, workspace_id]` — no `env` — and herdr rejects the flag with
 * `unknown option: --env`. A caller needing env on that route uses the command-prefix fallback.
 * Re-verified against 0.8.0: both param sets are unchanged in protocol 19's schema, and a live
 * `worktree create --env` there still answers `unknown option: --env`.
 */
function envFlags(env: Record<string, string> | undefined): string[] {
	return env ? Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]) : []
}

/**
 * `--ratio` takes the seam's number VERBATIM — herdr sizes the ORIGINAL pane, so no inversion, unlike
 * tmux's `-l` and wezterm's `--percent`. The guard is the same one those two render helpers call: the
 * seam refuses an out-of-range ratio here rather than pass `--ratio 5` (or `0`) through to a split herdr
 * would then size wrong.
 */
function toHerdrRatio(ratio: number): string {
	assertRatioInRange(ratio)
	return String(ratio)
}

/**
 * Launch a command in a worktree's root pane, carrying env the worktree verb could not set at birth.
 * The prefix-or-warn rule is the seam's (`env-fallback.ts`); this is the one route that invokes it,
 * because it is the one route that loses env. With a command, env rides in as a prefix; with none and
 * env asked for, it warns to stderr (stdout stays machine-readable) rather than dropping in silence.
 */
function carryLaunch(
	exec: Exec,
	target: OpenedPane,
	env: Record<string, string> | undefined,
	launch?: string | undefined,
): void {
	const fallback = envFallback(env, launch)
	if (fallback.kind === 'dropped') {
		process.stderr.write(
			`env (${fallback.variables.join(', ')}) could not be set on this worktree's workspace and ` +
				'no command was given to carry it — herdr worktree create/open take no env parameter\n',
		)
		return
	}
	if (fallback.command !== undefined) herdrMuxAdapter.submit(exec, target, fallback.command)
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
function parsePaneRecord(out: string | null): { workspaceId?: string | undefined; tabId?: string | undefined } {
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
 * The `code` of a herdr error envelope, when the runner captured one — how a wait's TIMEOUT (an answer)
 * is told from any other failure (a throw). Read from `Exec.lastError` because that is where herdr's
 * envelope lands: it is written to stderr with exit 1, so stdout is `null` for every failure alike and
 * the code is the only thing that separates them. Defensive throughout — no reason, unparseable JSON, or
 * a missing/non-string code all answer `undefined`, which routes to the throw rather than to a silent
 * "timed out" the backend never said.
 */
/**
 * How much of its own timeout a wait must actually spend before a failure is believed to BE that
 * timeout. A fraction rather than the whole, because process start-up and clock granularity make an
 * exact-or-greater comparison flaky on a real runner; wide enough that the case it exists to catch — a
 * herdr with no `wait-output` subcommand, which returns in milliseconds — is nowhere near it.
 */
const HERDR_WAIT_ELAPSED_RATIO = 0.9

/**
 * Whether a failed `pane wait-output` was the DEADLINE passing rather than the wait breaking — the
 * two-tier rule `waitForOutput` documents, kept out of the method so the tiers read as one decision.
 *
 * The envelope's code answers when the runner captured one. Otherwise the answer needs two facts, and
 * neither alone is enough: the pane must be LIVE (a gone pane is a failure, `pollForOutput`'s rule) and
 * the call must have SPENT the deadline (a wait that returned instantly never ran — herdr 0.7.4, whose
 * usage text for an unknown subcommand is not an envelope to read a code from).
 */
function isHerdrWaitTimeout(exec: Exec, target: { id: string }, timeoutMs: number, elapsedMs: number): boolean {
	const code = herdrErrorCode(exec.lastError)
	if (code != null) return code === 'timeout'
	if (elapsedMs < timeoutMs * HERDR_WAIT_ELAPSED_RATIO) return false
	return herdrMuxAdapter.paneExists(exec, target)
}

function herdrErrorCode(reason: string | undefined): string | undefined {
	if (!reason) return undefined
	try {
		return nonEmpty(JSON.parse(reason)?.error?.code)
	} catch {
		return undefined
	}
}

/**
 * A successful `pane wait-output` envelope: the snapshot it matched in, and the line it matched on.
 *
 * `matched` is `true` by construction — herdr exits 0 only on a match, so reaching here IS the match;
 * the parse only fills in the evidence. Defensive for the same reason `parsePaneRecord` is: a herdr
 * build that reshapes the envelope degrades to a match with no snapshot, never to a failed wait.
 */
function parseWaitOutput(out: string): MuxWaitResult {
	let text: string | undefined
	let line: string | undefined
	try {
		const result = JSON.parse(out)?.result
		text = nonEmpty(result?.read?.text)
		line = nonEmpty(result?.matched_line)
	} catch {
		// Leave both absent — see above.
	}
	return { matched: true, output: text ?? '', ...(line != null ? { matchedLine: line } : {}) }
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
 * was created in), and `pane split` (the workspace the split landed in, i.e. the caller's). Re-verified
 * against herdr 0.8.0. That is why the workspace costs no extra call: it rides in on the same output
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
	let pane:
		| { pane_id?: unknown | undefined; tab_id?: unknown | undefined; workspace_id?: unknown | undefined }
		| undefined
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
	const result = (parsed as { result?: unknown | undefined })?.result as
		| {
				workspace?: { workspace_id?: unknown | undefined } | undefined
				worktree?: { path?: unknown | undefined; branch?: unknown | undefined } | undefined
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
	const worktrees = ((parsed as { result?: { worktrees?: unknown | undefined } | undefined })?.result?.worktrees ??
		[]) as unknown
	if (!Array.isArray(worktrees)) return bindings
	for (const entry of worktrees as { path?: unknown | undefined; open_workspace_id?: unknown | undefined }[]) {
		const path = entry?.path
		const workspace = entry?.open_workspace_id
		if (typeof path === 'string' && path !== '' && typeof workspace === 'string' && workspace !== '') {
			bindings.set(normalizeWorktreePath(path), workspace)
		}
	}
	return bindings
}

/**
 * One spelling of `pane read`, taken by `read` for the snapshot AND for its truncation probe — so the
 * two differ only in the source and depth they are meant to differ in. `lines` omitted takes herdr's
 * own default window for the source.
 */
function paneRead(exec: Exec, target: MuxTarget, source: 'visible' | 'recent', lines: number | undefined): string {
	const args = ['pane', 'read', target.id, '--source', source]
	if (lines != null) args.push('--lines', String(lines))
	return exec('herdr', args) ?? ''
}
