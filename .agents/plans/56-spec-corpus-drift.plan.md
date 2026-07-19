---
cr: 56-spec-corpus-drift
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/56
status: implemented
todos:
  - content: "Audit corpus against structure/format/lifecycle/suite/combat-log governances"
    status: completed
  - content: "Open the CR issue with the audit findings"
    status: completed
  - content: "Report findings at the spec gate; get Council rulings on the open questions"
    status: completed
  - content: "Register the SDD plugin role-map in .agents/universal-plugin.json"
    status: completed
  - content: "Declare the placement strategy + routing table in the root spec"
    status: completed
  - content: "Add the root glossary; hoist inline term definitions into it"
    status: completed
  - content: "Add the missing required sections to both behavioral nodes"
    status: completed
  - content: "Fix root spec frontmatter: add producer attribution, drop the off-schema key"
    status: completed
  - content: "Resolve the top-level single-document reference node home"
    status: completed
---

## NEXT

Repairs landed. Structure audit reports zero blocking findings and the suite check
reports OK on both suites, where it previously skipped them for want of a scenario
map. Both frozen suites are byte-for-byte untouched.

Left standing for the Council, deliberately:

- the root spec's approval block still records the PREVIOUS change's verdicts,
  including an impl self-assertion whose own text says it lands provisionally
  pending review. Ruled: leave it, flag it. This change recorded its own spec gate
  on the ledger rather than overwriting that block, so nothing was destroyed.
- provenance format drift is reported on the CR and in no way retrofitted.
- four unratified Scanner strategy entries sit in an uncommitted ledger shard in
  the PRIMARY CHECKOUT, not this worktree. Untouched. They include the
  correction-cause decision, which is the Council's to rule on.

Follow-ups are recorded on this change's ledger shard and filed as issues.

## CR

Bring the spec corpus up to date with current SDD contracts. Audit-then-repair,
not a rewrite: close the gaps that are real, leave conforming structure alone,
invent no new spec content.

Boundary held: ledger shards, plan briefs, and combat logs are provenance. Their
format drift is reported in the CR and is deliberately NOT retrofitted.

Unratified Scanner strategy pending Council decision lives in an uncommitted
ledger shard in the primary checkout (not this worktree). Four entries, none
ratified. Surfaced, not acted on.
