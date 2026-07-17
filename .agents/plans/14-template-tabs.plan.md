---
todos:
  - content: Grill seed intent — scope, label convention, focus, capture
    status: completed
  - content: Probe both backends for workspace-wide tab enumeration
    status: completed
  - content: Spike tmux window-option persistence across a server restart
    status: completed
  - content: Draft layout/ spec + suite — the tabs form, the walk, capture --workspace
    status: completed
  - content: Draft mux/ spec + suite — the opaque workspace group id on the open contract
    status: completed
  - content: Reconcile mux/'s tab-naming non-goal (its premise holds only for herdr's root tab)
    status: completed
  - content: Correct the design doc's unreachable herdr layout.export claim
    status: completed
  - content: Spec gate — cold judge PASS/ALIGNED, status approved, freeze holds
    status: completed
  - content: Deliver — schema + desugarer for the tabs form
    status: completed
  - content: Deliver — the mux seam group id, tmux @cm_ws, herdr ignore
    status: completed
  - content: Close spec gap — a rename member on the seam (additive, self-clears)
    status: completed
  - content: Close spec gap — OpenedPane carries the pane's tab (additive, self-clears)
    status: completed
  - content: Deliver — the multi-tab walk and the manifest tab field
    status: completed
  - content: Deliver — the workspace geometry seam and save --workspace
    status: completed
  - content: Remove the invented label-uniqueness rules (2nd Clearance)
    status: completed
  - content: Impl gate — cold judge, IMPLEMENTATION_PASS
    status: completed
  - content: Land as PR #30
    status: completed
  - content: Drain follow-ups — #31 filed; two others dissolved
    status: completed
---

# A layout template expresses tabs, not one pane tree

