import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The synchronous twin of the library's `normalizeWorktreePath`, for the one caller that cannot await:
 * a multiplexer adapter keying its worktree bindings inside the synchronous `Exec` convention. Both
 * resolve through the native `realpath`, so a binding keyed here matches a root the library listed.
 * Falls back to `resolve` for a path not on disk, where there is no link to follow.
 */
export function normalizeWorktreePathSync(path: string): string {
	try {
		return realpathSync.native(path)
	} catch {
		return resolve(path)
	}
}
