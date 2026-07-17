import { execFileSync } from 'node:child_process'

/**
 * The synchronous command-runner seam every adapter takes: runs a command, returns trimmed stdout,
 * or `null` on any failure. Injecting it keeps the adapters pure and lets tests drive them with a
 * fake — no real multiplexer needed.
 */
export interface Exec {
	(cmd: string, args: string[]): string | null
	/**
	 * Why the MOST RECENT call returned `null` — the backend's own words, when the runner can supply
	 * them. A diagnostic, never a control-flow signal: `null` remains the one failure sentinel, so a
	 * runner that never sets this degrades to no reason at all and every call site is unchanged.
	 *
	 * Mutable state on a seam is a real cost, paid because `Exec` is **synchronous by construction**
	 * (`execFileSync`): "the most recent call" is unambiguous, and a throw site reads it on the line
	 * after the call that set it. A runner that sets it MUST also clear it on success — `exists` and
	 * the mux probe run commands that fail routinely, so a reason left lying around would be
	 * attributed to whatever failed next.
	 *
	 * The alternative was widening the return to a result object, which rewrites every call site and
	 * every fake for a diagnostic. Forwarding stderr to the terminal instead is not an option for the
	 * same routine-failure reason: it would spam every normal run.
	 */
	lastError?: string
}

export const realExec: Exec = (cmd, args) => {
	try {
		const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
		// Cleared on success, so a reason can never outlive the command that produced it.
		realExec.lastError = undefined
		return out
	} catch (err) {
		// Captured rather than inherited: routine failures would otherwise spam the caller's terminal.
		const stderr = (err as { stderr?: Buffer | string }).stderr
		realExec.lastError = String(stderr ?? '').trim() || undefined
		return null
	}
}

/**
 * A failure message carrying the runner's reason for it, when there is one. The backend's own words
 * verbatim — never a paraphrase, and never a guess: a refused split may be a region too small, or a
 * server that is simply gone, and only the backend knows which.
 */
export function withReason(exec: Exec, message: string): string {
	return exec.lastError ? `${message} — ${exec.lastError}` : message
}
