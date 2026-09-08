import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { type Exec, nodeExec } from './exec.ts'

/** Generic worktree seam — no host-specific concepts. */

/**
 * The filesystem half of the worktree adapter — the one seam here that is NOT `Exec`, exactly as
 * `TemplateStore` is for templates. `normalizeWorktreePath` and the remove gate reach for the disk,
 * and reading it through bare `node:fs` would make those the one worktree path a consumer cannot
 * drive hermetically. Injected (defaulting to `nodeWorktreeFs`), so #339's callers are unchanged and
 * a test can stand in a fake disk.
 */
export interface WorktreeFs {
	/** Whether a path exists on disk — the apply-time check behind the remove gate. */
	exists(path: string): boolean
	/** The path with symlinks resolved, native-cased — the normalization every matched path goes
	 * through. Throws for a path not on disk, exactly as `realpathSync.native` does; callers fall back. */
	realpath(path: string): string
}

export const nodeWorktreeFs: WorktreeFs = {
	exists: existsSync,
	realpath: (path) => realpathSync.native(path),
}

export interface WorktreeAddOptions {
	/** The primary checkout's root — the repo `git worktree add` runs against. */
	primaryRoot: string
	/** Where the new worktree should be checked out. */
	path: string
	/** Branch to create the worktree on. */
	branch: string
	/** Start point for the new branch; omit for git's own default (the current HEAD). */
	base?: string | undefined
}

export interface Worktree {
	root: string
	branch: string
}

/**
 * Which layered signal established that a branch's work has landed, named in the COST order the
 * layers run in. Each is positive-only — a layer that cannot match never contributes a `false`, it
 * simply leaves the verdict to the layers already run — so the composite is a monotone OR of
 * positives and two layers can never contradict each other. The only disagreement that CAN arise is
 * between a positive here and a guard in `isWorktreeRemovable` (dirty, occupied, prunable, primary),
 * and there the guard always wins.
 *
 * - `ancestor` — the branch tip is an ancestor of the default branch (`git branch --merged`). Git's
 *   own proof, one batched call for the whole repo, and the only layer that was here before.
 * - `upstream-gone` — the branch's remote-tracking ref has disappeared (`[gone]`), i.e. the forge
 *   merged the pull request and deleted its head branch. One batched call, offline, and correct for
 *   squash, rebase, and merge-commit strategies alike — but only as fresh as the caller's last
 *   `git fetch --prune`, which this module deliberately does not run for them (see
 *   `readGoneUpstreamBranches`).
 * - `squash-patch` — the branch collapsed to a single synthetic commit is already applied on the
 *   default branch (`git cherry`). Per-branch and offline; matches a clean squash or rebase merge,
 *   and degrades to no answer for a conflict-resolved or hand-edited one.
 * - `forge` — the forge says a merged pull request exists for this head branch. Authoritative for
 *   every strategy, needs network and auth, blind to local-only branches, and therefore OPT-IN: it
 *   runs only when a caller injects a `ForgeMergedProbe`.
 */
export type WorktreeMergedSignal = 'ancestor' | 'upstream-gone' | 'squash-patch' | 'forge'

/**
 * Ask the forge whether `branch` is the head of a merged pull request — the layer-4 seam. `undefined`
 * means the forge could not say (offline, unauthenticated, no such PR host), which is distinct from a
 * `false` "no merged PR" and, being positive-only, is treated identically here: neither clears a
 * branch. Injected rather than built in so this module owes nothing to any particular forge.
 */
export type ForgeMergedProbe = (branch: string) => boolean | undefined

/** The opt-in half of the landed-signal stack. Layers 1–3 always run — they are offline and cheap;
 * only the forge query, which needs network and auth, has to be asked for. */
export interface WorktreeSignalOptions {
	/** The layer-4 forge query. Omitted, the forge is never consulted and every other layer still works. */
	forge?: ForgeMergedProbe | undefined
}

/**
 * A worktree as reported when ENUMERATING — deliberately distinct from `Worktree`, which is the
 * result of CREATING one (where a branch exists by construction). Listing has to represent what
 * creation cannot produce: a detached HEAD, the primary checkout itself, and an entry whose
 * checkout git considers stale.
 */
