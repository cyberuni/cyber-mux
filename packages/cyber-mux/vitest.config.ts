import { defineConfig } from 'vitest/config'

// The default suite: fast, deterministic, no real multiplexer required — every Exec is a stub.
// Real-boundary tests (*.integration.test.ts) are opt-in only, via `pnpm test:integration`.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		// `*.integration.test.ts` needs a real multiplexer; `*.dist.test.ts` needs a built package. Both
		// are opt-in (`test:integration` / `test:dist`), never part of the fast, source-only suite.
		exclude: ['src/**/*.integration.test.ts', 'src/**/*.dist.test.ts'],
	},
})
