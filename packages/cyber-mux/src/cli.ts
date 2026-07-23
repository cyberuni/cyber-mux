import { join } from 'node:path'
import { Command, CommanderError, Option } from 'commander'
import { callerPane, resolveMuxAdapter } from './backend.ts'
import { AmbiguousPaneError, CliError, reportError } from './cli-error.ts'
import { AT_OPTION, ENV_OPTION, FORMAT_OPTION, LABEL_OPTION } from './cli-options.ts'
import { type Exec, nodeExec } from './exec.ts'
import type { LivePane, MuxAdapter, MuxPlacement, MuxTarget } from './mux.ts'
import { currentPane, probeMultiplexer } from './mux-probe.ts'
import { nodeNewId } from './new-id.ts'
import { type HelpEntry, isAutomatedOutput, output, printFields, printHelp, printTable, tildify } from './output.ts'
import { type OpenPrompt, realPrompt } from './prompt.ts'
import {
	collectPanes,
	isValidTemplateName,
	parseTemplate,
	resolveTree,
	type Template,
	validateTemplate,
} from './template.ts'
import { CaptureUnsupportedError, deriveRegionCapture, deriveWorkspaceCapture } from './template-capture.ts'
import {
	applyEdits,
	type EditAnswer,
	type EditField,
	type EditInput,
	type EditSlot,
	parseSet,
	planEdits,
	readEditInput,
	resolveSets,
	slotRef,
	toAnswers,
} from './template-edit.ts'
import {
	applyTemplateToRegion,
	openTemplate,
	TemplateApplyError,
	type TemplateManifest,
	templateRootPane,
} from './template-session.ts'
import {
	listTemplates,
	nodeTemplateStore,
	type ResolvedTemplate,
	resolveTemplate as resolveTemplateSource,
	type TemplateStore,
	templateDirs,
} from './template-store.ts'
import {
	gitWorktreeAdapter,
	isWorktreeRemovable,
	provisionWorktree,
	pruneWorktrees,
	resolvePrimaryRoot,
	resolveWorktreePath,
	WorktreeGitError,
} from './worktree.ts'
import {
	addAndOpenWorktree,
	listWorktrees,
	type OpenedWorktree,
	openExistingWorktree,
	removeWorktree,
} from './worktree-session.ts'

// NOTE: the verb surface below is provisional — the behavior spec is the next milestone and may
// rename verbs, adjust flags, or split concerns (e.g. move `nudge` behind its own group).

/** The env/exec pair every command resolves the backend and multiplexer through — injected so the
 * CLI can be driven deterministically in tests, the same seam every adapter already takes. */
export interface CliDeps {
	env: NodeJS.ProcessEnv
	exec: Exec
	/** The filesystem half, for the `template` group — injected for the same reason `exec` is: it is the
	 * only way `template` can be driven hermetically in tests, with no real templates on disk. Optional
	 * at this boundary so a caller that drives no template command need not know the seam exists. */
	store?: TemplateStore | undefined
	/** The interactive half, for `template edit` — injected for the same reason `store` is, and a
	 * FACTORY rather than a live prompt so no other verb pays stdin for its existence (`prompt.ts`
	 * has the why). */
	prompt?: OpenPrompt | undefined
}

/** `CliDeps` with every optional dep resolved — what each command is actually handed. */
interface Deps {
	env: NodeJS.ProcessEnv
	exec: Exec
	store: TemplateStore
	prompt: OpenPrompt
}

const DEFAULT_DEPS: CliDeps = { env: process.env, exec: nodeExec, store: nodeTemplateStore, prompt: realPrompt }

/**
 * Resolve the adapter for the multiplexer this process is inside, failing with a coded `no-mux` error
 * when there is none. The underlying throw is TRANSLATED, never forwarded — `resolveMuxAdapter`
 * names `$TMUX`/`$HERDR_ENV`, which is backend plumbing an agent driving cyber-mux cannot act on; the
 * help names how to get a backend through this CLI instead.
 */
function adapter(deps: Deps): MuxAdapter {
	try {
		return resolveMuxAdapter(deps.env, deps.exec)
	} catch {
		throw noMux()
	}
}

/** No multiplexer around this process — an operation failure (exit 1), not a usage error. */
function noMux(): CliError {
	return new CliError(
		'no-mux',
		'no multiplexer detected around this process',
		'run cyber-mux inside tmux or herdr, or set CYBER_MUX to name one',
		1,
	)
}

/** A locator that resolved to no live pane — a pane verb's not-found. Exit 1: a real operation
 * failure, distinct from a malformed argument. */
function paneNotFound(locator: string): CliError {
	return new CliError(
		'pane-not-found',
		`pane "${locator}" matched no live pane`,
		'list the live panes with: cyber-mux list',
		1,
	)
}

/** A malformed template name — a usage error (exit 2): the fix is a different name, nothing was
 * attempted. The same family a missing required argument is in. */
function invalidTemplateName(name: string): CliError {
	return new CliError(
		'invalid-template-name',
		`invalid template name "${name}" — a name must match [a-z0-9][a-z0-9-]* and be a plain filename stem`,
		'use a lowercase stem like pool-4',
		2,
	)
}

/**
 * A git/worktree operation that refused or failed — exit 1. A coded surface already on its way out (a
 * `no-mux`, a resolved-template error, an apply failure) passes through untouched rather than being
 * flattened into this generic one. A `WorktreeGitError` is this CLI's own worktree text (a refusal
 * naming `--force`, a primary-checkout guard), which is kept because the frozen worktree refusals are
 * asserted on it. Anything else reaching here comes from the session adapter opening/binding the
 * worktree's pane (`session.tmux.ts`/`session.herdr.ts`) and embeds the backend's own name plus its raw
 * stderr (`withReason`, `exec.lastError`) — AXI #6 forbids leaking a dependency's name or text, so that
 * detail is not load-bearing for the agent and goes to stderr as a diagnostic only; stdout carries this
 * CLI's own coded, translated error.
 */
function reportWorktreeFailure(err: unknown): never {
	if (err instanceof CliError) reportError(err)
	if (err instanceof WorktreeGitError) {
		reportError(new CliError('worktree-failed', err.message, 'check the worktree path and its state, then re-run', 1))
	}
	if (err instanceof Error && err.message) process.stderr.write(`${err.message}\n`)
	reportError(
		new CliError(
			'worktree-failed',
			'the worktree operation failed',
			'check the worktree path and its state, then re-run',
			1,
		),
	)
}

/**
 * Resolve a locator — a pane id or a human label — to the one pane it names.
 *
 * **Id first, then name.** An id can never be made to mean something else by a person renaming an
 * unrelated pane, so every caller that passes ids today keeps working no matter what anyone labels.
 * That also makes ambiguity a fuzzy-tier condition only: an id hit and a label hit are not peers, so
 * they are not candidates to choose between — the same ladder git, Docker and tmux resolve targets by.
 *
 * **An id is recognized by EXISTENCE, never by syntax.** The question asked is "does a live pane carry
 * this id?", not "does this string look like an id?". Docker sniffs shape (`sg-` → an id) and it is
 * the cheaper rule, refused here: encoding a backend's id format in the CLI is exactly the backend
 * leak this seam exists to prevent, and every new backend would owe a new syntax rule. It is also
 * wrong on a real case — `%9` is id-SHAPED, but if no pane carries it as an id and one carries it as a
 * label, a sniffer reports a missing pane while the live list finds the label.
 *
 * One `listPanes` read answers both halves, so name support costs the id path a single query and no
 * behavior. The SEAM is untouched: adapters keep receiving concrete ids, and never learn that a name
 * was ever involved.
 *
 * A locator matching NOTHING resolves to itself, deliberately — it is handed to the backend as an id
 * and takes the verb's existing not-found path (exit 1). Failing here instead would make every verb's
 * "no such pane" message this function's to write.
 */
function resolveTarget(deps: Deps, a: MuxAdapter, locator: string): MuxTarget {
	let panes: LivePane[]
	try {
		panes = a.listPanes(deps.exec)
	} catch {
		// A listing that cannot be read must not deny an id that would have worked — the id path never
		// needed this query. Degrade to the pre-resolution behavior rather than failing the verb.
		return { id: locator }
	}
	if (panes.some((p) => p.id === locator)) return { id: locator }
	const named = panes.filter((p) => p.label === locator)
	if (named.length === 1) return { id: named[0]!.id }
	// Guessing (first match, most recent, the focused one) would act on a pane the caller never named,
	// which is worse than making them look. The caller is present and is the only one who can say.
	if (named.length > 1) {
		throw new AmbiguousPaneError(
			locator,
			named.map((p) => ({ id: p.id, label: p.label ?? null, cwd: p.cwd ?? null })),
		)
	}
	return { id: locator }
}

/**
 * Wrap a verb's action so ANY coded failure reports itself on stdout and exits — the one place that
 * turns a `CliError` (an ambiguity, a `no-mux`, a `pane-not-found`, a template refusal) into output, for
 * every verb.
 *
 * Here rather than deeper so the report is the OUTERMOST thing a verb does: by the time it runs, every
 * inner catch-all has already had its chance to rethrow, and nothing can convert an exit-2 usage error
 * into an exit-1 generic failure behind its back. A non-`CliError` is a bug, not a surface — it is
 * rethrown to the top-level handler rather than dressed up as a coded failure.
 */