export interface WorktreeEntry {
	/** Absolute checkout path, normalized. */
	root: string
	/** Branch checked out there; absent for a detached HEAD or a bare entry. */
	branch?: string | undefined
	/** `false` for the primary checkout, `true` for a linked worktree. */
	linked: boolean
	/** git considers the entry stale — its checkout is gone from disk. */
	prunable: boolean
	/**
	 * The branch's work has LANDED on the repo's default branch — so removing the checkout destroys
	 * nothing the trunk does not already hold. Established by the layered signals in
	 * `WorktreeMergedSignal`, in cost order, each POSITIVE-ONLY: the first that says "landed" wins, and
	 * one that cannot match leaves the verdict where the cheaper layers left it. Absent when
	 * UNDETERMINABLE, never `false` as a stand-in: a detached HEAD or bare entry has no branch to ask
	 * about, and a repo whose default branch cannot be resolved has nothing to compare against.
	 *
	 * The residual error stays one-directional: a squash the heuristic cannot match (a conflict-resolved
	 * or hand-edited one) reads `false` for work that did in fact land, because under-reporting a
	 * disposal candidate costs the reader one manual check while over-reporting costs them work.
	 */
	merged?: boolean | undefined
	/**
	 * WHICH layer established `merged: true` — present only alongside a positive verdict, absent for a
	 * `false` or undeterminable one. Reported rather than kept private because the layers do not carry
	 * the same authority: `ancestor` is git's own proof, while `squash-patch` is a heuristic and
	 * `upstream-gone` is the forge's word, so a caller auditing a reclaim needs to see which one spoke.
	 */
	mergedSignal?: WorktreeMergedSignal | undefined
	/**
	 * The checkout has uncommitted changes — tracked or untracked. Merged is not sufficient on its own:
	 * a merged branch whose checkout carries edits is not disposable, because those edits exist nowhere
	 * else and `removeWorktreeSafely` is going to refuse them. Absent when there is no working tree to
	 * read (a `prunable` entry) or when git could not answer.
	 */
	dirty?: boolean | undefined
	/**
	 * The multiplexer workspace this worktree is currently open in. Joined in by the caller from a
	 * backend's binding; always absent on a backend that has no worktree/workspace binding, and when
	 * nothing is open on the worktree.
	 */
	workspace?: string | undefined
}

interface WorktreeRemoveOptions {
	primaryRoot: string
}

interface WorktreeAdapter {
	add(exec: Exec, opts: WorktreeAddOptions): Worktree
	remove(exec: Exec, path: string, opts: WorktreeRemoveOptions): void
}

/**
 * This module's own refusals and failures — plain cyber-mux prose, never a dependency's raw words.
 * `reportWorktreeFailure` (`cli.ts`) forwards a `WorktreeGitError`'s message onto stdout verbatim
 * because it is safe to: everything thrown here is this CLI's own text. Anything else that reaches
 * that catch-all (a `session.tmux.ts`/`session.herdr.ts` throw, which embeds the backend's own name
 * and its raw stderr via `withReason`) is a different case and is translated, not forwarded.
 */
export class WorktreeGitError extends Error {}

/** The only worktree backend at MVP — plain `git worktree`. */
export const gitWorktreeAdapter: WorktreeAdapter = {
	add(exec, opts) {
		const args = ['-C', opts.primaryRoot, 'worktree', 'add', '-b', opts.branch, opts.path]
		// git takes the start-point as a trailing commit-ish, after the path.
		if (opts.base) args.push(opts.base)
		const out = exec('git', args)
		if (out === null) throw new WorktreeGitError(`git worktree add failed for ${opts.path}`)
		return { root: resolve(opts.path), branch: opts.branch }
	},

	remove(exec, path, opts) {
		const out = exec('git', ['-C', opts.primaryRoot, 'worktree', 'remove', path, '--force'])
		if (out === null) throw new WorktreeGitError(`git worktree remove failed for ${path}`)
	},
}

/**
 * Resolve the primary checkout's root regardless of whether the caller's cwd is the primary
 * checkout or a linked worktree — `--git-common-dir` always points at the main repo's `.git`.
 */
export function resolvePrimaryRoot(exec: Exec): string {
	const commonDir = exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!commonDir) throw new WorktreeGitError('cannot resolve the primary checkout — not inside a git repository')
	return dirname(commonDir)
}

/**
 * The single normalization point for every path that gets MATCHED against another — a multiplexer
 * reports its own checkout paths, and those only line up with git's if both sides are resolved the
 * same way (a symlinked repo, or macOS's `/tmp` → `/private/tmp`, otherwise silently fails to
 * match). Falls back to `resolve` for a path that isn't on disk, where there is no link to follow.
 */
export function normalizeWorktreePath(path: string, fs: WorktreeFs = nodeWorktreeFs): string {
	try {
		return fs.realpath(path)
	} catch {
		return resolve(path)
	}
}

/**
 * Every worktree of the repo, straight from git. These are the facts — path, branch, linked,
 * prunable — on EVERY backend: a multiplexer that also happens to enumerate worktrees is only
 * re-reading git, so reading them here is what keeps two backends from ever disagreeing about the
 * same worktree. The one fact git cannot answer — which workspace a worktree is open in — is joined
 * in by the caller.
 */
