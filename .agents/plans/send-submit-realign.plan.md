---
todos:
  - content: Draft mux.feature scenarios + README use case for the send/submit contract
    status: completed
  - content: Spec gate — judge suite/spec, freeze if approved
    status: completed
  - content: Split SessionAdapter.send into sendText/sendKeys; submit takes optional text
    status: completed
  - content: Update nudge.ts, cli.ts (send becomes a group), and open()'s launch call site
    status: completed
  - content: Update tests (tmux/herdr unit + integration, nudge, cli)
    status: completed
  - content: Impl gate — verify every frozen scenario, run pnpm verify
    status: completed
  - content: Changeset + commit + handoff
    status: in_progress
---

# Realign the send/submit verbs

CR: split the turn-driving verbs so text and keys are separate intents and only `submit` presses
Enter.

- `send text <pane> <text>` — type literal characters, no Enter. A word naming a key (`Enter`, `Up`)
  is typed, never interpreted. tmux `send-keys -l -t <pane> <text>`; herdr `pane send-text`.
- `send keys <pane> <keys...>` — press named keys in order, typing nothing. Core vocabulary
  `Up Down Left Right Enter Escape Tab Space Backspace C-c F1..F12`, normalized per backend
  (`Backspace` → tmux `BSpace` is the ONLY rename); a non-core token is forwarded verbatim to the
  backend's own semantics. tmux `send-keys -t <pane> <keys...>`; herdr `pane send-keys`.
- `submit <pane> [text]` — type optional text, then always Enter. Guarantee is the OUTCOME (text
  typed literally, then Enter), never a pinned command: herdr `pane run` is atomic; tmux composes
  `send-keys -l -t <pane> <text>` THEN `send-keys -t <pane> Enter` (two calls — `-l` would type a
  trailing `Enter` argument as characters). No text, or empty text: bare-Enter flush.
- bare `send` — help to stderr, exit 1, stdout clean (commander's default).

Today `send(pane, text)` always types+submits and `submit(pane)` only ever sends a bare Enter. After
this: `SessionAdapter.send` splits into `sendText` + `sendKeys` (neither presses Enter), and `submit`
gains optional text while keeping its bare-flush behavior.

**Design provenance.** The CR's original design ("`send` = thin passthrough over the mux's own
send-keys primitive") rests on a false premise — the backends share no such primitive — and was
revised across four requester-approved pivots during explore. Every decision, its probe evidence, and
its accepted costs are logged in `packages/cyber-mux/.agents/spec/design/decisions/README.md`, which
is the single home for that rationale; do not restate it in the spec node or re-derive it here.

Key probe facts the impl must honor (measured, not inferred):
- herdr `pane send-keys` accepts ONLY `C-c` of all 26 `C-<letter>` forms; rejects `Home End Delete
  Insert PageUp PageDown S-Tab` and every `M-` form; accepts `Esc` and `F13`+.
- tmux NEVER errors on `send-keys` — it types an unrecognized token as literal characters. So `Esc`,
  `Backspace` and `F13` are typed, not pressed, on tmux.
- `session.herdr.ts:81`'s comment ("`pane run <id> \"\"` is a no-op in herdr") is STALE — it presses
  Enter. The bare-Enter implementation stays; the comment's reason must be corrected.

Out of scope: `nudge.ts`'s own removal/keep decision stays undecided — keep nudge working under the
new contract (initial turn `submit(exec, target, message)`, flush retry bare `submit`), decide
nothing about its future.

Target: `cyber-mux/mux` (`packages/cyber-mux`).

Freeze note: project spec is `status: draft` and `mux.feature` has zero `@frozen` scenarios; the
suite had NO send/submit scenarios before this CR — purely additive. No narrowing, no freeze
re-open, no Clearance floor.

Compatibility note: deliberate breaking change to `SessionAdapter` and the CLI verb surface,
authorized by the CR itself. Package is `0.0.0` (pre-1.0) → changeset is `minor`.

Touched: `src/session.ts`, `src/session.tmux.ts`, `src/session.herdr.ts`, `src/nudge.ts`,
`src/cli.ts`, the five affected test files, `.agents/spec/mux/` (README + feature),
`.agents/spec/axi/README.md` (the #8 amendment), and the new `.agents/spec/design/decisions/`.

## NEXT
Both gates PASSED; node is `status: implemented`. Rebased onto the current target (absorbed a
`--label` feature and a worktree-capability refactor that landed meanwhile); `pnpm verify` green,
193 tests, and the cold impl-judge verified all 16 CR-added frozen scenarios against LIVE tmux +
herdr, reproducing the pre-change fault first to prove its probe discriminates.

Remaining: push the branch and open the PR (delivery shape is branch -> PR). Nothing else is open.

Two follow-ups are filed in the ledger shard, neither blocking:
- the command-runner seam swallows backend failures, so a refused key reports success to the caller
  (pre-existing, affects every verb, found at the impl gate);
- whether the shared output contract should carve out a bare command group with no live view.

Carried in this commit deliberately: a repair of three malformed Scenario Outlines that landed on
the target with placeholders their Examples tables never declared. They fail the target's own
structural check independently of this work; this mission froze the file, so it repaired them by
adding the missing columns. Flagged for the reviewer — the invented values (`my-feature`, `my-unit`)
are this mission's, not their author's.
