import { defineConfig } from 'vitest/config'

// The published-surface suite: imports the package BY NAME (resolved through `exports` to `dist`), so
// it runs only against a fresh build. Wired into `verify` via the `test:dist` turbo task, which
// depends on `build`; also runnable standalone with `pnpm test:dist` after a build.
export default defineConfig({
	test: {
		include: ['src/**/*.dist.test.ts'],
	},
})
