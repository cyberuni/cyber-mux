---
spec-type: reference
concept: [axi]
---

# axi — the Agent Experience Interface output contract

A **reference artifact**: the shared output contract every `cyber-mux` CLI command follows so an AI
agent spends the fewest tokens per interaction. It adopts
[AXI](https://github.com/kunchenguid/axi) (Agent Experience Interface) — a design framework whose
principles treat the agent's token budget as a first-class constraint. `cyber-mux` is driven almost
entirely by AI agents orchestrating panes (open/send/read/focus/close), yet its output today
(`packages/cyber-mux/src/output.ts`) is human-prose-first with `--format json` as the escape — the
inverse of what an agent wants. This node states the cross-cutting conventions **once**; each
behavioral node ([`mux/`](../mux/README.md)) references this contract for its own commands'
scenarios.

> `cyberplace` (`.agents/specs/cyberplace/axi/`) and `packages/universal-plugin` (its ADR-0003)
> adopt this same contract, so an agent moving between bins sees one interface. **One deliberate gap
> today:** those nodes still put errors on **stderr**, where AXI says stdout — this node used to
> state that inversion word for word and no longer does (#6). The fix is theirs to land and is
> **recorded as a follow-up**, not ridden in from here; until it does, this bin conforms to AXI and
> they do not. Where
> this node and a sibling disagree, **AXI is the tiebreaker** — none of the three is the contract, all
> three adopt it. One open question — see **#8**.

## Subject

- **Artifact** — the AXI output contract, realized as shared CLI-output conventions in
  `packages/cyber-mux/src/` (`cli.ts` + the shared `output.ts`), not a separate shipped file. Every
  command's interface layer honors it.
- **Scope of adoption** — AXI principles **#1–#6 and #8–#10**. Principle **#7** (ambient context) is
  **out of scope here** — `cyber-mux` has no install/skill-surfacing concern of its own; a caller
  that wants ambient session-hook wiring composes it from the `cyberlegion` plugin, not this CLI.

### The contract surface (the conventions a command must satisfy)

1. **Token-efficient output (#1)** — a result- or list-shaped command (`list`, `doctor`, `mode`,
   `exists`) emits [TOON](https://toonformat.dev/) by default (~40% fewer tokens than JSON).
   `--format json` stays an explicit escape hatch (the existing structured shape); free-form human
   prose is never the default for a structured result. `cyber-mux`'s current `--format text|json`
   (with `agent` reserved but unused) collapses toward TOON default + the `json` escape.
2. **Minimal default schema (#2)** — a list/result row carries **3–4 fields**, not every field
   (`list` → `pane, label, harness, cwd`; `doctor` → `mux, via, pane, backend`). Full detail is
   reached through `--full`, never dumped by default.

   **A field earns its slot by discriminating, not by being known.** `list` reports no `mux`, though
   it knows it: one adapter is selected per session, so every row of a listing carries the *same*
   value and the column separates nothing — the ceiling is better spent on `label`, which is what a
   caller types instead of an id ([`mux/`](../mux/README.md)'s pane addressing). The backend is a
   live question for `doctor`, which is discovering it, and a settled one for `list`, which already
   ran through it. This example previously read `pane, mux, harness` and was stale on two counts —
   `cwd` had long been a fourth column, and `mux` was noise.
3. **Truncation + `--full` (#3)** — a large text body (`read` with no `--lines` on a long-running
   pane) is truncated with a size hint (`… +240 lines — rerun with --full`) unless `--full` is
   passed. `--full` is the universal escape hatch that suppresses truncation; `--format json` is
   never truncated.
4. **Pre-computed aggregates (#4)** — every result carries a summary of counts and statuses inside
   the structured payload, so the agent needs no follow-up round trip (`list` → `N panes across the
   <backend> backend`).
5. **Definitive empty states (#5)** — an empty result states so explicitly (`0 panes live`) with
   exit 0; `list` today already prints `(none)` for this case — never blank output an agent must
   guess at.
6. **Structured errors, exit codes, no prompts, fail-loud (#6)** — mutations are idempotent; errors
   are structured (a stable `code` + message + an actionable `help:`, honoring `--format`) and are
   written to **stdout**, the stream AXI reserves for everything the agent consumes; exit `0` =
   success (including no-ops), `1` = error, `2` = usage error — **AXI's set, restated in full**, with
   **one recorded exception below** (`exists`); commands **never** prompt interactively (already true
   — `cyber-mux` has no interactive prompts);
   an **unknown flag fails loud** at `2`, naming the flag and listing the command's valid flags, so
   the agent self-corrects in one turn rather than spending a round trip on `--help`.

   **`2` is AXI's own third code, and this node had dropped it.** AXI states the set as `0` = success
   (including no-ops), `1` = error, **`2` = usage error** — the status for an unrecognized flag or
   argument, and for a missing required parameter. The `0`/`1` above is not a *narrower adoption* of
   that set; it is an **incomplete restatement** of it, and the omission was never argued. So nothing
   here is an amendment: `cyber-mux` adopts AXI's set as written.

   **An ambiguous locator is a usage error.** `2` separates *your invocation is wrong, fix it and
   retry* from `1`'s *your invocation was fine, the operation failed*. `cyber-mux read worker` when
   three panes are labeled `worker` is the first: the argument is underspecified, nothing was
   attempted, and the fix is a different argument — the same shape as a missing required parameter,
   which AXI already puts here. It also lands in AXI's error form exactly, `error:` naming what went
   wrong plus an actionable `help:` — each candidate's id IS the retry
   ([`mux/`](../mux/README.md)'s pane addressing, `ambiguous-pane`). A predicate framing (`grep`,
   POSIX `test`, `diff`, `pgrep` all reserve a code for *couldn't answer*) reaches the same code by a
   different road; where the two disagree, AXI wins here, because it is the contract this node
   adopts.

   **This node used to record two divergences from AXI as though they were the contract. The text
   above no longer states them.** Each was a default or an omission restated without argument, and
   each reached every command through the one `fail()` helper and its 22 call sites — which is why
   correcting them was a single pass rather than three (the #36 error-surface CR), and why neither
   could ride in on one error path:

   - **An unknown flag exiting `1`, where AXI says `2`.** Commander's default. The contract above puts
     it at `2` — the same status as the missing required parameter AXI names, and the same one a bare
     command group leaves (see #8).
   - **Errors on stderr, where AXI says stdout.** AXI is explicit that stdout carries "data, errors,
     suggestions" precisely "so the agent can read and act on them", and that stderr is debug/progress
     that "agents don't read" — so an agent-facing report on stderr is a report its own reader never
     sees. Load-bearing, not cosmetic.

     It was never a `cyber-mux` slip: `cyberplace`'s node states the inversion identically, word for
     word, so it was the org's adoption that diverged rather than this bin. **This node no longer
     claims it.** This bin's own impl now reports errors on **stdout** (the #36 CR); what remains a
     **follow-up** is reconciling the sibling `cyberplace` node's identical stderr wording — a node
     this bin does not own — not any impl change here.

   Both are now **built** in this bin (the #36 error-surface CR): the unknown flag leaves `2` and every
   error reports on stdout. See *Impl trails the contract* for the full account of what ships today.

   **The one exception to the code set: `exists` spends `1` on `gone`.** `exists` is a predicate, and
   `gone` is the answer to the question rather than an error — so its `1` is not the `1` this set
   defines. That is the framing `grep`, POSIX `test` (normative) and `systemctl is-active` all take,
   and [`mux/`](../mux/README.md) keeps it deliberately. It is a **genuine divergence from AXI**, named
   here so the tiebreaker above ("where this node and a sibling disagree, AXI wins") does not silently
   overrule a decision this project means to keep. It is **not** an amendment, and this node used to
   call it one — wrongly twice over: the set was always `0`/`1`/`2`, so nothing was amended, and what
   `exists` actually diverges on is the *meaning* of `1`, which no amendment ever covered. Whether to
   keep it is open; the error-surface pass corrected the label, not the behavior.

7. *(#7 ambient context — out of scope, see Scope of adoption above.)*
8. **Content-first (#8)** — **`cyber-mux` invoked with no arguments** shows the most relevant live
   content, not a usage manual. That is AXI's rule as written, and its scope is the **bare binary**:
   "running your CLI with no arguments", its example being `$ tasks`. **`cyber-mux` has no such home
   view today** — bare `cyber-mux` prints help. That is this node's one real #8 divergence, it is
   unbuilt rather than argued away, and it is recorded in *Impl trails the contract* with the rest.

   **What #8 does not say — and what this node used to claim it said.** This bullet previously opened
   "a **command group** invoked with no subcommand shows live data", extending AXI's bare-binary rule
   to every group on the surface. AXI says nothing about a group with no subcommand. The extension may
   well be the right reading — a data-bearing group like `worktree` arguably owes its view for exactly
   AXI's reason — but it is **this node's extension, not AXI's text**, and it was never argued as one.
   That is the same defect that dropped `2` from #6's code set: a local paragraph restating the source
   into something the source does not say, then being read by later work as the contract. Whether the
   contract *should* extend #8 to groups is **open** and belongs to AXI, not to `cyber-mux`; nothing is
   asserted here about the other adopters.

   **Bare `send` is decided by #6, not by #8.** It writes help to **stdout** and **exits 2** because it
   is **incomplete input** — a missing required parameter, which #6 already puts at `2`. No
   content-first reasoning is needed or used: `send` drives a pane and has no view of its own (every
   view it could render already belongs to `list` or `doctor`), but that only explains why no home view
   is owed — it never made bare `send` an #8 case. It sat at `1` for the same reason an unknown flag
   did: commander's default restated as the contract without argument. The suite had frozen that `1`,
   so correcting it re-opened a frozen scenario and was cleared at the gate rather than patched. An
   earlier reading here ("and no third exit code") was a claim about the code **set** and was simply
   false — AXI always had three. What it defended — that `send` invents no code of its own — still
   holds, and holds better now that `send` uses AXI's.

   **Bare `worktree` is untouched, on scope alone.** `worktree` (`add`/`open`/`list`/`remove`) is a
   group on this surface and, unlike `send`, is data-bearing (`worktree list` is its live view). Its
   bare form ships help + exit 1 today and **keeps doing so**: the error-surface pass corrects the
   `worktree` *subcommands*' failures like every other verb, and the bare group is outside what that
   pass was scoped to. An earlier draft justified leaving it alone by arguing #8 wants it to print its
   listing and exit `0`, so moving it to `2` would entrench the answer #8 rejects — that argument is
   **withdrawn**, resting on the widening retracted above. The conclusion stands on scope; the reason
   it was given for does not. The bare-group question stays owned by the worktree capability.
9. **Contextual disclosure (#9)** — a command that leaves an obvious next move names it, as a
   `help[N]:` block **on stdout inside the structured payload** (`cyber-mux focus <pane>` after
   `open`; `cyber-mux read <pane>` after `submit`), so an agent discovers the surface by using it.
   Dynamic values are **placeholders** (`<pane>`), never a guessed concrete id. On an error, the
   suggestion names the command that **fixes** it — never "see `--help`".

   **Not every command owes one.** AXI is explicit that a suggestion is **omitted when the output is
   self-contained** — a detail view, a count, a confirmation answers the query, and a next step
   appended to it is noise the agent pays for. So `list` and an empty result earn one; `exists`,
   which answers exactly the question asked, does not.

   **This node previously required the opposite, and on the wrong stream**, calling for a next-step
   line from *every* command and routing it to **stderr**. Both halves were wrong: the "every"
   contradicts AXI's omit rule, and the stream is the same inversion #6 carried — AXI lists
   "suggestions" beside data and errors as what **stdout** is for, and renders them in the payload
   rather than as prose beside it. Neither half was ever argued; #6's inversion was simply restated
   here.

   **#9 is not "unimplemented", as this node used to claim — it is built, on the wrong stream, and
   this CR is the contract that moves it.** Two suggestion paths ship today, both on **stderr**:
   `worktree add`/`open` names the flag that would have grouped what it just placed (`src/cli.ts`,
   `reportOpenedWorktree`), and `layout save` reveals that a workspace holds more tabs than were
   captured (`noteTabsLeftOut`). The second is AXI's *Reveal truncated lists* case verbatim — load-
   bearing scope information sitting on the stream AXI defines as unread. This CR **sets the contract**
   that moves them into the structured payload on **stdout** as `help[N]:` blocks — re-opening the
   [`layout/`](../layout/README.md) frozen scenarios under a ratified Clearance for `save` and landing
   the worktree hint additively (it was only pinned stream-agnostically); its deliver step performs the
   move, and until it lands both still write stderr. Saying the principle was unbuilt would have hidden
   two live counter-examples behind a word — the same move that let #6's dropped code and #8's widening
   survive this long.
10. **Consistent help (#10)** — two halves, and this node used to state only one.

    - **Per-subcommand `--help`** — every subcommand answers `--help` with a concise, complete
      reference: flags with defaults, required arguments, and 2–3 usage examples, scoped to the
      subcommand asked about rather than the whole manual. Largely true via commander's built-in
      `--help`; the examples are still to add.
    - **The home view identifies the tool** — AXI also requires the no-argument view to carry the
      current executable's absolute path with `$HOME` collapsed to `~`, and a one-sentence description
      of what the tool is, before any live data. **This node had dropped that half entirely**, the same
      way #6 had dropped `2` from the code set: an omission, never an argued narrowing. It is unbuilt —
      `cyber-mux` has no home view at all (#8) — and both halves of that gap are one missing surface,
      recorded in *Impl trails the contract*.

### Stream discipline (how the surface is realized)

- **stdout** carries **everything the agent consumes** — the TOON (or `--format json`) payload with
  its aggregate summary (#4), the `help[N]:` suggestions (#9), and structured errors (#6). This is
  AXI's own split, and it is not arbitrary: stderr is defined as the stream agents **don't read**, so
  anything an agent must act on belongs here. `read`'s captured pane output is the one exception: it
  is the pane's own byte stream, not a structured result, and stays raw on stdout.
- **stderr** carries **diagnostics only** — warnings, progress, debug. Nothing on stderr is ever load-
  bearing for the agent; discarding it entirely loses no part of the answer.

**An error on stdout does not corrupt the result, and the exit code is why.** The worry this section
used to encode — keep stdout clean so a redirect survives — assumed a result and an error could land
on the same stream together. They cannot: a command either succeeds and writes its payload (exit `0`)
or fails and writes its error (exit `1`/`2`). A caller branches on the status before it parses, so
`--format json | jq` stays exactly as safe as it was. `read` is the sharpest case and holds for the
same reason: its stdout is a raw passthrough, so an error mixing into captured bytes would be real
corruption — but a failed `read` captures nothing, so the bytes and the error are never both there.

- **Conformance** — verified through the consumer suite of the [`mux/`](../mux/README.md)
  behavioral node (asserts the contract concretely for its commands), never by this artifact itself.
  A reference artifact carries this `## Subject` in place of `## Use Cases` + a `.feature`.
- **Impl trails the contract** — the shipped `cyber-mux` bin predates this adoption and most of it
  still emits human prose + `--format json`. Everything above is a **contract, not a report of what
  ships**; the impl gate certifies each principle against its frozen suite when a mission builds it,
  never on this artifact's say-so.

  **What ships today, verified against source rather than asserted:**

  - **The #6 error surface is built.** Every failure is now a `CliError` reported by `reportError`
    (`src/cli-error.ts`) on **stdout** under a stable `code`, with an actionable `help:` line, honoring
    `--format` — and the AXI exit split holds: a usage error (unknown flag, missing required argument, a
    malformed name, help-answered incomplete input) leaves `2`, an operation failure leaves `1`. The
    single `fail()` helper this node used to describe is **gone**; `src/cli.ts` has no `fail(` sites and
    writes no error to stderr. The `ambiguous-pane` report of [`mux/`](../mux/README.md)'s pane
    addressing (its `code`, candidates, and `--format` honoring) is the shape every site now uses.
  - **The two #9 suggestions ship today, still on stderr** — `layout save`'s truncation reveal
    (`noteTabsLeftOut`) and the `worktree` grouping hint (`reportOpenedWorktree`). This CR sets the
    contract that moves them into the stdout payload as `help[N]:` blocks; its deliver step performs the
    move, and until it lands they remain on stderr. See #9.
  - **Backend text is mostly translated, with one residual.** The coded error sites carry
    `cyber-mux`'s own text (the `layout-not-found` lookup names the directories it searched; the
    `invalid-template` and `layout-apply-failed` messages are this CLI's own). The remaining leak is the
    generic `worktree-failed` catch-all (`reportWorktreeFailure`, `src/cli.ts`), which still forwards
    the underlying error verbatim when no more-specific coded surface caught it — a stable `code` around
    still-untranslated backend text.

  **What still trails the contract:** the two #9 suggestions' move to stdout (this CR's own deliver
  step — see above) and the `worktree-failed` residual; TOON as the default format (#1) and `--fields`
  (#2), truncation with a size hint (#3), pre-computed aggregates (#4); the *omit rule* and any further
  suggestion sites of #9 as commands gain them; and the home view (#8) with the tool identity #10
  requires of it.
- **Boundary** — this bar owns the *shared* output shape. Each command's *domain* behavior (what
  `open` places, what `list` enumerates) lives in [`mux/`](../mux/README.md).
