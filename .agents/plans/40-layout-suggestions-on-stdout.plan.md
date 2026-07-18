---
cr: "40-layout-suggestions-on-stdout"
source: "github#40"
project: cyber-mux
status: implemented
todos:
  - content: "Explore grill: 4 decisions settled (axi sync-scope = Option A full re-sync)"
    status: completed
  - content: "Draft layout/: re-open 2 frozen layout.feature scenarios + add --format json scenario; 3 README prose edits"
    status: completed
  - content: "Draft mux/: additive worktree grouping-hint scenario + 1 README prose edit"
    status: completed
  - content: "Draft axi/ reference node #9 + 'what ships today' — Option A full re-sync (DONE, source-verified)"
    status: completed
  - content: "Dispatch cold spec-judge over CR diff; run spec gate; freeze; self-assert/ratify (DONE: R2 all lenses PASS, ALIGNED true; self-asserted by agent — provisional, ratify-or-kick-back)"
    status: completed
  - content: "Deliver: printHelp renderer in output.ts; moved the two writes to stdout help[]; save gained --format json; rebased onto origin/main; impl gate PASS (DONE)"
    status: completed
  - content: "Handoff: PR with Closes #40, changeset (user-facing CLI change), drain follow-ups"
    status: in_progress
---

# CR: two layout suggestions to stdout (AXI #9)

Source: github#40 — https://github.com/cyberuni/cyber-mux/issues/40

## Resolved decisions (do not relitigate)

1. **save → structured by default.** `layout save` stdout becomes a structured payload (a `path`
   field + optional `help[N]:` block), not a bare path. `$(...)` composition moves to
   `--format json | jq -r .path`. Ratified in-session (the "structured by default" grill choice,
   shown with the composition-change preview) — this ratifies the path-1 frozen re-open (Clearance).
2. **Path 2 (worktree grouping hint) is IN scope.** Moved to a stdout `help[]` field too.
3. **help entry shape = `{ message, command }`.** json: `help: [{message, command}]`; text: a
   `help[N]:` block, message line + indented `-> <command>`. Dynamic values are placeholders, never
   guessed concrete ids (#9).
4. **axi "What ships today" = Option A, full source-verified re-sync.** Fold the whole re-sync into
   #40: errors→stdout, `fail()`→`CliError`, backend text translated, + the two #9 suggestions on
   stdout. No `.feature`/behavior change (all error paths shipped in #36); pure doc-sync of the axi
   reference node. Confirmed against source this session: `cli.ts` has zero `fail(`/`console.error`,
   19 `reportError`/`throw new CliError`, `cli-error.ts:86 reportError` writes stdout via
   `console.log`. Ratified by user (grill choice, shown with the source-verified preview).

## The two paths (NOT symmetric)

- **Path 1 — `layout save` truncation note** (`packages/cyber-mux/src/cli.ts:587`,
  `noteTabsLeftOut`). Genuine frozen re-open. Because of decision 1 it re-opens **two** frozen
  `layout.feature` scenarios (the bare-save "says what it left out", and "save writes … the path"),
  and adds a `--format json` shape scenario. Clearance fires, ratified.
- **Path 2 — worktree grouping hint** (`cli.ts:252`, `reportOpenedWorktree`, used by `worktree
  add`/`worktree open`). Issue #40 calls it `open` — **wrong verb**. Pinned only by the
  **stream-agnostic** `mux.feature:1238` ("the caller is told the placement cost the grouping"), so
  moving it to a stdout `help[]` field is **additive → no re-open**. Follow-up #36 ledger seq 6's
  "needs a cleared re-open of the layout suite" is wrong for this half.

## NEXT — resume here

**Spec gate LANDED (provisional, agent-asserted — ratify or kick back).** R2: oracle/builder/
architect all PASS, ALIGNED true, no blocker, no open markers. Applied approve: both features stay
`@frozen` at new content, `approval.spec` in spec.md overwritten with #40's block (`by: agent`,
`cause: dimension`), project `status: implemented → approved`, ledger shard seq 2 gate line appended.
The layout Clearance rests on prior-session Resolved decision #1 (composition change ratified with
preview); this gate self-asserts the verdict on top of it and lands in the async review queue.

