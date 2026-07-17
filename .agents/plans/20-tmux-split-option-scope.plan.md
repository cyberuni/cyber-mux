---
cr: 20-tmux-split-option-scope
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/20
status: done
todos:
  - content: Confirm the guards are dead and the frozen suite needs no edit
    status: completed
  - content: Scope from/size into tmux's pane-split branch, deleting the !window guards
    status: completed
  - content: Correct the stale belt-and-braces test comment to name the new wrong subject
    status: completed
  - content: pnpm verify — argv must stay byte-identical, all frozen scenarios green
    status: completed
  - content: Impl gate — cold impl-judge over the frozen scenarios; self-assert within leash
    status: completed
  - content: Handoff — PR closing #20, ledger gate line; no changeset (nothing user-facing)
    status: completed
---

# CR 20 — tmux's split options say what they mean

Source: issue #20, filed as a `followup` by CR 10 (`ledger/10-split-options-contract.*.jsonl`, seq 6).

## The question

`session.tmux.ts` computes `from` and `size` behind a `!window &&` guard. The guard is dead: the
`new-window` branch spreads neither value, so removing either guard alone changes no emitted argv and
fails no test (established by mutation in CR 10, re-derived by its impl-judge at seq 9). The issue
asks which the codebase MEANS — dead code, or intent stated locally — because the natural reading
(that the guard is what prevents the leak) is wrong.

## The decision — delete the guards, scope the values

Lexical scoping **strictly dominates** the guard: a guard only helps while the value is in scope, so
it neutralizes a leak silently. Scoping the value into the split branch removes it from the window
branch's scope entirely, making the leak a **compile error** instead. `session.herdr.ts` already does
exactly this — which is why the `ratio is a split concept` scenario is tmux-only, and why the frozen
`from is ignored by tab and workspace` scenario passes on herdr with no guard at all. The seam's
contract already accepts structure-alone as satisfying it; tmux was simply the adapter that hadn't
caught up.

## Scope

Implementation only. **No spec, no suite, no behavior change** — emitted argv stays byte-identical, so
the frozen `mux.feature` is untouched (no narrowing, no re-open, no Clearance floor) and `spec.md`
stays `implemented`. Neither the mux README nor `spec.md` documents the guards, so nothing durable
records intent that this contradicts.

The two split-window ternary arms collapse into one branch with a `direction` variable — a
consequence of scoping the values (a ternary arm cannot hold a `const`), and the shape herdr already
uses.

## Outcome

Landed. The guard did not merely fail to help — it **concealed**. Verified by mutation in both
directions: wiring `...from`/`...size` into the window branch compiles clean on the old structure and
passes 71/71 silently (the guard empties the value), while the same edit on the scoped structure is
`TS2304: Cannot find name`. So the issue's framing (two defensible options) resolves — scoping
strictly dominates, and the reading it calls natural is wrong precisely because the guard hid the
mistake it appeared to prevent.

Argv byte-identical, proven differentially against the pre-change adapter (this CR's matrix, and the
cold impl-judge's independent 320-combination one — 0 mismatches). Frozen `mux.feature` untouched;
`spec.md` stays `implemented`. The `ratio is a split concept` scenario is NOT inert: the judge
reproduced the compound wrong subject the rewritten comment names (hoist back to function scope AND
wire in — legal TS) and the scenario failed red.

## NEXT

Nothing outstanding. CR done; issue #20 closes on merge.
