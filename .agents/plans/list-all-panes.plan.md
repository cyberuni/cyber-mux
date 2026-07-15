---
todos:
  - content: Add mux.feature scenarios documenting list enumerates every live pane
    status: completed
  - content: Fix herdr listPanes to stop dropping agent-less panes
    status: completed
  - content: Update/add tests, run pnpm verify
    status: completed
  - content: Changeset + commit
    status: completed
---

# list shows all panes, not just agent-bearing ones

CR: `cyber-mux list` is documented (`SessionAdapter.listPanes` doc, `cli.ts`'s `list` description) as
"enumerate every live pane the current backend can see." tmux already honors this (`list-panes -a`,
no filter). herdr does not: `session.herdr.ts`'s `listPanes()` drops any pane whose `agent` field is
empty (`session.herdr.test.ts:256`, "dropping scaffold panes with none") — so a plain tab, an extra
split, or a blank pane opened via `open` with no `--launch` (this session's prior change) never
shows up in `list` on herdr.

Target: `cyber-mux/mux` (`packages/cyber-mux`).

Note: project spec is `status: draft`, no `@frozen` scenarios in `mux.feature` yet — plain additive
edit, no freeze re-open applies.

Plan: stop filtering on `agent !== ''` in `session.herdr.ts`'s `listPanes` — keep only the
`pane_id`-present guard. `harness` stays `undefined` (already optional in `LivePane`) for a pane
with no agent, so shape stays consistent. Add a `mux.feature` scenario for `list` (currently
uncovered) documenting it enumerates every live pane regardless of whether an agent is running in
it. Rename/update the existing herdr test that asserted the drop.

## NEXT
Done. `pnpm verify` green; new scenario `list enumerates every live pane, including one running no
agent/harness` BOUND via its matching CLI-level test title. Changeset added (`list-all-panes.md`,
patch — restores the documented "every live pane" contract). No follow-up.
