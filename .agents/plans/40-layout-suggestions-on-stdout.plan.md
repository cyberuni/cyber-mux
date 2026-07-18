---
cr: "40-layout-suggestions-on-stdout"
source: "github#40"
project: cyber-mux
status: exploring
todos:
  - content: "Explore grill: 3 decisions settled; axi 'what ships today' sync-scope still OPEN"
    status: in_progress
  - content: "Draft layout/: re-open 2 frozen layout.feature scenarios + add --format json scenario; 3 README prose edits"
    status: completed
  - content: "Draft mux/: additive worktree grouping-hint scenario + 1 README prose edit"
    status: completed
  - content: "Draft axi/ reference node #9 + 'what ships today' — BLOCKED on sync-scope decision"
    status: pending
  - content: "Dispatch cold spec-judge over CR diff; run spec gate; freeze; self-assert/ratify"
    status: pending
  - content: "Deliver: printHelp renderer in output.ts; move cli.ts:252 + :587 into stdout help[]; update cli.test.ts; rebase; impl gate"
    status: pending
  - content: "Handoff: PR with Closes #40, changeset (user-facing CLI change), drain follow-ups"
    status: pending
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

**Next action:** resolve the ONE open blocking decision below, then write the `axi/README.md` edits
(`#9` section ~L157-184 + "What ships today" ~L224-242), then dispatch the cold `sdd:sdd-spec-judge`
over the CR diff and run `sdd:spec-gate`. Everything else in layout/ and mux/ is drafted already
(see the diff / commit).

**Blocking decision (was mid-grill when paused):**
- **axi "What ships today" sync scope.** That section is a **stale pre-#36-deliver snapshot** —
  verified against source: `reportError` writes stdout (`cli-error.ts` `console.log`), `fail()` no
  longer exists, backend text is translated; yet the node still says errors report "on stderr",
  "every other failure is free text through one `fail()` helper", "raw backend text, leaked", under a
  header claiming "verified against source." My #9 edit flips the "two #9 suggestions" line to stdout,
  which makes the section internally inconsistent unless the siblings are synced too.
  - **Option A (I recommended):** fold the full source-verified re-sync into this CR (errors→stdout,
    `fail()`→`CliError`, backend text translated, + the two #9 suggestions). Same reference node,
    **no behavior/.feature change** for the error paths (already shipped in #36) — pure doc-sync.
    Bigger diff, touches #36's snapshot.
  - **Option B:** edit only the two #9-suggestion facts; file a follow-up for the broader staleness.
    Keeps #40 tight; leaves the section inconsistent + "verified against source" partly false until
    the follow-up lands.
  - User rejected the question to pause — **decision still owed before axi/ can be written.**

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
