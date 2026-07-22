---
cr: split-worktree-cli-api-surfaces
project: cyber-mux
status: approved
source: operator-directed; distills cyberuni/cyberplace#360 (surface-axis divergence)
todos:
  - content: "Explore: split worktree into cli/worktree (CLI surface) + re-scoped mux/worktree (library seam); author new provision verb spec; placement-map surface-axis exception"
    status: done
  - content: "Spec gate: cold judge ALIGNED (3 rounds — 2 pre-flight, 1 fix); freeze both suites; leash+gate:spec to ledger shard c3f8a1"
    status: done
  - content: "Deliver: implement worktreeProvisionCommand in cli.ts over provisionWorktree (default gate); --branch/--base/--path/--format; report reused|created; + 5 cli.test.ts cases"
    status: done
  - content: "Impl gate: cold impl-judge IMPLEMENTATION_PASS (all 5 scenarios verified); ledger gate:impl; status implemented"
    status: done
  - content: "Changeset (new CLI verb), pnpm verify 8/8 (808 tests), commit, report"
    status: done
---

## CR

Split the worktree capability node into two SURFACE nodes because the CLI and library API diverge
(cyberuni/cyberplace#360): a CLI verb can only use the default availability gate, while the library
seam takes an injectable predicate.

- **cli/worktree/** (new surface node) — the `cyber-mux worktree <verb>` surface: add/open/list/remove/prune
  invocation + presentation + human-table rendering, **plus a new `worktree provision` verb**.
- **mux/worktree/** — re-scoped to the surface-independent library seam (provisionWorktree/WorktreeApi
  incl. the API-only injectable predicate, git-owns-facts, removal-never-delegated, gate ordering,
  disposability determination).
- **spec.md** — placement map gains a bounded surface-axis exception to capability-first.

## Spec gate — APPROVED (self-asserted, auto-spec)

Cold spec-judge ALIGNED (oracle/builder/architect PASS). Coverage conserved scenario-by-scenario
(37 baseline → relocated/re-altituded, +5 provision-verb, +3 remediation). The architect smear-vs-
divergence question PASSED on evidence (zero duplication; injectable predicate is a callable a flag
cannot express; cli/ holds one node). Re-open of mux/worktree ratified by mandate; Clearance cleared.
Ledger shard: split-worktree-cli-api-surfaces.c3f8a1.jsonl.

## NEXT

Mission complete. Both gates approved (self-asserted, auto-spec, provisional in the async review
queue). The `cyber-mux worktree provision` verb ships; the worktree spec is split by surface
(cli/worktree + mux/worktree seam) under a bounded surface-axis exception. Ledger shard
split-worktree-cli-api-surfaces.c3f8a1.jsonl records leash + spec/impl gates + 2 followups. Changeset
added (minor). pnpm verify 8/8 (808 tests). Awaiting async ratification of the two self-asserted gates
and the surface-axis precedent. Open followups (backlog, in-repo): adopt the scenario-bridge binding
convention (ledger seq 4).
