# CR 10 — design of record: the pane layer's split-options contract

Ratified at intake (in-session, plan-mode preview approved by the requester). This is the settled
draft the explore phase adopts; it is not re-grilled from scratch.

## The problem

`SessionOpenOptions` carries three fields that shape a split — `from`, `ratio`, `env` — and the
pane-abstraction node (`mux/`) specifies **none** of them. Their only spec home is
[`layout/layout.feature`](../../packages/cyber-mux/.agents/spec/layout/layout.feature), phrased in
template/apply terms. The pane layer's split-with-options contract has no statement at its own
layer, so an adapter author has nothing layer-local telling them what a split must support.

This is **pre-existing and consistent with house style**, not a regression: each field arrived with
the feature that needed it and was specified there. The `8-layout-save` ledger shard records that
style explicitly, and names issue #10 as the debt it defers. This CR pays that debt for the three
split fields.

Scope note: `describeRegion` is the *other* seam member specified through `layout.feature` (per the
same house style). It is **out of scope** — issue #10 names only the three split fields.

## Decisions

### D1 — the fold-back is a MOVE, not a duplicate (requester-ratified)

`mux/` becomes the single owning node for what the three fields mean at the seam; the moved
scenarios leave `layout.feature`.

Rejected alternative: add at `mux/` and leave `layout.feature` untouched. It is purely additive and
would need no clearance, but it manufactures exactly the defect cross-node overlap detection exists
to catch — *one behavior = one scenario in one owning node*. Two nodes specifying the ratio
convention makes a change to that convention touch both files, so two missions that look
file-disjoint are a hard collision the scenario rung cannot see.

**Which node owns it** is settled by the suite bar's test-vector rule, not by preference.
`layout.feature`'s ratio outline reads *"Given a split node with ratio 0.333 applied through the
`<backend>` adapter"*. Apply the swap test: replace the template domain with a direct `open()`
carrying a ratio, and the `Then` (*the backend receives `-l 67%`*) still holds. So the
template framing is **apparatus**; the precondition is *a `pane:*` open carrying a ratio*. That
scenario is a mux-layer fact wearing a layout costume.

**Cost, accepted:** removing scenarios from the frozen `layout.feature` is a **narrowing** — the
**Clearance** floor fires. Pre-authorized by the requester in this CR. The project's total contract
is not weakened: every assertion lands in `mux.feature`.

### D2 — scope is spec-only (requester-ratified)

No behavior change, no new CLI flags, no changeset. `--ratio` / `--env` on the `open` verb would be
new user-facing surface and is beyond what the issue asks. The three fields are seam-level and
reachable only through `SessionAdapter` today; that stays true.

### D3 — the layering

| Node | Owns |
|---|---|
| `mux/` | what `from`/`ratio`/`env` mean at the seam; how each backend renders them (flags, conventions, defaults, tier scope); `canSizeSplits` as a declared capability |
| `layout/` | template → seam desugaring and delegation; schema validation (range, `cwd`-free, duplicate labels); the degrade policy when a backend cannot size |

`layout.feature`'s *"each split names the pane it splits rather than relying on the backend's
default"* **stays** — that is layout's delegation duty, a different fact from what `from` does.

### D4 — the out-of-range ratio is NOT specified

The seam renders whatever number it is given: `open({ratio: 1.5})` emits `-l -50%`, `ratio: 0` emits
`-l 100%`. `0 < ratio < 1` is enforced only by the layout schema. Freezing the current behavior into
a scenario would cement a wart and block a future fix, so it is stated as a **prose boundary** in the
node README and filed as a follow-up instead.

## Findings that shaped this design

1. **A doc comment is actively wrong.** `session.ts`'s `env` doc says env is "only meaningful for a
   `pane:*` placement". The code emits env at **every** tier on both backends, and tests pin exactly
   that. Load-bearing: a layout's root pane is born by the region open, never by a split, so
   tier-scoping env would drop it silently. Corrected in this CR (comment only, no behavior).
2. **`mux.feature` has never parsed** — an `Examples:` table declares `| branch | placement |` and
   two of its three rows carry one cell. Gherkin rejects the whole file, so the entire frozen mux
   suite is invisible to `check-suite` and binds to nothing. This is a **blocking prerequisite**: the
   spec gate runs `check-suite` fail-closed over touched suites. Repaired here (see D5).
3. **The issue's "tested only through the layout suite" is loose.** The fields *are* driven directly
   at the pane layer in the adapter tests; those tests implement `layout.feature`'s scenarios. The
   **specification** claim holds; the testing claim does not.

### D5 — repairing the unparseable table is in scope, and is not a narrowing

The malformed outline asserts **nothing** today, because the file does not parse. Repairing the two
rows' missing `branch` cell restores the evident intent and takes the scenario from asserting nothing
to asserting three rows — it **widens** the contract and narrows nothing, so the freeze self-clears.
The repair is the conductor-served minor fix for an obvious stale mistake, taken because it blocks
this CR's own gate rather than because it was asked for.

Measured: repairing that one table takes the mux node from *0 parsed / 0 bound* to **61 scenarios,
34 bound, 34 pass, 0 fail, 27 unbound**.

### D6 — binding the new scenarios needs test renames, not new tests

The bridge binds a test to a scenario only when the test's **leaf title is the scenario name
verbatim**. The adapter test files already sit under the `spec:cyber-mux/mux` node wrapper and
already cover the behavior, but their leaf titles are implementation-voiced, so they bind to nothing.
Binding this CR's scenarios is therefore a **test-rename** job (the canonical rename), not new
coverage — with one exception, D7.

### D7 — the one real coverage gap (corrected at deliver)

`ratio` is not passed to a `tab`/`workspace` on tmux, and no test exercised that. Every ratio test
used `at: 'pane:right'`. This CR adds that test.

**Corrected by mutation, having first got this wrong.** The claim as originally written was that the
`!window &&` guard on `size` is the thing under test. It is not: `size` is only spread into the
`split-window` branches, and the `new-window` branch never references it, so the guard is
**structurally redundant** — deleting it changes no argv and fails no test. Mutating the guard alone
left all 52 tests green, which is what exposed the mistake.

The scenario is nonetheless **not inert**, and the miss test names the right wrong subject: an
adapter author who wires `...size` into the window branch. Verified by mutation — spreading `size`
into `new-window` *and* dropping the guard fails both rows of the new scenario. The contract being
pinned is the emitted **argv**, not the guard; tmux is defended twice over and it takes breaking both
defenses to lose the row. That is why the scenario is tmux-only: herdr cannot fail it at all, since
its `size` is lexically scoped inside the pane-split branch.

**The same is true of the `!window &&` guard on `from`** — found by the cold impl-judge, which
checked the sibling case this note had missed. The window branch never spreads `...from` either, so
removing that guard alone also leaves the whole tmux suite green; the bound test for *"from is
ignored by tab and workspace"* fails only once `from` is **also** wired into the window branch. Both
tmux guards are the same shape of dead defense-in-depth, and both scenarios are loseable only by the
compound wrong subject. Recorded rather than removed: the guards cost nothing and state the intent
locally, and deleting them is a production change this spec-only CR has no business making.

## The 27 unbound

Pre-existing, not this CR's to close beyond its own scenarios — recorded as a follow-up rather than
absorbed, the same call the `8-layout-save` mission made for layout's 41.
