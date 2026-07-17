---
cr: 36-axi-error-surface
source: https://github.com/cyberuni/cyber-mux/issues/36
pr: https://github.com/cyberuni/cyber-mux/pull/37
status: in-progress
todos:
  - content: "Grill + draft the axi/ node correction: streams, exit codes, structured errors, #9"
    status: completed
  - content: "Re-open the six mux.feature frozen scenarios (Clearance ratified) + write new error-surface suite"
    status: completed
  - content: "Clearance extended to layout.feature (Conflict): reclassify 4 usage errors to exit 2"
    status: completed
  - content: "Cold spec-judge rounds until convergence (R1 fail, R2 fail, R3 PASS)"
    status: completed
  - content: "Spec gate RATIFIED by unional: suites frozen, gate line recorded, status -> approved"
    status: completed
  - content: "Deliver: CliError model, 22 fail() sites -> stdout coded, usage errors exit 2 (pnpm verify green)"
    status: completed
  - content: "Impl gate PASSED: cold impl-judge re-derived every frozen scenario, drove the real binary"
    status: completed
  - content: "Handoff: rebased onto --env tip, re-gated green, PR #37 retitled (Closes #36), followup #40 filed"
    status: completed
---

# CR 36 — the CLI's error surface follows AXI

Source: issue #36. Lands by **updating PR #37 in place** (retitled; its
"prose-only, no code change" framing no longer holds).

## The change

`cyber-mux` adopts [AXI](https://github.com/kunchenguid/axi) but diverges from it on the
error surface across **every** command, not one path. One pass over one helper
(`fail()` in `packages/cyber-mux/src/cli.ts`, 22 call sites):

1. **Stream** — errors go to **stdout**; AXI says stderr is debug that "agents don't read".
2. **Code** — an unknown flag and a bare command group exit **2** (usage error), not 1.
3. **Structure** — every error carries a stable `code` + an actionable `help:`, honoring
   `--format`. Today only `ambiguous-pane` does.
4. **Suggestions (#9)** — next-step lines move to **stdout** as a `help[N]:` block, and are
   **omitted when self-contained** (AXI §9), not emitted by every command.

Item 4 was **not** in issue #36; it was found by reading the upstream AXI spec rather than
this repo's restatement, and folded in on the requester's call — it is the same helper,
same commands, same stream decision.

## Decisions (requester, in-session)

- **Streams** — follow AXI here; the `cyberplace` inversion is **filed, not fixed** in this CR.
  The axi/ node's stream-divergence bullet is removed (it stops being a divergence).
- **Clearance** — the frozen bare-send scenario re-open is **RATIFIED**. It pins both halves
  (`written to stderr`, `exits 1`) and both are wrong.
- **Scope** — fold the §9 suggestion divergence in.
- **Delivery** — update PR #37 in place.

## Floors

- **Clearance** — FIRES (frozen bare-send narrowed/rewritten). Ratified above.
- **Compatibility** — does **not** fire: package is `0.0.0`, nothing shipped, so the breaking
  exit-code/stream change exceeds no ceiling. Changeset still owed.
- **Conflict** — none known.

## Touched

- `packages/cyber-mux/.agents/spec/axi/README.md` — reference node (#6, #8, #9, Stream discipline)
- `packages/cyber-mux/.agents/spec/mux/mux.feature` — frozen; bare-send rewritten + new scenarios
- `packages/cyber-mux/.agents/spec/mux/README.md`
- `packages/cyber-mux/src/cli.ts`, `packages/cyber-mux/src/output.ts` (+ their tests)

## NEXT

Mission handed off. PR #37 (retitled, `Closes #36`) is up for review at
https://github.com/cyberuni/cyber-mux/pull/37 — awaiting merge. Both gates cleared (spec ratified
by unional, impl self-asserted + merged-tree re-gate green, 587 tests). Blocking follow-up filed as
#40. Four backlog follow-ups (ledger seq 2-5: cyberplace streams, exists exit-1, content-first→group,
no-home-view) stay in the ledger, unfiled by the requester's call — re-derivable by a later drain.

Keep this plan until #37 merges and the mission is doctrine-distilled. A corpus-wide formation pass
is due (sdd:manage → formation-loop) but is on-demand, not gated on this mission.
