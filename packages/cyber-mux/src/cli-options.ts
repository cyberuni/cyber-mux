import { Option } from 'commander'

/** Output format shared by every command: `text` (human), `json`, or `agent`. */
export const FORMAT_OPTION = new Option('--format <format>', 'Output format').choices(['text', 'json', 'agent'])

/** Placement for a newly opened pane, matching `SessionPlacement`. */
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
