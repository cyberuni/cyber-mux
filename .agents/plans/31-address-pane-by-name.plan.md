---
todos:
  - content: Grill seed intent — the ambiguity report shape, verb scope, id-vs-name precedence
    status: completed
  - content: Draft the mux spec prose + scenarios for name-or-id addressing
    status: completed
  - content: Amend axi #6's exit-code set to 0/1/2 and add the structured-error shape
    status: completed
  - content: Cold spec-judge rounds; converge or present the failing scenarios
    status: completed
  - content: Spec gate — freeze the touched suites, record the gate line
    status: completed
  - content: Deliver — put a label on LivePane across both backends, then resolution + the report
    status: completed
  - content: Rebase onto main, impl gate, land the PR
    status: in_progress
  - content: Drain the 3 recorded follow-ups into issues (needs permission)
    status: pending
---

# Address a pane by name or id

CR: [#31](https://github.com/cyberuni/cyber-mux/issues/31) — the pane verbs take a name or an id; a
single match resolves, two or more fail and report the candidates.

Target: `cyber-mux/mux` (`packages/cyber-mux`), suite
`packages/cyber-mux/.agents/spec/mux/mux.feature`. The reference node
`packages/cyber-mux/.agents/spec/axi/README.md` is in play iff the candidate report is decided to be
a structured error.

## What the survey found (before any grill)

Two premises in the issue do not survive contact with the source:

- **"Resolution needs no new backend capability" is false.** `LivePane` (`src/session.ts:97`) is
  `{id, mux, harness?, cwd?}` — **no label**. herdr's `pane list` already returns one and the
  adapter drops it (`src/session.herdr.ts:181`); tmux would need `#{pane_title}` added to the format
  string (`src/session.tmux.ts:139`) plus the host-comparison rule already used for `describeRegion`
  (`src/session.tmux.ts:182`). So the listing type grows a field on both backends.
- **There is no channel to report candidates through.** `fail()` (`src/cli.ts:65`) writes free text
  to stderr and exits 1 regardless of `--format`, and `read` / `submit` / `close` / `send *` carry
  no `--format` option at all. `axi/README.md:51` already names structured errors (a stable `code`,
  honoring `--format`) as unbuilt.

Every pane verb funnels through one helper — `target()` (`src/cli.ts:79`), which wraps the raw
string with zero validation. That is the seam the resolution hangs off.

## The settled contract (grilled, requester-decided)

| Decision | Outcome |
|---|---|
| Report shape | Structured error — a stable `code: ambiguous-pane` + a candidates array, on stderr, honoring `--format`; stdout clean. Wired through the resolution path only, not a full axi #6 sweep. |
| Resolution layer | The CLI's `target()` helper + `layout save --from`. Adapters keep taking concrete ids; the seam is untouched. |
| Id vs name | Id wins, then fall back to name. Resolved by **existence** via one `listPanes` read — never by syntax-sniffing the backend's id format, which would leak backend shapes into the CLI. |
| Exit codes | `0` = one match, `1` = zero, `2` = ambiguous — on **every** pane verb, not just `exists`. |
| Candidate fields | `id`, `label`, `cwd` — the three that discriminate; axi #2 caps a default row at 3–4. |

**This CR amends [`axi/`](../../packages/cyber-mux/.agents/spec/axi/README.md) #6**, whose code set is
`0 = success, 1 = failure`. Exit `2` = *couldn't answer* is added. Same shape the mux node already
used to amend axi #8 for bare `send` — scoped and filed at the reference node, not invented locally.

## Why the seam was refused

The seam's `from` has **no human-name caller**. The walk always passes `from: { id: paneId }` — a
pane it created three steps earlier (`layout-session.ts:297`); layout templates have no `from:` key
at all, the walk derives it structurally (`layout.ts:325`). Every other `from` is `callerPane()`
(`cli.ts:420, 434, 587, 632, 661`). The only human-authored one is `layout save --from`
(`cli.ts:303`) — a CLI flag. Meanwhile `layout-session.ts:31` already names this CR's consumer: a
dispatcher "needs NO new cyber-mux surface, since it addresses panes through
`read`/`submit`/`exists`/`focus`/`list`."

## Prior art (researched; folded into the spec's rationale)

- **Ambiguity is a fuzzy-tier condition only, and the split tracks whether a total order exists.**
  git refnames (a documented 6-step ladder), Docker (full ID → exact name → prefix), kubectl, brew
  all **pick silently at exit 0** across tiers. Where matches are **peers** — git short SHAs, tmux
  targets, brew cross-tap formulae — every tool **fails rather than guessing**. Our id-then-name
  ladder and our name-vs-name refusal are both the conventional answer.
- **The predicate third state belongs in the exit code**, not a stdout word: grep (`2`), POSIX
  `test` (`>1`, normative), `diff`, `expr`, `pgrep`. `systemctl is-active` is the negative result —
  it prints `inactive` for both "stopped" and "no such unit" and only exit 3 vs 4 tells them apart.
- **Candidate-list best practice** (git short-SHA, brew cross-tap, tmux's own *command* resolver):
  hard-fail non-zero, everything on stderr with stdout clean, each candidate line directly usable as
  the retry input, a discriminator per candidate (listing `worker, worker` helps nobody), and state
  the fix explicitly. kubectl's known wart is omitting the remedy.
- **We beat tmux rather than depart from it.** tmux's target resolver collapses ambiguous and
  not-found into one indistinguishable `can't find window: X` and has no "ambiguous" string at all —
  but its *command* resolver ships the exact idiom: `ambiguous command: n, could be: new-session,
  new-window, next-window`.
- **Considered and refused: enforcing unique labels.** tmux and Docker both make names unique at
  creation, which is *why* ambiguity is unrepresentable for them. Issue #31 closes that door
  deliberately — a label is a human name, herdr labels every root tab `1`, so duplicates arrive by
  default. Refusing them made capture lossy, which is what CR #14 removed.

## Result

**Both gates passed.** Spec gate ratified in-session by the requester; impl gate self-asserted on a
cold judge's 16/16. Suite additive throughout — 16 added / 0 modified / 0 removed / 90 unchanged,
`addOnly` true, re-checked on the merged tree after the rebase. `pnpm verify` green, 545 tests.

## What the loop actually caught

Five judge rounds, and the recurring defect was never a wrong design — it was an **unearned claim**:

- The first `addOnly: true` was computed against a **stale remote ref**. Right answer, by luck; the
  freeze self-clear rested on it. The branch was 13 commits behind, including the CR whose rationale
  this one builds on.
- Two scenarios were **inert**: both fixed a world of one live pane, so a resolver ignoring the name
  entirely passed all nine rows.
- The spec claimed in the **past tense** that the structured error was "built", on a spec-only round
  with no code. No test can catch that — the artifact is prose.
- The same false-built tense then **recurred in the ledger**, because the fix had been applied to the
  two instances named rather than swept for.
- The impl-producer's own mutation harness reported a **false kill**: vitest ate the `-t` filter as a
  flag, zero tests ran, and the nonzero exit read as a pass. Self-caught by a count check — and the
  reason the impl-judge re-ran all mutations by hand rather than reading the table.

Two judge claims were **refused** after checking the corpus: that `correction.cause` must hold a
closed enum (the corpus writes prose there and carries the vocabulary in `correction-kind`), and that
a missing `seq` on ledger lines is a corpus-wide gap (9 of 11 shards carry it — it is the norm).

## Scope cut at the impl gate

The delivery added a label column to `list`. Removed: it is not in the frozen contract and takes that
row to five fields against axi #2's three-to-four ceiling — a bar this same CR amends elsewhere.
Filed rather than shipped.

## NEXT

Land the PR. Then drain the 3 follow-ups in the ledger shard into issues — the cross-adopter
divergence of axi #6's third exit code, `fail()` staying free text on every other path, and `list`
not surfacing the label it now carries. Needs the requester's permission; the ledger records stand
either way, and a later drain re-derives what is outstanding by the same dedupe.
