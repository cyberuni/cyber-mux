import { defineConfig } from 'vitest/config'

// The default suite: fast, deterministic, no real multiplexer required — every Exec is a stub.
// Real-boundary tests (*.integration.test.ts) are opt-in only, via `pnpm test:integration`.
export default defineConfig({
	test: {
		// `scripts/` holds the unshipped maintainer tooling (the per-adapter conformance runner); its
		// decision core is unit-tested here with injected deps, so no multiplexer is needed.
		include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
		// `*.integration.test.ts` needs a real multiplexer; `*.dist.test.ts` needs a built package. Both
		// are opt-in (`test:integration` / `test:dist`), never part of the fast, source-only suite.
		exclude: ['**/*.integration.test.ts', 'src/**/*.dist.test.ts'],
	},
})
