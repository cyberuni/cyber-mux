# design — cyber-mux rules & models

The rules/model home for `cyber-mux`: cross-cutting shapes that no single capability owns, and the
decisions log.

- [`decisions/`](./decisions/README.md) — the ADR log (append-only, descriptive, ungated).

Backfilled narrow: only entries touched by the `send-submit-realign` change are captured; expand by
demand.

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
