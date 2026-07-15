---
status: implemented
project-path: packages/cyber-mux
approval:
  spec:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — purely additive. The suite carried NO send/submit scenarios and zero @frozen tags before this CR, so nothing is narrowed and no Clearance floor fires. Compatibility: a deliberate breaking change to SessionAdapter + the CLI verb surface, authorized by the CR itself, on a pre-1.0 (0.0.0) package — under the ceiling.
      blast: medium — one behavioral node (mux) plus its output-contract sibling (axi, whose "no command groups today" claim this CR falsifies and must update) and a new design/decisions node. No other project is touched; the cross-project axi #8 question is deferred to a filed follow-up, not decided here.
      novelty: high — the CR's premise was false (the backends share no send-keys primitive) and was replaced across four requester-approved pivots. Every backend claim is probed against live tmux 3.6b + herdr 0.7.1, never inferred from docs.
      confidence: high — cold sdd-spec-judge 3-lens {oracle,builder,architect} all PASS, ALIGNED true, zero failing scenarios, no open markers; mechanical check-suite + check-spec-state green. The judge independently re-probed every load-bearing claim and reproduced the history-recall hazard this CR exists to prevent. Eleven correction rounds are recorded in the plan's combat log, including a requester-issued scope correction. Self-asserted (by agent) — ratify or kick back.
      cr: send-submit-realign
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: none — no frozen scenario narrowed; the implementation was built to the frozen suite and the suite was not edited to fit it.
      blast: medium — a breaking SessionAdapter + CLI change, rebased onto the current target so the gate judged the tree that lands (the rebase absorbed a --label feature and a worktree-capability refactor that landed meanwhile).
      novelty: high — the fault fixed is real and was reproduced: submitting text that named a key pressed it, recalled shell history, and re-ran the pane's previous command.
      confidence: high — cold sdd-impl-judge re-derived all 16 CR-added frozen scenarios (22 concrete cases) and verified each against LIVE tmux 3.6b + herdr 0.7.1 by driving the built bin and reading panes back, not by trusting the mocked Exec; it also built a backstop proving its probe catches the pre-CR fault before confirming it gone. No absorption finding, no structural blocker. pnpm verify green, 193 tests. The judge's one substantive catch — a prose claim that herdr's refusal is "loud" when the Exec seam swallows it — was corrected rather than shipped, and filed as a follow-up. Self-asserted (by agent) — ratify or kick back.
      cr: send-submit-realign
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
| [`axi/`](./axi/README.md) | the Agent Experience Interface output contract every CLI command follows |
| [`design/`](./design/README.md) | cross-cutting rules/models and the decisions log (append-only, descriptive, ungated) |
