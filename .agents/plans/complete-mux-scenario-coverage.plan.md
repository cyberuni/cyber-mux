---
todos:
  - content: Add CLI-level tests closing the 4 UNBOUND mux.feature scenarios
    status: completed
  - content: Verify all 22 scenarios BOUND+PASS via the SDD scenario bridge
    status: completed
  - content: Commit
    status: pending
---

# Complete mux.feature scenario coverage

CR: close the remaining 4 UNBOUND scenarios in `packages/cyber-mux/.agents/spec/mux/mux.feature`
after wiring the scenario bridge (see prior commits `32cbed0`/`dbf22e9`/`c55fa40`). No spec/suite
content changes — these 4 scenarios already exist verbatim; only test coverage is missing.

Target: `cyber-mux/mux` (`packages/cyber-mux`).

Remaining UNBOUND scenarios (from `verify-scenarios --config packages/cyber-mux/.agents/sdd/scenario-bridge.toml`):
- `--at chooses where the new pane opens`
- `--at workspace opens the pane's own VISIBLE space on each backend` (Outline: tmux, herdr)
- `--at tab opens a new tab in the current window, never a split pane` (Outline: tmux, herdr)
- `the tab placement opens in the background without stealing focus`

Plan: add CLI-level tests to `packages/cyber-mux/src/cli.test.ts` driving `buildProgram()`'s `open`
command with a fake `Exec` (same stub pattern as the rest of the suite) — these are the only
scenarios not already covered at the adapter level, since they describe the CLI's `--at` routing
itself, not adapter internals.

## NEXT
Write the tests, run `pnpm test`, re-run `verify-scenarios`, confirm 22/22 BOUND+PASS, commit.
