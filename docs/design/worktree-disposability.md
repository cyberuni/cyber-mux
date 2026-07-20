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
| Table | one marker, `(done)`, on **BRANCH** — the composite `linked && !prunable && merged && !dirty && !workspace` |
| JSON | the raw booleans only. **No composite field.** |
| Rejected | ahead/behind vs upstream; last-commit age |
| Cost | `4 + N` git calls per invocation (`N` = worktrees whose checkout is on disk), up from `2` |
| Not in scope | removal gating, auto-prune, a `--prunable`/`--done` filter |

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
the listing says *not done* for a worktree that is in fact done. Under-reporting a disposal candidate
costs the reader one manual check; over-reporting would cost them work. The conservative direction is
the correct one for a signal whose whole purpose is "is it safe to delete this."

### clean vs dirty working tree — **kept**

Merged is not sufficient on its own. A merged branch whose checkout carries uncommitted edits is
*not* disposable: the edits exist nowhere else, and `worktree remove` already refuses to discard them
without `--force`. Reporting such a worktree as done would point the reader at exactly the removal
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

**The table compresses to one marker.** `(done)` on BRANCH, meaning all of:

```
linked && !prunable && merged && !dirty && !workspace
```

Every clause earns its place:

- `linked` — the primary checkout is never disposable. This also makes `(done)` mutually exclusive
  with the existing `(*)`, so BRANCH never carries two markers.
- `!prunable` — a vanished checkout already says `(gone)` on ROOT, which is *the* prune signal. Two
  markers for one action is noise, and `dirty` is unknowable for a directory that is not there.
- `merged === true` and `dirty === false` — strict identity, not truthiness. An **absent** field
  means *undeterminable* (detached HEAD, no merge target, a failed `status`), and undeterminable must
  never render as "safe to delete."
- `!workspace` — an occupied worktree is in use whatever git thinks of it.

BRANCH is the right column because the branch is what carries the work, and "the work has landed" is
what makes the checkout expendable.

`(done)` over the alternatives: `(merged)` names only one of three inputs and would read as a promise
the marker does not make; `(disposable)` is accurate and too wide for a column that is mostly short
branch names; `(gone)` is taken and means something else. The marker is defined in the command's own
`--help` text and in the docs, and the reader who wants the three inputs is one `--format json` away.

**Why no marker for the negative case.** The table's job here is to point at the removable rows, not
to explain every non-removable one. Marking "why not" would put a second marker on most rows in a
listing whose common shape is *mostly not disposable* — and the answer is one flag away.

## 6. Provenance: git answers, on every backend

The existing invariant holds unchanged and is the reason both new fields are computed in
`listWorktreesFromGit` rather than in `listWorktrees`: **worktree facts come from git on every
backend; the multiplexer contributes only the workspace binding.** A backend that also happens to
know something about a checkout is never asked, because two backends that both answered could
disagree about the same worktree.

The `(done)` composite reads `workspace`, which is joined in later by `listWorktrees` — so the
composite is evaluated at **render** time (`isWorktreeDone`, exported from `worktree.ts` so the rule
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

Measured on this repo (~20 worktrees, warm cache): 20 sequential `git status --porcelain` calls total
**~75 ms**. The batched merge read is a single call regardless of worktree count, so the growth term
is the status loop alone and it is comfortably inside an interactive budget at the target scale.

## 8. Degradation

Every path below must still produce a complete listing. A missing signal is an **absent field**,
never a throw and never a `false`.

| Situation | `merged` | `dirty` | Marked? |
| --- | --- | --- | --- |
| merged + clean + free | `true` | `false` | `(done)` |
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

- **Removal gating.** `removeWorktreeSafely`'s gates are unchanged. `(done)` informs a human; it does
  not authorize a deletion, and nothing consults it before removing.
- **Auto-prune.** This CR adds no verb that deletes.
- **Filtering.** No `--done` / `--prunable` flag. `--format json` plus `jq` serves the scripted case
  today; a filter can be added later against the fields this CR establishes.
