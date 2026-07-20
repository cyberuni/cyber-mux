# Design: worktree disposability

**Status:** accepted — implemented in `worktree.ts` / `cli.ts`.
**Scope:** `packages/cyber-mux/` — the `worktree list` surface only. This design **reports**; it never
removes, gates a removal, or prunes.
**Inputs:** `src/worktree.ts`, `src/worktree-session.ts`, `src/cli.ts`, `src/output.ts`, and the
render contract already frozen in `.agents/spec/mux/`.

## 1. Problem

`worktree list` answers *is this worktree **occupied***. `WorktreeEntry.workspace` is present when a
multiplexer workspace holds the checkout and absent when nothing does. That is a fact about **now**,
not about **worth**: a free worktree is either finished-and-disposable or idle-and-waiting, and the
listing cannot tell them apart. The reader has to open each checkout and eyeball git.

The gap to close: *is this worktree still **needed**?*

## 2. Verdict up front

| Decision | Answer |
| --- | --- |
| Signal | `merged` **and** `dirty`, both raw booleans on `WorktreeEntry` |
| Merge target | `origin/HEAD` when it resolves; otherwise the branch checked out in the **primary checkout**. Never a hardcoded `main`. |
| Table | one marker, `(removable)`, on **BRANCH** — the composite `linked && !prunable && merged && !dirty && !workspace` |
| JSON | the raw booleans only. **No composite field.** |
| Rejected | ahead/behind vs upstream; last-commit age |
| Cost | `4 + N` git calls per invocation (`N` = worktrees whose checkout is on disk), up from `2` |
| Not in scope | removal gating, auto-prune, a `--prunable`/`--removable` filter |

## 3. Which signal actually answers "no longer needed"

Four candidates were on the table. Two survive.

### merged into the default branch — **kept**

This is the only signal that speaks to **worth** rather than to state. A branch whose tip is an
ancestor of the default branch has had its work absorbed; deleting the checkout destroys nothing that
is not already in the trunk. Everything else on this list describes what the worktree *is doing*, not
whether its reason for existing is gone.

It also batches: **one** `git branch --format=%(refname:short) --merged <target>` from the primary
root yields the merged set for every branch in the repo at once. Cost is flat in the number of
worktrees.

*Known limitation, deliberately accepted:* a **squash** or **rebase** merge rewrites the commits, so
the original tip is not an ancestor and `--merged` reports `false`. The error is one-directional —
the listing withholds the marker from a worktree that is in fact disposable. Under-reporting a candidate
costs the reader one manual check; over-reporting would cost them work. The conservative direction is
the correct one for a signal whose whole purpose is "is it safe to delete this."

### clean vs dirty working tree — **kept**

Merged is not sufficient on its own. A merged branch whose checkout carries uncommitted edits is
*not* disposable: the edits exist nowhere else, and `worktree remove` already refuses to discard them
without `--force`. Marking such a worktree removable would point the reader at exactly the removal
the CLI is going to refuse.

Dirtiness is also the one input the reader cannot recover from anywhere else in the row.

### ahead/behind vs upstream — **rejected**

Ahead/behind is the wrong question asked in a confusing way. *Behind* says nothing about
disposability — a finished, fully merged branch is behind the trunk the moment anyone else lands a
commit, and it is exactly as disposable as it was a second earlier. *Ahead* is a strictly weaker
restatement of `merged`: a branch with unmerged commits is already `merged: false`, and the count of
them changes no decision. It would add two numeric fields, a per-worktree `rev-list --count` call,
and a hard dependency on an upstream that a local worktree branch frequently does not have — to
report something already implied.

### last-commit age — **rejected**

Age is a proxy, and a treacherous one in both directions. An old merged branch is disposable, but so
is a merged branch from ten minutes ago; a six-month-old branch with real unmerged work is not
disposable at any age. Age also has no threshold that is defensible without a policy knob, and a
policy knob on a listing verb is a second design. The signals that *do* answer the question already
answer it without asking the reader to pick a number.

## 4. What the merge target is

Hardcoding `main` is wrong twice: on a `master` repo and on any repo with a different trunk. The
resolution chain, in order:

1. `git symbolic-ref --short refs/remotes/origin/HEAD` → `origin/main` (or whatever the trunk is).
   The **remote-tracking** ref is the target, not the local branch: "merged" means *landed upstream*
   in a PR workflow, which is the workflow this tool exists to serve. A stale local `main` would
   under-report, and while under-reporting is the safe direction, `origin/HEAD` is simply the more
   truthful answer when it is available.
2. Otherwise, the branch checked out in the **primary checkout** — the entry where `linked` is
   `false`, already parsed and in hand, so this fallback costs **zero** extra git calls. For a
   local-only repo with no remote, the primary checkout's branch *is* the trunk.
3. Otherwise (bare primary, detached primary, no origin) → **no target**. `merged` is absent on every
   entry and no row is marked. Degrade; never guess, never throw.

