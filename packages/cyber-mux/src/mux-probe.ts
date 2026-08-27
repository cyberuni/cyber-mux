import type { Exec } from './exec.ts'

type Mux = 'tmux' | 'rmux' | 'herdr' | 'wezterm' | 'zellij' | 'cmux' | 'otty' | 'screen' | 'none'

/** A multiplexer that carries a per-pane env var, so a session can key its own identity from it. */
export type PaneMux = 'tmux' | 'rmux' | 'herdr' | 'wezterm' | 'zellij' | 'cmux' | 'otty'

export interface MuxProbe {
	mux: Mux
	pane?: string | undefined
	/** 'env' — trusted the $CYBER_MUX fast-path/override. 'ancestry' — walked the process tree. */
	via: 'env' | 'ancestry'
}

export interface ProbeOptions {
	/** Set `false` to skip the process-ancestry walk and answer `none` when the env fast-path misses —
	 * for a caller that only trusts the explicit override. */
	discover?: boolean | undefined
	/**
	 * The environment-variable namespace the fast-path reads, without the trailing `_PANE`. Defaults to
	 * `CYBER_MUX`, so `<prefix>` names the mux (`tmux|rmux|herdr|wezterm|zellij|cmux|otty|screen|none`)
	 * and `<prefix>_PANE` the pane. `screen` is recognized here but is not a drivable backend — see
	 * `resolveMuxAdapter`.
	 * A host embedding cyber-mux under its OWN namespace passes its prefix here and adopts the same
	 * fast-path without forking detection.
	 */
	envPrefix?: string | undefined
}

const KNOWN_MUX: readonly Mux[] = ['tmux', 'rmux', 'herdr', 'wezterm', 'zellij', 'cmux', 'otty', 'screen', 'none']

function isKnownMux(v: string | undefined): v is Mux {
	return v != null && (KNOWN_MUX as readonly string[]).includes(v)
}

/**
 * The single source of the mux → per-pane-env-var mapping. tmux exports `$TMUX_PANE`; herdr exports
 * `$HERDR_PANE_ID` (both in the same `wX:pY`-style namespace); WezTerm exports `$WEZTERM_PANE` in
 * every pane (its own bare-integer id) — per the issue that requested that backend (#47), the same
 * fast-path extension `$TMUX_PANE`/`$HERDR_PANE_ID` already get; Zellij exports `$ZELLIJ_PANE_ID` in
 * every terminal pane (its own `terminal_N`/bare-`N` id) — per the issue that requested this backend
 * (#46); cmux exports `$CMUX_SURFACE_ID` in every terminal (its surface ref, e.g. `surface:7`) — per
 * the issue that requested this backend (#48). screen carries no per-pane env var. Both the ancestry
 * probe and the `currentPane` self-identity helper read the pane through this table so the two never
 * diverge on which env var a given mux uses.
 *
 * **rmux is the one entry whose ORDER against another matters**, and the reason is not cosmetic: an
 * rmux pane exports `$RMUX_PANE` AND `$TMUX_PANE`, both holding the same `%N` id, because rmux
 * reimplements the tmux command language and keeps tmux's env contract for anything that reads it
 * (probed live on rmux 0.10.0 — a pane's env carried `RMUX=<socket>,<pid>,<session>`,
 * `RMUX_PANE=%1`, `TMUX=<the same triple>`, `TMUX_PANE=%1`, `TERM_PROGRAM=rmux`). So `$TMUX_PANE`
 * is NOT evidence of tmux, and every read that walks this table must ask rmux BEFORE tmux, or an
 * rmux session self-identifies as tmux and gets driven with the wrong binary. The table itself is
 * unordered — `currentPane` and `discoverByAncestry` below each carry the ordering, and each says so.
 */
const PANE_ENV: Record<PaneMux, (env: NodeJS.ProcessEnv) => string | undefined> = {
	tmux: (env) => env['TMUX_PANE'],
	rmux: (env) => env['RMUX_PANE'],
	herdr: (env) => env['HERDR_PANE_ID'],
	wezterm: (env) => env['WEZTERM_PANE'],
	zellij: (env) => env['ZELLIJ_PANE_ID'],
	cmux: (env) => env['CMUX_SURFACE_ID'],
	otty: (env) => env['OTTY_PANE_ID'],
}

/**
 * Resolve THIS session's own pane from env alone (no `ps` walk): the `$CYBER_MUX_PANE` fast-path a
 * spawn propagates → `$RMUX_PANE` (rmux) → `$TMUX_PANE` (tmux) → `$HERDR_PANE_ID` (herdr) →
 * `$WEZTERM_PANE` (wezterm) → `$ZELLIJ_PANE_ID` (zellij) → `$CMUX_SURFACE_ID` (cmux) →
 * `$OTTY_PANE_ID` (otty). Returns the pane tagged with its multiplexer, or undefined when the
 * session is in no pane-carrying multiplexer. This is the mux-agnostic self-identity key.
 *
 * **rmux is asked before tmux, and that order is load-bearing** — an rmux pane sets `$TMUX_PANE`
 * too (see `PANE_ENV`), so the tmux question is not a question rmux answers `no` to. The reverse
 * order would report every rmux pane as tmux and hand `resolveMuxAdapter` the wrong binary.
 */