function guarded<A extends unknown[]>(action: (...args: A) => void): (...args: A) => void {
	return (...args: A) => {
		try {
			action(...args)
		} catch (err) {
			if (err instanceof CliError) reportError(err)
			throw err
		}
	}
}

/**
 * `guarded` for an action that awaits — the same contract, and separate rather than a widening of it.
 *
 * Making `guarded` return `void | Promise<void>` would put an ignored promise behind every sync verb's
 * action, where a rejection would escape the guard entirely and surface as an unhandled rejection
 * instead of a coded error. Two functions keeps the sync path provably sync; commander's own
 * `parseAsync` (already what `main` calls) awaits whichever it gets.
 */
function guardedAsync<A extends unknown[]>(action: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
	return async (...args: A) => {
		try {
			await action(...args)
		} catch (err) {
			if (err instanceof CliError) reportError(err)
			throw err
		}
	}
}

/**
 * Run a pane verb's body, translating a backend throw into a `pane-not-found` on the way out.
 *
 * `resolveTarget` hands an unmatched locator to the backend as an id, so a bad target surfaces as the
 * backend's OWN diagnostic — which must never reach the caller: an agent handed a tmux/herdr error
 * cannot act on it through cyber-mux. A `CliError` already on its way out (a `no-mux` from `adapter`,
 * an ambiguity from `resolveTarget`) is a coded surface and passes through untouched; anything else is
 * the multiplexer's raw failure and becomes this CLI's own code and help instead.
 */
function paneVerb(locator: string, body: () => void): void {
	try {
		body()
	} catch (err) {
		if (err instanceof CliError) throw err
		throw paneNotFound(locator)
	}
}

/**
 * The backend when there is one, `undefined` when there is not — unlike `adapter`, which fails. For
 * verbs whose subject is git (`worktree list`/`remove`): a multiplexer can only ever add to the
 * answer, so its absence must not deny one.
 */
function optionalAdapter(deps: Deps): MuxAdapter | undefined {
	try {
		return resolveMuxAdapter(deps.env, deps.exec)
	} catch {
		return undefined
	}
}

/**
 * One shape for every verb that opens a worktree. `printFields` drops nullish entries, so a bare
 * `worktree add` — which opens nothing — prints exactly what it always did.
 *
 * When the chosen placement cost the workspace grouping, the backend could have grouped this worktree
 * and did not — worth saying out loud. Per axi/'s #9 that next move rides in the payload on STDOUT as
 * a `help[N]:` block, not on stderr the agent never reads; `workspace: null` is the machine-readable
 * half of the same report. `regroupCommand` is the caller's own verb re-stated with `--at workspace`,
 * so the flag that would have grouped it is named as a concrete command. Emitted only when a grouping
 * was actually lost (#9's omit-when-self-contained rule), so `help` never rides along otherwise.
 */
function reportOpenedWorktree(opened: OpenedWorktree, regroupCommand: string): void {
	const help: HelpEntry[] = opened.degraded
		? [{ message: 'opened ungrouped — pass --at workspace to group it with the repo', command: regroupCommand }]
		: []
	output(
		{
			root: opened.worktree.root,
			branch: opened.worktree.branch,
			pane: opened.target.id,
			workspace: opened.workspace ?? null,
			...(help.length ? { help } : {}),
		},
		() => {
			printFields({
				root: opened.worktree.root,
				branch: opened.worktree.branch,
				pane: opened.target.id,
				workspace: opened.workspace,
			})
			printHelp(help)
		},
	)
}

/**
 * `--template`, the exact sibling of `--launch`: both answer "what runs in the space you are opening",
 * one for a single pane and one for a pool. Mutually exclusive by construction — commander rejects
 * the pair rather than picking a winner.
 */
function templateOption(): Option {
	// Conflicts with both `--launch` (one command line for the space) and `--env` (the template owns
	// its own panes' env) — each answers "what is in the space you are opening", and a template names
	// all of it.
	return new Option('--template <name>', 'Named template to build in the opened space').conflicts(['launch', 'env'])
}

/**
 * Resolve, parse and validate a template — the whole answer BEFORE any side effect. A typo in a
 * template name must never leave a worktree behind, and an invalid template must not either, so every
 * caller runs this before it opens or creates anything.
 */
function resolveTemplate(
	deps: Deps,
	opts: { name?: string | undefined; file?: string | undefined },
): ResolvedTemplate & { template: Template } {
	// A malformed NAME is a usage error (exit 2), and it is caught HERE — before `resolveTemplateSource` reads —
	// so it is told apart from a well-formed name that simply resolves nowhere (exit 1, below). The name
	// is a lookup key that must also be a filename; `../../../etc/pwd` must never get as far as a read.
	if (opts.name !== undefined && opts.file === undefined && !isValidTemplateName(opts.name)) {
		throw invalidTemplateName(opts.name)
	}
	let resolved: ResolvedTemplate
	try {
		resolved = resolveTemplateSource({
			name: opts.name,
			file: opts.file,
			store: deps.store,
			exec: deps.exec,
			env: deps.env,
		})
	} catch (err) {
		// A well-formed name that resolves nowhere is a failed lookup, not malformed input (exit 1). The
		// message is this CLI's own — it names the directories it searched — so it is kept, not a backend's.
		throw new CliError(
			'template-not-found',
			err instanceof Error ? err.message : String(err),
			'list the templates resolvable from here with: cyber-mux template list',
			1,
		)
	}
	let parsed: unknown
	try {
		parsed = parseTemplate(resolved.raw)
	} catch (err) {
		throw new CliError(
			'invalid-template',
			`${resolved.path}: ${err instanceof Error ? err.message : String(err)}`,
			'fix the template JSON, then re-run',
			1,
		)
	}
	// A template's CONTENT being invalid is a predicate answer (exit 1), not a usage error — the
	// invocation was well-formed, the fix is to the file. Every error at once, one per line, each naming
	// its own JSON path — first-only would make a template with three mistakes take three runs to fix.
	const errors = validateTemplate(parsed, resolved.stem)
	if (errors.length > 0) {
		throw new CliError('invalid-template', errors.join('\n'), 'fix the fields named above, then re-run', 1)
	}
	return { ...resolved, template: parsed as Template }
}

/** The apply manifest — the handoff. `printFields`/`printTable` for humans, the raw object for json. */
function reportManifest(manifest: TemplateManifest, extra: Record<string, string | null> = {}): void {
	output({ ...extra, ...manifest }, () => {
		printFields({ ...extra, template: manifest.template, cwd: manifest.cwd, workspace: manifest.workspace })
		printTable(manifest.panes, [
			{ label: 'label', get: (p) => p.label ?? '' },
			{ label: 'pane', get: (p) => p.pane },
			{ label: 'dir', get: (p) => p.dir },
			{ label: 'command', get: (p) => p.command ?? '' },
		])
	})
}

/**
 * A walk that threw reports what it BUILT and exits 1, killing nothing. Rolling back would mean
 * killing panes, and a kill is not obviously safer than a half-built template the caller can see and
 * finish.
 */
function reportApplyFailure(err: unknown, extra: Record<string, string | null> = {}): never {
	if (err instanceof TemplateApplyError) {
		// The manifest is the WHOLE of stdout — one result payload, with the failed pane named inside it,
		// never a second structured error concatenated after it. The message is supplementary debug, so it
		// goes to stderr: moving it to stdout would break the "stdout carries exactly one payload" invariant
		// the stream decision rests on.
		reportManifest(err.manifest, extra)
		process.stderr.write(`${err.message}\n`)
		process.exit(1)
	}
	// A totally-failed apply that produced no result — a predictable pre-open failure (a missing dir
	// names the pane and the resolved path). Its message is this CLI's own text, exit 1.
	throw new CliError(
		'template-apply-failed',
		err instanceof Error ? err.message : String(err),
		'check the template and the target directory, then re-run',
		1,
	)
}

function templateListCommand(deps: Deps): Command {
	return new Command('list')
		.description('Every template resolvable from here, with its source and pane count')
		.addOption(FORMAT_OPTION)
		.action(
			guarded(() => {
				const dirs = templateDirs(deps.exec, deps.env)
				const templates = listTemplates(deps.store, dirs).map((entry) => {
					// A template that does not parse still LISTS — `list` answers "what is here", and
					// `validate` answers "is it any good". Conflating them would hide a broken file entirely.
					let panes = 0
					try {
						const raw = deps.store.read(entry.path)
						if (raw) panes = collectPanes(resolveTree(parseTemplate(raw) as Template)).length
					} catch {
						panes = 0
					}
					return { ...entry, panes }
				})
				output({ templates }, () =>
					printTable(templates, [
						{ label: 'name', get: (l) => l.name },
						{ label: 'source', get: (l) => l.source },
						{ label: 'panes', get: (l) => String(l.panes) },
						{ label: 'shadowed', get: (l) => (l.shadowed ? 'yes' : '') },
					]),
				)
			}),
		)
}

