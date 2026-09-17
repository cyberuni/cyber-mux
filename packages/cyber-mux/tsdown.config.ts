import { defineConfig } from 'tsdown'

export default defineConfig({
	// Six entries: the CLI bin, the library barrel (`.`), the three subpath surfaces, and the clibuilder
	// `mux` plugin. Each emits a `.mjs` plus a `.d.ts` (dts: true). The CLI and the plugin stay separate
	// entries so importing the library never pulls the clibuilder/`console.log`/`process.exit` machinery.
	entry: {
		cli: 'src/cli.ts',
		index: 'src/index.ts',
		worktree: 'src/worktree.ts',
		template: 'src/template.ts',
		agent: 'src/agent.ts',
		plugin: 'src/plugin.ts',
	},
	outDir: 'dist',
	format: 'esm',
	platform: 'node',
	clean: true,
	// Declaration maps point the bundled `.d.mts` back at `src/*.ts`, so a consumer's go-to-definition
	// lands in real source — which is why `src` (minus tests) ships in `package.json#files`.
	dts: { sourcemap: true },
})
