---
cr: "63-worktree-list-table-markers"
source: "pr#63"
project: cyber-mux
status: implemented
todos:
  - content: "Explore: locate the gap — mux/ specifies worktree-list PROVENANCE (git owns the facts), never how the table RENDERS them"
    status: completed
  - content: "Draft mux/: additive scenarios for the (*) primary marker, the ~ home shortening, the (gone) prunable marker, and the human-only boundary"
    status: completed
  - content: "Draft mux/README.md prose: the render contract beside the existing facts-vs-binding rule"
    status: completed
  - content: "Spec gate: cold spec-judge round, then freeze check (additive-only self-clears) + gate line"
    status: completed
  - content: "Impl gate: verify each new scenario against the already-landed code + tests"
    status: completed
  - content: "Handoff: commit the spec onto the CR branch, push to PR #63"
    status: completed
---

# CR: `worktree list` table render contract (backfill)

Source: PR #63 — the three rendering commits on `cyberlegion/unit-7489a249e48f46b5`.

## Out of order, stated plainly

This is a **backfill**: the code landed first (three commits, `pnpm verify` green, PR open), and the
spec is being written to behavior that already ships. Explore reads source + tests rather than
collecting seed intent. The impl gate's verification is the existing suite, not a fresh build.

## The gap

`mux.feature` already pins worktree-list **provenance** — "every reported path, branch, linked, and
prunable value is git's answer, not the backend's" — and `mux/README.md` carries the matching
facts-vs-binding rule. Neither says anything about how those facts are **rendered**. That silence is
what let three render decisions land uncontested:

1. `linked` lost its column; the primary checkout reads `<branch> (*)`.
2. A home-rooted `root` renders `~/…`, matching AXI #10's home-view rule (`$HOME` collapsed to `~`),
   which this project already states for a different surface.
3. `prunable` — never rendered at all before — marks its `root` `(gone)`.

The through-line worth specifying is not any one marker: it is that **a one-bit fact earns a marker,
not a column, and a marker is human-surface only** — `--format json` keeps every field and the
absolute path, because that is the surface an agent reads.

## Spec/suite

Additive only — new scenarios beside the existing worktree-list provenance ones, which are unchanged
and still hold (the markers render git's facts; they do not restate or override them). Self-clears
the freeze; no re-open.

## NEXT — landed

**Both gates self-asserted by agent** within the auto-spec leash (additive-only: 50 insertions, zero
modified or removed lines, so the file-level `@frozen` self-clears with no re-open; package is
`0.0.0`, so Compatibility does not fire; no Clearance narrowing and no Conflict).

**Two cold spec-judge rounds**, each re-deriving its own oracle. Round 1 failed the builder lens on
three underdetermination defects — a Then whose sibling-prefix subject the Given never constructed,
the marker glyphs living only in the never-frozen README, and the human-vs-structured boundary pinned
at the `--format json` flag rather than the surface (which this corpus's own owed TOON default would
have hollowed out). Round 2 verified all three fixes independently, passed builder, and caught a
**regression the producer introduced** by taking round 1's optional band-placement nit: the moved
band left the four removal-ordering scenarios filed under a listing-render heading. Cleared with an
additive section comment. Recorded as a regression rather than glossed; the loop was judged
converging (builder fail→pass, oracle pass both rounds) and the remedy comment-only, so no re-plan.

Impl gate verified each frozen scenario against a named case in the shipped suite rather than in
aggregate. `pnpm verify` 7/7 green.

**Working method / provenance:** ledger shard
`packages/cyber-mux/.agents/spec/ledger/63-worktree-list-table-markers.0088cf.jsonl`. SDD default
squad (no plugin registry).