function templateShowCommand(deps: Deps): Command {
	return new Command('show')
		.description('Print a resolved template as JSON')
		.argument('[name]', 'Template name')
		.option('--file <path>', 'Read this path instead, skipping resolution entirely')
		.option('--desugar', 'Print the canonical tree panes/arrange expands to — exactly what apply builds')
		.action(
			guarded((name: string | undefined, opts: { file?: string | undefined; desugar?: boolean | undefined }) => {
				if (!name && !opts.file) {
					throw new CliError(
						'missing-argument',
						'template show needs a template name or --file <path>',
						'pass a template name, or --file <path>',
						2,
					)
				}
				const { template } = resolveTemplate(deps, { name, file: opts.file })
				// One desugarer, so `--desugar` and the walk can never disagree about what a flat template means.
				console.log(JSON.stringify(opts.desugar ? resolveTree(template) : template, null, 2))
			}),
		)
}

function templateValidateCommand(deps: Deps): Command {
	return new Command('validate')
		.description('Validate a template — exit 0 valid, 1 invalid, every error at once with a JSON path')
		.argument('[name]', 'Template name')
		.option('--file <path>', 'Validate this path instead, skipping resolution entirely')
		.action(
			guarded((name: string | undefined, opts: { file?: string | undefined }) => {
				if (!name && !opts.file) {
					throw new CliError(
						'missing-argument',
						'template validate needs a template name or --file <path>',
						'pass a template name, or --file <path>',
						2,
					)
				}
				// resolveTemplate already fails with every error, one per line. Reaching here means valid, and
				// a valid template says nothing at all — this is the CI hook, so silence is the pass signal.
				resolveTemplate(deps, { name, file: opts.file })
			}),
		)
}

/**
 * `save` is the one verb here that reads a multiplexer rather than a file, and the only one that
 * WRITES: it captures a live region into a named template, so a pool built by hand once can be named
 * rather than hand-written. That is the schema's one real authoring cost — a 4+ pane grid needs
 * nested `split` nodes nobody wants to type.
 *
 * **What it saves is a draft, and the file says so.** A capture recovers geometry, labels and dirs;
 * it never recovers commands, because what a backend can report about a running pane is a resolved,
 * machine-local command line rather than a portable one (`template-capture.ts` has the why). A saved
 * template therefore lands with no `command` on any pane
 * and is immediately listed by `template list` alongside finished ones, so the draft has to announce
 * itself IN the file — hence the `description` default. Saying it only on stderr would put the
 * warning everywhere except where the reader is.
 *
 * `--to` defaults to `repo`, matching resolution's own precedence: a template is a statement about
 * how the PROJECT is worked on, and that is the copy worth having by default.
 *
 * **`save`'s subject is a REGION and stays one.** `--workspace` widens it to every tab of the
 * workspace the caller's region sits in — one captured tab per live tab, each with its own derived
 * tree, the exact inverse of the tabs walk. It is opt-in rather than the default because widening the
 * default silently would rewrite what `save` has always meant for every caller already relying on it.
 * The bare form does not stay quiet about the narrowing, though: capturing one tab of three notes on
 * stderr what it left out, rather than letting a caller believe a 3-tab workspace round-trips from a
 * 1-tab template.
 */
function templateSaveCommand(deps: Deps): Command {
	return new Command('save')
		.description('Capture the live region around a pane into a named template')
		.argument('<name>', 'Name for the captured template')
		.option('--from <pane>', "Pane whose region to capture; defaults to this process's own pane")
		.option('--workspace', "Capture every tab of the caller's workspace, as a tabs template")
		.option('--description <text>', 'Description to record in the template')
		.addOption(
			new Option('--to <source>', 'Which templates directory to write to').choices(['repo', 'user']).default('repo'),
		)
		.option('--force', 'Overwrite an existing template of this name')
		.addOption(FORMAT_OPTION)
		.addHelpText(
			'after',
			'\nA capture recovers geometry, labels and dirs — NOT commands. A backend can often say what is\n' +
				'RUNNING, but it reports the resolved command line rather than the one you typed (`nr web dev`\n' +
				'comes back as `node /run/user/1000/fnm_multishells/.../bin/nr web dev`), which is not portable\n' +
				'to another machine — so every pane is saved without one.\n' +
				'\nFill them in before the template is worth applying:\n' +
				'  cyber-mux template edit <name>                  # list the panes\n' +
				'  cyber-mux template edit <name> --set 1=claude   # fill one in',
		)
		.action(
			guarded(
				(
					name: string,
					opts: {
						from?: string | undefined
						workspace?: boolean | undefined
						description?: string | undefined
						to: 'repo' | 'user'
						force?: boolean | undefined
					},
				) => {
					// Before the multiplexer is touched: a name is a lookup key that must also be a filename, so an
					// unusable one should not cost a region read to find out. A usage error (exit 2), the same
					// malformed-name family `show` refuses at 2.
					if (!isValidTemplateName(name)) throw invalidTemplateName(name)
					try {
						const path = join(templateDirs(deps.exec, deps.env)[opts.to], `${name}.json`)
						// Checked BEFORE the capture, so a refusal costs nothing — and refused by default, because a
						// template is hand-edited after it is saved (the commands are added by hand) and silently
						// overwriting one would throw that work away.
						if (!opts.force && deps.store.read(path) !== null) {
							throw new CliError(
								'template-exists',
								`template "${name}" already exists at ${path} — pass --force to overwrite it`,
								're-run with --force to replace it',
								1,
							)
						}
						const a = adapter(deps)
						// The geometry-capability refusal is UNCONDITIONAL and so outranks the missing-pane usage
						// error below: a backend that cannot report geometry (or enumerate a workspace) cannot be
						// captured for ANY pane, so no --from rescues it. Telling such a caller to "pass --from"
						// would send them down a dead end — pass it, rerun, and get exit 1 anyway. So the
						// backend-unsupported refusal (exit 1) is raised BEFORE the target is resolved. The DECISION
						// stays in the library: throw its typed `CaptureUnsupportedError`, mapped to
						// `backend-unsupported` in the catch below, so the message and exit code are single-source.
						// Each mode asks only for the member it needs (a backend is never refused for lacking one
						// this run would not call), matching the derive orchestrator's own check.
						if (!(opts.workspace ? a.regions?.describeWorkspace : a.regions?.describeRegion)) {
							throw new CaptureUnsupportedError(a.name, opts.workspace ? 'workspace' : 'region')
						}
						// `--from` names a pane explicitly; otherwise capture around the pane THIS process sits in,
						// which is what makes a bare `template save pool-4` mean "the screen I am looking at".
						//
						// Through the same resolver every flat verb uses, rather than the `{ id: opts.from }` this
						// built inline: `--from` is a pane locator like any other, and a name that works on `read`
						// and silently means nothing here is the drift a second spelling guarantees. The caller's
						// OWN pane needs no resolution — `callerPane` already answers with a concrete id.
						const target = opts.from ? resolveTarget(deps, a, opts.from) : callerPane(a, deps.env)
						if (!target) {
							// A required parameter is missing, not an operation that failed — a usage error (exit 2).
							throw new CliError(
								'missing-pane',
								'template save needs a pane to capture the region around — pass --from <pane>, or run it inside one',
								'pass --from <pane>, or run template save inside a pane',
								2,
							)
						}
						const captureOpts = { name, description: opts.description ?? CAPTURED_DESCRIPTION }
						// The orchestrators re-check the same seam member and refuse the same way — that check is
						// their own library contract (it is what makes the template/capture refusal provable at that
						// node, independent of this verb). The early guard above only fixes the ORDER relative to the
						// missing-pane error; reaching here, the member is already known present.
						const { template, warnings } = opts.workspace
							? deriveWorkspaceCapture(a, deps.exec, target, captureOpts)
							: deriveRegionCapture(a, deps.exec, target, captureOpts)
						deps.store.write(path, `${JSON.stringify(template, null, 2)}\n`)
						// A capture warning (a dir outside the repo root) is a diagnostic, not part of the answer —
						// it stays on stderr, where `capture.feature` pins it. The PAYLOAD is stdout.
						for (const warning of warnings) process.stderr.write(`${warning}\n`)
						// save's stdout is a structured payload: a `path` field, plus a `help[N]:` block only when a
						// bare save left tabs behind (#9's reveal-a-truncated-list, omitted otherwise). This replaces
						// the bare path, so programmatic composition reads `--format json | jq -r .path` instead.
						const entry = opts.workspace ? null : noteTabsLeftOut(deps, a, target, name)
						const help: HelpEntry[] = entry ? [entry] : []
						output({ path, ...(help.length ? { help } : {}) }, () => {
							printFields({ path })
							printHelp(help)
						})
					} catch (err) {
						// A coded failure (the refusals above, an ambiguity, a no-mux) is already a surface and
						// passes through to `guarded`. Anything else is a capture that could not produce a tree — a
						// region no splits could have built, or an empty one — reported under this CLI's own code,
						// never the backend's raw text. Exit 1: the capture failed, the invocation was well-formed.
						if (err instanceof CliError) throw err
						// The library's geometry-capability refusal: the DECISION is the orchestrator's; the exit
						// code, the fix hint and the exact sentence are this CLI's, composed from the backend name
						// and which seam was missing. Exit 1 — a genuine operation failure, not a usage error.
						if (err instanceof CaptureUnsupportedError) throw backendUnsupported(err)
						throw new CliError(
							'unsplittable-region',
							'this region could not be captured — it is not a tree any sequence of splits could have produced',
							'template save can only capture a region built by splitting',
							1,
						)
					}
				},
			),
		)
}

