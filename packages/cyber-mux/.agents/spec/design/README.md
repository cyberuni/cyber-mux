# design — cyber-mux rules & models

The rules/model home for `cyber-mux`: cross-cutting shapes that no single capability owns, and the
decisions log.

- [`decisions/`](./decisions/README.md) — the ADR log (append-only, descriptive, ungated).

Backfilled narrow: only entries touched by the `send-submit-realign` change are captured; expand by
demand.

## Locality — the seam is local by construction, and staying that way is a decision

Every `MuxAdapter` member but `waitForOutput` is synchronous, because `Exec` is an `execFileSync`
wrapper; detection is local for a second reason, reading this process's own environment and ancestry.
Both are deliberate, and neither is a placeholder for a remote concept: a pane reference names a pane
on THIS machine, and no member takes, reports, or resolves a host.

Reaching a pane on another machine is therefore not a new adapter — it is a change to what the seam
is. The `153-remote-async` block in [`decisions/`](./decisions/README.md) settles the gating question
(a blocking `ssh` transport does NOT force async; the requirement that one unreachable machine not
block the others does), names the migration shape, and carries the recheck triggers. Until that
migration lands as its own major, adapter work stays synchronous on purpose — a partly async seam is
the one shape that cannot be codemodded.

## Test binding — the SDD scenario-bridge `@id:` convention

Every acceptance `Scenario:` in this corpus carries a stable **`@id:<slug>`** tag, and the test that
proves it binds to that slug, so the SDD impl-gate bridge (`verify-scenarios`) confirms
scenario→test coverage mechanically instead of re-deriving each scenario by hand. This is the SDD
convention — its full rules live in the external `verify-scenarios` skill; the standing local rule is:

- **Every `Scenario` / `Scenario Outline` carries one `@id:<slug>`** (a Gherkin tag above the
  scenario, the slot `@frozen` uses on the `Feature`). A Scenario Outline is one `@id:`.
- **The proving test binds by two facts:** it sits under a `describe('spec:cyber-mux/<node>', …)`
  wrapper whose node path **exactly** equals the scenario's node, and its leaf `it(...)` title is
  **exactly** the `@id:<slug>`. The bridge matches the **first** `spec:` segment in the describe
  chain, so a node wrapper must be **top-level**, never nested inside a coarser `spec:` wrapper.
- **New suites adopt this from the start**; slugs are kebab-case, `<subject>-<distinguisher>`, unique
  within a node (the key is node-path + slug, globally unique).

See [`decisions/`](./decisions/README.md) (the `83-adopt-scenario-bridge-binding` block) for the why
and the corpus-wide adoption record.
