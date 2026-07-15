import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: { cli: 'src/cli.ts' },
	outDir: 'dist',
	format: 'esm',
	platform: 'node',
	clean: true,
})
