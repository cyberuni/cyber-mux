import { InvalidArgumentError, Option } from 'commander'

/** Output format shared by every command: `text` (human), `json`, or `agent`. */
export const FORMAT_OPTION = new Option('--format <format>', 'Output format').choices(['text', 'json', 'agent'])

/**
 * Accumulate one `--env KEY=VALUE` into the running map. Repeatable: commander calls this once per
 * flag, threading the previous map through, so `--env A=1 --env B=2` collects both. Rejecting a
 * malformed pair from HERE — the parser, before the action runs — is what makes "rejected before any
 * side effect" hold on every verb, worktree-creating ones included. The KEY is everything before the
 * first `=`, the VALUE everything after it: a value may contain `=` (a URL query, a base64 pad) and a
 * KEY may not, so the first `=` is the only unambiguous split. A missing `=` is malformed; a present
 * `=` with nothing after it is a deliberate empty value, not an error.
 */
function collectEnv(pair: string, previous: Record<string, string> = {}): Record<string, string> {
	const eq = pair.indexOf('=')
	if (eq <= 0) throw new InvalidArgumentError(`expected KEY=VALUE, got "${pair}"`)
	return { ...previous, [pair.slice(0, eq)]: pair.slice(eq + 1) }
}

/**
 * `--env KEY=VALUE`, repeatable — the CLI door to the seam's env option, on every verb that opens a
 * pane. One shared Option so the collector, the split rule, and the rejection are defined once and
 * every verb inherits them, the way `AT_OPTION`/`LABEL_OPTION` are shared. Conflicts with `--template`,
 * whose template owns its own panes' env; the two verbs that carry `--template` refuse the pair.
 */
export const ENV_OPTION = new Option('--env <pair>', 'Environment variable KEY=VALUE (repeatable)')
	.argParser(collectEnv)
	.conflicts('template')

/** Placement for a newly opened pane, matching `MuxPlacement`. */
export const AT_OPTION = new Option('--at <placement>', 'Where to place the new pane').choices([
	'pane:right',
	'pane:down',
	'tab',
	'workspace',
])

/**
 * Name for whatever `--at` opens. Host-neutral because every backend names every tier: on herdr a
 * workspace/tab/pane label, on tmux a window name (where `workspace` and `tab` both collapse to a
 * Window) or a pane title.
 */
export const LABEL_OPTION = new Option('--label <label>', 'Name for the opened workspace/tab/pane')
