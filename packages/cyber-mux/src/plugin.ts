import type { PluginActivationContext } from 'clibuilder'
import { MUX_DESCRIPTION, MUX_PLUGIN_COMMAND, muxCommands } from './cli.ts'

/**
 * The clibuilder plugin entry, published as `cyber-mux/plugin`: mounts every cyber-mux verb under
 * `mux` in the host CLI, so `<host> mux list` is `cyber-mux list`. A host loads it by listing
 * `cyber-mux/plugin` in its config's `plugins`.
 *
 * A subpath rather than the package root, so the library barrel (`cyber-mux`) never pulls in the CLI.
 * The verbs are the same list the standalone binary mounts. Their answers, errors and usage errors are
 * reported by the host's clibuilder, in the host's output mode and format.
 */
export function activate(ctx: PluginActivationContext): void {
	ctx.addCommand({
		name: MUX_PLUGIN_COMMAND,
		description: MUX_DESCRIPTION,
		commands: muxCommands(),
	})
}
