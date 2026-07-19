---
cr: 56-spec-corpus-drift
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/56
status: in-progress
todos:
  - content: "Audit corpus against structure/format/lifecycle/suite/combat-log governances"
    status: completed
  - content: "Open the CR issue with the audit findings"
    status: completed
  - content: "Report findings at the spec gate; get Council rulings on the open questions"
    status: in_progress
  - content: "Register the SDD plugin role-map in .agents/universal-plugin.json"
    status: pending
  - content: "Declare the placement strategy + routing table in the root spec"
    status: pending
  - content: "Add the root glossary; hoist inline term definitions into it"
    status: pending
  - content: "Add the missing required sections to both behavioral nodes"
    status: pending
  - content: "Fix root spec frontmatter: add producer attribution, drop the off-schema key"
    status: pending
  - content: "Resolve the top-level single-document reference node home"
    status: pending
---

## NEXT

Audit is done and filed as the CR. Holding at the spec gate to report drift before
repairing it, per the mission brief. Three rulings are needed before the repair
todos start: whether to register the agent-config production chain alongside the
documentation one; the correction-cause decision already pending as unratified
strategy; and whether the root spec's provisional impl approval is ratified or
reopened.

## CR

Bring the spec corpus up to date with current SDD contracts. Audit-then-repair,
not a rewrite: close the gaps that are real, leave conforming structure alone,
invent no new spec content.

Boundary held: ledger shards, plan briefs, and combat logs are provenance. Their
format drift is reported in the CR and is deliberately NOT retrofitted.

Unratified Scanner strategy pending Council decision lives in an uncommitted
ledger shard in the primary checkout (not this worktree). Four entries, none
ratified. Surfaced, not acted on.