**IMPL GATE LANDED (provisional, agent-asserted).** Cold sdd-impl-judge: IMPLEMENTATION_PASS true,
all 4 frozen scenarios pass (3 layout driven on the REAL binary in a live tmux session; the herdr
grouping-hint scenario via mutation-backstop since herdr wasn't available live), no blocker, no
absorption findings, changeset confirmed, verify 7/7 · 601 tests. spec.md `approval.impl` overwritten
with #40's block, project `status: approved → implemented`, ledger seq 3 impl gate line appended.
Non-blocking observations carried to handoff follow-ups: (a) no `--format json` test for the degraded
worktree add/open case (symmetric trivial path); (b) recommend a live-herdr smoke pass in CI for the
grouping-hint scenario.

**Next action — HANDOFF (todo 7):** push the branch, open a PR with `Closes #40`, drain follow-ups.
Branch was rebased onto `origin/main` (569b10b, the squashed #37 error surface) — a clean linear
history of 4 #40 commits. Nothing pushed yet.

**Historical: DELIVER (todo 6) — DONE:** made the two re-tensed axi claims true in source.
1. Add a `printHelp(entries)` renderer to `output.ts` — text `help[N]:` block (message line + indented
   `-> <command>`); json emits `help: [{message, command}]`.
2. `layout save` → `output({path, help}, () => { printFields({path}); printHelp(help) })`; `help` carries
   the truncation-reveal entry (placeholder `<command>` for the workspace capture) only when tabs were
   left out. This is the frozen layout.feature contract: bare-save reveal, path-on-stdout, `--format
   json` `{path, help}` object.
3. `reportOpenedWorktree` (cli.ts:252) → move the grouping hint off `process.stderr.write` into a `help`
   field on the payload, populated only when `opened.degraded`. `noteTabsLeftOut` (cli.ts:588) → same,
   off stderr into the save payload's help.
4. Update `cli.test.ts` for the moved streams. Legit stderr writes that STAY: cli.ts:345 (apply-failure
   diagnostic), :545 (capture dir-outside-root warnings, pinned by layout.feature as stderr warnings),
   :1181 (commander).
5. Rebase onto target tip, run `pnpm verify`, dispatch cold `sdd:sdd-impl-judge` at the impl gate.
Then handoff (todo 7): PR `Closes #40`, changeset (user-facing CLI output change), drain follow-ups
(the `worktree-failed` backend-text residual; the `worktree add --format json` scenario gap the
spec-judge observed).

**Spec-gate round 1 (this session):** structural checks all green. Edit-class: layout.feature MIXED
(2 frozen re-opens → Clearance, pre-authorized per Resolved decision #1); mux.feature ADDITIVE
(self-clears). Cold judge: oracle PASS, builder PASS, **architect FAIL / ALIGNED false** — caught a
**false-tense** defect: my axi #9 re-sync wrote the two suggestions' stdout move as *delivered*, but
source (`cli.ts:250` reportOpenedWorktree, `:586` noteTabsLeftOut) still writes **stderr** — deliver
(todo 6) hasn't run. Fixed: re-tensed the 3 #9 spots to contract voice (built-on-stderr-today, this
CR sets the contract, deliver performs the move). Amended into the axi commit; re-verify dispatched.

**Blocking decision — RESOLVED (Option A, source-verified & ratified).** See `## Resolved decisions`
#4. The axi node's "What ships today" + the #6 narrative + #9 paragraph were all re-synced to the
post-#36 reality (errors→stdout via `reportError`, `fail()` gone, exit-2 usage split, two #9
suggestions on stdout). One honesty residual recorded IN the node, not hidden: the generic
`worktree-failed` catch-all (`reportWorktreeFailure`, cli.ts:125) still forwards raw backend text —
listed under "what still trails the contract."

**Source-verified code names cited in the axi node (checked this session):** `layout-not-found`,
`invalid-template`, `layout-apply-failed`, `worktree-failed`, `unknown-flag`/`usage-error` (exit 2),
`ambiguous-pane`. `cli.ts` has zero `fail(`/`console.error`; `reportError` (cli-error.ts:86) writes
stdout.

**Findings the diff won't show:**
- The `--format json | jq -r .path` composition path assumes `save` honors `--format json` with a
  `{path, help}` object — `save` currently just `console.log(path)` and does NOT emit a structured
  json object. Deliver must ADD that json shape (via `output(...)`), not just move a stream.
- Deliver mechanics: add a `printHelp(entries)` renderer to `output.ts` (text `help[N]:` block);
  `save` becomes `output({path, help}, () => { printFields({path}); printHelp(help) })`;
  `reportOpenedWorktree` gains a `help` field on the payload (populated only when `opened.degraded`).
  Legit stderr writes that STAY: `cli.ts:345` (apply-failure diagnostic), `:545` (capture
  dir-outside-root warnings, pinned by `layout.feature` as stderr warnings), `:1181` (commander).
- Changeset owed at handoff (user-facing CLI output change).

**Working method / provenance:** ledger shard
`packages/cyber-mux/.agents/spec/ledger/40-layout-suggestions-on-stdout.1e0db2.jsonl` (run-start
leash, seq 1). SDD default squad (no plugin registry). See `## Resolved decisions` above — do not
relearn the three settled calls.
