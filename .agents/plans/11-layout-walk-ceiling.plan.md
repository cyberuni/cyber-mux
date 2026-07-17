---
todos:
  - content: Spike — measure the real pane-count/depth ceiling on live tmux (throwaway -L server)
    status: completed
  - content: Spike — measure the same on live herdr, working around the insideHerdrPane gate
    status: completed
  - content: Decide from the measurement — documented limit, clear failure mode, or both
    status: completed
  - content: Close Q4 in the design doc with the measurement, uninterpreted
    status: completed
  - content: Implement Exec.lastError + withReason; carry the reason through the adapter throw sites
    status: completed
  - content: Correct the mux node's prose, which this CR falsifies
    status: completed
  - content: Changeset, verify, commit, PR closing #11
    status: pending
---

# 11 — the layout walk's pane-count and depth ceiling

CR: [#11](https://github.com/cyberuni/cyber-mux/issues/11) — Q4 of `docs/design/layout-templates.md`
§12, the one open question the layout design carried forward.

Target: `cyber-mux` (`packages/cyber-mux`).

## Final scope (cut by the user after the spec gate stalled)

**The doc and the `lastError` change. No suite edit, no new tests.** `layout.feature` and
`layout/README.md` are reverted to HEAD and untouched — the node's spec and its frozen suite are not
part of this CR. What ships:

- `docs/design/layout-templates.md` — Q4 closed with the measurement, **uninterpreted** (below).
  Also corrects §5.3, which described `tiled` as `ceil(n/2)` columns where the code does
  `ceil(sqrt(n))` — pre-existing rot, and the direct cause of three bad readings.
- `src/exec.ts` — `Exec` becomes a callable interface with an optional `lastError`; `realExec`
  captures stderr and **clears on success**; new `withReason(exec, message)`.
- `src/session.tmux.ts` / `src/session.herdr.ts` — the 8 throw sites that run a command carry the
  reason. The pure-parser site deliberately does not.
- `packages/cyber-mux/.agents/spec/mux/README.md` — its claim that the seam "discards a backend's
  stderr" is falsified by this CR; corrected to say the gap **narrows** rather than closes.

## The measurement (the answer to #11)

The issue's framing did not survive contact. Nothing breaks near four panes; the ceiling is not a
pane count and depth is not the constraint. tmux 3.6b ceilings, region pinned via `-x`/`-y`, binary
search + linear verification:

| region | `tiled` | `even-horizontal` | `even-vertical` |
|---|---|---|---|
| 80x24 | 156 | 32 | 12 |
| 120x40 | 380 | 45 | 19 |
| 200x50 | 506 | 70 | 22 |
| 400x100 | >700 (search cap) | 128 | 39 |

**herdr 0.7.4 enforces no floor at all** — 110 successive down-splits of a 45-row region all succeed
(111 panes, 108 claiming `viewport_rows: 2`). So the same 16-pane `even-vertical` template in 80x24
exits 1 half-built on tmux and exits 0 undisplayable on herdr: a real dent in *one template means one
geometry everywhere*, recorded rather than papered over.

**The only conclusion drawn: no rule cyber-mux could rely on predicts the ceiling** → never
pre-flight. The numbers are deliberately not interpreted beyond that; see below for why.

Two findings the issue did not anticipate: `layout.feature:293`'s failure contract **holds against a
real backend** (partial manifest matched live panes exactly, nothing killed, exit 1 — it had only
ever been proven against a mocked `Exec`), and the failure was **correct but blind**, which is what
`lastError` fixes.

## The lesson, recorded because it cost three rounds

The spec gate ran three rounds and failed all three on Builder+Architect (Oracle passed every time).
**Every failure was the prose explaining the data; never the data.** Round 1: a powers-of-two ladder
made every ceiling a lower bound, inviting a "~3 rows × 3 cols" floor its own table refuted. Round 2:
correct numbers, over-read — "no constant floor" argued from a drifting *average* (vacuous: a
constant floor with uneven panes predicts exactly that). Round 3: the repair asserted "`tiled` is not
a comb" — **false**; `layout.ts:291` builds a right-comb of down-combs and its own comment says so.
Each misreading came from trusting §5.3's stale prose instead of `layout.ts`. Hence the scope cut:
ship the table and the one supported sentence, and stop explaining.

## NEXT
Commit and open the PR closing #11. Nothing is gated: the frozen suite is untouched (verified
`0 added / 0 modified / 0 removed` vs HEAD), no node changes `status`, and no spec gate applies
because no spec behavior changed — `mux/README.md` is a factual correction to unfrozen prose. Full
`pnpm verify` is green except a pre-existing biome complaint about the untracked
`.agents/cyberlegion/config.json`, which is not this CR's and is not staged.