/**
 * What a bare `save` left behind: a `help` entry when the caller's workspace holds tabs this capture
 * did not take, so the capture is honest about its own scope rather than letting a caller believe a
 * 3-tab workspace round-trips from a 1-tab template.
 *
 * Per axi/'s #9 this reveal rides in `save`'s stdout payload as a `help[N]:` block, not on stderr the
 * agent never reads — programmatic composition reads the path from `--format json`, not bare stdout.
 * It is a NOTE rather than a refusal: the template the caller asked for is correct and is already
 * written. Which is also why this is best-effort — a workspace read that fails or that the backend
 * cannot do at all returns `null` (no entry), costing the caller a courtesy, not their capture. An
 * untagged window on a backend with no workspace tier reports one tab and yields nothing, which is
 * right — a window nobody grouped is a workspace of one, and nothing was left out. The `command`
 * re-states the caller's own `name` with `--workspace`, the flag that captures every tab.
 */
/**
 * The CLI surface of the library's geometry-capability refusal: exit 1 (a genuine operation failure,
 * not a usage error), naming the backend, with the flag-specific fix hint. The DECISION to refuse is
 * the orchestrator's (`CaptureUnsupportedError`); this composes only the presentation from the two
 * structured fields the error carries, so the sentence lives in one place per surface.
 */
function backendUnsupported(err: CaptureUnsupportedError): CliError {
	return err.capability === 'region'
		? new CliError(
				'backend-unsupported',
				`${err.backend} cannot report a region's geometry — template save needs a backend that can`,
				'run template save on a backend that reports geometry (tmux or herdr)',
				1,
			)
		: new CliError(
				'backend-unsupported',
				`${err.backend} cannot enumerate a workspace's tabs — template save --workspace needs a backend that can`,
				'run template save --workspace on a backend that enumerates tabs (tmux or herdr)',
				1,
			)
}

function noteTabsLeftOut(deps: Deps, adapter: MuxAdapter, target: MuxTarget, name: string): HelpEntry | null {
	const describeWorkspace = adapter.regions?.describeWorkspace
	if (!describeWorkspace) return null
	let tabs: number
	try {
		tabs = describeWorkspace(deps.exec, target).length
	} catch {
		return null
	}
	if (tabs <= 1) return null
	return {
		message:
			`this pane's workspace holds ${tabs} tabs — only the caller's own region was captured. ` +
			'Pass --workspace to capture every tab of it',
		command: `cyber-mux template save ${name} --workspace`,
	}
}

/**
 * The default `description` on a captured template — the draft warning, written where the reader
 * actually is. A saved capture is listed by `template list` next to finished templates and shows up in
 * `template show`, so a note that only ever reached the terminal that ran `save` would be gone by the
 * time anyone reads the file. Overridden by `--description`, since an author who names the template's
 * purpose has said something more useful than this.
 */
const CAPTURED_DESCRIPTION = 'Captured from a live region — geometry only; add a command to each pane.'

/**
 * `edit` is `save`'s other half, and exists because of what `save` cannot do: a capture recovers
 * geometry, labels and dirs and lands with no `command` on any pane (`template-capture.ts` has the
 * why), so a saved template is a draft that is worth nothing until every command is filled in. Doing
 * that by hand means opening JSON and counting braces to work out which leaf is the pane on the left.
 *
 * **Three modes, and the DEFAULT is the one an agent uses.** AXI's no-interactive-prompts rule is not
 * a preference here — a verb whose only mode is a conversation is unusable by the caller this CLI is
 * built for, and a prompt against a pipe hangs with nothing on screen to say why. So:
 *
 * - bare — LIST the panes and what each says. AXI #8's content-first home view, and the half of the
 *   agent's loop that makes the other half possible: the `pane` column prints exactly the token
 *   `--set` takes, so acting on the listing is a paste rather than a derivation.
 * - `--set <pane>=<value>` — the mutation, complete with flags alone, repeatable, idempotent.
 * - `--interactive` — the guided walk, for a human filling a fresh capture in one pass.
 *
 * **Line-based rather than a TUI even in the interactive mode.** A full-screen editor would need a
 * rendering dependency in a package that has exactly one, and a raw-mode event loop the synchronous
 * `Exec` seam every other verb is built on cannot express.
 *
 * **Nothing is written until every answer is in and the result validates.** `applyEdits` clones, so a
 * refusal costs the author nothing and there is never a half-edited template on disk — which is what
 * lets Ctrl-D mean "abandon this" rather than "commit whatever I happened to have typed", and what
 * makes a `--set` batch naming one bad pane write none of them.
 */