export function listWorktreesFromGit(
	exec: Exec,
	primaryRoot: string,
	fs: WorktreeFs = nodeWorktreeFs,
	signals?: WorktreeSignalOptions | undefined,
): WorktreeEntry[] {
	const out = exec('git', ['-C', primaryRoot, 'worktree', 'list', '--porcelain'])
	if (!out) return []
	const normalizedPrimary = normalizeWorktreePath(primaryRoot, fs)
	// Porcelain emits one blank-line-separated record per worktree, each opening with `worktree <path>`.
	const entries = out
		.split('\n\n')
		.map((record) => record.trim())
		.filter((record) => record.startsWith('worktree '))
		.map((record): WorktreeEntry => {
			const lines = record.split('\n')
			const root = normalizeWorktreePath(lines[0]!.slice('worktree '.length), fs)
			// `branch refs/heads/<name>`; absent entirely when detached or bare.
			const branchLine = lines.find((line) => line.startsWith('branch '))
			const branch = branchLine?.slice('branch '.length).replace(/^refs\/heads\//, '')
			return {
				root,
				// Omitted, never carried as an explicit `undefined`: a detached/bare entry has no branch,
				// and `WorktreeEntry.branch` is an absent-or-present field.
				...(branch !== undefined ? { branch } : {}),
				// Derived from the path rather than record order — git lists the primary first today,
				// but that ordering is not something to depend on.
				linked: root !== normalizedPrimary,
				prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
			}
		})
	const target = resolveDefaultBranchRef(exec, primaryRoot, entries)
	const merged = readMergedBranches(exec, primaryRoot, target)
	// Both cheap layers are read ONCE for the whole repo, before the per-entry walk — they cost the
	// same at one worktree as at fifty, and reading them per entry would turn a listing into N calls.
	const goneUpstream = readGoneUpstreamBranches(exec, primaryRoot)
	for (const entry of entries) {
		const landed = resolveLanded(exec, primaryRoot, entry.branch, {
			target,
			merged,
			goneUpstream,
			forge: signals?.forge,
		})
		if (landed.merged !== undefined) entry.merged = landed.merged
		if (landed.signal !== undefined) entry.mergedSignal = landed.signal
		// No directory to stat for an entry git already calls stale — and skipping it is the one place
		// the per-worktree cost can be avoided honestly. Assigned only when git answered, so `dirty`
		// stays absent (never explicit `undefined`) for a checkout git could not read.
		if (!entry.prunable) {
			const dirty = readDirty(exec, entry.root)
			if (dirty !== undefined) entry.dirty = dirty
		}
	}
	return entries
}

/**
 * The ref that "merged" is measured against — never a hardcoded `main`, which is wrong on a `master`
 * repo and on any repo with a different trunk.
 *
 * `origin/HEAD` first: the REMOTE-tracking ref is the target rather than the local branch, because
 * "merged" means *landed upstream* in the PR workflow this tool exists to serve, and a stale local
 * trunk would under-report. The fallback is the branch checked out in the PRIMARY checkout — already
 * parsed and in hand, so it costs zero extra git calls, and for a local-only repo with no remote the
 * primary checkout's branch simply IS the trunk. Undefined when neither answers (a bare or detached
 * primary with no origin), which leaves `merged` absent everywhere rather than guessed.
 */
function resolveDefaultBranchRef(exec: Exec, primaryRoot: string, entries: WorktreeEntry[]): string | undefined {
	const originHead = exec('git', ['-C', primaryRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
	if (originHead) return originHead
	return entries.find((entry) => !entry.linked)?.branch
}

/**
 * Every local branch whose tip is an ancestor of `target`, in ONE call for the whole repo — the merge
 * signal costs the same at one worktree as at fifty. `undefined` when there is no target or git
 * refused, which is what keeps `merged` absent rather than uniformly `false`.
 */
function readMergedBranches(exec: Exec, primaryRoot: string, target: string | undefined): Set<string> | undefined {
	if (!target) return undefined
	const out = exec('git', ['-C', primaryRoot, 'branch', '--format=%(refname:short)', '--merged', target])
	if (out === null) return undefined
	return new Set(
		out
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean),
	)
}

/**
 * Every local branch whose remote-tracking ref has DISAPPEARED — `[gone]` — in one call for the whole
 * repo. That is the forge's own statement that it merged the pull request and deleted its head
 * branch, and it is the one landed-signal that is correct for squash, rebase, and merge-commit
 * strategies alike without needing to reason about rewritten commits at all.
 *
 * Read, never refreshed: this deliberately does NOT run `git fetch --prune` on the caller's behalf.
 * A listing is a report, and a report must not reach for the network, block on it, or mutate the
 * repo's refs as a side effect. The signal is therefore exactly as fresh as the caller's last fetch,
 * which for a pool driver means fetching on its own schedule.
 *
 * A branch with no upstream at all yields an empty track field and is simply absent from the set —
 * `[gone]` requires a CONFIGURED upstream whose ref is missing, so a purely local branch can never
 * land here. `undefined` when git refused, which keeps the layer silent rather than clearing nothing.
 */
function readGoneUpstreamBranches(exec: Exec, primaryRoot: string): Set<string> | undefined {
	// Tab-separated rather than space-separated: a ref name cannot contain a tab, and neither can it
	// contain a space, but the track field can — `[ahead 1, behind 2]` — so splitting on the FIRST tab
	// is the only parse that stays unambiguous as git's track vocabulary grows.
	const out = exec('git', [
		'-C',
		primaryRoot,
		'for-each-ref',
		'--format=%(refname:short)\t%(upstream:track)',
		'refs/heads/',
	])
	if (out === null) return undefined
	const gone = new Set<string>()
	for (const line of out.split('\n')) {
		const tab = line.indexOf('\t')
		if (tab === -1) continue
		if (line.slice(tab + 1).trim() === '[gone]') gone.add(line.slice(0, tab))
	}
	return gone
}

/**
 * Whether the branch, COLLAPSED to a single synthetic commit, is already applied on `target` — the
 * squash-merge signal, exactly as issue #151 specifies it.
 *
 * A squash merge lands one rewritten commit on the target whose patch is the branch's whole diff, so
 * no commit of the branch is an ancestor of anything and `git branch --merged` can never see it. This
 * builds the shape the squash actually produced: `commit-tree <branch>^{tree} -p <merge-base>` is the
 * branch's final tree hung off the point it forked from — one commit whose patch is that whole diff —
 * and `git cherry` then asks git's own patch-id machinery whether an equivalent patch is already on
 * the target. A leading `-` means applied.
 *
 * POSITIVE-ONLY, and the reason is the whole safety argument: a squash that was conflict-resolved or
 * hand-edited on the way in produces a different patch, so the ids do not match and this returns
 * `false` — which must degrade to "not reusable" rather than being read as a contradiction of some
 * other layer. It writes one loose commit object into the repo (unreferenced, so ordinary gc collects
 * it); nothing else about the repo is touched, and no ref moves.
 */
function isSquashApplied(exec: Exec, primaryRoot: string, target: string, branch: string): boolean {
	const git = (args: string[]) => exec('git', ['-C', primaryRoot, ...args])
	const base = git(['merge-base', target, branch])
	if (!base) return false
	// `commit-tree` takes the tree-ish directly, so the branch tree needs no separate `rev-parse`.
	//
	// The identity is supplied INLINE, and is not a nicety: `commit-tree` refuses outright ("empty ident
	// name") when neither the environment nor git's config names an author, which is the state of any
	// machine that has not configured git yet — a CI runner, a fresh container. Left to the ambient
	// identity this whole layer would go silently dark there and every squash-merged worktree would read
	// unlanded again, which is the exact bug this exists to fix (caught by the live-backends job, whose
	// runner has no git identity). A throwaway probe object should not carry the caller's name anyway.
	const synthetic = exec('git', [
		'-c',
		'user.name=cyber-mux',
		'-c',
		'user.email=probe@cyber-mux.invalid',
		'-C',
		primaryRoot,
		'commit-tree',
		`${branch}^{tree}`,
		'-p',
		base,
		'-m',
		'cyber-mux squash probe',
	])
	if (!synthetic) return false
	const cherry = git(['cherry', target, synthetic])
	if (cherry === null) return false
	// One synthetic commit in, so one line out: `- <sha>` when the patch is already upstream, `+ <sha>`
	// when it is not. Anything else (an empty answer for an empty diff) is not a positive.
	return cherry.split('\n').some((line) => line.startsWith('-'))
}

/** What the layered signals concluded for one branch: the verdict, and which layer produced it. */
interface LandedVerdict {
	merged?: boolean | undefined
	signal?: WorktreeMergedSignal | undefined
}

/**
 * Run the landed-signal layers for ONE branch, in cost order, stopping at the first positive.
 *
 * The layering rule, stated once here because it is the whole correctness argument: every layer is
 * POSITIVE-ONLY. Layer 1 is allowed to seed a `false` — it is git's own ancestry answer and the
 * historical meaning of this field — but no later layer can ever turn a `true` into a `false`, and a
 * layer that cannot match simply declines to speak. So the layers cannot contradict each other, and
 * the composite is monotone: adding a layer can only ever move a branch from "not landed" to
 * "landed", never the other way.
 *
 * The disagreement that DOES matter is between a landed verdict and a guard — a dirty checkout, an
 * occupied workspace, a stale entry, the primary checkout — and that is resolved in
 * `isWorktreeRemovable`, where every guard outranks every signal. Nothing here can make a worktree
 * disposable on its own.
 *
 * Why a wrong positive is survivable at all: neither `removeWorktreeSafely` nor `provisionWorktree`
 * deletes the branch REF. Prune removes the checkout and provision repoints the checkout to a fresh
 * branch; either way the old branch still names its commits, so COMMITTED work outlives a wrong
 * answer and can be checked out again. The only thing a wrong answer can destroy is UNCOMMITTED work,
 * which the `dirty` guard refuses outright.
 */
function resolveLanded(
	exec: Exec,
	primaryRoot: string,
	branch: string | undefined,
	ctx: {
		target: string | undefined
		merged: Set<string> | undefined
		goneUpstream: Set<string> | undefined
		forge: ForgeMergedProbe | undefined
	},
): LandedVerdict {
	// A detached HEAD or bare entry has no branch to ask about — undeterminable, not `false`.
	if (!branch) return {}
	// Layer 1 — ancestry. The only layer that may report a negative, and the seed for the rest.
	if (ctx.merged?.has(branch)) return { merged: true, signal: 'ancestor' }
	const seed: LandedVerdict = ctx.merged ? { merged: false } : {}
	// Layer 2 — the forge merged the PR and deleted its head branch.
	if (ctx.goneUpstream?.has(branch)) return { merged: true, signal: 'upstream-gone' }
	// Layer 3 — the branch collapsed to one commit is already applied on the target.
	if (ctx.target && isSquashApplied(exec, primaryRoot, ctx.target, branch))
		return { merged: true, signal: 'squash-patch' }
	// Layer 4 — the forge itself, only when a caller injected the probe.
	if (ctx.forge?.(branch) === true) return { merged: true, signal: 'forge' }
	return seed
}

/**
 * The `owner/repo` slug of the repo's `origin`, or `undefined` when there is no origin or its URL is
 * not a recognizable forge URL. Derived from the REMOTE rather than from the process cwd because
 * `Exec` runs commands without one: `gh` on its own would answer for whatever directory the caller
 * happens to be in, which for a library seam is nobody's intent.
 */
function resolveOriginSlug(exec: Exec, primaryRoot: string): string | undefined {
	const url = exec('git', ['-C', primaryRoot, 'remote', 'get-url', 'origin'])
	if (!url) return undefined
	// Both shapes git remotes actually take: `git@host:owner/repo(.git)` and `scheme://host/owner/repo(.git)`.
	const match = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url.trim())
	return match?.[1]
}

/**
 * A `ForgeMergedProbe` backed by the GitHub CLI — the layer-4 implementation for repos hosted there,
 * offered rather than imposed: it is not wired in anywhere, and a caller opts in by passing it as
 * `signals.forge`.
 *
 * `gh pr list --head <branch> --state merged` answers the authoritative question for EVERY merge
 * strategy, which is what makes it worth a network round trip when the offline layers cannot match a
 * hand-edited squash. It is also the layer with the most ways to say nothing — no `gh` on PATH, no
 * auth, no network, no origin, a non-GitHub remote, a local-only branch the forge has never seen —
 * and all of them collapse to `undefined` (could not say) rather than to `false`, because a
 * positive-only layer must never be the reason a branch looks unlanded.
 */
export function ghForgeMergedProbe(exec: Exec, primaryRoot: string): ForgeMergedProbe {
	return (branch) => {
		const slug = resolveOriginSlug(exec, primaryRoot)
		if (!slug) return undefined
		const out = exec('gh', [
			'pr',
			'list',
			'--repo',
			slug,
			'--head',
			branch,
			'--state',
			'merged',
			'--json',
			'number',
			'--limit',
			'1',
		])
		if (out === null) return undefined
		try {
			const prs: unknown = JSON.parse(out)
			return Array.isArray(prs) ? prs.length > 0 : undefined
		} catch {
			// `gh` answered with something that is not the JSON we asked for — could not say, not "no".
			return undefined
		}
	}
}

/**
 * Whether a checkout has uncommitted changes, distinguishing "clean" from "git could not say" —
 * `undefined` is not `false`, and a caller deciding whether a worktree is safe to delete must not read
 * an unanswered question as a clean tree.
 */
function readDirty(exec: Exec, worktreeRoot: string): boolean | undefined {
	const out = exec('git', ['-C', worktreeRoot, 'status', '--porcelain'])
	return out === null ? undefined : out.length > 0
}

/**
 * The disposability composite — "the work has landed and nothing is holding this checkout", the single
 * thing `worktree list` compresses to a `(removable)` marker on BRANCH.
 *
 * Stated once, here, rather than inline at the render site: it is the rule the docs describe and the
 * one worth testing directly. Deliberately NOT a field on `WorktreeEntry` — it is fully derivable from
 * fields already there, and baking it into the payload would freeze one policy into the wire format
 * (see `docs/design/worktree-disposability.md` §5).
 *
 * Evaluated at render time because `workspace` is joined in by `listWorktrees` after the git read.
 * Every clause earns its place, and the two signal reads are STRICT identity rather than truthiness —
 * an absent field means undeterminable, and undeterminable must never render as "safe to delete".
 */
export function isWorktreeRemovable(entry: WorktreeEntry): boolean {
	return (
		// The primary checkout is never disposable — which also makes `(removable)` mutually exclusive with
		// the `(*)` marker, so BRANCH never carries two.
		entry.linked &&
		// A vanished checkout already says `(gone)` on ROOT, which is THE prune signal; two markers for
		// one action is noise.
		!entry.prunable &&
		entry.merged === true &&
		entry.dirty === false &&
		// Occupied is in use, whatever git thinks of the branch.
		!entry.workspace
	)
}

/**
 * Refuse the primary checkout: a spawned session's resolved worktree root must never be the primary
 * checkout itself.
 */
export function assertDistinctFromPrimary(worktreeRoot: string, primaryRoot: string): void {
	if (resolve(worktreeRoot) === resolve(primaryRoot)) {
		throw new WorktreeGitError(
			'refusing to run in the primary checkout — spawn a worktree distinct from the primary checkout',
		)
	}
}

/**
 * Default worktree location — a sibling of the primary checkout (`<parent>/<repo>.worktrees/<name>`),
 * never nested inside the primary's own working tree (an untracked-but-present nested worktree
 * pollutes `git status` in the primary and confuses tools that walk the tree expecting only the
 * primary's own files).
 */
export function resolveWorktreePath(primaryRoot: string, name: string): string {
	return join(dirname(primaryRoot), `${basename(primaryRoot)}.worktrees`, name)
}

/**
 * Whether a worktree has uncommitted changes — gates a safe remove unless the caller forces it. An
 * unanswered `status` collapses to `false` HERE, unlike the reporting path: a gate that refused on a
 * question git could not answer would block removal of a checkout git has nothing to say about.
 */
function isDirty(exec: Exec, worktreeRoot: string): boolean {
	return readDirty(exec, worktreeRoot) === true
}

/**
 * Remove a worktree the safe way: refuse the primary checkout (absolute — `force` never overrides
 * it), tolerate a worktree already gone from disk, and refuse to discard uncommitted changes unless
 * `force` is set.
 *
 * `releaseBinding` detaches whatever a multiplexer has bound to this checkout (a herdr workspace).
 * It stays an opaque callback so this module owes nothing to the session seam. Its ORDER is a
 * specified property, not an incidental one:
 *
 *  - every gate runs BEFORE it, so a REFUSED removal has no side effect — a dirty worktree that
 *    fails the check must not lose its workspace on the way out;
 *  - it runs BEFORE git removes the checkout, so no workspace is ever left pointing at a deleted
 *    directory (and a held cwd can block the removal outright).
 */
export function removeWorktreeSafely(
	exec: Exec,
	path: string,
	opts: {
		primaryRoot: string
		force?: boolean | undefined
		releaseBinding?: (() => void) | undefined
		fs?: WorktreeFs | undefined
	},
): void {
	const fs = opts.fs ?? nodeWorktreeFs
	assertDistinctFromPrimary(path, opts.primaryRoot)
	if (!fs.exists(path)) {
		// A checkout already gone but still bound is exactly the orphan this releases; git has nothing
		// left to remove, so the "no git removal command" promise still holds.
		opts.releaseBinding?.()
		return
	}
	if (!opts.force && isDirty(exec, path)) {
		throw new WorktreeGitError(`worktree "${path}" has uncommitted changes — pass --force to discard them`)
	}
	opts.releaseBinding?.()
	gitWorktreeAdapter.remove(exec, path, { primaryRoot: opts.primaryRoot })
}

/** One worktree `pruneWorktrees` declined to remove, and why — so a caller can report the reason
 * rather than just the fact of a skip. */
export interface WorktreePruneSkip {
	entry: WorktreeEntry
	reason: string
}

/** What `pruneWorktrees` did (or, on a dry run, would do) — every linked worktree it removed, and
 * every one it left alone with a reason. The primary checkout is never in either list: it is not a
 * candidate, not a skip, just absent. */
export interface WorktreePruneResult {
	removed: WorktreeEntry[]
	skipped: WorktreePruneSkip[]
}

/**
 * Why `isWorktreeRemovable` said no, in prose — the first failing clause, in the same order the gate
 * checks them. `entry.prunable` is deliberately not folded into "not merged": a checkout git already
 * calls gone needs `git worktree prune`, a different remedy than the others here.
 */
function worktreePruneSkipReason(entry: WorktreeEntry): string {
	if (entry.prunable) return 'checkout already gone from disk — run `git worktree prune` to clear it'
	if (entry.workspace) return `open in workspace ${entry.workspace}`
	if (entry.dirty !== false)
		return entry.dirty === undefined ? 'uncommitted changes could not be determined' : 'has uncommitted changes'
	if (entry.merged !== true)
		return entry.merged === undefined
			? 'merge status could not be determined'
			: 'branch has not landed on the default branch — no ancestry, gone-upstream, or squash signal matched'
	return 'not removable'
}

/**
 * The bulk remove — every worktree `isWorktreeRemovable` clears, gone in one call. No new git
 * plumbing: this composes `listWorktreesFromGit`, `isWorktreeRemovable`, and `removeWorktreeSafely`,
 * the same primitives `worktree list`'s `(removable)` marker and `worktree remove` already use, so
 * prune can never disagree with what the listing promised.
 *
 * `dryRun` reports exactly what a live run would do without removing anything — the CLI's default,
 * so a bare invocation is always safe to run. The primary checkout is filtered out before the gate
 * even runs, matching `isWorktreeRemovable`'s own absolute refusal of it.
 */
export function pruneWorktrees(
	exec: Exec,
	primaryRoot: string,
	opts?: {
		dryRun?: boolean | undefined
		fs?: WorktreeFs | undefined
		signals?: WorktreeSignalOptions | undefined
	},
): WorktreePruneResult {
	const fs = opts?.fs ?? nodeWorktreeFs
	const entries = listWorktreesFromGit(exec, primaryRoot, fs, opts?.signals).filter((entry) => entry.linked)
	const removed: WorktreeEntry[] = []
	const skipped: WorktreePruneSkip[] = []
	for (const entry of entries) {
		if (!isWorktreeRemovable(entry)) {
			skipped.push({ entry, reason: worktreePruneSkipReason(entry) })
			continue
		}
		if (!opts?.dryRun) removeWorktreeSafely(exec, entry.root, { primaryRoot, fs })
		removed.push(entry)
	}
	return { removed, skipped }
}

/** What a freshly-created worktree needs when none is free to reuse — the `add` path's inputs, minus
 * `primaryRoot` (supplied positionally to `provisionWorktree`, exactly as it is to `pruneWorktrees`). */
export interface WorktreeCreateSpec {
	/** Where a fresh checkout goes — the caller's resolved path (e.g. `resolveWorktreePath`). */
	path: string
	/** Branch the handed-back worktree ends up on — created fresh on both paths, so reuse and create
	 * yield the same branch for the same request. */
	branch: string
	/** Start-point for the new branch. Used verbatim on the create path (git's own default is HEAD);
	 * on the reuse path it defaults to the resolved default branch, then `HEAD`, when omitted. */
	base?: string | undefined
}

/** Whether `provisionWorktree` reused an existing checkout or created a fresh one. */
export type WorktreeProvisionAction = 'reused' | 'created'

/** What `provisionWorktree` did — the twin of `WorktreePruneResult`. `worktree` is the handed-back
 * checkout on its new branch; `reused` is the entry that was recycled, carried in full so the caller
 * can report the reclaim — including its prior branch and its `workspace` (occupancy). Absent when a
 * fresh checkout was created. */
export interface WorktreeProvisionResult {
	action: WorktreeProvisionAction
	worktree: Worktree
	reused?: WorktreeEntry | undefined
}

/**
 * Reuse a free worktree instead of creating a fresh one — the mirror of `pruneWorktrees`. Prune
 * REMOVES every disposable worktree; provision RECYCLES one, and both ask the same question through the
 * same predicate, so they can never disagree about which worktrees are free.
 *
 * `available` is the injected availability gate, defaulting to `isWorktreeRemovable` — the exact
 * predicate prune removes on. It is a PARAMETER, not a hardcoded rule, because "free" splits at the
 * seam's own boundary: the clean/landed/on-disk/unoccupied part is generic git and lives here, but
 * "no LIVE agent session is attached" is host semantics (a cyberlegion ship/pane) this module must
 * never know. A host composes its own predicate on top; the default excludes worktrees a mux
 * workspace holds, and a host may loosen that.
 *
 * When a candidate is reused, its branch and working tree are reset to a PRISTINE tree: a fresh branch
 * at `base`, then `reset --hard`, then `clean -fdx`. The `merged` gate in the default predicate proves
 * the old branch's work has landed, so repointing it destroys nothing the trunk does not already hold
 * — the same safety prune leans on to delete the whole checkout, here spent on reusing it instead
 * (see the `worktree-provision` ADR for the ratified semantics). `base` defaults to the resolved default
 * branch, then `HEAD`.
 *
 * The primary checkout is filtered out before the gate even runs, matching prune and
 * `isWorktreeRemovable`'s own absolute refusal of it — so even a host predicate that forgot the check
 * can never hand back the primary.
 */
export function provisionWorktree(
	exec: Exec,
	primaryRoot: string,
	opts: {
		create: WorktreeCreateSpec
		available?: ((entry: WorktreeEntry) => boolean) | undefined
		fs?: WorktreeFs | undefined
		signals?: WorktreeSignalOptions | undefined
	},
): WorktreeProvisionResult {
	const fs = opts.fs ?? nodeWorktreeFs
	const available = opts.available ?? isWorktreeRemovable
	const entries = listWorktreesFromGit(exec, primaryRoot, fs, opts.signals).filter((entry) => entry.linked)
	const candidate = entries.find((entry) => available(entry))
	if (candidate) {
		const base = opts.create.base ?? resolveDefaultBranchRef(exec, primaryRoot, entries) ?? 'HEAD'
		recycleWorktree(exec, candidate.root, opts.create.branch, base)
		return { action: 'reused', worktree: { root: candidate.root, branch: opts.create.branch }, reused: candidate }
	}
	const worktree = gitWorktreeAdapter.add(exec, { primaryRoot, ...opts.create })
	return { action: 'created', worktree }
}

/**
 * Reset a reused checkout to a pristine tree on a fresh branch — the ratified reuse semantics. Each
 * step is gated by the caller's availability predicate (merged + clean by default), so nothing here
 * discards work that lives only in this checkout: `switch -c` repoints to the new branch at `base`,
 * `reset --hard` pins the tree to it, and `clean -fdx` clears untracked and ignored state (a warm
 * `node_modules` included) for a cold, deterministic start. Any failing git call throws this module's
 * own error rather than leaving the checkout half-reset.
 */
function recycleWorktree(exec: Exec, root: string, branch: string, base: string): void {
	const run = (args: string[]): void => {
		if (exec('git', ['-C', root, ...args]) === null)
			throw new WorktreeGitError(`git ${args[0]} failed while recycling worktree ${root}`)
	}
	run(['switch', '-c', branch, base])
	run(['reset', '--hard', base])
	run(['clean', '-fdx'])
}

/** The seams a `WorktreeApi` binds. Both optional, each defaulting to its Node-backed impl. */
export interface WorktreeDeps {
	exec?: Exec | undefined
	fs?: WorktreeFs | undefined
}

/** `removeWorktreeSafely`'s options minus `fs` — the `WorktreeApi` supplies the bound one. */
export interface RemoveWorktreeOptions {
	primaryRoot: string
	force?: boolean | undefined
	releaseBinding?: (() => void) | undefined
}

/**
 * The git-worktree helpers with their `Exec`/`WorktreeFs` BOUND — the ergonomic surface over the raw,
 * exec-first functions above. `worktreeApi(deps?)` binds once (defaulting to
 * `nodeExec`/`nodeWorktreeFs`); every method then drops the runner. The raw functions stay exported
 * for a caller threading its own per call, exactly as `resolveMuxAdapter` sits under `resolveMux`.
 *
 * Pure helpers with no seam to bind — `isWorktreeRemovable`, `resolveWorktreePath`,
 * `assertDistinctFromPrimary` — stay free functions.
 */
export interface WorktreeApi {
	/** The primary checkout's root — `resolvePrimaryRoot` bound. */
	primaryRoot(): string
	/** Every worktree git reports; `primaryRoot` defaults to `primaryRoot()` — `listWorktreesFromGit` bound.
	 * `signals` carries the opt-in forge layer; layers 1–3 run either way. */
	list(primaryRoot?: string | undefined, signals?: WorktreeSignalOptions | undefined): WorktreeEntry[]
	/** Create a worktree — `gitWorktreeAdapter.add` bound. */
	add(opts: WorktreeAddOptions): Worktree
	/** Remove a worktree under cyber-mux's gates — `removeWorktreeSafely` bound (its `fs` supplied). */
	removeSafely(path: string, opts: RemoveWorktreeOptions): void
	/** Remove every disposable worktree; `primaryRoot` defaults to `primaryRoot()` — `pruneWorktrees` bound. */
	prune(
		opts?:
			| {
					primaryRoot?: string | undefined
					dryRun?: boolean | undefined
					signals?: WorktreeSignalOptions | undefined
			  }
			| undefined,
	): WorktreePruneResult
	/**
	 * Reuse a free worktree or create a fresh one; `primaryRoot` defaults to `primaryRoot()` —
	 * `provisionWorktree` bound. `available` defaults to `isWorktreeRemovable`; a host injects its own to
	 * add a live-session check (or to loosen occupancy).
	 */
	provision(opts: {
		primaryRoot?: string | undefined
		create: WorktreeCreateSpec
		available?: ((entry: WorktreeEntry) => boolean) | undefined
		signals?: WorktreeSignalOptions | undefined
	}): WorktreeProvisionResult
	/** Symlink-resolved, native-cased path — `normalizeWorktreePath` bound. */
	normalizePath(path: string): string
}

/**
 * Bind the git-worktree helpers to a runner and filesystem once, returning a `WorktreeApi` whose
 * methods no longer take an `Exec`. `deps` default to `nodeExec` / `nodeWorktreeFs`.
 */
export function worktreeApi(deps?: WorktreeDeps | undefined): WorktreeApi {
	const exec = deps?.exec ?? nodeExec
	const fs = deps?.fs ?? nodeWorktreeFs
	return {
		primaryRoot: () => resolvePrimaryRoot(exec),
		list: (primaryRoot, signals) => listWorktreesFromGit(exec, primaryRoot ?? resolvePrimaryRoot(exec), fs, signals),
		add: (opts) => gitWorktreeAdapter.add(exec, opts),
		removeSafely: (path, opts) => removeWorktreeSafely(exec, path, { ...opts, fs }),
		prune: (opts) =>
			pruneWorktrees(exec, opts?.primaryRoot ?? resolvePrimaryRoot(exec), {
				dryRun: opts?.dryRun,
				fs,
				signals: opts?.signals,
			}),
		provision: (opts) =>
			provisionWorktree(exec, opts.primaryRoot ?? resolvePrimaryRoot(exec), {
				create: opts.create,
				available: opts.available,
				fs,
				signals: opts.signals,
			}),
		normalizePath: (path) => normalizeWorktreePath(path, fs),
	}
}