export function currentPane(env: NodeJS.ProcessEnv): { mux: PaneMux; pane: string } | undefined {
	if (env['CYBER_MUX_PANE']) {
		// The fast-path pane carries its mux in $CYBER_MUX (rmux/herdr/wezterm/zellij/cmux/otty spawns
		// tag it; tmux is the default when none does).
		const mux: PaneMux =
			env['CYBER_MUX'] === 'rmux'
				? 'rmux'
				: env['CYBER_MUX'] === 'herdr'
					? 'herdr'
					: env['CYBER_MUX'] === 'wezterm'
						? 'wezterm'
						: env['CYBER_MUX'] === 'zellij'
							? 'zellij'
							: env['CYBER_MUX'] === 'cmux'
								? 'cmux'
								: env['CYBER_MUX'] === 'otty'
									? 'otty'
									: 'tmux'
		return { mux, pane: env['CYBER_MUX_PANE'] }
	}
	// rmux BEFORE tmux — an rmux pane carries both `$RMUX_PANE` and `$TMUX_PANE`.
	const rmux = PANE_ENV.rmux(env)
	if (rmux) return { mux: 'rmux', pane: rmux }
	const tmux = PANE_ENV.tmux(env)
	if (tmux) return { mux: 'tmux', pane: tmux }
	const herdr = PANE_ENV.herdr(env)
	if (herdr) return { mux: 'herdr', pane: herdr }
	const wezterm = PANE_ENV.wezterm(env)
	if (wezterm) return { mux: 'wezterm', pane: wezterm }
	const zellij = PANE_ENV.zellij(env)
	if (zellij) return { mux: 'zellij', pane: zellij }
	const cmux = PANE_ENV.cmux(env)
	if (cmux) return { mux: 'cmux', pane: cmux }
	const otty = PANE_ENV.otty(env)
	if (otty) return { mux: 'otty', pane: otty }
	return undefined
}

/**
 * Two-mode multiplexer detection.
 *
 * Fast-path: `$CYBER_MUX` (tmux | rmux | herdr | wezterm | zellij | cmux | otty | screen | none) is
 * trusted outright — this also serves as an OVERRIDE (`=none` forces no-mux even inside a real
 * multiplexer).
 * `$CYBER_MUX_PANE` carries the pane id alongside it. Detection RECOGNIZES `screen` (so an override
 * pinning it, or a real screen ancestor, is reported truthfully rather than silently ignored), but
 * `screen` is not a drivable backend — `resolveMuxAdapter` rejects it with a reason. Recognition is
 * not support.
 *
 * Discovery (else): walk the process ancestry from `$$` via `ps -o ppid=,comm= -p <pid>`, since the
 * tool's own shell may not be the human's pane. `$RMUX`/`$TMUX`/`$HERDR_ENV` are NOT trusted alone —
 * they are used only as a fast-positive hint the ancestry walk falls back to when the walk itself is
 * inconclusive (e.g. `ps` unavailable), never as a substitute for it.
 */
export function probeMultiplexer(exec: Exec, env: NodeJS.ProcessEnv, opts: ProbeOptions = {}): MuxProbe {
	// A host with its own namespace ADOPTS the fast-path by passing its prefix — `<prefix>` names the
	// mux and `<prefix>_PANE` the pane — rather than forking the probe. Defaults to `CYBER_MUX`, so an
	// unset `envPrefix` is exactly today's behavior. NOT an alias list: one prefix per call, the host's.
	const prefix = opts.envPrefix ?? 'CYBER_MUX'
	const override = env[prefix]
	const pane = env[`${prefix}_PANE`]
	if (isKnownMux(override)) {
		return {
			mux: override,
			...(pane ? { pane } : {}),
			via: 'env',
		}
	}
	if (opts.discover === false) return { mux: 'none', via: 'ancestry' }
	return discoverByAncestry(exec, env)
}

const MUX_COMM: readonly { re: RegExp; mux: Mux }[] = [
	{ re: /^tmux(:|$)/, mux: 'tmux' },
	// rmux parents its panes from a long-lived `rmux-daemon` process, NOT from a process named `rmux`
	// — verified live on 0.10.0 by walking `ps -o ppid=,comm=` from a shell inside a pane, which
	// climbed `sh → zsh → rmux-daemon`. The bare `rmux` alternative is kept because the client
	// binary is named that and a future layout could parent through it; matching only `rmux-daemon`
	// would make this walk depend on an implementation detail of one release.
	//
	// No conflict with the `tmux` row above despite rmux shipping a PATH shim literally named `tmux`
	// (`$TMUX_PROGRAM` points at it): the shim execs into rmux, so what `ps` reports for the process
	// is `rmux-daemon`, not `tmux`. Both regexes are `^`-anchored, so neither can match the other's
	// name in any case.
	{ re: /^rmux(-daemon|-server)?(:|$)/, mux: 'rmux' },
	{ re: /^herdr(:|$)/, mux: 'herdr' },
	// Unverified against a live WezTerm (no GUI in this sandbox) — its GUI process is commonly
	// `wezterm-gui`, and a headless mux server `wezterm-mux-server`; both are matched so the walk
	// does not miss the one form because the other happened to be named differently.
	{ re: /^wezterm(-gui|-mux-server)?(:|$)/, mux: 'wezterm' },
	// Zellij's server process is `zellij` (it runs a client and a server, both named `zellij`).
	{ re: /^zellij(:|$)/, mux: 'zellij' },
	{ re: /^screen(:|$)/, mux: 'screen' },
]

