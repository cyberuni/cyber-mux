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

> This is the **same** contract `cyberplace` (`.agents/specs/cyberplace/axi/`) and
> `packages/universal-plugin` (its ADR-0003) adopted; `cyber-mux` shares the output shape so an
> agent moving between bins sees one interface. One open question — see **#8**.

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
   are structured (a stable `code` + message, honoring `--format`) — `fail()` in `cli.ts` writes free
   text to stderr and exits 1, still unstructured for every error but the one below; exit `0` =
   success (including no-ops), `1` = error, `2` = usage error — **AXI's set, restated in full**, and
   the first two are already true; commands **never** prompt interactively (already true —
   `cyber-mux` has no interactive prompts); an **unknown flag fails loud** (commander's default —
   exit 1, naming the flag, which is the wrong code: AXI puts an unknown flag at `2`, see below).

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

   **Two divergences from AXI remain, and neither is claimed as correct.** Both predate this node's
   first structured error and both are **filed**, not settled here:

   - **An unknown flag exits `1`, where AXI says `2`.** That is commander's default, restated above as
     though it were the contract. Fixing it is a change to every command's failure surface, so it is
     not ridden in on one error path. The same gap covers a bare command group (see #8).
   - **Errors go to stderr, where AXI says stdout.** AXI is explicit that stdout carries "data,
     errors, suggestions" precisely "so the agent can read and act on them", and that stderr is
     debug/progress that "agents don't read". The *Stream discipline* section below inverts that. It
     is not a `cyber-mux` slip — `cyberplace`'s node states it identically, word for word, so the
     inversion is the org's adoption rather than this bin's. It is load-bearing, not cosmetic: an
     agent-facing report on a stream AXI says agents ignore is a report its own reader never sees.

7. *(#7 ambient context — out of scope, see Scope of adoption above.)*
8. **Content-first (#8)** — a **command group** invoked with no subcommand shows live data, not
   help. `send` (`send text` / `send keys`, see [`mux/`](../mux/README.md)) **does not meet this**:
   it drives a pane and has no view of its own to show — every view it could render already belongs
   to a verb (`list`, `doctor`) — so bare `cyber-mux send` writes help to **stderr** and **exits 1**,
   stdout clean (commander's default, no custom code; the same shape #6 describes for an unknown
   flag). **That `1` is the wrong code and is frozen wrong.** Bare `send` is **incomplete input**,
   which is exactly what AXI's `2` = usage error is for — the same family as the missing required
   parameter AXI names. It sits at `1` for the same reason an unknown flag does: commander's default
   was restated as the contract without argument. The suite pins `exits 1`, so correcting it is a
   frozen-scenario change and belongs to the repo-wide reconciliation filed at #6, not to a note here.
   An earlier reading of this parenthetical ("and no third exit code") was a claim about the code
   **set** and was simply false — AXI always had three. What it was defending — that `send` invents no
   code of its own — still holds, and holds better once `send` uses AXI's. Whether #8 should carve out
   a group like this is **open** and
   belongs to the contract, not to `cyber-mux` — a follow-up is filed; nothing is asserted here about
   the other adopters.

   The trigger this principle used to name — "revisit if `nudge`/`worktree` land behind their own
   group" — has **fired**: `worktree` (`add`/`open`/`list`/`remove`) is a group on this surface, and
   unlike `send` it **is** data-bearing (`worktree list` is its live view), so #8 covers it as written
   and needs no amendment. Its bare form ships help + exit 1 today, which is a divergence owned by the
   worktree capability, not by this note and not closed here.
9. **Next-step suggestions (#9)** — every command ends with a next-step line naming the natural
   follow-up (`→ cyber-mux focus <pane>` after `open`; `→ cyber-mux read <pane>` after `submit`), so
   an agent is handed the next move. Not yet implemented.
10. **Consistent help (#10)** — every subcommand answers `--help` with a concise reference (synopsis,
    flags, one example) — already true via commander's built-in `--help`, one example per command
    still to add.

### Stream discipline (how the surface is realized)

- **stdout** carries the machine result only — the TOON (or `--format json`) payload **including its
  aggregate summary (#4)**. So `--format json | jq` and TOON parsing stay clean. `read`'s captured
  pane output is the one exception: it is the pane's own byte stream, not a structured result, and
  stays raw on stdout.
- **stderr** carries the human affordances — the next-step line (#9), warnings, and structured errors
  (#6). Redirecting or discarding stderr never corrupts the parsed result.

- **Conformance** — verified through the consumer suite of the [`mux/`](../mux/README.md)
  behavioral node (asserts the contract concretely for its commands), never by this artifact itself.
  A reference artifact carries this `## Subject` in place of `## Use Cases` + a `.feature`.
- **Impl trails the contract** — the shipped `cyber-mux` bin predates this adoption: it emits human
  prose + `--format json`, unstructured errors, and no next-step lines. Only the AXI output surface
  is unbuilt; the impl gate withholds certification until a follow-up mission re-implements each
  command against its frozen suite. **The first path to break that trail is specified but unbuilt**:
  the `ambiguous-pane` error of [`mux/`](../mux/README.md)'s pane addressing is contracted to be
  structured — a stable `code`, its candidates, honoring `--format` — because that CR is the first
  caller that actually needs the shape. It is a contract, not a report of what ships: nothing on this
  surface emits a structured error today, and the impl gate certifies it against the frozen suite
  like everything else here.
- **Boundary** — this bar owns the *shared* output shape. Each command's *domain* behavior (what
  `open` places, what `list` enumerates) lives in [`mux/`](../mux/README.md).
