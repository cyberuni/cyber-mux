import { describe, expect, it } from 'vitest'
import { launchFallback } from './env-fallback.ts'

describe('launchFallback', () => {
	// The whole reason this rule lives in one module: the env prefix belongs INSIDE the `cd`'s `&&`.
	// `env K=V cd '/x' && cmd` sets the variables on `cd` and leaves `cmd` without them, and it fails
	// SILENTLY — the command still runs, just unenvironed. A second hand-written copy is exactly where
	// that ordering gets flipped, so it is pinned here rather than only at the two call sites.
	it('puts the env prefix inside the cd, never outside it', () => {
		const result = launchFallback({ TOKEN: 'abc' }, 'run me', '/unit')
		expect(result).toEqual({ kind: 'carried', command: `cd '/unit' && env TOKEN='abc' run me` })
	})

	// Unlike env, a `cd` needs no command to ride: a route with a cwd and no launch still lands in the
	// right directory, because the `cd` is sent alone.
	it('sends the cd alone when there is no launch command', () => {
		expect(launchFallback(undefined, undefined, '/unit')).toEqual({ kind: 'carried', command: `cd '/unit'` })
	})

	// A directory is user data on a shell command line: a space would split it into two words and a
	// quote would unbalance the line outright.
	it('shell-quotes a cwd carrying a space or a quote', () => {
		expect(launchFallback(undefined, undefined, "/tmp/my dir/it's")).toEqual({
			kind: 'carried',
			command: `cd '/tmp/my dir/it'\\''s'`,
		})
	})

	// env asked for with no command to ride is genuinely lost and the caller must warn naming the
	// variables — but losing env is no reason to also lose the directory, so the `cd` still comes back.
	it('reports dropped env while still carrying the cd', () => {
		expect(launchFallback({ TOKEN: 'abc' }, undefined, '/unit')).toEqual({
			kind: 'dropped',
			variables: ['TOKEN'],
			command: `cd '/unit'`,
		})
	})

	it('reports dropped env with no command at all when there is no cwd either', () => {
		expect(launchFallback({ TOKEN: 'abc' }, undefined, undefined)).toEqual({
			kind: 'dropped',
			variables: ['TOKEN'],
			command: undefined,
		})
	})

	// A route that carried both natively can call this unconditionally and get its launch back
	// untouched — no `cd` it does not need, no prefix over an env the backend already set.
	it('returns the launch command unchanged when nothing was lost', () => {
		expect(launchFallback(undefined, 'run me', undefined)).toEqual({ kind: 'carried', command: 'run me' })
		expect(launchFallback({}, 'run me', undefined)).toEqual({ kind: 'carried', command: 'run me' })
		expect(launchFallback(undefined, undefined, undefined)).toEqual({ kind: 'carried', command: undefined })
	})

	// `MuxOpenOptions.cwd` is a required string, so a caller with no directory to name passes the empty
	// one. `cd ''` is not what that means.
	it('treats an empty cwd as none', () => {
		expect(launchFallback(undefined, 'run me', '')).toEqual({ kind: 'carried', command: 'run me' })
	})
})
