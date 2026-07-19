---
cr: rename-layout-to-template
project: cyber-mux
source: Council ruling (owner mail 1784487176382-a315de)
status: done
todos:
  - content: Ratify freeze re-open on layout.feature — wholesale rename is a rewrite class, not additive
    status: completed
  - content: Author template/ node — README prose naming all three parts (arrangement, environment, launch)
    status: completed
  - content: git mv layout.feature -> template.feature; rename vocabulary; verify 102 scenarios / 7 outlines preserved
    status: completed
  - content: Spec gate — re-freeze verified by hand (tool verdict false-green); self-asserted
    status: completed
  - content: Rename src modules + identifiers (live surface only; backend native vocab untouched)
    status: completed
  - content: cli.ts — template command group, --template flag, NO layout alias (clean break)
    status: completed
  - content: Changesets — edited 8 pending changesets to speak template; bump kept minor (owner call, 0.1.0)
    status: completed
  - content: pnpm verify — full build/typecheck/lint/test/biome
    status: completed
  - content: Website docs — cli/template.md, concepts/templates.md (delegated, verified)
    status: completed
  - content: Impl gate — independent cold verifier over the frozen-suite rename + boundary
    status: completed
  - content: Handoff — pushed, PR #54, operator reported, owner mail acked
    status: completed
---

# CR rename-layout-to-template

Rename the `layout` capability to `template` across the live surface. Source: Council ruling,
owner mail `1784487176382-a315de`.

## The argument (drives the spec prose, not just the identifiers)

`layout` names only the geometry. A saved artifact carries **three** things:

1. **arrangement** — the pane tree and its ratios
2. **environment** — the env vars each pane is born with
3. **launch commands** — what runs as panes are restored or created

It is a recipe for standing up a working workspace, not a description of where rectangles go. A
rename that changes every symbol but leaves the prose describing an arrangement has done the
mechanical half and missed the point.

## Scope boundary — three buckets

| Bucket | Action |
|---|---|
| Live feature surface: `src/layout*.ts` + tests, `cli.ts`, `session.ts` docblocks, `.agents/spec/layout/`, `apps/website/src/content/docs/` | rename → `template` |
| **Backend native vocabulary**: `herdr pane layout`, `layout.panes[].rect`, `layout.splits[]` (`session.herdr.ts`), tmux `#{window_layout}` (`session.tmux.ts`) | **leave** — foreign API surface, not ours to rename |
| History: `.agents/plans/`, `.research/`, `.agents/spec/ledger/` | leave — genuinely history |

`mux/mux.feature` is **mixed** — it already says "template" for the artifact and "layout" for the
capability node in the same sentences. Read line by line; never sed.

## Settled decisions (do not relitigate)

- **One concept.** Do not split arrangement from saved artifact.
- **No deprecated alias.** `cyber-mux layout` goes at once. Package is unpublished
  (`version: 0.0.0`, npm 404, no CHANGELOG), so a clean break costs no consumer.

## Open — settle at the changeset step

The ruling said **major**. But at `0.0.0` unpublished, a major changeset means **1.0.0** — an
unvoted stability declaration. The root `spec.md`'s own prior gate already records the project's
position: *"Compatibility does not fire: package is 0.0.0, nothing shipped."*

Also: the three pending `.changeset/layout-*.md` are **not history** — they are unreleased
deliver-tense release notes for this very feature. Ship them as-is and the first release describes
a `layout` command that does not exist. Edit them to say template.

## Verification floor (brief's explicit instruction)

Do **not** trust a green freeze verdict on the wholesale `.feature` rename. Read the diff. Baseline
to preserve: **102 scenarios, 7 Scenario Outlines, 18 `# ── stage ──` sections**, feature-level
`@frozen`.

## NEXT

Nothing — the mission landed. PR #54 carries the rename; both gates self-asserted (ledger),
independently verified clean (byte-identical frozen-suite substitution, boundary respected, 638
tests). Version settled at minor → 0.1.0 (owner override of Council's "major" on the unpublished
fact). Operator reported (mail `1784491161964-44f463`); owner mail `1784487176382-a315de` acked.

One follow-up outstanding, NOT filed here because it belongs to another repo: `classify-edit-class`
(SDD plugin, cyberplace) reports a renamed frozen `.feature` as additive/self-clears — a freeze-guard
hole. Recorded in the ledger and routed to the operator. Re-derive from the ledger if a later mission
drains follow-ups against the SDD tooling repo.

Keep this brief until PR #54 merges and is doctrine-distilled.
