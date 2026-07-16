---
cr: 5-layout-templates
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/5
status: done
todos:
  - content: Author layout/ node — README.md use cases + layout.feature scenarios
    status: completed
  - content: Spec gate — cold spec-judge, freeze layout.feature, self-assert within leash
    status: completed
  - content: Seam — SessionOpenOptions.ratio + env, both adapters (Gap B/C)
    status: completed
  - content: layout.ts — schema, parseLayout, validateLayout, desugar (pure)
    status: completed
  - content: layout-store.ts — LayoutStore seam on CliDeps, resolution order
    status: completed
  - content: layout-session.ts — the walk + apply manifest
    status: completed
  - content: cli.ts — layout list|show|validate group; --layout on open + worktree add
    status: completed
  - content: Fix impl-gate findings — root-leaf env honored at region tier, root-leaf dir honored or warned+reported honestly
    status: completed
  - content: Impl gate — cold impl-judge over frozen scenarios
    status: completed
  - content: Handoff — PR closing #5, changeset, follow-ups
    status: completed
---

# CR 5 — layout templates

Named, reusable pane-layout templates applied against a target cwd. Source: issue #5.
Design: [`docs/design/layout-templates.md`](../../docs/design/layout-templates.md) (in-repo, tracked).

## Scope (decided at intake)

- **Core only.** Schema + desugar + store + the walk + `layout list|show|validate` + `--layout` on
  `open` / `worktree add`. **`layout export` (design §6.4) deferred** — it needs a new portable
  report-region-geometry seam verb on both adapters.
- **`--if-populated` and `--dry-run` cut from v1** (design §6.5 flagged both as open). Cutting
  `--if-populated` also drops §9.3's cwd heuristic — the design's own self-named weakest joint.
- **Node:** new `layout/` capability, `packages/cyber-mux/.agents/spec/layout/`.

## Prereq state (verified post-rebase, not assumed)

- **Gap A is real** — `from?: SessionTarget` (`session.ts:30`), `callerPane` (`backend.ts:30`), both
  threaded through `cli.ts`. Landed on main as "split the calling pane, not whichever pane is
  focused"; this branch was behind and has been rebased onto it.
- **Gap B (`ratio`) and Gap C (`env`) are NOT in the seam** — both absent from
  `SessionOpenOptions`. Both are native on both backends per the design's live probes; this CR adds
  the seam fields and wires them.
- No `layout` code exists anywhere under `src/`.

## Conventions

- Suite: one `.feature` per behavioral node, feature-level `@frozen`, `# ── stage ──` sections,
  boolean scenarios, `Scenario Outline` + `Examples` for per-backend pairs. Match `mux/mux.feature`.
- Tests: co-located `*.test.ts`, mocked `Exec`, no real multiplexer. `*.integration.test.ts` is the
  opt-in tier.
- Published-package change ⇒ needs a changeset.

## NEXT

Nothing — the mission landed. PR #7 carries the CR and closes #5 on merge; the project spec is at
`implemented` with both gates recorded. Five backlog follow-ups were recorded and filed as #8–#12.

Keep this brief until #7 merges and is doctrine-distilled.
