---
status: approved
project-path: packages/cyber-mux
approval:
  spec:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: Clearance — FIRED and pre-authorized by the requester at intake, the one floor this CR trips. Three scenarios are REMOVED from the frozen layout.feature and re-stated at mux/, which is a narrowing however the net reads: the project's total contract is unchanged (every assertion lands in mux.feature), but the floor keys on the edit class, not the net. Verified structurally rather than by line diff — gherkin-cli diff --base origin/main layout.feature: 0 added / 0 modified / 3 removed, exactly the scenarios declared, nothing else touched. The lifecycle's pure-move/rename exemption (zero content delta preserves freeze) is deliberately NOT claimed: the moved scenarios were reworded from template voice to seam voice, so there is no zero-delta git mv to point to, and the cold judge independently confirmed that a producer invoking that exemption here would have been wrong. The mux/ side is the opposite class — 11 added / 0 modified / 0 removed, addOnly true, so its freeze self-clears with no re-open. Compatibility: no behavior change at all (spec + one doc comment), so no semver class to exceed.
      blast: medium — two behavioral nodes, one owning move rather than an addition. mux/ gains the seam's split-options contract (11 scenarios, a README use case, a behavior-table row); layout/ loses the three seam-convention scenarios and is repointed. The trigger is issue #10, which the previous CR's own ledger names as the debt it was deferring, so this pays a tracked debt rather than reversing a live decision. Scope held to the three fields the issue names: describeRegion is the other seam member specified through layout under the same house style and is deliberately left out. No production code changes.
      novelty: high — the issue's premise checked out, but the ground under it was worse than filed. mux.feature HAS NEVER PARSED: an Examples table declares | branch | placement | while two of its three rows carry one cell, so Gherkin rejected the whole file and the entire frozen suite was invisible to check-suite and bound to no test — the node reported 0 scenarios where it holds 61. That made the repair a blocking prerequisite rather than scope creep, since the spec gate runs check-suite fail-closed over touched suites; repaired in its own commit, taking the node to 61/34 bound/34 pass/0 fail. A second finding contradicts the code's own documentation: session.ts said env is "only meaningful for a pane:* placement" while both backends emit it at EVERY tier and the tests pin exactly that — load-bearing, because a pane pool's root pane is born by the region open and never by a split, so the stale comment instructed precisely the bug that would drop it. Corrected here. Also corrected against the issue: its "tested only through the layout suite" is loose — the fields ARE driven directly at the pane layer, but those tests implement layout.feature's scenarios, so the specification claim holds and the testing claim does not.
      confidence: high — cold sdd-spec-judge (fresh context, independent) 3-lens {oracle,builder,architect} all PASS, ALIGNED true, zero failing scenarios, no blocker, no open markers; mechanical check-suite + check-spec-state green. It re-derived every load-bearing claim rather than trusting the brief: it re-ran both edit classifications structurally; it verified every backend claim against the adapter source rather than this CR's prose (herdr's pane id is positional and no --from flag exists, toTmuxSize(0.333) really is 67%, the !window guards, env at every tier on both backends, herdr's worktree verbs accepting env in their type and never referencing it, canSizeSplits true on both); it ran the miss test over all 11 new scenarios and found none inert; it ran the absorption check in the direction that threatened this CR (scenarios authored after reading the implementation) and found no apparatus in any Given; and it checked pairwise consistency across all 72 scenarios. Two catches worth recording: it reproduced the EPARSE itself by stashing the tree and diffing against the committed baseline, rather than taking the blocker on trust; and it checked the carve-out this CR could have abused, confirming the pure-move exemption does not apply and is not claimed. Three non-blocking observations carried to deliver. Self-asserted within the auto-spec leash (by user) — ratify or kick back.
      cr: 10-split-options-contract
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — no frozen scenario narrowed; the implementation was built to the frozen suite and the suite was not edited to fit it.
      blast: medium — a widened SessionAdapter.open plus a one-line manifest fix, rebased onto the current target so the gate judged the tree that lands.
      novelty: medium — the fault is real and was reproduced live: panes demonstrably sitting in a real workspace while the manifest reported null.
      confidence: high — cold sdd-impl-judge verified all 8 frozen scenarios against LIVE herdr 0.7.4 + tmux 3.6b by driving the built bin rather than trusting the mocked Exec; it built a mutation backstop proving its probe catches the pre-CR fault and restored the tree byte-identical by hash, and PATH-shimmed herdr to prove the no-extra-call claim by counting real invocations. pnpm verify --force green, 424 tests. Its one substantive catch — the added scenarios were phrased as CLI reports when a bare `open --format json` emits the pane alone, making them true only under a seam reading — was corrected rather than shipped, and the surface gap it exposed filed as a follow-up. Self-asserted (by agent) — ratify or kick back.
      cr: 9-open-reports-workspace

---

# cyber-mux — the CLI: cross-multiplexer pane control

> Root project spec — the **descriptive** top index for the `cyber-mux` npm package
> (`packages/cyber-mux`). Behaviors live in the capability folders below.

`cyber-mux`: one contract (`SessionAdapter`) over terminal multiplexers (tmux, herdr) — detection,
pane identity, placement, git worktree, and turn-taking (nudge) helpers — decoupled from legion
(no store/identity/doorbell). Env namespace is `CYBER_MUX` / `CYBER_MUX_PANE`.

## Capabilities

| Node | Concern |
|---|---|
| [`mux/`](./mux/README.md) | the pane abstraction — backend selection, placement, multiplexer detection, focus reporting |
| [`layout/`](./layout/README.md) | named, reusable pane layouts — template resolution, the schema, and the walk that builds a pool against a target cwd |
| [`axi/`](./axi/README.md) | the Agent Experience Interface output contract every CLI command follows |
| [`design/`](./design/README.md) | cross-cutting rules/models and the decisions log (append-only, descriptive, ungated) |