## 5. The split: what JSON carries vs what the table compresses to

The brief's framing is the right one, and both extremes are real failure modes. A single opaque
`disposable: true` is unexplainable — the reader cannot see which of three conditions made it false.
Four raw booleans in a table is a wall, and the previous CR deleted a column on purpose.

**JSON carries the raw facts, and only the raw facts.** `merged` and `dirty` join `linked`,
`prunable`, and `workspace`. There is deliberately **no** composite field in the payload:

- it is fully derivable from fields already present, and a derived field in a payload is a
  maintenance liability that can drift from its own inputs;
- it would freeze *one* policy into the wire format. A consumer that wants "merged and clean, ignore
  occupancy" — a batch cleaner that closes workspaces itself — is a legitimate consumer, and the raw
  fields serve it while a baked `disposable` fights it.

**The table compresses to one marker.** `(removable)` on BRANCH, meaning all of:

```
linked && !prunable && merged && !dirty && !workspace
```

Every clause earns its place:

- `linked` — the primary checkout is never disposable. This also makes `(removable)` mutually exclusive
  with the existing `(*)`, so BRANCH never carries two markers.
- `!prunable` — a vanished checkout already says `(gone)` on ROOT, which is *the* prune signal. Two
  markers for one action is noise, and `dirty` is unknowable for a directory that is not there.
- `merged === true` and `dirty === false` — strict identity, not truthiness. An **absent** field
  means *undeterminable* (detached HEAD, no merge target, a failed `status`), and undeterminable must
  never render as "safe to delete."
- `!workspace` — an occupied worktree is in use whatever git thinks of it.

BRANCH is the right column because the branch is what carries the work, and "the work has landed" is
what makes the checkout expendable.

`(removable)` over the alternatives, and this went through a revision worth recording. The marker
first shipped as `(done)`, which is shorter and reads as plain English — but its **referent is
ambiguous**: done *what*? A reader (or an agent still on the default table, see §5.1) has to guess
whether it describes the branch's work, a process that finished, or a task. `(removable)` names the
**action the reader can take** rather than a state they must interpret, which is also what this repo's
AXI bar pushes for everywhere else. The six extra characters land on one column, on only the rows that
earned the marker.

The others: `(merged)` names one of three inputs and would read as a promise the marker does not make;
`(disposable)` is a synonym with no advantage and two more characters; `(gone)` is taken and means
something else. The marker is defined in the command's own `--help` text and in the docs, and the
reader who wants the three inputs is one `--format json` away.

### 5.1 Would a column be clearer to an agent?

No — and the question is answered on a different surface than the one it is asked about.

**An agent reads `--format json`, where there are no markers at all.** It receives `merged`, `dirty`,
`linked`, `prunable`, and `workspace` as named booleans, and `mux/`'s frozen render contract holds the
line: *a marker shows a fact, and is never the fact*. Nothing about a marker's wording reaches a
consumer that asks for structured output, so a column would add a fourth human-surface rendering
beside three that already exist, on the surface the agent is not reading.

The caveat is real but narrow, and it is checked at the source rather than assumed: `.agents/spec/axi.md`
lists TOON-as-the-default-format under **"What still trails the contract."** So *today* an agent that
runs `worktree list` with no `--format` does get the human table. That is the only reason marker
wording is an agent question at all — and the fix for it is finishing AXI #1, not spending a column.

A column would not even solve the stated problem. A `STATUS` column carrying the value `removable` has
exactly the same referent to resolve as the marker does, and costs its full width on **every** row to
carry a value that distinguishes a few. That is the trade the previous CR deleted a column to avoid.
The wording fix (`done` → `removable`) addresses the ambiguity; the column addresses nothing.

**Why no marker for the negative case.** The table's job here is to point at the removable rows, not
to explain every non-removable one. Marking "why not" would put a second marker on most rows in a
listing whose common shape is *mostly not disposable* — and the answer is one flag away.

## 6. Provenance: git answers, on every backend

The existing invariant holds unchanged and is the reason both new fields are computed in
`listWorktreesFromGit` rather than in `listWorktrees`: **worktree facts come from git on every
backend; the multiplexer contributes only the workspace binding.** A backend that also happens to
know something about a checkout is never asked, because two backends that both answered could
disagree about the same worktree.

The `(removable)` composite reads `workspace`, which is joined in later by `listWorktrees` — so the
composite is evaluated at **render** time (`isWorktreeRemovable`, exported from `worktree.ts` so the rule
is stated once and tested directly), not baked into the entry during the git read.

## 7. Cost

Per `worktree list` invocation, `N` = worktrees whose checkout is on disk:

| Call | Count | Batched? |
| --- | --- | --- |
| `rev-parse --git-common-dir` (existing) | 1 | — |
| `worktree list --porcelain` (existing) | 1 | yes |
| `symbolic-ref refs/remotes/origin/HEAD` | 1 | — |
| `branch --format --merged <target>` | 1 | **yes — whole repo, one call** |
| `status --porcelain` per worktree | **N** | **no** |

