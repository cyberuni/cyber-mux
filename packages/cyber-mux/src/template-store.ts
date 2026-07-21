import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { type Exec, nodeExec } from './exec.ts'
import { isValidTemplateName } from './template.ts'
import { resolvePrimaryRoot } from './worktree.ts'

/**
 * Template resolution — the filesystem half. Owes nothing to the multiplexer: `list`, `show` and
 * `validate` all take a FILE as their subject, so they answer with no mux present at all.
 *
 * Template resolution is the first feature in this package that needs the filesystem, which has no
 * seam (every other seam is `Exec`). Reading templates through bare `node:fs` would make `template` the
 * one command tree that cannot be driven hermetically in `cli.test.ts` — hence `TemplateStore`.
 */

export interface TemplateStore {
	/** Template names (filename stems) at this source; empty when the directory does not exist. */
	list(dir: string): string[]
	/** Raw file contents, or `null` when absent — mirrors `Exec`'s null-on-failure convention, which
	 * is what lets the resolution chain be a plain `??` walk rather than a try/catch ladder. */
	read(path: string): string | null
	/** Whether a directory exists — the apply-time check behind a pane's `dir`. Here rather than in
	 * the walk because this is the package's one filesystem seam, and a walk that reached for bare
	 * `node:fs` would be untestable exactly where it matters. */
	dirExists(path: string): boolean
	/** Write a template, creating the templates directory if it is not there yet — `template save`. The
	 * one WRITING member of this seam; `save` is the one verb that authors a file rather than reading
	 * one, and it goes through the seam for the same reason the reads do. Overwrite protection is the
	 * caller's, not this method's: a store is a filesystem, and a filesystem overwrites. */
	write(path: string, contents: string): void
}

export const nodeTemplateStore: TemplateStore = {
	list(dir) {
		try {
			return readdirSync(dir)
				.filter((file) => file.endsWith('.json'))
				.map((file) => basename(file, '.json'))
				.sort()
		} catch {
			// An absent templates directory is the common case, not an error: it means "no templates here".
			return []
		}
	},
	read(path) {
		try {
			return readFileSync(path, 'utf8')
		} catch {
			return null
		}
	},
	dirExists(path) {
		return existsSync(path)
	},
	write(path, contents) {
		// `recursive` because `.cyber-mux/templates` usually does not exist yet — the first `save` in a
		// repo is exactly the call that has to create it, and failing there would make the common case
		// the broken one.
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, contents, 'utf8')
	},
}

/** Where a template was found. `file` is `--file`, which skips resolution entirely. */
export type TemplateSource = 'repo' | 'user' | 'file'

export interface ResolvedTemplate {
	/** The template's name — its filename stem, which its `name` field must equal. */
	stem: string
	path: string
	source: TemplateSource
	raw: string
}

export interface TemplateDirs {
	repo: string
	user: string
}

/**
 * The two searched directories.
 *
 * The repo location resolves through `resolvePrimaryRoot`, NOT `./.cyber-mux` relative to the
 * caller's cwd, and that is load-bearing rather than incidental: cyber-mux is used across many
 * worktrees of one project, and a worktree branched from a commit that predates a template would
 * otherwise silently see a stale template, or none at all. Resolving through the primary checkout
 * gives one canonical answer from every worktree.
 */
export function templateDirs(exec: Exec, env: NodeJS.ProcessEnv, homedir: () => string = osHomedir): TemplateDirs {
	// The home dir is INJECTED (defaulting to node's `homedir`), never read from the ambient process at
	// import time — so importing the library barrel reads no environment; only calling this does.
	const configHome = env['XDG_CONFIG_HOME'] || join(env['HOME'] || homedir(), '.config')
	return {
		repo: join(resolvePrimaryRoot(exec), '.cyber-mux', 'templates'),
		user: join(configHome, 'cyber-mux', 'templates'),
	}
}

export interface ResolveTemplateOptions {
	/** A template name — resolved repo-then-user. Ignored when `file` is given. */
	name?: string | undefined
	/** An explicit path, which SKIPS resolution entirely: the escape hatch for a template that is not
	 * checked in. Neither templates directory is consulted. */
	file?: string | undefined
	store: TemplateStore
	exec: Exec
	env: NodeJS.ProcessEnv
}