CR: [#14](https://github.com/cyberuni/cyber-mux/issues/14) — a template describes a workspace as a
set of tabs, each carrying its own pane tree.

Target: `cyber-mux/layout` (`packages/cyber-mux`), suite
`packages/cyber-mux/.agents/spec/layout/layout.feature`. Reconciles into `cyber-mux/mux`
(`packages/cyber-mux/.agents/spec/mux/mux.feature`) — see the non-goal note below.

## The premise

Today `LayoutTemplate` is `{ root?: LayoutNode; panes?: FlatPane[]; arrange? }` — one split tree,
i.e. **one tab's worth**. A workspace is two levels: tabs, each holding panes. The template cannot
say that.

`layout/`'s own non-goal already flagged the deferral and left the door open: *"Named windows/tabs
inside a layout — v1 builds one region and splits inside it. An honest deferral: the schema leaves
room by keeping `root` a single node rather than a list."* This CR walks through that door.

## Ground truth from the code (mapped at intake, not assumed)

- `SessionPlacement = 'pane:right' | 'pane:down' | 'tab' | 'workspace'` (`src/session.ts`). The
  `tab` placement already exists and is already driven on both backends.
- **herdr** has a real workspace tier; `tab create --cwd --label --env --no-focus` names a tab
  **at birth**.
- **tmux** collapses `workspace` and `tab` onto the same `new-window -d`; `-n <label>` names it at
  birth. So a workspace of N tabs is **N unrelated windows** with no grouping, and
  `LayoutManifest.workspace` stays `null`.
- `openLayout` (`src/layout-session.ts`) opens **exactly one** region and treats its root pane as the
  tree root. There is no loop over regions.
- `describeRegion` is scoped to the single region a pane sits in — there is **no workspace-wide
  geometry seam**, so a multi-tab `layout save` has nothing to read.
- There is **no tab handle**: `open` returns `OpenedPane {id, workspace?}`. A tab is reachable only
  through its root pane id.

## The non-goal that needs reconciling, and why it is narrower than it reads

`mux/` states: *"Naming a tab inside a workspace is likewise out: herdr labels a new workspace's root
tab `1` with no flag to change it (only `tab rename` after the fact), and the workspace label is what
its UI groups by."*

The premise is true **only of the root tab** born with `workspace create`. Every subsequent
`tab create --label` names at birth. So the awkward case is **tab 1 alone**, not tabs in general —
the non-goal over-generalizes from one real constraint. Multi-tab layouts are its first real
customer, so it gets revisited here rather than silently contradicted.

## Backend capability, established live (herdr 0.7.4, tmux 3.6b)

Both backends **can** do this. Probed, not inferred:

- **herdr — clean.** `herdr tab list --workspace <id>` enumerates a workspace's tabs;
  `herdr pane list --workspace <id>` stamps every pane with its `tab_id`; and
  `herdr pane layout --pane <any pane in that tab>` returns live geometry for a tab that is
  **unfocused and in a different workspace**. Nothing needs focusing first, so the workspace-wide
  read is race-free.
  - Correction to `docs/design/layout-templates.md:300-303`, which asserts herdr's `layout.export`
    takes a `tab_id` as if reachable: **`herdr layout` is not a CLI verb in 0.7.4**
    (`layout.export`/`layout.apply` are socket-API-only). The adapter shells out, so the `tab_id`
    route is unreachable and the pane-per-tab indirection above is the only road.
- **tmux — needs a convention.** `tmux list-windows -a -F '…#{window_layout}'` enumerates every
  window in one call, but tmux has no workspace tier, so "which windows are this workspace" is not a
  fact it holds.

## The issue's proposed mechanism is falsified

The issue proposes carrying the grouping in the tab label (`<workspace> - <tab>`). **That label
cannot be parsed back.** A window named `acme - beta - main` is genuinely ambiguous — workspace
`acme` / tab `beta - main`, or workspace `acme - beta` / tab `main` — and no split rule resolves it;
first-occurrence makes one reading impossible, last-occurrence the other. Verified by creating that
window. A legal label silently lands in the wrong workspace's tab set.

**Resolution — the prefix and the grouping key are two different jobs.** The label prefix is kept for
what it is genuinely good at: a human reading a tmux status bar. The grouping capture reads back is
an opaque tmux **window user option**, `set-option -w @cm_ws <id>`, readable in the same enumeration
call as `#{@cm_ws}` and filterable server-side via `-f '#{==:#{@cm_ws},<id>}'`. Verified working. No
label is ever parsed, so a workspace label containing the separator is harmless and a user renaming a
window keeps its grouping.

**Restart persistence — spiked, and it is a non-question.** A tmux server restart drops the option,
but it destroys every window with it, so there are no panes left to capture. The option lives exactly
as long as the window it tags. The only real exposure is `tmux-resurrect`-style tooling restoring
windows without their user options; that is a stated limit, not a bug.

## Settled with the requester

| Question | Answer |
|---|---|
| Scope | **Full** — apply and capture both learn tabs |
| Label prefix | **Only where the backend lacks a workspace tier** (tmux yes, herdr no) |
| Focus after apply | **Unchanged** — apply never steals focus; a template cannot say |
| Shortening / collision | **No shortening.** The prefix is the label the caller already chose; `@cm_ws` carries correctness, so shortening is cosmetic and the collision question dissolves |
| tmux grouping | **Both** — label prefix for humans, `@cm_ws` for machines |
| `layout save` default | **Region, unchanged.** `--workspace` opts into multi-tab capture |

## The freeze boundary — one scenario, cleared

Exactly one frozen scenario contradicts the design. `layout.feature:109`:

```gherkin
Scenario Outline: exactly one of root and panes
  Examples:
    | both root and panes    |
    | neither root nor panes |
```

A `tabs`-only template declares neither root nor panes, so the frozen contract refuses it. The
outline is **rewritten** to the three-form schema — a re-open firing the **Clearance** floor,
**pre-authorized by the requester at intake**. Every original row survives (`both root and panes`
still exits 1) and the outline gets stricter, gaining `root and tabs` and `panes and tabs`; the row
`neither root nor panes` becomes `none of root, panes or tabs`, preserving its intent. The only
behavior that changes is what #14 exists to add.

**Nothing else is touched.** Verified rather than assumed:

- `save`'s scenarios are all region-scoped, so `--workspace` as an opt-in is purely additive.
- `the manifest's workspace is null on tmux` (`:322`) **stays true** — `@cm_ws` is cyber-mux's own
  bookkeeping, not a workspace tier. Reporting it as `workspace` would claim a tier tmux does not
  have, against the node's own absent-rather-than-false convention.
- `mux.feature` carries **no** scenario forbidding tab naming — the non-goal is README prose only,
  and `:584` (`--label names whatever --at opened, on every backend`) already specifies it. So the
  mux side is a prose reconcile, not a re-open.

## Spec gate — PASSED, self-asserted within the auto-spec leash

`status: approved`. Cold `sdd-spec-judge`, fresh context: **{oracle, builder, architect} all PASS,
ALIGNED true, 36/36 new scenarios passing, 0 failing, no blocker, no open markers.** Mechanical
`check-spec-state` + `check-suite` green; both suites parse (**layout 97 / 0 errors, mux 82 / 0**).

Edit class, verified structurally on both sides:

| Suite | added | modified | removed | class |
|---|---|---|---|---|
| `layout.feature` | 31 | 0 | 1 | the cleared Clearance |
| `mux.feature` | 5 | 0 | 0 | `addOnly` — freeze self-clears |

The judge re-derived rather than trusted: it re-ran both edit classifications, confirmed the
rewritten outline is a strict superset (no old-valid template becomes newly invalid), confirmed the
frozen tmux-workspace-null scenario is byte-identical to `main`, grepped the adapters to confirm the
seam scenarios are new surface rather than reverse-engineered from code, ran the miss test over all
36, and **independently reproduced every backend claim live** — the label ambiguity, the `@cm_ws` tag
surviving a rename and dying with its window, and herdr's unfocused-tab geometry read.

**The judge caught a real defect in this CR's own record**, now corrected: the run-start leash
predicted *"purely additive … no Clearance floor fires"*, written before the frozen suite was read.
Clearance **did** fire. Recorded as a `correction` (`explore-finding`) in the combat log; the leash
line stands as written, because the ledger is append-only and correcting a wrong prediction in place
would erase the fact that it was made.

## Deliver — what build-to-learn found, and it is the story of this CR

**The spec had two gaps of one shape, and only building surfaced them.** Both were caught by
impl-producers that **stopped and reported rather than inventing**, which is the behavior worth
keeping. Both fixes were **additive** to a frozen suite, so the freeze self-cleared and no floor
fired — `layout` still carries exactly one removal, the pre-authorized Clearance.

1. **No way to rename a space** (`correction` seq:2). `layout.feature` requires naming a space after
   birth (herdr's root tab) and `mux/README` even states the cost as "one tab rename" — but
   `SessionAdapter` had **no rename at all**. herdr's `pane rename` existed only *inside* `open`,
   private to the `pane:*` branch. Fixed with a required `rename(exec, target, tier, name)`.
2. **No way to name WHICH tab** (`correction` seq:3). `rename(…, 'tab', …)` needs a tab id;
   `OpenedPane` reported only the pane. The trap: `herdr tab rename <pane-id>` fails
   (`tab_not_found`) while `tmux rename-window -t <pane-id>` **succeeds** — so the naive fix is green
   on tmux and silently broken on herdr, with every mocked test passing. Fixed by widening
   `OpenedPane` with a **required** `tab`.

**Root cause, common to both:** the layout behavior was specified without walking the seam's actual
return shape and verb list. The spec gate could not catch it — a cold judge checks pairwise
consistency and the miss test, and neither surfaces a *mechanism that no scenario names*.

**Also caught: a false-green test** (`correction` seq:4). `a tabs template still defaults --at to
workspace` was bound on tmux and **survived** mutating its own subject, because tmux collapses
`workspace` and `tab` onto the same `new-window` — identical argv at either placement, so no
assertion over it can discriminate. Rewritten on herdr. **General hazard: tmux is the wrong backend
to bind any scenario that turns on the workspace/tab distinction.**

### Landed

| Unit | Bound | Commit |
|---|---|---|
| tabs schema + desugarer (`layout.ts`) | 9/9 | `389115e` |
| seam group id, `@cm_ws` (`session*.ts`) | 5/5 | `5cd17f4` |
| `rename` seam member | 3/3 | pending |
| `OpenedPane.tab` | 2/2 | pending |

Bridge: **layout 47/97, mux 80/87, 0 fail**; 486 tests green, `pnpm verify` 6/6.

### Seam shape deliver settled on

```ts
export type SessionSpaceTier = 'pane' | 'tab'
rename(exec: Exec, target: SessionTarget, tier: SessionSpaceTier, name: string): void

export interface OpenedPane extends SessionTarget {
	tab: string        // REQUIRED — every multiplexer has the Tab level
	workspace?: string // optional — only SOME have a Workspace level
}
```

`rename` is **required, not optional**: a caller finding it absent could not degrade, since a rename
is the only way to name a root tab (`canSizeSplits` is the contrast — a ratio has a real degrade, so
it is *declared*; a name has none). The tier signal stays `opened.workspace`, which already means
"this backend has a workspace tier" — a declared `hasWorkspaceTier` flag was rejected because it does
not stand alone (herdr's root tab needs the rename regardless).

## NEXT

**Landed as [PR #30](https://github.com/cyberuni/cyber-mux/pull/30)** — 11 commits, 510 tests,
`pnpm verify` 6/6, both gates passed, `Closes #14`. Nothing outstanding.

Final state: **layout 64/99 bound, mux 83/90, 0 fail.** Every new/changed scenario bound and
passing; **zero unbound debt added** (the 35 + 7 unbound are the untouched pre-existing baseline).
The bound count went *up* while the scenario count went *down* — `every validation error is reported
at once` had a paraphrased test title and had been bound to nothing.

**Two Clearances, both pre-authorized by the requester:**

1. The three-form outline rewrite (`exactly one of root and panes` refused a tabs-only template).
2. **Label uniqueness removed** — the requester dismantled it. It was invented, and it made capture
   lossy in the one direction that mattered: a label reaches a live pane because a *person* renamed
   it, and `save` exists to capture that, so dropping a shared label discarded the fact it was there
   to preserve. Neither backend requires uniqueness; herdr *manufactures* duplicates by labelling
   every root tab `1`. Nothing keys on a name.

**Follow-ups:** [#31](https://github.com/cyberuni/cyber-mux/issues/31) — address a pane by name or
id, failing with the candidates when ambiguous (the requester's design; the successor to removing
uniqueness). Two other recorded follow-ups **dissolved** rather than being filed, and are superseded
in the ledger so a later drain does not re-file them.

## The lesson worth carrying out of this CR

Every real defect here was found by **building**, and none by reading. Four of the eight combat-log
corrections are would-have-shipped bugs or conductor errors rather than routine iteration.

- **A route-agnostic scenario needs route-agnostic verification.** Three bugs traced to one habit:
  a behavior specified against the route being built, worded as a property of the template, bound on
  one route, silently false on the other. All three were green in CI and wrong on a real backend.
  The fix was structural, not three patches — the shared `walkTabs` engine means a route can no
  longer forget.
- **tmux cannot discriminate the workspace/tab tiers** (both emit `new-window`), so any scenario
  turning on that distinction must bind on **herdr** or it goes false-green. One did.
- **Do not report a self-imposed design limit as a fact about the world.** The conductor told the
  requester that `worktree add --layout` could not group its windows, and proposed narrowing the spec
  to match. The requester rejected the premise and was right: `@cm_ws` is an ordinary window option
  settable on any window at any time. The blocker was a seam the conductor had written, not a
  constraint anyone had found.
- **Probe before defending a rule.** Both invented-uniqueness rules survived until someone asked
  "does tmux actually reject it?" — a question answerable in one command, against a fact
  (herdr's ten root tabs labelled `1`) this CR already had in hand.
