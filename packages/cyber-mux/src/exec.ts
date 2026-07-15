import { execFileSync } from 'node:child_process'

/**
 * The synchronous command-runner seam every adapter takes: runs a command, returns trimmed stdout,
 * or `null` on any failure. Injecting it keeps the adapters pure and lets tests drive them with a
 * fake — no real multiplexer needed.
 */
export type Exec = (cmd: string, args: string[]) => string | null

export const realExec: Exec = (cmd, args) => {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	} catch {
		return null
	}
}
