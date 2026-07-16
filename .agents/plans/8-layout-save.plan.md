---
todos:
  - content: Revise layout/README.md — drop the `layout export` non-goal, add the capture use case + behavior row
    status: completed
  - content: Add the capture scenarios to layout.feature (additive; frozen scenarios untouched)
    status: completed
  - content: Spec gate — cold sdd-spec-judge, freeze, ledger gate line
    status: completed
  - content: Re-land the spike against the frozen suite; re-title tests verbatim so they bind
    status: completed
  - content: Impl gate — cold sdd-impl-judge over every frozen scenario
    status: completed
  - content: Rebase onto origin/main, pnpm verify, changeset, PR closing #8
    status: completed
---

# 8-layout-save

CR: capture a live pane region back into a named layout template — the schema's one real authoring
cost (a 4+ pane grid needs nested `split` nodes nobody wants to type). Reverses the `layout export`
non-goal recorded at `packages/cyber-mux/.agents/spec/layout/README.md:132-137`.

Target: `cyber-mux/layout` (`packages/cyber-mux`). Source: GitHub issue #8.

## Shape

**Revise + additive.** The node exists and is `implemented`; its `.feature` is `@frozen`.

- `README.md` — prose, never frozen: drop the export non-goal, add the use case. Also correct the
  "managing templates never touches a multiplexer" claim, which `save` is the first exception to.
- `layout.feature` — **additive only**. No existing scenario narrows or is rewritten, so the freeze
  **self-clears** and no re-open ratification is needed. The `list, show and validate answer with no
  multiplexer at all` outline stays true verbatim — `save` is simply not in its Examples.

## Decisions already ratified by the user

- The verb is **`layout save`**, not `layout export`, and it **writes a file** (`--to repo|user`,
  default repo; `--force`; prints the path to stdout). This **supersedes** design §6.4's
  "prints to stdout rather than writing a file keeps that honest".
- Draft-ness is instead carried by a default `description` written **into** the file, because
  `layout list` shows a saved capture beside finished templates.

## The spike (built before the spec — treat as throwaway learning, not as done)

Proven against live tmux 3.6b and herdr 0.7.4; `pnpm verify` green (408 tests). Its **test titles are
invented prose, so they bind to nothing** under the verify-scenarios bridge — the whole reason this
mission exists. What it established:

- A new **portable** seam verb `describeRegion(exec, target): RegionPane[]` reporting each pane of a
  region with a rect. Per house style (Gap A's `from`, and `ratio`/`env` before it), a seam addition
  driven by layout is specified through `layout.feature`, not folded back into `mux`.
- **Rects, not a tree** — the design doc's claim that herdr's `pane layout` reports a tree is
  **wrong**: `splits[]` is flat and its parent links live only in an undocumented id convention
  (`split_1_0`). tmux's tree is a bespoke string. Rects are the fact both report exactly; the tree is
  derived by guillotine cuts in a pure module.
- `ratio = 1 - second/total` (the complement), **not** `first/(first+second)` — the latter reads 0.69
  where tmux's own `-l 30%` says 0.7, because the divider cell belongs to the region, not to a pane.
- n-ary rows lower to a **right-comb** (desugar's inverse); a 2x2's genuine ambiguity breaks
  **columns-first** to match `tiled`.
- Live round-trip: a real 4-pane herdr region captured → validated → re-applied reproduced the
  original geometry cell-for-cell (121x30 / 61x13 / 60x13 / 80x43).

## NEXT

Landed. Both gates self-asserted `by: agent` — **awaits ratification or kick-back**.

Four cold impl-judge rounds; three found real defects, every one by MUTATION rather than
by reading:

1. no duplicate-label check — `save` wrote a template its own `validate` rejected, silently
2. three scenarios bound to tests that never checked the CLI-observable half of their `Then`
3. this CR's own duplicate-label fix MASKED the tmux hostname filter — a fixture with two
   host-titled panes collided and was dropped, giving the right answer for the wrong reason

Plus one self-caught: the test bound to `a captured template passes validate` was inert.

The lesson worth keeping: on this CR, reading never found a defect and mutation always did.

Follow-ups recorded in the ledger shard, none absorbed:
- 41 of 69 layout scenarios are UNBOUND (pre-existing; clean-HEAD baseline 46/5/41) because
  their CLI tests sit under the mux node's segment. This CR bound all 23 of its own and added
  no new debt.
- the round-trip check models a divider-less backend, so it cannot catch a divider regression
- two near-duplicate label-uniqueness loops, capture-time and validate-time
