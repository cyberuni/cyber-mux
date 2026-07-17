#!/usr/bin/env node

// Parses every .feature so a malformed suite fails `verify` on the day it lands.
// The suites are prose contracts read by agents, not by a runner, so nothing else would notice.
//
// Walked by hand rather than globbed: the suites live under a dotted `.agents/` directory, which
// `**` skips silently, and a check that finds nothing must never render the same as one that
// passed — that is the failure this check exists to prevent, so finding zero files is an error.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin'
import { IdGenerator } from '@cucumber/messages'

const root = fileURLToPath(new URL('..', import.meta.url))
const PRUNED = new Set(['node_modules', 'dist', '.git', '.turbo'])

function findFeatures(dir) {
	const found = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!PRUNED.has(entry.name)) found.push(...findFeatures(join(dir, entry.name)))
		} else if (entry.isFile() && entry.name.endsWith('.feature')) {
			found.push(join(dir, entry.name))
		}
	}
	return found
}

const files = findFeatures(root)
	.map((file) => relative(root, file).split(sep).join('/'))
	.sort()

if (files.length === 0) {
	console.error('check:features found no .feature files — the check is not looking where the suites are')
	process.exit(1)
}

const newId = IdGenerator.uuid()
const failures = []

for (const file of files) {
	const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher())
	try {
		parser.parse(readFileSync(join(root, file), 'utf8'))
	} catch (error) {
		failures.push({ file, message: error.message })
	}
}

for (const { file, message } of failures) {
	console.error(`✗ ${file}\n${message}\n`)
}

if (failures.length > 0) {
	console.error(`check:features — ${failures.length} of ${files.length} .feature files failed to parse`)
	process.exit(1)
}

console.log(`check:features — ${files.length} .feature files parse`)
