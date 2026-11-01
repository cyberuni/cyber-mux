import { defineConfig } from 'tsdown'

const shared = {
	outDir: 'dist',
	format: 'esm',
	platform: 'node',
} as const

export default defineConfig([
	{
		// The library: the barrel (`.`), the three subpath surfaces, and the clibuilder `mux` plugin. Each
		// emits a `.mjs` plus a `.d.mts`. Dependencies stay external: `cyber-agentkit` is a runtime
		// dependency of `./worktree`, and `clibuilder` is an optional peer that only `./plugin` uses, so the
		// plugin's verbs mount into the host CLI's own clibuilder. Importing the library never pulls the
		// clibuilder/`console.log`/`process.exit` machinery.
		...shared,
		entry: {
			index: 'src/index.ts',
			worktree: 'src/worktree.ts',
			template: 'src/template.ts',
			agent: 'src/agent.ts',
			plugin: 'src/plugin.ts',
		},
		clean: true,
		// Declaration maps point the bundled `.d.mts` back at `src/*.ts`, so a consumer's go-to-definition
		// lands in real source — which is why `src` (minus tests) ships in `package.json#files`.
		dts: { sourcemap: true },
	},
	{
		// The bin's entry. An installed agent plugin directory is a copy of the package with no
		// `node_modules`, so the CLI inlines every runtime dependency into one file. Nothing imports it,
		// so it ships no declarations.
		...shared,
		entry: { cli: 'src/cli.ts' },
		dts: false,
		deps: { alwaysBundle: [/.*/], onlyBundle: false },
		outputOptions: { codeSplitting: false },
	},
])
