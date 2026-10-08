#!/usr/bin/env node

// Rewrites the `cyber-mux@<version>` npx pins in the plugin's skills to the package version.
// `universal-plugin publish sync-version` syncs the manifests but not these pins, so the release
// `version` script runs this after it.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = fileURLToPath(new URL('../packages/cyber-mux/', import.meta.url))
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const skillsDir = join(pkgDir, 'skills')

for (const name of readdirSync(skillsDir)) {
	const file = join(skillsDir, name, 'SKILL.md')
	let text
	try {
		text = readFileSync(file, 'utf8')
	} catch {
		continue
	}
	const next = text.replace(/\bcyber-mux@\d+\.\d+\.\d+(?:-[\w.]+)?/g, `cyber-mux@${version}`)
	if (next !== text) writeFileSync(file, next)
}
