---
cr: 10-split-options-contract
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/10
status: done
todos:
  - content: Repair the unparseable Examples table in mux.feature — blocking prerequisite
    status: completed
  - content: Author mux/ split-options section — README use cases + 11 scenarios in mux.feature
    status: completed
  - content: Move the seam-convention scenarios out of layout.feature; repoint layout/README
    status: completed
  - content: Spec gate — check-suite, cold spec-judge, freeze, self-assert within leash
    status: completed
  - content: Bind the new scenarios — rename adapter test leaf titles to scenario names
    status: completed
  - content: Add the one missing test — ratio suppressed for tab/workspace on tmux
    status: completed
  - content: Fix the stale env tier-scope comment in session.ts
    status: completed
  - content: Impl gate — cold impl-judge over the frozen scenarios
    status: completed
  - content: Handoff — PR closing #10, follow-ups; no changeset (nothing user-facing)
    status: completed
---

# CR 10 — the pane layer's split-options contract

Fold the split-with-options contract (`from`, `ratio`, `env`) back to the node that owns the seam.
Source: issue #10. Design: [`10-split-options-contract.design.md`](./10-split-options-contract.design.md)
(in-repo, tracked).

## Scope (decided at intake, requester-ratified)

- **Spec-only.** No behavior change, no new CLI flags, no changeset. `--ratio`/`--env` on `open`
  would be new user-facing surface and is beyond the issue.
- **A move, not a duplicate.** `mux/` becomes the sole owner of the seam conventions; the moved
  scenarios leave `layout.feature`. This narrows a frozen suite — **Clearance pre-authorized in this
  CR**. Total project contract is unchanged; every assertion lands in `mux.feature`.
- **`describeRegion` is out.** It is the other seam member specified through layout, but #10 names
  only the three split fields.
- **The out-of-range ratio is not specified** — prose boundary + follow-up, never a frozen scenario.

## Carried in as blockers, not scope creep

- `mux.feature` **has never parsed** (a 2-column `Examples:` table with two 1-cell rows). The spec
  gate runs `check-suite` fail-closed over touched suites, so this CR cannot gate without the repair.
  Widens, narrows nothing → freeze self-clears.
- The `env` doc comment in `session.ts` says env is `pane:*`-only; the code sets it at every tier and
  the tests pin that. Corrected here rather than shipped alongside a contract that contradicts it.

## Verification

- `check-suite --files <both .feature>` — self-run before the cold judge.
- `gherkin-cli diff --base origin/main` per suite — `mux.feature` must read `addOnly`;
  `layout.feature` will show `removed` (the pre-authorized Clearance edit).
- `verify-scenarios --node cyber-mux/mux` — every scenario this CR adds must BIND and PASS.
- `pnpm verify` — build + typecheck + lint + test + biome.
- The new tab/workspace-ratio test must be seen to fail against a mutated guard, so it is not a
  scenario nothing can lose.

## NEXT

Both gates passed and self-asserted; the branch is ready to push and open as a PR closing #10.
Nothing is in flight. Remaining, and neither blocks the CR:

1. **Drain the follow-ups** — five are recorded in the ledger shard and none matches an existing
   issue (deduped against the forge, open and closed). Filing is permission-gated and was not
   granted in-session, so they are recorded and NOT filed. Re-derive what is outstanding by the
   same dedupe before filing; the records carry no filed-state.
2. **Retire this plan** once the PR merges and the CR is doctrine-distilled.
