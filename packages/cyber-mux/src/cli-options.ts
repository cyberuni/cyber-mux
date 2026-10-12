import { type Descriptor, t } from 'clibuilder'
import { CliError } from './cli-error.ts'

type MuxPlacementName = 'pane:right' | 'pane:down' | 'pane:float' | 'tab' | 'workspace'

/**
 * `--env KEY=VALUE`, repeatable — the CLI door to the seam's env option, on every verb that opens a
 * pane. One shared option so the split rule and the rejection are defined once and every verb inherits
 * them, the way `AT_OPTION`/`LABEL_OPTION` are shared. Conflicts with `--template`, whose template owns
 * its own panes' env; the two verbs that carry `--template` refuse the pair.
 *
 * The parser only collects the raw pairs: a refined element type would stop clibuilder from reading the
 * option as a string array. Each verb runs `parseEnv` FIRST, before any side effect, which is what keeps
 * "rejected before anything runs" true on every verb, worktree-creating ones included.
 */
export const ENV_OPTION: { description: string; type: Descriptor<string[] | undefined, true>; conflicts: string[] } = {
	description: 'Environment variable KEY=VALUE (repeatable)',
	type: t.array(t.string()).optional(),
	conflicts: ['template'],
}

/**
 * Fold the collected `--env` pairs into one map. The KEY is everything before the first `=`, the VALUE
 * everything after it: a value may contain `=` (a URL query, a base64 pad) and a KEY may not, so the
 * first `=` is the only unambiguous split. A missing `=` (or an empty KEY) is malformed — a usage error,
 * exit 2; a present `=` with nothing after it is a deliberate empty value, not an error.
 */
export function parseEnv(pairs: string[] | undefined): Record<string, string> | undefined {
	if (!pairs) return undefined
	const env: Record<string, string> = {}
	for (const pair of pairs) {
		const eq = pair.indexOf('=')
		if (eq <= 0) {
			throw new CliError(
				'invalid-value',
				`--env expects KEY=VALUE, got "${pair}"`,
				'pass each variable as --env KEY=VALUE',
				2,
			)
		}
		env[pair.slice(0, eq)] = pair.slice(eq + 1)
	}
	return env
}

/**
 * Placement for a newly opened pane, matching `MuxPlacement`.
 *
 * `pane:float` is the one choice that is not universal: tmux (≥ 3.7) and zellij open a real floating
 * pane, wezterm and herdr refuse it (`backend-unsupported`, exit 1). It is still an enum member on
 * every backend — the value is VALID input everywhere, and which backend can realize it is a runtime
 * answer, not a parse-time one. Gating the choice list on the detected backend would make `--help` say
 * different things in different panes and turn a truthful refusal into a usage error.
 */
export const AT_OPTION: { description: string; type: Descriptor<MuxPlacementName | undefined, true> } = {
	description: 'Where to place the new pane',
	type: t.enum(['pane:right', 'pane:down', 'pane:float', 'tab', 'workspace']).optional(),
}

/**
 * Name for whatever `--at` opens. Host-neutral because every backend names every tier: on herdr a
 * workspace/tab/pane label, on tmux a window name (where `workspace` and `tab` both collapse to a
 * Window) or a pane title.
 */
export const LABEL_OPTION: { description: string; type: Descriptor<string | undefined, true> } = {
	description: 'Name for the opened workspace/tab/pane',
	type: t.string().optional(),
}
