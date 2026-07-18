---
status: implemented
project-path: packages/cyber-mux
approval:
  spec:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "Clearance FIRES on path 1 and was pre-authorized. Structural edit class (gherkin-cli diff vs main): layout.feature MIXED — 3 added / 0 modified / 2 removed, the two removed being the frozen bare-save scenarios ('says what it left out', 'save writes the path') rewritten so save's stdout becomes a structured {path, help[]} payload rather than a bare path, which breaks command-substitution composition (it moves to --format json | jq -r .path). That narrowing is the 'structured by default' choice the requester ratified in a prior session with the composition-change preview shown (plan Resolved decision 1), so the leash's STOP-for-ratification precondition on the path-1 re-open is met; this gate self-asserts the verdict provisionally on top of it. mux.feature ADDITIVE — 1 added, the lost-grouping help entry, folds into the frozen file without unfreezing (self-clears); the worktree hint was pinned only stream-agnostically so moving it to a stdout help[] field re-opens nothing. Compatibility does NOT fire and was checked, not assumed: package is 0.0.0, nothing shipped, so the breaking stream/composition change exceeds no caller's ceiling. No Conflict remains (judge ALIGNED true). Changeset owed at handoff."
      blast: "medium — one REFERENCE node shared beyond this repo (axi/, which names cyberplace and universal-plugin as adopters) plus two behavioral suites and their nodes. axi/ is a pure doc-sync of its stale 'what ships today' snapshot to the post-#36 reality (errors to stdout via reportError, fail() gone, exit-2 usage split, the worktree-failed backend-text residual recorded honestly), verified against source this session — no .feature or behavior change on the error paths. The behavioral delta is the help[N] block's concrete shape: layout gains 3 scenarios (bare-save reveal, path-on-stdout, --format json path+help object), mux gains 1 (lost-grouping help entry). The two #9 suggestions' ACTUAL stdout move is the deliver step, not this gate — at this gate cli.ts:252/:588 still write stderr, and the node now says so."
      novelty: "medium — the false-tense defect class recurred and was caught mid-gate. The axi re-sync correctly moved the #6 error-surface facts to shipped voice (they landed in #36) but wrote the #9 suggestions' stdout move as already-delivered, when source still writes stderr and this CR only SETS that contract (deliver performs the move). Same class the #36 gate's R2 caught ('is built' to 'is filed' over nothing filed); here it was 'this CR delivered' over an unshipped move. Re-tensed the three #9 spots to contract voice (built-on-stderr-today / this CR sets the contract / until deliver lands both still write stderr)."
      confidence: "high — two cold sdd-spec-judge rounds (fresh context, independent, backward against oracle/builder/architect). R1: oracle PASS, builder PASS, architect FAIL / ALIGNED false — caught the #9 false-tense against cli.ts:250/:586 directly. R2 after the re-tense: all three lenses PASS, ALIGNED true, no blocker, no failing scenarios, no open markers; it re-confirmed both stderr sites unchanged and the prose now matches source, and confirmed the #6 bullets untouched and still accurate. Mechanical checks green: check-spec-state, check-suite (both features parse, boolean Then), referenced-artifact-exists and use-case-coverage (diff-scoped vs main). Edit class read structurally, not from prose. Self-asserted within the auto-spec leash (by agent) — the spec lands provisionally in the async review queue: ratify or kick back."
      cr: "40-layout-suggestions-on-stdout"
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "none at the impl gate. Every frozen scenario was built against, not fitted to: no .feature was edited at deliver, no frozen scenario narrowed or added. The layout.feature re-open (path 1) and the additive mux.feature scenario were both settled at the spec gate; the impl gate froze that contract and built to it. Compatibility does not fire: package is 0.0.0, nothing shipped, so moving the two #9 suggestions from stderr to a stdout help[] payload — and making layout save's stdout a structured {path, help} payload rather than a bare path — breaks no existing caller's contract. Re-derived structurally against origin/main after the rebase; the bare/non-degraded worktree add json branch is a code path this CR never touches."
      blast: "medium — one shared output primitive (printHelp in output.ts, sibling to printFields/printTable) plus two call sites (layout save, reportOpenedWorktree shared by worktree add/open). The two stderr writes for the #9 notes are gone; the three legit stderr writes stay (capture warnings at the save site, the apply-failure diagnostic, the main() catch-all). layout save gained --format json (FORMAT_OPTION). The axi reference node's #9 prose was re-tensed from contract voice to shipped voice, verified against the running binary. No seam or adapter change: session.ts and both adapters are untouched."
      novelty: "low-to-medium — the surface was well-specified by the frozen suite, so deliver was execution. The one judgment the suite constrained without dictating: the help command is the caller's OWN value (the name they passed, the branch they named) re-stated with the grouping/capture flag, never a guessed id — honoring #9's placeholder rule while staying concretely actionable."
      confidence: "high — cold sdd-impl-judge, fresh context, re-deriving each frozen scenario's oracle from cli.ts/output.ts rather than the producer's prose. It re-ran pnpm verify itself (7/7 turbo tasks, 601 tests, biome ci clean, both features parse) and DROVE THE REAL BINARY for the three layout scenarios inside a live 3-window tmux session (bare save: path field + help[0] block + empty stderr; single-window save: path only, no help; --format json: {path, help:[{message, command}]}), plus the exit-2 unknown-flag structured error on stdout listing --format. The worktree grouping-hint scenario needs a binding herdr session it could not stand up live, so it re-derived from source and ran a mutation backstop (dropped the help emission, confirmed the frozen test fails), then reverted to a clean tree. Absorption clean: no scenario literal special-cased in production. Scenario bridge: all 4 frozen scenarios BOUND + PASS. IMPLEMENTATION_PASS true, no blocker. Two non-blocking observations: no --format json test for the degraded worktree case (symmetric trivial path); and a recommended live-herdr smoke pass in CI for the grouping-hint scenario. Self-asserted within the auto-spec leash (by agent) — lands provisionally in the async review queue: ratify or kick back."
      cr: "40-layout-suggestions-on-stdout"
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
