import { defineConfig } from 'vitest/config'

// The real-boundary suite: drives the actual tmux binary against a throwaway, isolated server
// (never the ambient session). Skipped internally when tmux isn't installed. Opt-in only — never
// part of `pnpm test` / `turbo test` / `pnpm verify` — via `pnpm test:integration`.
export default defineConfig({
	test: {
		// `scripts/` carries the conformance runner's own real-boundary suite (`--all`, driven as a
		// real subprocess against this machine's actual multiplexers).
		include: ['src/**/*.integration.test.ts', 'scripts/**/*.integration.test.ts'],
	},
})
