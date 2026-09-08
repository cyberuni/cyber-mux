/**
 * The launch-line fallbacks — the compensations for what a creating route could not set natively.
 *
 * Two things a caller can ask for may have no native flag on the verb that opens a pane: the env the
 * pane starts with, and the directory it starts in. Both are then delivered the only way left, by
 * composing them onto the command line the pane runs — an `env K=V` prefix, a `cd <dir> &&` prefix,
 * or both. They compose in ONE order (`cd '/x' && env K=V cmd`, the env INSIDE the `&&`), because the
 * other order sets the variables on `cd` and leaves the command without them.
 *
 * The routes that lose env are herdr's worktree `create`/`open` (0.7.4 answers `--env` with `unknown
 * option`) and every cmux and otty creating verb. The routes that lose cwd are cmux's `new-pane` and
 * otty's `tab new`. Each adapter's header records what it found; this module only composes.
 *
 * The env prefix is a LAST resort — the values land in `ps` output and the pane's shell history — and
 * it only works when there IS a command to ride; with none, the honest outcome is to warn, never to
 * drop silently. A `cd` needs no command to ride, so a route with a cwd and no launch still lands in
 * the right directory.
 *
 * This lives in one module, called by every route that can lose either, so the rule cannot be wired
 * on one and forgotten on another — and so the ordering the two must agree about is written once.
 * Only a route that actually lost the native flag may call it: prefixing over a natively-set value
 * would push it into `ps` and shell history on every route, the exact cost these prefixes exist to
 * pay only when they must.
 */

/**
 * Single-quote a value for a shell command line. Everything is literal inside single quotes, so the
 * only escape needed is for a single quote itself: end the quoting, emit an escaped `'`, reopen.
 * Without this a value carrying a space or a quote would split into extra words, or unbalance the
 * line outright.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `env K=V …` with a trailing space, ready to prepend to a command line. Values are shell-quoted. */
export function envPrefix(env: Record<string, string>): string {
	return `env ${Object.entries(env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(' ')} `
}

/**
 * The fallback decision for a route that could not carry env natively — computed once, applied the
 * same way everywhere. `carried` means there was nothing to compensate (no env, or env with a command
 * that now carries it); `dropped` means env was asked for with no command to ride, and the caller
 * must warn naming `variables`.
 */
export type EnvFallback = { kind: 'carried'; command: string | undefined } | { kind: 'dropped'; variables: string[] }

/**
 * Given the env a route could not carry and the command (if any) that would run in the opened pane,
 * decide how env rides in. With a command, env is prefixed onto it and the pane carries the value;
 * with none, env is dropped and the caller warns. No env (or an empty map) is `carried` unchanged, so
 * a caller on the losing route can call this unconditionally and get the right command back.
 */
export function envFallback(env: Record<string, string> | undefined, command: string | undefined): EnvFallback {
	if (env === undefined || Object.keys(env).length === 0) return { kind: 'carried', command }
	if (command === undefined) return { kind: 'dropped', variables: Object.keys(env) }
	return { kind: 'carried', command: `${envPrefix(env)}${command}` }
}

/**
 * The fallback decision for a creating route that could not carry env, cwd, or both natively —
 * everything such a route needs to know, computed once so the composition order is written once.
 *
 * `command` is the line to submit into the freshly opened pane, or `undefined` when there is nothing
 * to send. `kind` is `dropped` only when env was asked for with no command to ride: the caller must
 * warn naming `variables`, and must still submit `command`, which carries the `cd` when there was a
 * cwd — losing env is no reason to also lose the directory.
 */
export type LaunchFallback =
	| { kind: 'carried'; command: string | undefined }
	| { kind: 'dropped'; variables: string[]; command: string | undefined }

/**
 * Compose whatever a creating route could not set natively onto the command line for its new pane.
 *
 * Pass `env` and `cwd` ONLY when this route genuinely has no native flag for them; a route that sent
 * `--cwd` must not also send a `cd`, which would push into shell history a directory the pane is
 * already in. A route that carried both natively can still call this with both omitted and get its
 * `launch` back unchanged.
 *
 * The env prefix goes INSIDE the `cd`'s `&&`, never outside it: `env K=V cd '/x' && cmd` sets the
 * variables on `cd` and leaves `cmd` without them, and it fails SILENTLY — the command still runs.
 */
export function launchFallback(
	env: Record<string, string> | undefined,
	launch: string | undefined,
	cwd: string | undefined,
): LaunchFallback {
	const carried = envFallback(env, launch)
	const command = carried.kind === 'dropped' ? undefined : carried.command
	// An empty `cwd` is treated as none, not as a `cd ''`: `MuxOpenOptions.cwd` is a required string,
	// so a caller with nothing to say passes the empty one rather than omitting the key.
	const composed = cwd ? cdPrefixed(cwd, command) : command
	if (carried.kind === 'dropped') return { kind: 'dropped', variables: carried.variables, command: composed }
	return { kind: 'carried', command: composed }
}

/** `cd <dir>` on its own, or chained ahead of the command that must run in that directory. */
function cdPrefixed(cwd: string, command: string | undefined): string {
	const cd = `cd ${shellQuote(cwd)}`
	return command === undefined ? cd : `${cd} && ${command}`
}