/** The per-pane env var for a mux, via the shared `PANE_ENV` table; undefined for screen/none. */
function paneFor(mux: Mux, env: NodeJS.ProcessEnv): string | undefined {
	return mux === 'tmux' || mux === 'rmux' || mux === 'herdr' || mux === 'wezterm' || mux === 'zellij' || mux === 'cmux'
		? PANE_ENV[mux](env)
		: undefined
}

/**
 * An ancestry-discovered probe, OMITTING `pane` when the mux carries none — never carrying it as an
 * explicit `undefined`, so `MuxProbe.pane` stays an absent-or-present field (the same conditional
 * shape the `$CYBER_MUX_PANE` fast-path uses above).
 */
function ancestryProbe(mux: Mux, env: NodeJS.ProcessEnv): MuxProbe {
	const pane = paneFor(mux, env)
	return { mux, ...(pane !== undefined ? { pane } : {}), via: 'ancestry' }
}

const MAX_ANCESTORS = 32

function walkAncestry(exec: Exec, env: NodeJS.ProcessEnv): MuxProbe | undefined {
	let pid = process.pid
	const seen = new Set<number>()
	for (let i = 0; i < MAX_ANCESTORS; i++) {
		if (seen.has(pid)) break
		seen.add(pid)
		const line = exec('ps', ['-o', 'ppid=,comm=', '-p', String(pid)])
		if (!line) break
		const trimmed = line.trim()
		const spaceIdx = trimmed.indexOf(' ')
		const ppidStr = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
		const comm = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()
		const ppid = Number.parseInt(ppidStr, 10)
		for (const entry of MUX_COMM) {
			if (entry.re.test(comm)) return ancestryProbe(entry.mux, env)
		}
		if (!Number.isFinite(ppid) || ppid <= 1) break
		pid = ppid
	}
	return undefined
}

function discoverByAncestry(exec: Exec, env: NodeJS.ProcessEnv): MuxProbe {
	const found = walkAncestry(exec, env)
	if (found) return found
	// Ancestry walk was inconclusive (no ps, or no mux ancestor found) — fall back to the
	// fast-positive env hint rather than declaring 'none' outright. WezTerm has no separate
	// "inside wezterm" flag the way $TMUX/$HERDR_ENV are — $WEZTERM_PANE IS the hint, doubling as
	// both the fast-positive signal and the pane id. Zellij DOES have a dedicated flag: $ZELLIJ is
	// set inside any Zellij pane (its pane id rides separately in $ZELLIJ_PANE_ID, attached by
	// `ancestryProbe`), so it plays the same role as $TMUX/$HERDR_ENV. cmux has $CMUX_WORKSPACE_ID
	// as its dedicated flag (its surface id rides separately in $CMUX_SURFACE_ID). otty has no
	// dedicated "inside otty" flag — $OTTY_PANE_ID IS the hint, same as WezTerm. rmux has $RMUX, its
	// own exact analogue of $TMUX (same `<socket>,<pid>,<session>` triple), with its pane riding
	// separately in $RMUX_PANE.
	//
	// **$RMUX is tested BEFORE $TMUX, and that order is the whole correctness of this fallback.** An
	// rmux pane sets BOTH (verified live on 0.10.0 — see `PANE_ENV`), so `$TMUX` is a true positive
	// for "some tmux-language multiplexer" and NOT evidence of tmux itself. Asking tmux first would
	// resolve every rmux session to the tmux adapter, which would then shell out to a `tmux` binary
	// that is either absent or — worse, since rmux puts a `tmux` shim on $PATH — is rmux wearing
	// tmux's name, making the misdetection invisible. The reverse mistake is not reachable: tmux does
	// not set $RMUX.
	if (env['RMUX']) return ancestryProbe('rmux', env)
	if (env['TMUX']) return ancestryProbe('tmux', env)
	if (env['HERDR_ENV']) return ancestryProbe('herdr', env)
	if (env['WEZTERM_PANE']) return ancestryProbe('wezterm', env)
	if (env['ZELLIJ']) return ancestryProbe('zellij', env)
	if (env['CMUX_WORKSPACE_ID']) return ancestryProbe('cmux', env)
	if (env['OTTY_PANE_ID']) return ancestryProbe('otty', env)
	return { mux: 'none', via: 'ancestry' }
}
