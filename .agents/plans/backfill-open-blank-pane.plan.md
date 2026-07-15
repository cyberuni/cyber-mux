---
todos:
  - content: Add a mux.feature scenario for open with no --launch (blank pane)
    status: completed
  - content: Verify the new scenario BOUND+PASS via the scenario bridge
    status: in_progress
  - content: Commit
    status: pending
---

# Backfill mux.feature: open with no --launch

CR: `packages/cyber-mux`'s `open --launch` flag was made optional in this session (implementation,
adapter changes, and unit tests already landed and `pnpm verify` green) — `open` with no `--launch`
now creates a blank pane and sends/runs nothing, on both the tmux and herdr adapters. This mission
backfills the frozen-shape spec suite so `mux.feature` matches shipped behavior; no further code
changes.

Target: `cyber-mux/mux` (`packages/cyber-mux`).

Note: the project spec (`packages/cyber-mux/.agents/spec/spec.md`) is `status: draft` and no
scenario in `mux.feature` carries `@frozen` yet, so this is a plain additive edit — no freeze
re-open applies.

Plan: add one `Scenario: open with no --launch creates a blank pane` to
`packages/cyber-mux/.agents/spec/mux/mux.feature`, worded to bind against the CLI-level test
`open with no --launch creates a blank pane` in `packages/cyber-mux/src/cli.test.ts` (same
title-match convention the scenario bridge already uses for `--at chooses where the new pane
opens`, etc.). Adapter-level unit tests in `session.tmux.test.ts` / `session.herdr.test.ts` cover
the same behavior per-backend but stay unbound, consistent with existing adapter-level coverage.

## NEXT
Run `pnpm verify` to confirm no regressions, spot-check the scenario bridge binds the new scenario,
then commit as `test(mux): backfill spec for optional open --launch`.
