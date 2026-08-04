#!/usr/bin/env node

// Publishes only what is genuinely unpublished, then delegates the real publish to
// `changeset publish`.
//
// The shared release workflow runs this on EVERY push to main, including pushes with no changeset.
// On those, `changesets/action` falls through to "publish any unpublished packages" and runs the
// publish script directly. Left as a bare `changeset publish`, that re-attempts the already-live
// version: npm rejects it with an E403 ("cannot publish over the previously published version"),
// and `@changesets/cli` (through at least 2.31.1) crashes reading `.includes` on that error's
// absent `summary` field instead of skipping — turning every no-changeset push red while nothing
// is actually wrong.
//
// So gate the publish on a direct registry check. If every publishable package's local version is
// already on npm, exit 0 without invoking changesets (no crash). If any version is genuinely new,
// delegate to `changeset publish` unchanged — it still owns provenance, OIDC, dist-tags, and git
// tags, and a real publish failure there still propagates a non-zero exit.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// Mirror pnpm-workspace.yaml's globs. A package is publishable when it is not `private` — the same
// bar npm and changesets apply — which already excludes the ignored `website` app.
function publishablePackages() {
	const found = []
	for (const workspace of ['packages', 'apps']) {
		const dir = join(root, workspace)
		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const manifest = join(dir, entry.name, 'package.json')
			let pkg
			try {
				pkg = JSON.parse(readFileSync(manifest, 'utf8'))
			} catch {
				continue
			}
			if (pkg.private || !pkg.name || !pkg.version) continue
			found.push({ name: pkg.name, version: pkg.version })
		}
	}
	return found
}

// `npm view <name>@<version> version` prints the version when it exists and exits non-zero (E404)
// when it does not — the authoritative "is this exact version already published?" check.
function isPublished({ name, version }) {
	try {
		const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		return out.trim() === version
	} catch {
		return false
	}
}

const packages = publishablePackages()
const unpublished = packages.filter((pkg) => !isPublished(pkg))

if (unpublished.length === 0) {
	const names = packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
	console.log(`Nothing to publish — already on npm: ${names || '(no publishable packages)'}`)
	process.exit(0)
}

console.log(`Publishing: ${unpublished.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`)
execFileSync('pnpm', ['exec', 'changeset', 'publish'], { stdio: 'inherit' })
