---
cr: 88-capture-derive-orchestrator
project: cyber-mux
status: implemented
source: cyberuni/cyber-mux#88 (agent-filed followup, carved from #86 surface-test mission)
todos:
  - content: "Explore DONE: derive orchestrators + CaptureUnsupportedError in template-capture.ts; cli.ts delegates + maps; README light touch. Bridge: template/capture 21/21 BOUND+PASS (was 19/21). tsc clean."
    status: done
  - content: "Spec gate DONE: cold spec-judge ALIGNED on re-dispatch (2 rounds — R1 blocked on governance-preflight relay miss, corrected + re-declared 7 governances). .feature byte-identical (freeze intact), no status transition; gate:spec self-asserted to ledger shard f9647d. correction line logged."
    status: done
  - content: "Deliver DONE (built-to-keep): deriveRegionCapture/deriveWorkspaceCapture; cli.ts delegates; noteTabsLeftOut left as-is. pnpm verify green (845+8). Rebased on origin/main 61a6974 (target tip unchanged)."
    status: done
  - content: "Impl gate DONE: cold impl-judge IMPLEMENTATION_PASS, 7/7 (2 library + 5 CLI siblings); mutation-tested the 2 new tests (3/3 mutants caught); error strings byte-identical vs origin/main; no scope/absorption/published-surface issues. gate:impl self-asserted. 1 backlog followup (exit-code ordering corner)."
    status: done
  - content: "Handoff: no changeset (no published-surface change); commit (code+README, then SDD records); push + PR Closes #88; surface backlog followup"
    status: in_progress
---

## CR

Issue #88: the capture refusal on an unsupported backend lives only in `cli.ts`, so two frozen
`template/capture` scenarios (`capture-workspace-enumerate-unsupported-refused`,
`capture-geometry-unsupported-refused`) cannot bind at their own library node. The pure engine
(`captureTemplate`/`captureWorkspaceTemplate`) takes already-read data and never sees the adapter.

**Change (behavior/API):**
- Add two library orchestrators to `src/template-capture.ts`:
  `deriveRegionCapture(adapter, exec, target, opts)` and `deriveWorkspaceCapture(...)`. Each reads the
  optional `adapter.regions?.describeRegion` / `describeWorkspace`; **refuses** on absence by throwing
  a new typed `CaptureUnsupportedError(backend, capability)` (extends Error, portable — no exit code);
  otherwise calls the existing pure capture. Single source of truth for the refusal DECISION.
- `cli.ts` `template save` delegates to the orchestrators and **catches `CaptureUnsupportedError`**,
  mapping it to the existing `backend-unsupported` CliError (exit 1, naming the backend, fix hint).
  CLI observable unchanged. Leave `noteTabsLeftOut`'s best-effort courtesy read as-is (it must NOT
  refuse — absent member → null entry).
- README light touch: name where the refusal contract is enforced (the library orchestrator), CLI
  observable delegating.

**Frozen `.feature` is UNCHANGED** — both scenarios already read "When a region/workspace capture is
derived", i.e. they already describe the library-derivation surface. Additive impl change → freeze
self-clears, no re-open.

## Decisions (user-ratified this session)
- Error seam: library decides (typed error carries backend + capability), CLI presents (wording/exit/hint).
- README: light-touch prose update naming the orchestrator.
- Leash: **auto-all** (self-assert both gates within leash, stop only on a hard floor).

## NEXT

Both gates passed (self-asserted, auto-all, provisional in the async review queue). `template/capture`
is 21/21 BOUND+PASS (was 19/21); corpus 279/281 → 281/281. The refusal DECISION now lives in the
library derive orchestrators; cli.ts delegates. `.feature` unchanged (freeze intact), no status
transition. No changeset (new exports internal, not in published ./template surface). pnpm verify
green (845+8). Ledger shard 88-capture-derive-orchestrator.f9647d records leash + gate:spec + gate:impl
+ 1 backlog followup; combat log records the spec-gate governance-preflight correction.

Remaining: PR landed with Closes #88. Open followup (backlog, ledger): the exit-code ordering corner
(no-pane + unsupported-backend now exits 2 not 1) — decide deliberately (pin a scenario or document as
unspecified). Not filed as an issue yet — awaiting the user's go-ahead.
