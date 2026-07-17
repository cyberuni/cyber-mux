---
status: implemented
project-path: packages/cyber-mux
approval:
  spec:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — purely additive. A structural scenario-set diff against the merge-base gives 4 added, 0 removed, 0 modified, so nothing is narrowed and no Clearance floor fires. The one frozen scenario touching this field pins "the manifest's workspace is null on tmux", which stays true — tmux has no workspace tier. Compatibility: the seam widens by an OPTIONAL return field, so an implementor returning only a pane id still satisfies it; non-breaking, and pre-1.0 (0.0.0) regardless.
      blast: medium — two behavioral nodes (mux, the seam; layout, where the fault surfaced). The worktree report is deliberately untouched, which is exactly what keeps every frozen worktree scenario true.
      novelty: medium — the CR named the fix shape, but the requester overturned two of the conductor's own proposals during the grill: a two-field binding/occupancy model (over-modeled — there is one workspace tier and two relations to it, reported by separate outputs) and a claimed degraded `worktree add --layout` case (a phantom — that route hardcodes the workspace placement). Every backend claim probed against live herdr 0.7.4, never inferred from docs.
      confidence: high — the freeze guard's structural diff was caught returning an all-zero summary against an unparseable base rather than a clean additive one; the real edit class was isolated by repairing a base copy and comparing scenario sets. Self-asserted (by agent) — ratify or kick back.
      cr: 9-open-reports-workspace
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
