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
