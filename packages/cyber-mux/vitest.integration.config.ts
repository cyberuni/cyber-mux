import { defineConfig } from 'vitest/config'

// The real-boundary suite: drives the actual tmux, herdr, wezterm, and zellij binaries against a
// throwaway, isolated server (never the ambient session). Each file skips itself when its binary
// isn't installed. Opt-in only — never part of `pnpm test` / `turbo test` / `pnpm verify` — via
// `pnpm test:integration`.
export default defineConfig({
	test: {
		// `scripts/` carries the conformance runner's own real-boundary suite (`--all`, driven as a
		// real subprocess against this machine's actual multiplexers).
		include: ['src/**/*.integration.test.ts', 'scripts/**/*.integration.test.ts'],

		// Vitest's defaults (5s test, 10s hook) are budgets for tests that do not wait on a separate
		// process coming up, and every wait in this suite is bounded ALREADY — by its own poll loop, so
		// a hang still fails rather than running forever. Left on the defaults, those two ceilings
		// collide: zellij's `beforeAll` spends 100 x 100ms waiting for its client to register, which is
		// the entire 10s hook budget before `zellij attach` or any post-loop work is counted, and
		// wezterm's spends 60 x 100ms plus a `wezterm cli list` per iteration. The hook then dies on the
		// harness clock rather than on its own — a green suite on a fast runner and a red one on a slow
		// runner, from identical code. The same collision sits at test level, where `pollUntil` defaults
		// to 5000ms against a 5000ms default and polls a real binary every 50ms on top.
		//
		// So give both clocks room to sit ABOVE the suite's own ceilings. These are backstops against a
		// wedged binary, not the thing that decides a pass — the poll loops still own that.
		hookTimeout: 60_000,
		testTimeout: 30_000,
	},
})
