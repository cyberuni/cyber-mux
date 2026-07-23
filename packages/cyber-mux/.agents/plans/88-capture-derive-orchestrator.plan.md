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
  - content: "Handoff: no changeset; commits (code+README, SDD records); push + PR #90 Closes #88"
    status: done
  - content: "Followup RESOLVED in-session ('just fix it'): backend-unsupported (exit 1) outranks missing-pane (exit 2); cli.ts refuses before target resolution (single-source via CaptureUnsupportedError); pinned by additive frozen scenario template-capture-backend-refusal-outranks-missing-pane + test. cli/template/capture 15/15."
    status: done
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

PR #90 landed with Closes #88. The exit-code ordering followup was RESOLVED in-session (user: "just
fix it"): backend-unsupported (exit 1) now outranks missing-pane (exit 2) — cli.ts refuses on the
absent seam member before target resolution, throwing the library's CaptureUnsupportedError (mapped
once), pinned by the additive frozen scenario template-capture-backend-refusal-outranks-missing-pane
and its test. cli/template/capture 14→15/15 BOUND+PASS. Nothing outstanding to file. Combat log seq 2
records the resolution.
