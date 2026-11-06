// The release commits the Version Packages PR through the GitHub API, which cannot carry the
// executable bit: one tracked executable under `packages/` fails the release before it opens the PR.
// Scripts the setup-tmux skill installs are made executable at install time instead.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))

function gitRoot(): string | undefined {
	try {
		return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: pkgDir, encoding: 'utf8' }).trim()
	} catch {
		return undefined
	}
}

const root = gitRoot()

describe.skipIf(!root)('tracked file modes', () => {
	it('commits no executable file under packages/', () => {
		const entries = execFileSync('git', ['ls-files', '-s', '--', 'packages'], { cwd: root, encoding: 'utf8' })
		const executables = entries
			.split('\n')
			.filter((line) => line.startsWith('100755 '))
			.map((line) => line.split('\t')[1])
		expect(executables).toEqual([])
	})
})
