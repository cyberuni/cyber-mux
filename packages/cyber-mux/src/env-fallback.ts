/**
 * The env-prefix fallback — the one compensation for a route that could not set env at birth.
 *
 * env is native at every tier on both backends EXCEPT herdr's worktree `create`/`open`, which take
 * no env parameter (0.7.4 answers `--env` with `unknown option`). A route that hit that wall carries
 * env the only way left: as an `env KEY=VALUE` prefix on the command the pane runs. It is a LAST
 * resort — the values land in `ps` output and the pane's shell history — and it only works when there
 * IS a command to ride; with none, the honest outcome is to warn, never to drop silently.
 *
 * This lives in one module, called by both routes that can lose env (the CLI worktree verbs and the
 * template walk's root pane), so the rule cannot be wired on one and forgotten on the other. Only a
 * route that lost env may call it: prefixing over a natively-set env would push the values into `ps`
 * and shell history on every route, the exact cost the prefix exists to pay only when it must.
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
