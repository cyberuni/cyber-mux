import { defineConfig } from 'tsdown'

export default defineConfig({
	// Four entries: the CLI bin, the library barrel (`.`), and the two subpath surfaces. Each emits a
	// `.mjs` plus a `.d.ts` (dts: true). The CLI stays a separate entry so importing the library never
	// pulls the commander/`console.log`/`process.exit` machinery.
	entry: {
		cli: 'src/cli.ts',
		index: 'src/index.ts',
		worktree: 'src/worktree.ts',
		template: 'src/template.ts',
	},
	outDir: 'dist',
	format: 'esm',
	platform: 'node',
	clean: true,
	// Declaration maps point the bundled `.d.mts` back at `src/*.ts`, so a consumer's go-to-definition
	// lands in real source — which is why `src` (minus tests) ships in `package.json#files`.
	dts: { sourcemap: true },
})
