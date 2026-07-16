---
status: implemented
project-path: packages/cyber-mux
approval:
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — no frozen scenario was narrowed. The suite was frozen before the build and is byte-identical after it (md5 unchanged across two judge rounds); every defect found at the gate was fixed in code, never by editing the contract to fit the implementation.
      blast: medium — three new modules (layout, layout-store, layout-session) plus additive seam fields (ratio, env) on SessionOpenOptions and both adapters, and a new CLI group. Additive on a pre-1.0 package; rebased onto the target tip so the gate judged the tree that lands.
      novelty: high — the round found a bug that would have shipped: the impl-producer emitted an --env flag on herdr's worktree create/open that does not exist. Verified against the live 0.7.4 socket schema (WorktreeCreateParams has no env) and a throwaway-repo probe (CLI answers 'unknown option: --env'); it would have thrown on the feature's PRIMARY flow for the canonical template. The root pane's env there now takes the design's own Gap C command-prefix fallback, which the design had recorded as having no customer — this route is its first.
      confidence: high — cold sdd-impl-judge (fresh context, second round after a `change` verdict) re-derived every scenario's oracle, hand-re-derived the ratio inversion and desugar arithmetic rather than trusting the tests, confirmed herdr's worktree verbs emit no --env, and empirically ran an injection attempt through a real pty against bash and zsh to test the env-prefix quoting — no injection or breakage. All 46 frozen scenarios pass, zero failing, no absorption findings, no blocker. pnpm verify green, 370 tests. Self-asserted (by agent) — ratify or kick back.
      cr: 5-layout-templates
  spec:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — purely additive. A new `layout/` behavioral node beside `mux/` and `axi/`; no existing frozen scenario is touched, so nothing is narrowed and no Clearance floor fires. The seam additions this CR specifies (SessionOpenOptions.ratio, env) are additive optional fields — no existing caller changes shape. Compatibility: additive on a pre-1.0 (0.0.0) package, under the ceiling.
      blast: medium — one new behavioral node (layout) and its root-index row; the ratio/env seam fields land in mux-layer source but, per existing house style (Gap A's `from` shipped the same way), are specified through layout.feature rather than folded back into mux. No other project touched. layout export, --if-populated, --dry-run and the cwd heuristic are scoped out of this CR at intake, with reasons recorded in the node's non-goals.
      novelty: medium — the design of record (docs/design/layout-templates.md) is thorough and pre-probed against live tmux 3.6b + herdr 0.7.4; the mission migrated a scoped subset of it. A build-to-learn spike independently confirmed the two load-bearing numbers before freeze — the even-horizontal 1/n comb yields equal panes, and tmux's -l takes round((1-ratio)*100) so ratio 0.333 → 67%.
      confidence: high — cold sdd-spec-judge 3-lens {oracle,builder,architect} all PASS, ALIGNED true, 46 scenarios passing, zero failing, no open markers; mechanical check-suite + check-spec-state green. The judge re-derived the desugar and ratio arithmetic itself and confirmed it. Its two apparatus-absorption findings and one coverage gap were fixed before freeze (one correction round). Self-asserted (by agent) — ratify or kick back.
      cr: 5-layout-templates
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
