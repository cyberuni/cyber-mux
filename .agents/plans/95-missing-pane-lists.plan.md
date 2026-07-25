---
cr: 95-missing-pane-lists
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/95
status: approved
todos:
  - content: "Intake: CR #95 opened (companion to #94); user ratified the freeze re-open (Clearance) of lookup-missing-arg-usage-error; leash + clearance in ledger"
    status: completed
  - content: "Explore: rewrote lookup-missing-arg-usage-error -> lookup-missing-pane-lists-candidates (all 8 pane verbs) + no-mux-outranks + list agentStatus column + cli/agent wait-outranks; READMEs reconciled; axi.md verified no-change"
    status: completed
  - content: "Spec gate: ratified scope mechanically confirmed (1 removed = the ratified scenario, rest additive); cli/agent addOnly; self-asserted (auto-spec); gate line written; status approved"
    status: completed
  - content: "Deliver: MissingPaneError (exit 2, candidates) via resolveTarget chokepoint; <pane> -> [pane] on all verbs; list agentStatus column; tests; changeset"
    status: pending
  - content: "Impl gate: verify per scenario; pnpm verify green; rebase; status implemented"
    status: pending
  - content: "Handoff: land in the SAME PR as #94 (Closes #94, #95); combat log"
    status: pending
---

# CR 95 — missing `<pane>` fails with the live panes listed, across all pane verbs

Companion to #94. A missing `<pane>` today gives a useless "missing required argument" message. New
contract: missing `<pane>` → **exit 2** (usage error, unchanged) but the backend is queried and the
**live panes are listed as candidates** — the exact shape the sibling `ambiguous-pane` error already
uses. Applies to every pane verb via the single `resolveTarget` chokepoint. `list` also gains an
agent-status column, herdr-only. Source: #95.

## Ratified re-open (Clearance)

User ratified rewriting the frozen `cli/lookup` scenario `lookup-missing-arg-usage-error`: delete the
"having called no backend" guarantee + the "names the missing argument" step; replace with the
candidate-listing behavior. Recorded in the ledger shard. Harmonizes missing-pane with ambiguous-pane
(both exit-2 usage errors that query the backend to list candidates).

## Design (decided)

- `MissingPaneError` (code `missing-pane`, exit 2) carrying `candidates` like `AmbiguousPaneError`;
  raised in `resolveTarget` when the locator is absent — one chokepoint, every pane verb.
- `<pane>` → `[pane]` (optional) on all pane verbs; no-mux (exit 1) surfaces first when no mux to list.
- `agent wait` backend-unsupported (exit 1) outranks missing-pane on non-herdr backends (mirrors
  `template-capture-backend-refusal-outranks-missing-pane`).
- `list` agent-status column only where the backend feeds it (herdr) — AXI #2 discriminates rule.

## Leash

`packages/cyber-mux/.agents/spec/ledger/95-missing-pane-lists.86bce2.jsonl` — `auto-spec`, Clearance
ratified by user. Hash `86bce2`.

## NEXT

Spec gate on the producer's re-open + additive scenarios. Then deliver (brief:
scratchpad `deliver-brief-95.md`). Land in the same PR as #94.