**Total `4 + N`, up from `2`.**

The `N` is unavoidable and is stated rather than hidden. A working tree's cleanliness is a property of
a **directory**, and git offers no primitive that reports it for several worktrees at once —
`worktree list --porcelain` does not carry it, and there is no `status --all-worktrees`. The one call
is skipped for a `prunable` entry, where there is no directory to stat.

### 7.1 Where the wall time actually goes

Measured on this repo, 20 worktrees, warm cache, local ext4 — per `worktree list` invocation:

| Component | Cost | Grows with `N`? |
| --- | --- | --- |
| node startup + bundle load | 41 ms | no |
| `rev-parse` + `worktree list --porcelain` + `execFileSync` spawn overhead | ~117 ms | no |
| `symbolic-ref` + `branch --merged` — the **`merged`** signal | **10 ms** | **no — batched** |
| `status --porcelain` × 20 — the **`dirty`** signal | **74 ms** | **yes** |
| **total** | **~242 ms** | |

Two things fall out, and both matter more than the headline number:

- **The signal costs ~84 ms on a ~160 ms baseline** — roughly 1.5×, not an order of magnitude. Most of
  the invocation is node startup and per-spawn overhead, not git.
- **`merged` and `dirty` are not the same kind of cost.** `merged` is batched and flat — ~10 ms whether
  the repo has 2 worktrees or 200. `dirty` is **100% of the growth term**. Any future lever belongs on
  `dirty` alone; gating "the disposability signal" as one unit would trade away the cheap half for
  nothing.

A full `status --porcelain` on the largest repo available locally (1675 tracked files, 581 MB of
`node_modules`) measured **13 ms** — `.gitignore` short-circuits the directory walk, so the untracked
scan is far cheaper than its reputation.

### 7.2 The tail this does NOT measure

Every number above is **warm-cache, small-repo, local ext4**, and none of it generalizes to:

- a monorepo one to two orders of magnitude larger (100k+ tracked files);
- a **cold** page cache;
- a network filesystem, or a host where per-file `stat` is expensive.

On any of those, one `git status` can run 500 ms–2 s, and 20 worktrees becomes **10–40 seconds**. That
is a real cliff, it is simply not reachable from the measurements here, and it is recorded rather than
left for a best-case number to imply away.

**Trigger to revisit:** a report of `worktree list` taking more than ~2 s, or adoption on a repo an
order of magnitude larger than this one.

### 7.3 Why there is no `--no-dirty` flag

There are genuine callers that never need the signal — resolving a branch's checkout path, or asking
only which workspace holds a worktree — and `axi.md` notes this CLI is driven almost entirely by
agents, for whom path lookup is plausibly the dominant call. So the question is real; a bespoke flag is
just the wrong shape of answer:

1. **The general lever already exists in the contract and is unbuilt.** AXI **#2** (`--fields` / `--full`,
   listed under *"What still trails the contract"*) says a list row carries 3–4 fields by default and
   full detail is reached explicitly. Computing `dirty` only when that field was asked for falls out of
   #2 for free and applies to every command, not just this one.
2. **A one-off `--no-dirty` becomes debt against that work** — a negative flag, a second code path, and
   something #2 would have to unwind.
3. **The measured cost does not justify the surface today**, per §7.1.

Short-circuiting instead — running `status` only where `merged && linked && !prunable && !workspace`,
the rows where the answer could change — was also weighed and rejected here: it would make `dirty`
absent on rows that were simply never checked, overloading the "absent means *undeterminable*" promise
§8 depends on. It stays available as a remedy if §7.2's tail is ever actually hit.

## 8. Degradation

Every path below must still produce a complete listing. A missing signal is an **absent field**,
never a throw and never a `false`.

| Situation | `merged` | `dirty` | Marked? |
| --- | --- | --- | --- |
| merged + clean + free | `true` | `false` | `(removable)` |
| merged + dirty | `true` | `true` | no |
| unmerged | `false` | `false` | no |
| merged + clean but **occupied** | `true` | `false` | no |
| detached HEAD (no branch) | absent | read normally | no |
| bare entry | absent | absent | no |
| prunable (checkout gone) | read normally | absent | no — ROOT says `(gone)` |
| no `origin/HEAD` **and** no primary branch | absent | read normally | no |
| `git branch --merged` fails | absent | read normally | no |
| `git status` fails | read normally | absent | no |

## 9. Explicitly out of scope

- **Removal gating.** `removeWorktreeSafely`'s gates are unchanged. `(removable)` informs a human; it does
  not authorize a deletion, and nothing consults it before removing.
- **Auto-prune.** This CR adds no verb that deletes.
- **Filtering.** No `--removable` / `--prunable` flag. `--format json` plus `jq` serves the scripted case
  today; a filter can be added later against the fields this CR establishes.
