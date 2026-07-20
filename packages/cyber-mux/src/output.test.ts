import { describe, expect, it } from 'vitest'
import { tildify } from './output.ts'

describe('tildify', () => {
	it('collapses the home prefix so a table spends no width on it', () => {
		expect(tildify('/home/ann/code/app', '/home/ann')).toBe('~/code/app')
	})

	it('collapses the home directory itself', () => {
		expect(tildify('/home/ann', '/home/ann')).toBe('~')
	})

	it('leaves a path that merely STARTS with the same string alone', () => {
		// `/home/annex` is not under `/home/ann` — the match is on a path boundary, not a prefix.
		expect(tildify('/home/annex/code', '/home/ann')).toBe('/home/annex/code')
	})

	it('leaves a path outside home alone', () => {
		expect(tildify('/srv/repo', '/home/ann')).toBe('/srv/repo')
	})

	it('collapses nothing when home is the root, which would swallow every absolute path', () => {
		expect(tildify('/srv/repo', '/')).toBe('/srv/repo')
	})
})
