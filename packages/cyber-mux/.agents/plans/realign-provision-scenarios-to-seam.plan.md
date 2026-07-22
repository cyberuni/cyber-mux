---
cr: realign-provision-scenarios-to-seam
project: cyber-mux
status: draft
source: doctrine — Scanner strategy candidate (strategy 109cb2, seq 5, distills worktree-provision)
todos:
  - content: "Intake: open CR, scaffold plan brief, set statusline"
    status: done
  - content: "Explore: re-altitude the 4 CLI-naming provision Givens to the provisionWorktree/WorktreeApi.provision seam; keep behavior assertions intact"
    status: done
  - content: "Dispatch cold spec-judge over the re-altituded suite (2 rounds: gov pre-flight, then edit-class reframe; all 3 lenses PASS)"
    status: done
  - content: "Spec gate: re-open (ratified by mandate) + Clearance run explicitly, freeze, leash+gate lines to fresh ledger shard"
    status: done
  - content: "Impl gate: 8 provision tests green — shipped seam satisfies re-altituded scenarios (byte-identical acceptance); self-asserted"
    status: done
  - content: "Validate (pnpm verify 8/8, 803 tests), report gate verdicts"
    status: done
---

## CR

Re-altitude the six `provision` scenarios in `packages/cyber-mux/.agents/spec/mux/worktree/worktree.feature`
(the `# ── provision ──` band) so their `Given` names the **shipped** surface — the library seam
`provisionWorktree` / `WorktreeApi.provision` (`src/worktree.ts`) — not a `cyber-mux worktree provision`
CLI invocation, which does **not** exist.

**Defect (spec-feature-contradiction):** the frozen suite asserts a CLI surface the code never reaches.
`cli.ts` wires only worktree `add`/`open`/`list`/`remove`/`prune`; there is no `provision` verb. The
`worktree-provision` ADR (`.agents/spec/design/decisions/README.md`) explicitly defers the CLI verb:
"Left as a clean follow-up if a CLI `worktree provision` verb ever wants one." Provision ships **only**
as the library seam.

**Fix (A), chosen over (B):** the ADR/Council intent is that provision is a library seam and the CLI verb
is an unshipped follow-up — so (A) re-altitude, not (B) build-to-contract a new verb. Only the 4 Givens that
name `cyber-mux worktree provision` are edited (scenarios 1–4); scenarios 5–6 open on a predicate and are
already surface-neutral. `When`/`Then` behavior assertions are untouched. A band comment names the surface.

**Edit class:** rewriting frozen scenario Givens = a re-open in general, BUT this is an **obvious
stale-mistake contradiction** (both sides not plausibly intended: the ADR settles provision as
library-only), so it is a conductor-served minor fix per the autonomy bar — no ratified re-open needed,
no behavior narrowed (Clearance does not fire). Package is 0.0.0 (Compatibility inert). No Conflict.

## NEXT

Mission complete — both gates approved (self-asserted within the auto-spec leash), ledger shard
`realign-provision-scenarios-to-seam.b7d4e2.jsonl` records leash + spec/impl gate + followup.
`pnpm verify` green (8/8, 803 tests). Awaiting async ratification of the two self-asserted gates.
Open follow-up (backlog, cross-repo, unfiled): a suite-format-governance bar requiring a Given to
name a shipped surface — see ledger seq 4.