function templateEditCommand(deps: Deps): Command {
	return new Command('edit')
		.description('Show a template’s panes, and fill them in with --set or --interactive')
		.argument('[name]', 'Template name')
		.option('--file <path>', 'Edit this path instead, skipping resolution entirely')
		.option(
			'--set <pane=value>',
			'Set the field on a pane, e.g. --set 1=claude (repeatable; empty value clears)',
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.option('-i, --interactive', 'Ask one question per pane instead, pre-filling the current value')
		.addOption(
			new Option('--field <field>', 'Which field --set and --interactive write')
				.choices(['command', 'label'])
				.default('command'),
		)
		.option('--dry-run', 'Print the edited template instead of writing it')
		.addOption(FORMAT_OPTION)
		.addHelpText(
			'after',
			'\nPanes are addressed by ordinal, never by label (two panes may share one): "3" in a\n' +
				'single-region template, "2.3" for tab 2 pane 3. Run the bare form to see them.\n' +
				'\nExamples\n' +
				'  cyber-mux template edit pool-4                        # list the panes\n' +
				'  cyber-mux template edit pool-4 --set 1=claude         # fill one in\n' +
				'  cyber-mux template edit pool-4 --set 2="pnpm dev" --set 3=          # set two, clear one\n' +
				'  cyber-mux template edit pool-4 --field label --set 1=planner\n' +
				'  cyber-mux template edit pool-4 --interactive          # one prompt per pane',
		)
		.action(
			guardedAsync(
				async (
					name: string | undefined,
					opts: {
						file?: string
						set: string[]
						interactive?: boolean
						field: EditField
						dryRun?: boolean
						format?: string
					},
				) => {
					if (!name && !opts.file) {
						throw new CliError(
							'missing-argument',
							'template edit needs a template name or --file <path>',
							'pass a template name, or --file <path>',
							2,
						)
					}
					// Two ways of saying what to write, given together, cannot be reconciled — the same
					// malformed-input family `--template` with `--launch` is in (exit 2).
					if (opts.interactive && opts.set.length > 0) {
						throw new CliError(
							'conflicting-options',
							'template edit takes --set or --interactive, not both',
							'pass --set for a scripted edit, or --interactive to be asked pane by pane',
							2,
						)
					}
					const resolved = resolveTemplate(deps, { name, file: opts.file })
					const slots = planEdits(resolved.template)
					if (slots.length === 0) {
						throw new CliError(
							'empty-template',
							`template "${resolved.stem}" declares no panes to edit`,
							'check the template with: cyber-mux template validate',
							1,
						)
					}
					// The bare form MUTATES NOTHING. It is the listing, so an agent that runs the verb to find
					// out what is there cannot accidentally change anything by doing so.
					if (!opts.interactive && opts.set.length === 0) {
						printSlots(resolved, slots, opts.field)
						return
					}
					const answers = opts.interactive
						? await interactiveAnswers(deps, resolved, slots, opts.field)
						: setAnswers(slots, opts.set, opts.field)
					const edited = applyEdits(resolved.template, answers)
					// Belt-and-braces, and honestly so: `resolveTemplate` already validated on the way in, and
					// neither field this verb offers can be made invalid (both are free strings), so today this
					// cannot fire. It is here because `--field` is the seam that grows — a `dir` can escape the
					// apply-time root and a `ratio` can leave `(0,1)`, and the moment one of those is offered
					// this is the check that stops an answer from writing a template apply would then refuse.
					const errors = validateTemplate(edited, resolved.stem)
					if (errors.length > 0) {
						throw new CliError(
							'invalid-template',
							`those answers would make "${resolved.stem}" invalid:\n${errors.join('\n')}`,
							'give a value the schema accepts',
							1,
						)
					}
					if (opts.dryRun) {
						console.log(JSON.stringify(edited, null, 2))
						return
					}
					// Unchanged writes nothing at all, and exits 0 — AXI's idempotent-mutation rule. Re-running the
					// same `--set` is a no-op rather than an error, and a walk the author pressed Enter through
					// leaves the file's mtime alone: a template is checked in, and a no-op edit that dirtied the
					// working tree would show up as a change in review that is not one.
					if (answers.length > 0) deps.store.write(resolved.path, `${JSON.stringify(edited, null, 2)}\n`)
					output({ path: resolved.path, changed: answers.length }, () =>
						printFields({ path: resolved.path, changed: String(answers.length) }),
					)
				},
			),
		)
}

/**
 * The listing — AXI #8's content-first view, and the first half of an agent's list-then-act loop.
 *
 * The `pane` column is `slotRef`, which is verbatim what `--set` takes: an identifier a caller has to
 * transform before reusing is an identifier that invites transforming it wrong. `position` is here
 * for the same reason it is in the prompt — apply order is a tree walk, not a reading order, so an
 * ordinal alone cannot tell a caller which pane on screen it is about to write to.
 */
function printSlots(resolved: ResolvedTemplate & { template: Template }, slots: EditSlot[], field: EditField): void {
	const missing = slots.filter((slot) => slot[field] === undefined)
	const panes = slots.map((slot) => ({
		pane: slotRef(slot),
		tab: slot.tabLabel ?? (slot.tab === undefined ? '' : String(slot.tab + 1)),
		position: slot.position ?? '',
		label: slot.label ?? '',
		dir: slot.dir ?? '',
		command: slot.command ?? '',
	}))
	// #9 disclosure: what to do next, parameterized rather than guessed. The name is echoed back from
	// what the caller actually passed, so the suggestion is runnable as printed.
	const subject = resolved.source === 'file' ? `--file ${resolved.path}` : resolved.stem
	const help: HelpEntry[] = []
	if (missing.length > 0) {
		help.push({
			message: `${missing.length} of ${slots.length} panes have no ${field} — a template applies without one, but the pane just sits at a shell`,
			command: `cyber-mux template edit ${subject} --set ${slotRef(missing[0]!)}=<${field}>`,
		})
	}
	help.push({
		message: 'Fill them in one prompt at a time, with the current value pre-filled',
		command: `cyber-mux template edit ${subject} --interactive`,
	})
	output({ path: resolved.path, field, panes, help }, () => {
		printFields({ template: resolved.stem, path: tildify(resolved.path), source: resolved.source })
		printTable(panes, [
			{ label: 'pane', get: (p) => p.pane },
			// Dropped entirely for a single-region template rather than printed empty — a column of blanks
			// is a claim that there is a tab tier to think about, and there is not.
			...(resolved.template.tabs ? [{ label: 'tab', get: (p: (typeof panes)[number]) => p.tab }] : []),
			{ label: 'position', get: (p) => p.position },
			{ label: 'label', get: (p) => p.label },
			{ label: 'dir', get: (p) => p.dir },
			{ label: field, get: (p) => (field === 'label' ? p.label : p.command) },
		])
		printHelp(help)
	})
}

/**
 * `--set` resolved against the listing's own identifiers.
 *
 * The parse and the lookup both throw plain `Error`s from the pure module; they become coded usage
 * errors HERE, at the boundary that owns exit codes. Exit 2 rather than 1 for the same reason
 * `invalidTemplateName` is a 2: the fix is a different argument, and nothing was attempted.
 */
function setAnswers(slots: EditSlot[], specs: string[], field: EditField): EditAnswer[] {
	try {
		return resolveSets(slots, specs.map(parseSet), field)
	} catch (err) {
		throw new CliError(
			'invalid-set',
			err instanceof Error ? err.message : String(err),
			'list the panes and their identifiers with: cyber-mux template edit <name>',
			2,
		)
	}
}

/**
 * The guided walk's answers — the interactive mode's whole body, kept out of the action so the two
 * mutation paths meet at exactly one place (`applyEdits`) and cannot drift on validation or writing.
 */
async function interactiveAnswers(
	deps: Deps,
	resolved: ResolvedTemplate & { template: Template },
	slots: EditSlot[],
	field: EditField,
): Promise<EditAnswer[]> {
	// A prompt against a pipe would block forever with nothing on screen to say why — the one failure
	// mode an agent driving this CLI cannot diagnose or escape. `--format json|agent` is refused for the
	// same reason even on a tty: a caller asking for machine output has said it is not a human.
	if (!process.stdin.isTTY || isAutomatedOutput()) {
		throw new CliError(
			'not-interactive',
			'template edit --interactive asks questions and needs a terminal',
			'set the values directly instead: cyber-mux template edit <name> --set <pane>=<value>',
			2,
		)
	}
	const inputs = await askSlots(deps, resolved, slots, field)
	// `undefined` is Ctrl-D — the human left. Nothing is written, and it is a failure rather than a
	// quiet success so a caller that wrapped this can tell an abandoned edit from a finished one.
	if (!inputs) {
		throw new CliError(
			'edit-aborted',
			`edit of "${resolved.stem}" abandoned — nothing was written`,
			'run it again to start over',
			1,
		)
	}
	return toAnswers(slots, inputs, field)
}

/**
 * The walk itself: a header, then one question per pane, in apply order.
 *
 * Returns `undefined` the moment the prompt reports EOF, rather than collecting a partial list —
 * "the human left" has to reach the caller as one fact, and a short array would be indistinguishable
 * from a walk where the last few panes were skipped.
 *
 * The prompt is closed in a `finally` because it owns stdin: a throw from anywhere in the walk that
 * left it open would hang the process at exit with no output, turning a diagnosable error into a
 * silent freeze.
 */
async function askSlots(
	deps: Deps,
	resolved: ResolvedTemplate & { template: Template },
	slots: EditSlot[],
	field: EditField,
): Promise<EditInput[] | undefined> {
	const tabs = resolved.template.tabs?.length
	const scope = tabs ? `${tabs} tabs, ${slots.length} panes` : `${slots.length} panes`
	process.stdout.write(`\n${resolved.stem} — ${scope}  (${resolved.source}: ${tildify(resolved.path)})\n`)
	process.stdout.write(`Enter keeps, "-" clears, Ctrl-D abandons.\n\n`)
	const prompt = deps.prompt()
	const inputs: EditInput[] = []
	try {
		let tab: number | undefined
		for (const slot of slots) {
			// Printed only when it CHANGES, so a single-region template shows no tab header at all and a
			// tabs template shows each one once — the grouping the author sees matches the one in the file.
			if (slot.tab !== undefined && slot.tab !== tab) {
				tab = slot.tab
				// The count is the tab's OWN, not the walk's — a tabs template's panes are numbered within
				// each tab, so "4 panes" here is what the ordinals below actually run to.
				const panes = slots.filter((other) => other.tab === tab).length
				const label = slot.tabLabel ? ` "${slot.tabLabel}"` : ''
				process.stdout.write(`  tab ${tab + 1}${label} (${panes} ${panes === 1 ? 'pane' : 'panes'})\n`)
			}
			const line = await prompt.ask(`  ${describeSlot(slot, field)} `, slot[field])
			if (line === undefined) return undefined
			inputs.push(readEditInput(line))
		}
	} finally {
		prompt.close()
	}
	return inputs
}

/**
 * One pane's prompt text: which pane, what already identifies it, and the field being asked for.
 *
 * The context shown is every field EXCEPT the one being edited — a pane is told apart by its dir and
 * its label, and echoing the current value here would duplicate what the pre-filled line already
 * shows. Panes carry no identity of their own beyond their ordinal (a label is a name two panes may
 * share, by design), so the ordinal always leads.
 *
 * **The position leads the rest of the context**, because it is the only part that answers the
 * question the author is actually asking — which pane on my screen is this? Apply order is a tree
 * walk rather than a reading order, so pane 2 of a 2x2 is the one BELOW pane 1, not the one beside
 * it; without a bearing the ordinal alone invites filling the right command into the wrong pane.
 */
function describeSlot(slot: EditSlot, field: EditField): string {
	const context = [
		slot.position ?? null,
		slot.label !== undefined && field !== 'label' ? `label: ${slot.label}` : null,
		slot.dir !== undefined ? `dir: ${slot.dir}` : null,
		slot.command !== undefined && field !== 'command' ? `command: ${slot.command}` : null,
	].filter((part) => part !== null)
	const indent = slot.tab === undefined ? '' : '  '
	return `${indent}pane ${slot.index + 1}${context.length ? ` (${context.join(', ')})` : ''} ${field}?`
}

/**
 * The `template` group manages templates — there is deliberately no `template apply`. Applying is what
 * `open` and `worktree add` already do, told to build N panes instead of one, so it is `--template` on
 * those verbs.
 *
 * `list` / `show` / `validate` take a FILE as their subject and touch no multiplexer. `save` is the
 * exception in both respects — it reads a live region and writes a file — and it belongs here anyway:
 * it AUTHORS a template, which is what this group is for.
 */
function templateCommand(deps: Deps): Command {
	const cmd = new Command('template').description('Manage named templates (apply one with open/worktree --template)')
	cmd.addCommand(templateListCommand(deps))
	cmd.addCommand(templateShowCommand(deps))
	cmd.addCommand(templateValidateCommand(deps))
	cmd.addCommand(templateSaveCommand(deps))
	cmd.addCommand(templateEditCommand(deps))
	return cmd
}

function doctorCommand(deps: Deps): Command {
	return new Command('doctor')
		.description('Probe the multiplexer, self pane, and backend; print fast-path pins')
		.addOption(FORMAT_OPTION)
		.action(() => {
			const probe = probeMultiplexer(deps.exec, deps.env)
			const self = currentPane(deps.env)
			let backend = 'none'
			try {
				backend = resolveMuxAdapter(deps.env, deps.exec).name
			} catch {
				// no backend — reported as 'none'
			}
			const data = {
				mux: probe.mux,
				via: probe.via,
				pane: self?.pane ?? probe.pane ?? null,
				backend,
			}
			output(data, () => {
				printFields({
					multiplexer: data.mux,
					'detected via': data.via,
					pane: data.pane ?? '(none)',
					backend: data.backend,
				})
				if (self) {
					console.log('')
					console.log('Pin the fast-path to skip detection:')
					console.log(`  export CYBER_MUX=${self.mux} CYBER_MUX_PANE=${self.pane}`)
				}
			})
		})
}

function modeCommand(deps: Deps): Command {
	return new Command('mode')
		.description('Report the detected session backend (tmux / herdr / none)')
		.addOption(FORMAT_OPTION)
		.action(() => {
			let name = 'none'
			try {
				name = resolveMuxAdapter(deps.env, deps.exec).name
			} catch {
				// no backend — reported as 'none'
			}
			output({ backend: name }, () => console.log(name))
		})
}

function openCommand(deps: Deps): Command {
	return new Command('open')
		.description('Open a new pane/tab/workspace, optionally launching a command in it')
		.option('--launch <command>', 'Command line to run in the new pane')
		.addOption(templateOption())
		.option('--cwd <path>', 'Working directory for the new pane', process.cwd())
		.addOption(AT_OPTION)
		.addOption(ENV_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action(
			guarded(
				(opts: {
					launch?: string | undefined
					template?: string | undefined
					cwd: string
					at?: MuxPlacement | undefined
					env?: Record<string, string> | undefined
					label?: string | undefined
				}) => {
					if (opts.template) {
						// Resolve and validate BEFORE touching a backend, so an unresolvable name opens nothing.
						const { template } = resolveTemplate(deps, { name: opts.template })
						const a = adapter(deps)
						try {
							reportManifest(
								openTemplate(deps.exec, a, template, {
									cwd: opts.cwd,
									// A fresh space is empty by construction, which is why the pool defaults there.
									at: opts.at ?? 'workspace',
									label: opts.label ?? template.name,
									dirExists: deps.store.dirExists,
									newId: nodeNewId,
									from: callerPane(a, deps.env),
								}),
							)
						} catch (err) {
							reportApplyFailure(err)
						}
						return
					}
					const a = adapter(deps)
					const t = a.open(deps.exec, {
						cwd: opts.cwd,
						launch: opts.launch,
						at: opts.at,
						env: opts.env,
						label: opts.label,
						from: callerPane(a, deps.env),
					})
					// The workspace rides in on the open itself — the backend answered when the pane was born, so
					// reporting it asks nothing extra; hiding it would discard a fact already in hand. `?? null`
					// on the JSON side only, matching `reportOpenedWorktree`: absent is the seam's meaning, null
					// is its spelling at the machine-readable boundary.
					output({ pane: t.id, workspace: t.workspace ?? null }, () =>
						printFields({ pane: t.id, workspace: t.workspace }),
					)
				},
			),
		)
}

/** The `send` group: drive a pane's input WITHOUT taking its turn. Neither subcommand presses an
 * Enter the caller did not write — supplying one is `submit`'s job. Bare `cyber-mux send` is
 * incomplete input, not a content request: it is answered with help on stdout and exit 2 (a usage
 * error — a missing required parameter; see the AXI note in `.agents/spec/axi/README.md`). */
function sendCommand(deps: Deps): Command {
	const send = new Command('send').description('Drive a pane without taking its turn (text | keys)')
	send.addCommand(
		new Command('text')
			.description('Type literal text into a pane, pressing no Enter (a key-named word is typed, not pressed)')
			.argument('<pane>', 'Target pane id')
			.argument('<text>', 'Literal text to type')
			.addOption(FORMAT_OPTION)
			.action(
				guarded((pane: string, text: string) => {
					paneVerb(pane, () => {
						const a = adapter(deps)
						a.sendText(deps.exec, resolveTarget(deps, a, pane), text)
					})
				}),
			),
	)
	send.addCommand(
		new Command('keys')
			.description('Press named keys in a pane, typing nothing (Up, Enter, Escape, C-c, F1 …)')
			.argument('<pane>', 'Target pane id')
			.argument(
				'<keys...>',
				'Key names, in order — core vocabulary is portable, anything else is passed to the backend as-is',
			)
			.addOption(FORMAT_OPTION)
			.action(
				guarded((pane: string, keys: string[]) => {
					paneVerb(pane, () => {
						const a = adapter(deps)
						a.sendKeys(deps.exec, resolveTarget(deps, a, pane), keys)
					})
				}),
			),
	)
	return send
}

function submitCommand(deps: Deps): Command {
	return new Command('submit')
		.description("Take a pane's turn: type the text if given, then always press Enter (no text = bare-Enter flush)")
		.argument('<pane>', 'Target pane id')
		.argument('[text]', 'Text to type before Enter; omit to flush an already-staged buffer without retyping it')
		.addOption(FORMAT_OPTION)
		.action(
			guarded((pane: string, text: string | undefined) => {
				paneVerb(pane, () => {
					const a = adapter(deps)
					a.submit(deps.exec, resolveTarget(deps, a, pane), text)
				})
			}),
		)
}

function readCommand(deps: Deps): Command {
	return new Command('read')
		.description("Capture a pane's output")
		.argument('<pane>', 'Target pane id')
		.option('--lines <n>', 'Trailing lines to capture', (v) => Number.parseInt(v, 10))
		.addOption(FORMAT_OPTION)
		.action(
			guarded((pane: string, opts: { lines?: number | undefined }) => {
				paneVerb(pane, () => {
					const a = adapter(deps)
					const t = resolveTarget(deps, a, pane)
					// A failed read captures nothing — there are no bytes for an error to land amid, so `paneVerb`
					// throwing here means stdout is the structured error alone, with no partial pane output before it.
					const out = a.read(deps.exec, t, opts.lines != null ? { lines: opts.lines } : undefined)
					process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
				})
			}),
		)
}

function focusCommand(deps: Deps): Command {
	return new Command('focus')
		.description('Beam the attached client to a pane')
		.argument('<pane>', 'Target pane id')
		.addOption(FORMAT_OPTION)
		.action(
			guarded((pane: string) => {
				paneVerb(pane, () => {
					const a = adapter(deps)
					a.focus(deps.exec, resolveTarget(deps, a, pane))
				})
			}),
		)
}

function closeCommand(deps: Deps): Command {
	return new Command('close')
		.description('Close a pane')
		.argument('<pane>', 'Target pane id')
		.addOption(FORMAT_OPTION)
		.action(
			guarded((pane: string) => {
				paneVerb(pane, () => {
					const a = adapter(deps)
					a.teardown(deps.exec, resolveTarget(deps, a, pane))
				})
			}),
		)
}

function listCommand(deps: Deps): Command {
	return new Command('list')
		.description('Enumerate every live pane the current backend can see')
		.addOption(FORMAT_OPTION)
		.action(
			guarded(() => {
				const panes = adapter(deps).listPanes(deps.exec)
				output({ panes }, () =>
					printTable(panes, [
						{ label: 'pane', get: (p) => p.id },
						// `label` takes the slot `mux` held. Every row of one listing reports the same mux — one
						// adapter is selected per session, so the column is constant by construction and
						// discriminates nothing. The label is what a caller now types INSTEAD of the id, so it is
						// the fact this row exists to carry. `doctor` is where the backend is a live question.
						{ label: 'label', get: (p) => p.label ?? '' },
						{ label: 'harness', get: (p) => p.harness ?? '' },
						{ label: 'cwd', get: (p) => p.cwd ?? '' },
					]),
				)
			}),
		)
}

function existsCommand(deps: Deps): Command {
	return new Command('exists')
		.description('Probe whether a single pane is still live (exit 0 = live, 1 = gone)')
		.argument('<pane>', 'Target pane id')
		.addOption(FORMAT_OPTION)
		.action(
			guarded((pane: string) => {
				const a = adapter(deps)
				// Resolution runs BEFORE any output: an ambiguous locator throws out of here, so `live`/`gone`
				// is never printed for a question that has no single pane to be about.
				const t = resolveTarget(deps, a, pane)
				const live = a.paneExists(deps.exec, t)
				output({ pane, live }, () => console.log(live ? 'live' : 'gone'))
				if (!live) process.exit(1)
			}),
		)
}

function worktreeAddCommand(deps: Deps): Command {
	return new Command('add')
		.description('Create a git worktree, and open it when given a placement — grouped where the backend can')
		.requiredOption('--branch <branch>', 'Branch to create the worktree on')
		.option('--path <path>', 'Where to check out the worktree (default: a sibling of the primary checkout)')
		.option('--base <ref>', 'Start point for the new branch (default: the current HEAD)')
		.option('--launch <command>', 'Command to run in the opened pane; implies --at workspace')
		.addOption(templateOption())
		.addOption(AT_OPTION)
		.addOption(ENV_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action(
			(opts: {
				branch: string
				path?: string | undefined
				base?: string | undefined
				launch?: string | undefined
				template?: string | undefined
				at?: MuxPlacement | undefined
				env?: Record<string, string> | undefined
				label?: string | undefined
			}) => {
				try {
					const primaryRoot = resolvePrimaryRoot(deps.exec)
					// The primary flow this feature exists for. Resolve and validate FIRST: a typo in a
					// template name, or a template that sets a cwd, must not leave a worktree behind.
					if (opts.template) {
						const { template } = resolveTemplate(deps, { name: opts.template })
						const path = opts.path ?? resolveWorktreePath(primaryRoot, opts.branch)
						const a = adapter(deps)
						// No `launch`: the worktree's workspace opens blank and its root pane becomes the
						// tree's root region — not a wasted pane, the one the walk splits into. Its `env`
						// must ride in HERE, though: no split ever births that pane, so this is the only
						// call that can set it.
						const opened = addAndOpenWorktree(deps.exec, a, {
							primaryRoot,
							branch: opts.branch,
							path,
							base: opts.base,
							env: templateRootPane(template).env,
							at: 'workspace',
							label: opts.label ?? template.name,
							from: callerPane(a, deps.env),
						})
						const extra = { root: opened.worktree.root, branch: opened.worktree.branch }
						try {
							reportManifest(
								applyTemplateToRegion(deps.exec, a, template, {
									root: opened.target,
									cwd: opened.worktree.root,
									workspace: opened.workspace ?? null,
									// The same label the workspace was just opened under — a tabs template carries
									// it into each later tab's name where the backend has no workspace tier.
									label: opts.label ?? template.name,
									// The route that opened the region is the only thing that knows whether it
									// could carry the root pane's env; the walk falls back to a prefix when not.
									rootEnvHonored: opened.envHonored,
									dirExists: deps.store.dirExists,
									newId: nodeNewId,
								}),
								extra,
							)
						} catch (err) {
							reportApplyFailure(err, extra)
						}
						return
					}
					const path = opts.path ?? resolveWorktreePath(primaryRoot, opts.branch)
					// With no placement asked for AND nothing to put IN a pane, this IS a git operation: it
					// creates a checkout, opens nothing, and needs no multiplexer to be inside of. There is
					// nothing to group because nothing was opened — `worktree open` groups it later. `--env`
					// joins `--launch` in this guard: asking for something in a pane is asking for the pane,
					// so it can no longer be a bare add.
					if (!opts.at && !opts.launch && !opts.env) {
						const wt = gitWorktreeAdapter.add(deps.exec, { primaryRoot, path, branch: opts.branch, base: opts.base })
						output({ root: wt.root, branch: wt.branch, pane: null, workspace: null }, () =>
							printFields({ root: wt.root, branch: wt.branch }),
						)
						return
					}
					// A launch or an env with no placement wants its own space, not a pane crowding the
					// caller's — and `workspace` is the only placement a backend can bind a worktree to.
					const at = opts.at ?? 'workspace'
					const a = adapter(deps)
					reportOpenedWorktree(
						addAndOpenWorktree(deps.exec, a, {
							primaryRoot,
							branch: opts.branch,
							path,
							base: opts.base,
							launch: opts.launch,
							env: opts.env,
							at,
							label: opts.label,
							from: callerPane(a, deps.env),
						}),
						`cyber-mux worktree add --branch ${opts.branch} --at workspace`,
					)
				} catch (err) {
					reportWorktreeFailure(err)
				}
			},
		)
}

/**
 * `worktree provision` — reuse a free worktree or create a fresh one, the CLI wiring of the
 * `provisionWorktree` seam. The verb uses the DEFAULT availability gate (`isWorktreeRemovable`, the
 * exact set `worktree list` marks `(removable)` and `prune` removes) and offers NO flag to inject a
 * host predicate — that is the surface divergence from the library seam, which takes one. A host that
 * must exclude a live-session worktree calls `WorktreeApi.provision` directly. It reports what it did
 * (`reused` | `created`), the worktree, and on reuse the recycled entry — its prior branch and the
 * workspace it was open in; `printFields` drops the nullish reuse fields on a create.
 */
function worktreeProvisionCommand(deps: Deps): Command {
	return new Command('provision')
		.description(
			'Reuse a free worktree or create a fresh one — the default-gate wiring of the provision seam (a worktree `list` marks "(removable)"). Reports whether it reused or created',
		)
		.requiredOption('--branch <branch>', 'Branch the provisioned worktree ends up on')
		.option('--base <ref>', 'Start point for the fresh branch (default: the resolved default branch, then HEAD)')
		.option(
			'--path <path>',
			'Where a fresh checkout goes when none is free to reuse (default: a sibling of the primary checkout)',
		)
		.addOption(FORMAT_OPTION)
		.action((opts: { branch: string; base?: string | undefined; path?: string | undefined }) => {
			try {
				const primaryRoot = resolvePrimaryRoot(deps.exec)
				const path = opts.path ?? resolveWorktreePath(primaryRoot, opts.branch)
				const result = provisionWorktree(deps.exec, primaryRoot, {
					create: { path, branch: opts.branch, base: opts.base },
				})
				const reused = result.reused
					? {
							root: result.reused.root,
							branch: result.reused.branch ?? null,
							workspace: result.reused.workspace ?? null,
						}
					: null
				output({ action: result.action, root: result.worktree.root, branch: result.worktree.branch, reused }, () =>
					printFields({
						action: result.action,
						root: result.worktree.root,
						branch: result.worktree.branch,
						'reused-from': reused ? (reused.branch ?? '(detached)') : undefined,
						'reused-workspace': reused?.workspace ?? undefined,
					}),
				)
			} catch (err) {
				reportWorktreeFailure(err)
			}
		})
}

function worktreeOpenCommand(deps: Deps): Command {
	return new Command('open')
		.description('Open an existing git worktree — groups it with the repo where the backend can bind')
		.argument('<path>', 'Worktree path to open')
		.option('--launch <command>', 'Command to run in the opened pane')
		.addOption(AT_OPTION)
		.addOption(ENV_OPTION)
		.addOption(LABEL_OPTION)
		.addOption(FORMAT_OPTION)
		.action(
			(
				path: string,
				opts: {
					launch?: string | undefined
					at?: MuxPlacement | undefined
					env?: Record<string, string> | undefined
					label?: string | undefined
				},
			) => {
				try {
					const primaryRoot = resolvePrimaryRoot(deps.exec)
					const a = adapter(deps)
					reportOpenedWorktree(
						openExistingWorktree(deps.exec, a, {
							primaryRoot,
							path,
							launch: opts.launch,
							env: opts.env,
							at: opts.at,
							label: opts.label,
							from: callerPane(a, deps.env),
						}),
						`cyber-mux worktree open ${path} --at workspace`,
					)
				} catch (err) {
					reportWorktreeFailure(err)
				}
			},
		)
}

function worktreeListCommand(deps: Deps): Command {
	return new Command('list')
		.description(
			'Every worktree of the repo, and the workspace each is open in — BRANCH is marked "(*)" for the primary checkout (every other row is a linked worktree) or "(removable)" when the worktree looks disposable (its branch is merged into the default branch, the checkout is clean, and nothing is open in it), and ROOT is marked "(gone)" when the checkout no longer exists on disk (git can prune it)',
		)
		.addOption(FORMAT_OPTION)
		.action(() => {
			try {
				const primaryRoot = resolvePrimaryRoot(deps.exec)
				const worktrees = listWorktrees(deps.exec, optionalAdapter(deps), { primaryRoot })
				output({ worktrees }, () =>
					printTable(worktrees, [
						// `linked` is one BIT, so it does not earn a column: the primary checkout — the single
						// row where it is false — is marked in BRANCH instead. The field itself stays intact in
						// `--format json`, where a consumer reads the boolean rather than the marker.
						// `(removable)` is the disposability COMPOSITE — merged AND clean AND unoccupied — compressed to
						// one word, and it rides on BRANCH because the branch is what carries the work that landed.
						// Its inputs (`merged`, `dirty`) stay raw and unmarked in `--format json`, where a consumer
						// composes its own policy rather than inheriting this one.
						{
							label: 'branch',
							get: (w) =>
								`${w.branch ?? '(detached)'}${w.linked ? (isWorktreeRemovable(w) ? ' (removable)' : '') : ' (*)'}`,
						},
						// `prunable` is likewise one bit, and a rarer one — the marker rides on ROOT because the
						// path is the thing that is actually gone. `(gone)` is git's own word for a target that
						// vanished (`branch -vv` prints it), where "stale" would read as merely out of date.
						{ label: 'root', get: (w) => `${tildify(w.root)}${w.prunable ? ' (gone)' : ''}` },
						{ label: 'workspace', get: (w) => w.workspace ?? '' },
					]),
				)
			} catch (err) {
				reportWorktreeFailure(err)
			}
		})
}

function worktreeRemoveCommand(deps: Deps): Command {
	return new Command('remove')
		.description('Remove a git worktree — refuses the primary checkout and uncommitted changes unless --force')
		.argument('<path>', 'Worktree path to remove')
		.option('--force', 'Discard uncommitted changes in the worktree')
		.action((path: string, opts: { force?: boolean | undefined }) => {
			try {
				const primaryRoot = resolvePrimaryRoot(deps.exec)
				removeWorktree(deps.exec, optionalAdapter(deps), path, { primaryRoot, force: opts.force })
			} catch (err) {
				reportWorktreeFailure(err)
			}
		})
}

/**
 * The bulk remove — every candidate `worktree list` already marks `(removable)`, gone in one call
 * instead of one `worktree remove` per path.
 *
 * **Bare form previews, `--force` applies.** The gate is destructive (it discards checkouts,
 * irreversibly), so the default has to be the side-effect-free one — a caller can run this to see
 * what WOULD go, exactly as `template edit`'s bare form lists rather than mutates. `--force` here is
 * "actually do it", not `removeWorktreeSafely`'s "discard uncommitted changes": prune's candidates
 * are already clean by construction (`isWorktreeRemovable` requires `dirty === false`), so there is
 * nothing for that meaning to apply to.
 */
function worktreePruneCommand(deps: Deps): Command {
	return new Command('prune')
		.description(
			'Remove every disposable worktree in one call — the same gate `worktree list` marks "(removable)" with. Bare form previews the candidates; pass --force to actually remove them',
		)
		.option('--force', 'Remove the candidates instead of only previewing them')
		.addOption(FORMAT_OPTION)
		.action((opts: { force?: boolean | undefined }) => {
			try {
				const primaryRoot = resolvePrimaryRoot(deps.exec)
				const result = pruneWorktrees(deps.exec, primaryRoot, { dryRun: !opts.force })
				const removed = result.removed.map((entry) => ({ root: entry.root, branch: entry.branch ?? null }))
				const skipped = result.skipped.map((s) => ({
					root: s.entry.root,
					branch: s.entry.branch ?? null,
					reason: s.reason,
				}))
				output({ applied: Boolean(opts.force), removed, skipped }, () => {
					printTable(removed, [
						{ label: opts.force ? 'removed' : 'would remove', get: (r) => tildify(r.root) },
						{ label: 'branch', get: (r) => r.branch ?? '(detached)' },
					])
					if (skipped.length > 0) {
						printTable(skipped, [
							{ label: 'skipped', get: (s) => tildify(s.root) },
							{ label: 'reason', get: (s) => s.reason },
						])
					}
					if (!opts.force && removed.length > 0) {
						printHelp([
							{
								message: `${removed.length} worktree${removed.length === 1 ? '' : 's'} would be removed`,
								command: 'cyber-mux worktree prune --force',
							},
						])
					}
				})
			} catch (err) {
				reportWorktreeFailure(err)
			}
		})
}

function worktreeCommand(deps: Deps): Command {
	const cmd = new Command('worktree').description('Git worktree helpers for spawning/tearing down a session')
	cmd.addCommand(worktreeAddCommand(deps))
	cmd.addCommand(worktreeProvisionCommand(deps))
	cmd.addCommand(worktreeOpenCommand(deps))
	cmd.addCommand(worktreeListCommand(deps))
	cmd.addCommand(worktreeRemoveCommand(deps))
	cmd.addCommand(worktreePruneCommand(deps))
	return cmd
}

/**
 * Translate a commander-level rejection into the SAME coded error surface every verb uses. commander's
 * own failures — a flag the command does not define, a required argument the parser never received, two
 * mutually-exclusive flags — are USAGE errors: the fix is a different invocation, not a retry, so they
 * exit 2, and they belong on stdout under a stable code exactly as an operation failure does.
 *
 * The callback is attached per command, so `command` is the SUBCOMMAND actually invoked — which is what
 * lets an unknown flag be rejected against that subcommand's own flags (`template list` does not share
 * `template save`'s), and the offending flag be named beside them so the agent self-corrects in one turn
 * rather than a second `--help` round trip.
 */
function handleCommanderError(command: Command, err: CommanderError): never {
	// An explicit `--help`/`--version` is not an error: help is already on stdout, exit 0, and no flag
	// validation ever rejects `--help` on any command.
	if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') process.exit(err.exitCode)
	// A bare group (`cyber-mux send` with no subcommand, or a bare `cyber-mux`) is incomplete input, not
	// a content request: its help belongs on stdout — the stream the agent reads — and it exits 2, the
	// status that separates bad input from a failed operation.
	if (err.code === 'commander.help') {
		process.stdout.write(command.helpInformation())
		process.exit(2)
	}
	if (err.code === 'commander.unknownOption') reportError(unknownFlagError(command, err))
	if (err.code === 'commander.missingArgument') reportError(missingArgumentError(command, err))
	if (err.code === 'commander.conflictingOption' || err.code === 'commander.excessArguments') {
		reportError(
			new CliError('usage-error', usageMessage(err), 'pass only one of the conflicting flags, then re-run', 2),
		)
	}
	// Anything else (an invalid --at choice, an unknown subcommand) keeps commander's own behavior:
	// re-thrown to the top-level handler, which honors the exit code commander chose.
	throw err
}

/** commander's raw message minus its own `error: ` prefix — its own CLI's text, safe to surface. */
function usageMessage(err: CommanderError): string {
	return (err.message ?? '').replace(/^error:\s*/, '')
}

/** An unknown flag, named beside the command's OWN valid flags, so the agent self-corrects in one turn. */
function unknownFlagError(command: Command, err: CommanderError): CliError {
	const flag = err.message.match(/'([^']+)'/)?.[1] ?? 'the flag'
	const valid = command.options.map((o) => o.long ?? o.short).filter((f): f is string => Boolean(f))
	return new CliError(
		'unknown-flag',
		`unknown flag ${flag} for ${command.name()}`,
		valid.length > 0 ? `valid flags for ${command.name()}: ${valid.join(' ')}` : `${command.name()} takes no flags`,
		2,
	)
}

/** A required argument the parser never received — a usage error naming the missing argument. */
function missingArgumentError(command: Command, err: CommanderError): CliError {
	const arg = err.message.match(/'([^']+)'/)?.[1] ?? 'an argument'
	return new CliError(
		'missing-argument',
		`missing required argument: ${arg}`,
		`provide ${arg}: cyber-mux ${command.name()} <${arg}>`,
		2,
	)
}

/**
 * Every command in the tree gets a translating `exitOverride` — NOT inherited by subcommands, so it is
 * walked. Without it `cyber-mux send` with no subcommand would `process.exit` straight from the group
 * and kill the caller's process (in tests, the runner itself); with the plain default it would throw a
 * bare `CommanderError`. This routes commander's own rejections through the coded error surface, so a
 * missing argument or unknown flag reaches the caller as an exit-2 structured error on stdout, exactly
 * as an ambiguity or a `no-mux` does.
 */
function exitOverrideTree(command: Command): Command {
	command.exitOverride((err) => handleCommanderError(command, err))
	for (const sub of command.commands) exitOverrideTree(sub)
	return command
}

/** Assembles the full command tree against the given deps (real env/exec in production, fakes in
 * tests). Every command in the tree gets `exitOverride()`, so commander throws a `CommanderError`
 * instead of calling `process.exit` directly and a rejection (an invalid `--at` choice, a missing
 * argument, a bare `send`) is catchable both here and in tests, rather than killing the test
 * runner's own process. */
export function buildProgram(cliDeps: CliDeps = DEFAULT_DEPS): Command {
	const deps: Deps = {
		env: cliDeps.env,
		exec: cliDeps.exec,
		store: cliDeps.store ?? nodeTemplateStore,
		prompt: cliDeps.prompt ?? realPrompt,
	}
	const program = new Command()
		.name('cyber-mux')
		.description('Cross-multiplexer pane control — one contract over tmux and herdr')
		.version('0.0.0')

	program.addCommand(doctorCommand(deps))
	program.addCommand(modeCommand(deps))
	program.addCommand(openCommand(deps))
	program.addCommand(sendCommand(deps))
	program.addCommand(submitCommand(deps))
	program.addCommand(readCommand(deps))
	program.addCommand(focusCommand(deps))
	program.addCommand(closeCommand(deps))
	program.addCommand(listCommand(deps))
	program.addCommand(existsCommand(deps))
	program.addCommand(worktreeCommand(deps))
	program.addCommand(templateCommand(deps))

	return exitOverrideTree(program)
}

/** The real CLI entry point — called explicitly by `bin/cyber-mux.mjs`, never as an import-time
 * side effect, so importing this module (e.g. from tests) never runs the real CLI. */
export async function main(): Promise<void> {
	try {
		await buildProgram().parseAsync(process.argv)
	} catch (err) {
		// A coded failure that reached here unguarded still owes the caller its structured error on stdout.
		if (err instanceof CliError) reportError(err)
		// A commander rejection `handleCommanderError` re-threw (an invalid --at choice, an unknown
		// subcommand): commander already wrote its own text to stderr, so honor the exit code it chose and
		// add nothing — re-printing would double it.
		if (err instanceof CommanderError) process.exit(err.exitCode)
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
		process.exit(1)
	}
}
