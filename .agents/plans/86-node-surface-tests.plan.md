---
cr: 86-node-surface-tests
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/86
status: draft
todos:
  - content: "Explore: confirm 20 gaps + read surface conventions per node group; no spec/.feature change"
    status: completed
  - content: "Spec gate: no-op pass (zero spec delta, freeze untouched) — record ledger line"
    status: completed
  - content: "Deliver: author 21 surface tests (20 gaps + tabs-grouped fix); bridge 8/8 nodes BOUND+PASS; pnpm verify green"
    status: completed
  - content: "Impl gate: 18/20 bound (7 nodes 100%, template/capture 19/21); pnpm verify green; impl-judge remediated; self-asserted (ledger seq 3)"
    status: completed
  - content: "Handoff: 2 commits, rebased onto main, PR #89 (Closes #86), followup #88; statusline cleared"
    status: completed
---

# CR 86 — surface tests for 20 frozen scenarios (scenario-bridge full coverage)

Author a test **at each scenario's own node surface** for the 20 frozen scenarios that #83 left
UNBOUND (proven only via a neighbor seam). Target: 281/281 bound. Source: issue #86 (agent-filed
follow-up from #83 / PR #85).

## Shape (decided at intake, user-ratified)

- **Full sweep now** — all 20, one mission (user chose over per-node).
- **Zero spec delta.** No `.feature` change, no new scenarios. Nodes stay `implemented`; freeze
  untouched. Spec gate is a **no-op pass**. Real gate = **impl gate** (bridge BOUND+PASS + verify).
- **Test-only, no behavior change.** Each new test drives the scenario's own surface (CLI via
  `run(program, [...])`, or the library seam at the node) and mirrors the existing neighbor proof.
  Leaf title = the frozen `@id:` slug, under an exact `describe('spec:cyber-mux/<node>', ...)`.
- **Risk to watch (build-to-learn):** if a behavior is not actually reachable at its own surface,
  that node escalates from test-only to a real gap → surface as a blocking follow-up, do not fake.

## The 20 gaps by node (exact @id: slugs — from #83 ledger seq 4-11)

- **cli/worktree (7)** — worktree-remove-tolerates-gone, worktree-remove-refuses-dirty,
  worktree-remove-force-discards-dirty, worktree-add-placement-fallback,
  worktree-add-nonbinding-no-note, worktree-label-names-space, worktree-label-omitted-default
- **cli/lookup (2)** — lookup-close-terminates-pane, lookup-list-space-rendered-whole
- **cli/template/apply (2)** — manifest-workspace value (open --template --format json / herdr),
  manifest-workspace null (tabs template / tmux)
- **mux/driving (2)** — driving-unknown-token-not-rescued, driving-wezterm-non-core-key-known
- **mux/lookup (2)** — lookup-wezterm-name-never-resolves, lookup-ambiguous-name-fails-all-verbs
- **mux/placement (2)** — placement-wezterm-workspace-never-absent,
  placement-wezterm-ratio-not-for-tab-workspace
- **template/apply (1)** — apply-tab-label-never-parsed-back
- **template/capture (2)** — capture-workspace-enumerate-unsupported-refused,
  capture-geometry-unsupported-refused

(Exact slugs for cli/template/apply to be read from apply.feature during deliver.)

## Verification (bridge is the oracle)

- Per node: `verify-scenarios --run --node cyber-mux/<node> --feature <f> --feature-root .
  --root packages/cyber-mux` → target scenarios BOUND + PASS, 0 UNBOUND at that node.
- `pnpm verify` — build + typecheck + lint + test + biome, full green.
- Freeze: no `.feature` edits at all, so no freeze transition (confirm `git diff` touches no
  `*.feature`).

## Ledger

`packages/cyber-mux/.agents/spec/ledger/86-node-surface-tests.99fae1.jsonl` — leash seq 1 written
(auto-all, blast small).

## Deliver notes (done)

- All 21 tests landed across 5 files; bridge oracle = 8/8 touched nodes 100% BOUND+PASS; `pnpm verify`
  green (845 tests). Freeze intact (no `*.feature` diff).
- **Correction found:** #86 listed cli/template/apply's 2nd gap as "tabs on tmux → null", but
  `template-apply-manifest-workspace-null-tmux` was ALREADY bound at HEAD. The real gap was
  `template-apply-manifest-workspace-null-tabs-grouped` — bound with a new tmux tabs-template test.
- **Reroute done:** `lookup-ambiguous-name-fails-all-verbs` bound in cli.test.ts (mux/lookup wrapper)
  as an it.each over all 8 pane verbs (resolution lives in cli.ts:resolveTarget, not the adapters).
- **Scrutiny flag for impl-judge:** template/capture's two `*-unsupported-refused` tests prove the
  "structural half" at the library node (pure engine takes no adapter; refusal decision is in cli.ts)
  + mirror the CLI refusal message. Judge confirming this is a sufficient node-surface proof.

## Landed

- PR #89 (Closes #86), rebased onto main tip. 18/20 gaps bound at their own surface; `pnpm verify`
  green; freeze intact.
- Follow-up **#88** (blocking): the 2 `template/capture` `*-unsupported-refused` scenarios need a
  library capture-derive orchestrator so the API enforces the refusal (CLI delegates) — a behavior CR.
  Corpus at 279/281 until then.

## NEXT

- Await merge of #89. After merge: distill doctrine and retire this plan.
- A corpus-wide formation pass is due (node-placement question raised for template/capture vs
  cli/template/capture) — run via `sdd:manage` on demand; nothing is gated on it.
