---
status: implemented
project-path: packages/cyber-mux
approval:
  spec:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — the suite edit is purely additive, verified structurally rather than by line diff (`gherkin-cli diff --base HEAD`: 22 added, 0 modified, 0 removed, 46 unchanged, addOnly true). No frozen scenario is narrowed or rewritten, so the freeze self-clears and no re-open ratification is needed; the file keeps its @frozen tag. The one place this could have gone wrong was the pre-existing "list, show and validate answer with no multiplexer at all" outline — save reads a mux, but it is not among that outline's Examples, so the outline stays true verbatim. The judge re-ran the classification itself and confirmed. Compatibility: additive on a pre-1.0 package, under the ceiling.
      blast: medium — one behavioral node revised (layout), 22 scenarios added to a 46-scenario frozen suite. The node's README reverses a non-goal the previous CR recorded, and corrects its "managing templates never touches a multiplexer" claim, which save is the first exception to. A new optional seam member (describeRegion?) is specified here rather than in mux/, following the house style this node already set for `from`, `ratio` and `env` — issue #10 tracks that style itself; the judge independently confirmed #10 is real and on-point and that deferring to it rather than absorbing the fix is correct for a CR about capture.
      novelty: high — the design of record was WRONG on the load-bearing fact and the CR corrects it. §6.4 claimed herdr's `pane layout` reports a tree via `splits[]`; probed against live 0.7.4, splits[] is FLAT and its parent links exist only inside an undocumented id convention (`split_1_0`), while tmux's tree is a bespoke string. So the seam reports RECTS and cyber-mux derives the tree by guillotine cuts — the fact both backends report exactly, and a region built by splitting is always guillotine-cuttable. Two further corrections found by probing rather than by reading: a ratio must be the complement `1 - second/total`, because `first/(first+second)` reads 0.69 where tmux's own `-l 30%` says 0.7 (the divider cell belongs to the region, not to either pane); and a 2x2's genuine ambiguity must break columns-first to match `tiled` rather than its transpose.
      confidence: high — cold sdd-spec-judge (fresh context, independent) 3-lens {oracle,builder,architect} all PASS, ALIGNED true, zero failing scenarios, no blocker, no open markers; mechanical check-suite + check-spec-state green. It re-derived the edit classification, ran the miss test over all 22 new scenarios and found none inert, and ran the absorption check in the direction that actually threatened this CR — the scenarios were authored AFTER an implementation spike, so it checked whether the spike's live-captured cell counts leaked into any Given, and confirmed they stayed in trailing comments while the Givens state preconditions. It reported one cosmetic content gap (a missing behavior-table row), fixed before this write, and two impl-side observations for the impl gate. Self-asserted (by agent) — ratify or kick back.
      cr: 8-layout-save
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — no frozen scenario was narrowed, rewritten or deleted. One scenario was ADDED at the impl gate, to specify the duplicate-label behavior the round-1 blocker's fix introduced rather than leave it an unnamed implementation choice; additive, so the freeze self-cleared (gherkin-cli diff --base HEAD: 23 added / 0 modified / 0 removed, addOnly true). Round 2 independently judged that addition legitimate and said it would have flagged the alternative — folding the behavior silently under the existing round-trip scenario — as a gap, since nothing about "the template still validates" pins down WHICH pane loses its name. Every defect found at the gate was fixed in code or in tests, never by editing the contract to fit the implementation. Compatibility: additive on a pre-1.0 package, under the ceiling; describeRegion? is an optional member, so no external SessionAdapter implementor changes shape.
      blast: medium — one new pure module (layout-capture), a new optional seam member (describeRegion?) implemented on both adapters, a new writing member on the LayoutStore seam, and a new CLI verb. Rebased onto the target tip before the gate, so the judge saw the tree that lands. Scenario binding: this CR's 23 scenarios all bind and pass under the verify-scenarios bridge (69 total / 28 bound / 28 pass / 0 fail / 41 unbound); the 41 unbound are the PRE-EXISTING baseline (clean HEAD measured at 46/5/41), untouched — this CR adds no unbound debt and is filing the pre-existing gap as a follow-up rather than absorbing it.
      novelty: high — the design of record was wrong on the load-bearing fact and the CR corrects it: §6.4 claimed herdr's pane layout reports a tree, but probed against live 0.7.4 its splits[] is FLAT with parent links only in an undocumented split_1_0 id convention, and tmux's tree is a bespoke string. So the seam reports RECTS and cyber-mux derives the tree by guillotine cuts. Two arithmetic corrections came from probing rather than reading: ratio must be the complement 1 - second/total (first/(first+second) reads 0.69 where tmux's own -l 30% says 0.7, because the divider cell belongs to the region and to neither pane), and a 2x2's genuine ambiguity must break columns-first to match tiled rather than its transpose.
      confidence: high — FOUR cold sdd-impl-judge rounds (each a fresh context, each re-deriving every oracle), three of which returned a `change` verdict on real defects, all found by MUTATION rather than by reading. R1: no duplicate-label check, so a region with two panes sharing a title wrote a template that its own validate rejected — silently, with no warning; live-reproduced against real tmux. R2: three scenarios bound to tests that never exercised the CLI-observable half of their Then — proven by disabling stderr forwarding and watching the suite stay green. R3: two over-claiming checks, the subtler being that this CR's OWN duplicate-label fix masked the tmux hostname filter (a fixture with two host-titled panes would collide and be dropped, giving the right answer for the wrong reason). One further defect was self-caught: the test bound to "a captured template passes validate" was inert, asserting only that the name came back, never running the validator — the very test that should have caught R1's bug. R4 mutation-tested the eight remaining unprobed behaviors (--to routing, name-validation ORDER, tie-break, ratio formula and precision, dir subtraction, overwrite-guard order, --force), found every one caught, and passed with no blocker. R1 additionally hand-derived the ratio arithmetic and live-verified against real tmux 3.6b and herdr 0.7.4 binaries including a live round-trip reproducing 119x34 / 119x15 / 80x50 cell-for-cell. No absorption findings across four rounds. pnpm verify green, 415 tests. Self-asserted (by agent) — ratify or kick back.
      cr: 8-layout-save
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
