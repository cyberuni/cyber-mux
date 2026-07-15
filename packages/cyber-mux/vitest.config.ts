import { defineConfig } from 'vitest/config'

// The default suite: fast, deterministic, no real multiplexer required — every Exec is a stub.
// Real-boundary tests (*.integration.test.ts) are opt-in only, via `pnpm test:integration`.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		exclude: ['src/**/*.integration.test.ts'],
	},
})