/**
 * Resolve a template to its bytes: `--file` (explicit), then the repo, then the user.
 *
 * **Repo beats user, deliberately.** A project that ships a template is making a statement about how
 * the project is worked on, and a personal template of the same name should not silently shadow it —
 * so `template list` reports each name's source and marks the user template a repo one shadows.
 *
 * Throws when nothing resolves, naming BOTH directories searched — a name that resolves nowhere is a
 * typo, and the answer to a typo is where it looked.
 */
export function resolveTemplate(opts: ResolveTemplateOptions): ResolvedTemplate {
	if (opts.file) {
		const raw = opts.store.read(opts.file)
		if (raw === null) throw new Error(`cannot read template: ${opts.file}`)
		return { stem: basename(opts.file, '.json'), path: opts.file, source: 'file', raw }
	}
	const name = opts.name ?? ''
	// BEFORE any read. A name is a lookup key, not a path — treating it as one is exactly how
	// `../../../etc/pwd` becomes a file read, and the stem rule is what makes that unreachable.
	assertTemplateName(name)
	const dirs = templateDirs(opts.exec, opts.env)
	for (const source of ['repo', 'user'] as const) {
		const path = join(dirs[source], `${name}.json`)
		const raw = opts.store.read(path)
		if (raw !== null) return { stem: name, path, source, raw }
	}
	throw new Error(`template "${name}" not found — searched ${dirs.repo} and ${dirs.user}`)
}

export function assertTemplateName(name: string): void {
	if (!isValidTemplateName(name)) {
		throw new Error(
			`invalid template name "${name}" — a name must match [a-z0-9][a-z0-9-]* and be a plain filename stem`,
		)
	}
}

export interface TemplateListing {
	name: string
	source: TemplateSource
	path: string
	/** A user template hidden by a repo template of the same name. Never true of a repo template. */
	shadowed: boolean
}

/**
 * Every template resolvable from here, repo first.
 *
 * A shadowed user template is REPORTED rather than omitted: the whole reason repo wins is that a
 * personal template should not silently displace the project's, and "silently" cuts both ways — a
 * user whose `pool-4` stopped being used deserves to be told why, not left to wonder.
 */
export function listTemplates(store: TemplateStore, dirs: TemplateDirs): TemplateListing[] {
	const repo = store.list(dirs.repo)
	const repoNames = new Set(repo)
	return [
		...repo.map((name) => ({
			name,
			source: 'repo' as const,
			path: join(dirs.repo, `${name}.json`),
			shadowed: false,
		})),
		...store.list(dirs.user).map((name) => ({
			name,
			source: 'user' as const,
			path: join(dirs.user, `${name}.json`),
			shadowed: repoNames.has(name),
		})),
	]
}

/** The seams a `TemplateApi` binds. Both optional, each defaulting to its Node-backed impl. */
export interface TemplateDeps {
	exec?: Exec | undefined
	store?: TemplateStore | undefined
}

/**
 * Template resolution with `env` / `Exec` / `TemplateStore` BOUND — the ergonomic surface over the
 * raw, seam-taking functions above. `templateApi(env, deps?)` binds once (defaulting to
 * `nodeExec` / `nodeTemplateStore`); `env` is bound like `resolveMux(env)` because the searched
 * directories read `$XDG_CONFIG_HOME` / `$HOME`. The raw functions stay exported for a caller
 * threading its own; the pure schema functions (`validateTemplate`, `resolveTree`, …) never needed one.
 */
export interface TemplateApi {
	/** The two searched directories — `templateDirs` bound. */
	dirs(): TemplateDirs
	/** Resolve a template to its bytes — `resolveTemplate` bound. */
	resolve(opts: { name?: string | undefined; file?: string | undefined }): ResolvedTemplate
	/** Every resolvable template, repo first; `dirs` defaults to `dirs()` — `listTemplates` bound. */
	list(dirs?: TemplateDirs | undefined): TemplateListing[]
}

/**
 * Bind template resolution to an environment, runner, and store once, returning a `TemplateApi` whose
 * methods no longer take them. `deps` default to `nodeExec` / `nodeTemplateStore`.
 */
export function templateApi(env: NodeJS.ProcessEnv, deps?: TemplateDeps | undefined): TemplateApi {
	const exec = deps?.exec ?? nodeExec
	const store = deps?.store ?? nodeTemplateStore
	return {
		dirs: () => templateDirs(exec, env),
		resolve: (opts) => resolveTemplate({ ...opts, store, exec, env }),
		list: (dirs) => listTemplates(store, dirs ?? templateDirs(exec, env)),
	}
}
