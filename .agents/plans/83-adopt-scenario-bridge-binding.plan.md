---
cr: 83-adopt-scenario-bridge-binding
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/83
status: draft
todos:
  - content: "Explore: slug convention + build-to-learn bind cli/worktree (31) — DONE 24/31, 7 gaps, hoist trap found"
    status: completed
  - content: "Explore: record the @id: binding convention as a design/ doctrine node — DONE (design/README + decisions ADR)"
    status: completed
  - content: "Explore: tag remaining 13 .feature suites with @id: slugs — DONE (281/281 tagged, additive)"
    status: completed
  - content: "Spec gate: all 14 suites @id:-tagged, node-unique, freeze self-clears — DONE (self-asserted, ledger seq 2)"
    status: completed
  - content: "Deliver: rebind every test — DONE. 261/281 bound, 0 fail (19 recovered in reconcile); dead-fixture cleanup; pnpm verify GREEN (811+8 tests, biome+typecheck clean)"
    status: completed
  - content: "Impl gate: bridge 261/281 bound+pass 0 fail + pnpm verify green; cold impl-judge APPROVE (4/4); user-ratified — DONE (ledger seq 3)"
    status: completed
  - content: "Handoff: 2 commits, PR #85 (Closes #83), followups ledger seq 4-11, umbrella issue #86 — DONE"
    status: completed
---

# CR 83 — adopt the SDD scenario-bridge @id: binding convention across cyber-mux suites

Bind every acceptance `Scenario:` in the 14 frozen `.feature` suites to its proving test so the
impl-gate scenario-bridge (`verify-scenarios`) reports BOUND instead of UNBOUND. Source: issue #83.

## Scope (decided at intake, user-ratified)

- **Full sweep now.** All 14 suites (281 scenarios) + their tests, this mission. The issue suggested
  per-node-as-touched; the user chose the full sweep.
- **Mechanism = `@id:<slug>` tags.** Every `Scenario`/`Scenario Outline` gets an `@id:<slug>` tag
  (the bridge's primary convention; verbatim-title is the fallback we are NOT using). The test binds
  by leaf title `= @id:<slug>` under an exact `describe('spec:cyber-mux/<node>', ...)` wrapper.
- **No behavior change.** Adding `@id:` tags is additive/non-narrowing → **freeze self-clears**, no
  re-open. Retitling tests changes no assertions.

## Two independent breaks (both must be fixed per node)

1. **Wrong-grained node wrapper.** Tests wrap with `describe('spec:cyber-mux/mux')` /
   `.../template` — coarse. Bridge matches `r.node === node` (exact), so it never equals the leaf
   node the impl-judge passes (`cyber-mux/cli/worktree`, `cyber-mux/mux/worktree`, ...). Fix: regrain
   the wrapper to the exact node; one test file may need several node wrappers.
2. **Non-matching leaf titles.** `it('add() runs git worktree add ...')` matches no scenario. Fix:
   retitle to the scenario's `@id:` slug.

## Slug convention (@id:)

- kebab-case, derived from scenario intent; **unique within a node** (key = node-path + slug is
  globally unique — no cross-node collision worry).
- Scenario Outline = ONE key (one `@id:` on the outline); the table-driven test gets a **static**
  leaf title = that slug (no per-row interpolation).

## Verification (the bridge is the oracle)

- Per node: `verify-scenarios --run --node cyber-mux/<node> --feature <f> --feature-root . --root
  packages/cyber-mux` → every scenario BOUND + PASS, 0 UNBOUND.
- `gherkin-cli diff --base <baseref> <feature>` — tag additions read additive (no narrowing).
- `pnpm verify` — build + typecheck + lint + test + biome, full green.
- Config already present: `packages/cyber-mux/.agents/sdd/scenario-bridge.toml`;
  `.scenario-report.xml` already gitignored.

## Watch for (exemplar learnings — brief every deliver agent with these)

- **THE HOIST TRAP.** The bridge takes the FIRST `spec:` segment in the ` > `-joined describe chain
  and STOPS. `cli.test.ts` wraps everything in `describe('spec:cyber-mux/mux') > describe('cli')`, so
  a *nested* `describe('spec:cyber-mux/cli/X')` is shadowed and stays UNBOUND. Fix: **hoist** each
  `cli/X` (and any mis-nested node) to a **top-level** `describe('spec:cyber-mux/cli/X', ...)`,
  mirroring the existing top-level `describe('spec:cyber-mux/template')` (give it its own
  `logs`/`beforeEach`/`afterEach`). Applies to nearly every cli/* node.
- **Coverage gaps are real and expected.** cli/worktree bound 24/31 — 7 scenarios have NO
  CLI-surface test (only library-seam tests in worktree-session.test.ts). Do NOT fabricate a binding;
  record each as a `backlog` follow-up (a cli/X scenario lacking a direct CLI test). The impl gate
  will show these UNBOUND; the impl-judge hand-derives them (the pre-existing state) — net improvement,
  not a regression.
- **Surface vs library split.** A test calling `gitWorktreeAdapter.add()` / `removeWorktree()` /
  `isWorktreeRemovable()` directly proves the LIBRARY node `mux/X`; a test driving `run(program,
  ['worktree', ...])` proves the CLI node `cli/X`. Route by what the test actually calls.
- **Scenario Outline = one static `it` title** = the slug; a single-row `it` is a valid proof.
- **Extras are harmless** (a real test with no frozen scenario) — leave them.
- **File-collision rule for deliver:** partition test-binding by TEST FILE, one agent per file, never
  two agents on one file. `cli.test.ts` (huge, many cli/* nodes) = ONE agent, sequential.

## NEXT

Mission landed. Both gates passed (spec self-asserted within leash; impl user-ratified after a cold
impl-judge APPROVE). **PR #85** open, `Closes #83`. Final: **261/281 bound, 0 fail**, `pnpm verify`
green, behavior-neutral. The 20 coverage gaps → **issue #86** (agent-filed umbrella) + ledger seq 4-11.

Remaining, neither blocks the CR:
1. **Merge #85.** Pre-push suite green; CI is the shared reusable workflow.
2. **Retire this plan** once #85 merges (source #83 auto-closes) and the CR is doctrine-distilled;
   the combat log (`*.log.jsonl`) is deleted at that retro.
3. A corpus-wide **formation pass** is optionally due (`sdd:manage` → audit corpus structure) — the
   binding sweep touched every node's tests but changed no node shape; not gated on it.
