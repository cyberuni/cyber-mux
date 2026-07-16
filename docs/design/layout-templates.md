# Design: layout templates

**Status:** proposed — design only, nothing implemented.
**Scope:** `packages/cyber-mux/` — a named, reusable workspace-layout template applied against a
target directory at invocation time.
**Inputs:** `.research/mux-workspace-layouts/conclusion.md`, `.research/mux-message-bus/conclusion.md`,
and the current source (`session.ts`, `session.tmux.ts`, `session.herdr.ts`, `worktree.ts`,
`worktree-session.ts`, `cli.ts`).

## 1. Problem

Spinning up a pool of agent panes for a fresh git worktree is a repeated, hand-driven sequence of
`cyber-mux open` calls today: one per pane, each with its own `--cwd`, `--launch`, `--label`, and no
way to express geometry beyond "right" or "down" relative to wherever the caller happens to be.

A layout template names that sequence once and re-targets it at a new directory on every apply. The
research verdict, which this design adopts: **a tree of splits/panes with geometry, a startup command
+ env per pane, and an apply-time `cwd` override so one named template targets a new directory each
call.** Nothing about the target directory is ever written into the template.

## 2. Verdict up front

| Decision | Answer |
| --- | --- |
| Where templates live | `<primaryRoot>/.cyber-mux/layouts/<name>.json`, then `$XDG_CONFIG_HOME/cyber-mux/layouts/<name>.json`. Repo wins. |
| Format | JSON. Zero new dependency, matches herdr's native shape, matches `--format json`. |
| Schema | Binary split tree (`split` / `pane` nodes), `direction: right\|down`, `ratio`, `first`/`second`; panes carry `label`/`command`/`env`/`dir`. **No `cwd` field exists at all.** |
| Flat-N sugar | Yes — `panes: [...]` + `arrange`, compiled by cyber-mux into a canonical nested split tree on **both** backends. tmux's native `select-layout` is deliberately not used. |
| CLI | `cyber-mux layout list \| show \| validate \| export` — the group **manages templates**. Applying one is not its own verb: it is `--layout` on the commands that already open a space (`open`, `worktree add`), the exact sibling of `--launch`. §6. |
| Backend strategy | cyber-mux owns the layout engine and compiles to the **portable `SessionAdapter` verbs**, not to any backend's native layout primitive. See §7 — this is where this design departs from the research. |
| Out of scope | Dispatch, mailbox, routing, "who is idle". Not cyber-mux's job. §11. |

## 3. Where the template file lives

### The constraint the research did not have

cyber-mux is used across many worktrees of one project. A repo-local layout directory must resolve to
**one shared location** from every worktree — otherwise every `git worktree add` either duplicates
the templates or loses them.

The codebase already solves this. `resolvePrimaryRoot` (`worktree.ts:76`) resolves the primary
checkout from anywhere via `git rev-parse --git-common-dir`, and every worktree verb already pins its
git calls to it. A linked worktree is a checkout of the same repo, so a tracked
`<primaryRoot>/.cyber-mux/layouts/` file is *also* present in each worktree's own checkout — but
resolving through `resolvePrimaryRoot` gives one canonical answer regardless of which worktree the
caller sits in, and regardless of whether the worktree's branch happens to predate the template.
That last part is the reason to resolve rather than to read `./.cyber-mux` relative to cwd: a
worktree branched from an older commit would otherwise silently see a stale template, or none.

### Resolution order

1. `--file <path>` — explicit, skips resolution entirely. Also the escape hatch for a template that
   is not checked in.
2. `<primaryRoot>/.cyber-mux/layouts/<name>.json` — the project's templates, checked in, shared by
   every worktree and every contributor.
3. `${XDG_CONFIG_HOME:-~/.config}/cyber-mux/layouts/<name>.json` — the user's own templates, across
   projects.

Repo beats user, deliberately: a project that ships a layout is making a statement about how the
project is worked on, and a personal `pool-3.json` should not silently shadow it. `layout list`
reports the source of each name and marks a user template that a repo template shadows.

Precedent: Zellij resolves named layouts from a `layouts/` directory by filename (E4); WezTerm and
herdr have no directory convention at all, so there is nothing to match there.

**Not** a single `.cyber-mux.json` with all layouts inline: one-file-per-template makes `layout list`
a `readdir`, makes a template copy-pasteable between repos, and keeps diffs scoped to the layout that
changed.

### The testability problem this creates

Every seam in this codebase is `Exec`, and adapters are tested with a mocked `Exec` and no real
multiplexer (per `AGENTS.md`). Layout resolution is the first feature that needs the **filesystem**,
which has no seam. Reading templates through bare `node:fs` would make `layout` the one command tree
that cannot be driven hermetically in `cli.test.ts`.

Proposal: add a `LayoutStore` to `CliDeps` alongside `env`/`exec` —

```ts
export interface LayoutStore {
  /** Template names available at this source, for `layout list`. */
  list(dir: string): string[]
  /** Raw file contents, or null when absent — mirrors Exec's null-on-failure convention. */
  read(path: string): string | null
}
```

with a `realLayoutStore` in `REAL_DEPS` and a fake in tests. `null`-on-absent rather than throwing
matches `Exec`'s existing convention, so the resolution chain is a plain `??` walk.

## 4. File format

**JSON.** Reasoning, in order of weight:

1. **Zero new dependency.** `packages/cyber-mux/package.json` has exactly one runtime dependency:
   `commander`. There is no YAML or TOML parser anywhere in the monorepo, and Node ships neither —
   verified on the pinned 24.15.0, not merely assumed from the `>=22` engine floor. YAML would add a
   parser to the *published* dependency tree, which every consumer of a package whose whole pitch is
   being a narrow, thin CLI would inherit — for a config file most users write once. This reason
   carries the decision on its own.
2. **It is already the output shape.** `--format json` exists on every command that reports
   structure. `layout show` emitting the same format it consumes closes the loop, and makes a
   generated template (from a script, or a future `layout export`) trivial.

Note what is deliberately **not** an argument here: that JSON is herdr's wire shape. It is, but this
design compiles to the portable `SessionAdapter` verbs and never builds a `layout.apply` body (§7.1),
so the encodings agreeing buys nothing — and the *schemas* deliberately disagree in three places
(this schema forbids `cwd`; it makes `ratio` optional where herdr's `LayoutNode` requires it; its
`command` is a shell string where herdr's is argv). Arguing from a wire shape this design does not
speak would be borrowing credibility from a rejected route.

Costs, acknowledged: no comments, and the nesting is noisier to hand-author than
tmuxinator's YAML. The `panes` + `arrange` sugar (§5.3) removes the nesting for the common case,
which is where most of that pain lives. A `description` field carries the one comment a template
usually wants. If authoring ergonomics later prove to be the blocker, YAML can be added as a second
accepted extension without changing the schema — the schema is the contract, the encoding is not.
That reversibility is what makes this a cheap decision rather than a load-bearing one: `layout.ts` is
pure and parses to an in-memory tree, so nothing downstream knows what bytes it came from. If the
missing-comments cost is what bites (likelier than nesting, since `description` covers the template
but not *"why is this pane's ratio 0.3?"*), JSONC is the smaller move than YAML — same schema, same
`JSON.parse` after a strip.

TOML is rejected outright, and for a stronger reason than aesthetics: its array-of-tables syntax
cannot express `first`/`second` recursion at all without inventing a flattening convention, and the
schema is a recursive tree. KDL is rejected: Zellij's format, no Node parser worth the dependency, no
gain over JSON here.

Extension: `.json`. Filename stem is the template name; a name is `[a-z0-9][a-z0-9-]*` and is
validated to be exactly the stem, so a name can never traverse out of the layouts directory.

## 5. Schema

### 5.1 Tree form

```json
{
  "name": "agent-pool-3",
  "description": "One planner over two workers",
  "root": {
    "type": "split",
    "direction": "right",
    "ratio": 0.5,
    "first": {
      "type": "pane",
      "label": "planner",
      "command": "claude",
      "env": { "ROLE": "planner" }
    },
    "second": {
      "type": "split",
      "direction": "down",
      "ratio": 0.5,
      "first":  { "type": "pane", "label": "worker-a", "command": "claude", "env": { "ROLE": "worker" } },
      "second": { "type": "pane", "label": "worker-b", "command": "claude", "env": { "ROLE": "worker" } }
    }
  }
}
```

### 5.2 Fields

**Template**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Must equal the filename stem. Redundancy is the point: a copied file that kept its old name fails validation loudly. |
| `description` | string | no | Human note; JSON has no comments. |
| `root` | Node | one of | The split tree. |
| `panes` + `arrange` | see §5.3 | one of | The flat sugar. Exactly one of `root` / `panes` — both, or neither, is a validation error. |

**Split node**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | `"split"` | yes | Explicit discriminant. Not inferred from which keys are present — an inferred union produces terrible errors on a typo. |
| `direction` | `"right"` \| `"down"` | yes | **Deliberately the existing vocabulary**, matching `SessionPlacement`'s `pane:right`/`pane:down` and herdr's `--direction right\|down`. Not `horizontal`/`vertical`: tmux's `-h` means "side by side" while most people read "horizontal" as "a horizontal divider", and that ambiguity has burned every tool that shipped it. `right` and `down` say where the new pane goes and cannot be misread. |
| `ratio` | number | no | Fraction of the region given to `first`. `0 < ratio < 1`, default `0.5`. See §7.3 for the compile rule — the sign convention matters. |
| `first` | Node | yes | Keeps the region's existing pane. |
| `second` | Node | yes | Gets the newly split-off pane. |

**Pane node**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | `"pane"` | yes | |
| `label` | string | no | Passed to `open`'s `label` (herdr: `pane rename`; tmux: `select-pane -T`). Also the pane's key in the apply manifest (§6.5) — this is what a higher layer addresses the pane by, and the one field `layout export` (§6.4) can recover. Must be unique within a template; duplicates are a validation error. |
| `command` | string | no | Launched via `submit` after geometry is built (§7.2). Omit for a blank shell pane. |
| `env` | `Record<string,string>` | no | Set in the pane's environment at birth. Native on both backends (§7.3 Gap C). Valid with or without `command`. |
| `dir` | string | no | A **relative** subdirectory, joined onto the apply-time cwd. Absolute paths and any `..` escape are validation errors. This is the pressure valve for "the test-watcher pane starts in `packages/cyber-mux`" without ever letting a machine-specific path into the template. |
| `cwd` | — | **rejected** | Not "optional" — not in the schema. A template carrying a `cwd` fails validation with an error naming `--cwd` and `dir`. This is the single rule the whole feature exists to enforce; making it a hard error rather than an ignored key is what keeps a template reusable. |

### 5.3 Flat-N sugar

The research flagged this as the one real ergonomics cost of herdr's binary tree: a 4-pane grid needs
three nested split nodes, and nobody wants to hand-write that.

```json
{
  "name": "pool-4",
  "arrange": "tiled",
  "panes": [
    { "label": "w1", "command": "claude", "env": { "ROLE": "worker" } },
    { "label": "w2", "command": "claude", "env": { "ROLE": "worker" } },
    { "label": "w3", "command": "claude", "env": { "ROLE": "worker" } },
    { "label": "w4", "command": "claude", "env": { "ROLE": "worker" } }
  ]
}
```

`arrange`: `"tiled"` (default) | `"even-horizontal"` (all side by side) | `"even-vertical"` (all
stacked). Names borrowed from tmux's built-ins because they are the names people already know.

**The sugar is desugared by cyber-mux's own compiler into a canonical nested split tree, and the
result is identical on every backend.** tmux's native `select-layout tiled` is deliberately *not*
used, even though it exists and would be one call. Reason: `select-layout tiled` implements tmux's
own grid algorithm, herdr has no equivalent, and using it would mean the same template produces a
visibly different geometry on tmux than on herdr — and a third geometry on whatever backend comes
next, each with its own grid algorithm and its own edge cases at odd `n`. One template, one geometry,
everywhere — that is the entire value of a backend-agnostic schema, and it is worth more than one
saved call. This is §7.1's principle at the schema level: cyber-mux owns the geometry, the backend
only splits panes. The desugaring is pure, total, and unit-testable with no multiplexer at all.

Desugaring rules (deterministic, so `layout show --desugar` prints exactly what apply will build):

- `even-horizontal`: a right-comb — split right at `1/n`, `1/(n-1)`, … so all `n` panes end equal.
- `even-vertical`: the same comb, `down`.
- `tiled`: split into `ceil(n/2)` columns and the rest as rows, balanced — for `n=4`, one `right` at
  `0.5` then a `down` at `0.5` in each half. Exact algorithm is the implementation's to pin, but it
  must be a pure function of `n` alone, documented, and covered by a table test for `n = 1..8`.

`n = 1` is legal and produces a single pane with no split.

### 5.4 What is *not* in the schema

- **`cwd`** — §5.2. The point of the feature.
- **Agent status / role semantics** — a layout is write-only. It creates panes; it does not know or
  care that a pane later becomes `idle`. See §11.
- **`wait_for` / sequencing** — `herdr-spreader` has it; it turns a layout into a script. A template
  that waits on output is a workflow, and a workflow belongs to the caller.
- **Focus** — apply never steals focus (matching every existing spawn path, which all pass
  `--no-focus` / `-d`). A caller who wants to land somewhere calls `cyber-mux focus` with a pane id
  from the manifest.
- **Named windows/tabs inside a layout** — v1 builds one region (one workspace, tab, or pane) and
  splits inside it. Multi-tab layouts are a real want and an honest deferral; the schema leaves room
  by keeping `root` a single node rather than a list.

## 6. CLI surface

Follows the existing group pattern (`worktree add|open|list|remove`), the shared `FORMAT_OPTION` /
`AT_OPTION` / `LABEL_OPTION` from `cli-options.ts`, and the existing `fail()` convention.

### 6.1 `cyber-mux layout list`

Every template name resolvable from here, with source and pane count.

```
name          source  panes  shadows
agent-pool-3  repo    3
pool-4        repo    4
scratch       user    2
```

`--format json` → `{ layouts: [{ name, source, panes, path, shadowed }] }`. Works with no multiplexer
at all — like `worktree list`, its subject is not the mux (`optionalAdapter` is not even needed; no
adapter is touched).

### 6.2 `cyber-mux layout show <name> [--desugar]`

The resolved template as JSON. `--desugar` prints the canonical tree that `panes`/`arrange` expands
to — the debugging tool for "why did my tiled layout come out like that".

### 6.3 `cyber-mux layout validate <name> | --file <path>`

Exit 0 valid, 1 invalid, errors on stderr, one per line, each naming a JSON path
(`root.second.first.cwd: templates must not set cwd — pass --cwd at apply time, or use "dir" for a
subdirectory`). Touches no multiplexer. This is the CI hook: `cyber-mux layout validate --file
.cyber-mux/layouts/*.json`.

### 6.4 `cyber-mux layout export <name> [--from <pane>]`

Capture the caller's live region back into a template, so a pool is **built by hand once and named**
rather than hand-written as a tree. This closes the schema's one real authoring cost — the research's
own flagged weakness, that a 4+ pane grid needs nested `split` nodes nobody wants to type (§5.3).

Was deferred as Q6 on the reasoning that *"the portable path cannot do it at all — `listPanes`
reports no split structure"*. That is true of the **seam** and false of the **backends**, so the
premise does not hold and export is a v1 verb:

- **herdr** — `pane layout` returns `splits[]` carrying `direction` + `ratio` directly.
- **tmux** — `#{window_layout}` returns a nested tree:
  `83ae,200x50,0,0{133x50,0,0[133x29,0,0,0,133x20,0,30,2],66x50,134,0,1}`, where `{}` is a horizontal
  split and `[]` a vertical one.

Both verified against live binaries. So export costs a **new portable seam verb** — "report this
region's geometry" — not a herdr-only verb. That was Q6's stated fork, and the cheap branch turned
out to be available.

**The tier is a region, not a workspace.** Both backends export at tab/window granularity (herdr's
`layout.export` takes a `tab_id`/`pane_id` and exports *that tab*; tmux's is `window_layout`), which
matches §5.4's rule that v1 builds one region and splits inside it. `--from` defaults to the caller's
own pane via `callerPane` (`backend.ts`), so bare `layout export pool-4` captures the region you are
sitting in. The name is positional, matching `show` / `validate`.

**Three conversion rules, each load-bearing:**

1. **n-ary → binary.** tmux's tree is n-ary — three panes side by side is *one* node with three
   children (`{66x50,0,0,0,66x50,67,0,1,66x50,134,0,2}`), not nested binary splits. Lowering it is a
   **right-comb** — which is exactly what §5.3 already specifies for `arrange: even-horizontal`.
   Export and the flat-N sugar reach the same canonical form from opposite directions, so the
   lowering is not new code so much as the desugarer's inverse.
2. **Cells → ratio.** tmux reports sizes in cells, so `ratio = child / parent`, rounded. herdr
   reports `ratio` directly. A round-trip is therefore *approximate* on tmux and exact on herdr.
3. **cwd → stripped, or relativized to `dir`.** A live region has an absolute cwd on every pane, and
   the schema forbids `cwd` outright (§5.2). Export strips it, emitting `dir` only where a pane sits
   *under* the captured root. This is apply's injection run backwards, and the fact that the rule
   composes in both directions is the best evidence it is coherent rather than arbitrary.

**Export recovers geometry, not commands. State this in `--help`, or it reads as round-trip.** No
backend can give the launch command back:

- tmux has `pane_start_command`, but it is **empty for every pane cyber-mux creates** — §7.2 types
  commands with `submit` rather than passing them to the split, which herdr forces (its `pane split`
  takes no command at all). `pane_current_command` reports `zsh` or `node`, never `claude --foo`.
- herdr can name the *harness* in a pane, which is not a command line either.

So the emitted template carries the tree, ratios, labels and dirs, with `command` left for the author
to fill. That is still the bulk of the value — geometry is the verbose part; a command is one word —
but a template straight out of `export` is a **draft**, not a finished artifact. `export` prints to
stdout rather than writing a file, so the author edits before it lands anywhere.

### 6.5 Applying a template: `--layout` on the verbs that open a space

**There is no `layout apply`.** Applying is not a layout-group concern — it is what `open` and
`worktree add` already do, told to build N panes instead of one. `--layout <name>` is the exact
sibling of `--launch <command>`: both answer *"what runs in the space you are opening"*, one for a
single pane and one for a pool. They are **mutually exclusive**; commander rejects the pair.

```bash
cyber-mux open --layout agent-pool-3 --cwd <path> --at workspace
cyber-mux worktree add --branch feat-x --layout agent-pool-3
```

An earlier draft had both a `layout apply <name> --at workspace --cwd <path>` verb *and*
`worktree add --layout`, which were two roads to one place — `apply`'s `--at` defaulted to
`workspace`, so it was `open --at workspace` wearing a layout-shaped hat. Folding it in leaves one
way to open a space, and leaves the `layout` group doing only what its name says: managing templates.
Note there is deliberately no `workspace` verb to hang this on either — `workspace` is an `--at`
value, and `open --at workspace` is already that command.

| Option | Default | Notes |
| --- | --- | --- |
| `--layout <name>` | — | Mutually exclusive with `--launch`. |
| `--cwd <path>` | `process.cwd()` | The injected target. `open`'s existing default. On `worktree add` the worktree root is the target and `--cwd` does not apply. |
| `--at <placement>` | `workspace` when `--layout` is given | A fresh space is empty by construction, which sidesteps §9.3 entirely. |
| `--label <label>` | template name | Names the opened region. |
| `--if-populated <policy>` | `fail` | `fail` \| `append`. §9.3. Only reachable via `--at pane:*` / `tab`; see the open question below. |
| `--dry-run` | off | Print the manifest that *would* be built and touch nothing. |

**Two unsettled costs of the fold, recorded rather than hidden:**

- **`--format json` goes conditional.** Bare `open` reports `{ pane }`; `open --layout` must report
  the manifest below. A verb whose output shape depends on a flag is a wart. It is not a *new* wart —
  `worktree add --layout` had it the moment §6.5 existed — but folding `apply` in means `open` now
  carries it too.
- **`--if-populated` and `--dry-run` migrate onto `open`.** Both are arguably not worth their keep.
  `--if-populated` is moot at the default placement by the design's own admission and rests on §9.3's
  cwd heuristic, which that section calls the design's weakest joint. `--dry-run` overlaps
  `show --desugar`, which already prints the tree with no cwd in sight; all `--dry-run` adds is `dir`
  resolved against a real target, and its manifest is a half-truth anyway — pane ids do not exist
  yet, so every `pane` field is `null`, a different shape from the one §11 promises. **Open: cut
  either or both from v1.** Flagged, not decided.

`--format json` emits the **apply manifest** — the handoff contract (§11):

| Option | Default | Notes |
| --- | --- | --- |
| `--cwd <path>` | `process.cwd()` | The injected target. Same default as `open`. |
`--format json` emits the **apply manifest** — the handoff contract (§11):

```json
{
  "layout": "agent-pool-3",
  "cwd": "/home/u/code/proj.worktrees/feat-x",
  "workspace": "w7",
  "panes": [
    { "label": "planner",  "pane": "w7:pA", "dir": "/home/u/code/proj.worktrees/feat-x", "command": "claude" },
    { "label": "worker-a", "pane": "w7:pB", "dir": "/home/u/code/proj.worktrees/feat-x", "command": "claude" },
    { "label": "worker-b", "pane": "w7:pC", "dir": "/home/u/code/proj.worktrees/feat-x", "command": "claude" }
  ]
}
```

`workspace` is `null` on tmux, matching how `reportOpenedWorktree` already reports it. On
`worktree add --layout` the same manifest is reported alongside the worktree's own `root`/`branch`
(§9.1) — that composition flow is the primary one this feature exists for.

## 7. Compilation

### 7.1 cyber-mux owns the layout engine — the departure from the research

The research recommends compiling the tree into one herdr `layout.apply` socket call, calling it a
"near-lossless mapping". It is. This design does not take it, for two reasons — the second is the
load-bearing one.

**The narrow reason: `session.herdr.ts` does not speak the socket API.** Its own header states the
choice and the reason:

> Talks to herdr's own CLI (`herdr pane ...`) rather than its Unix-socket API, so it composes with
> this codebase's synchronous `Exec` convention exactly like the tmux adapter — no new
> client/transport needed.

`layout.apply` is a socket-API verb. Reaching it means a Unix-socket client, which means async, which
breaks the synchronous `Exec` seam that **every** adapter and **every** test in this package is built
on.

**The real reason: more multiplexers are coming, and only one of them will ever have
`layout.apply`.** This is not speculative — `mux-probe.ts` already carries `screen` in the
`CYBER_MUX` override vocabulary, and the package's entire pitch is *one contract over terminal
multiplexers*. herdr's native tree-apply is, per the research, unique in the field: tmux has nothing,
cmux has nothing, WezTerm has nothing, screen has nothing. Zellij has KDL layouts in an incompatible
shape.

So a design that leans on `layout.apply` is a design where **the good path exists on exactly one
backend and every other backend needs the portable walk anyway** — the walk gets written regardless,
and the `layout.apply` path is a second implementation of an already-solved problem, gated on a
transport, that only ever serves one adapter. That is the expensive branch, not the cheap one.

**Therefore: cyber-mux owns the layout engine.** The compiler is a pure tree-walk emitting
`open`/`submit` calls against the portable verbs. It is not a fallback and not a v1 compromise — it
is the implementation, on every backend, and a new adapter gets layouts the moment it implements
`open` plus §7.3's Gap A. Nothing about a template, its schema, its desugaring, or its geometry is a
backend's business. The capability the multiplexer must supply is *"split **this** pane, that way"*,
and that is the whole ask.

**That ask is small, but it is not universal — and the counter-example is already in the
vocabulary.** An earlier draft called it "a low bar deliberately, because it is the bar screen,
Zellij, or WezTerm would each have to clear". screen does not clear it (§12 Q7): its regions have no
ids, `split` splits only the current region, and it carries no per-pane env var, so a caller cannot
name its own pane *or* name the pane to split. So layouts are an **optional capability**, exactly as
`worktree?` already is — *"present only on a backend that binds a git worktree to a workspace
(herdr); `undefined` on one with no such concept (tmux)"* — and as `isPaneFocused` is for a fact a
backend cannot answer. A screen adapter would be a genuinely different shape (send/read per *window*,
which works fine), not a degraded one. Finding the floor does not move the argument: the walk is
still the implementation everywhere it is possible at all.

`layout.apply` therefore drops out of this design entirely rather than being deferred: it is a
possible **optimization** of one adapter's inner loop, not an architecture. If it is ever taken, the
shape is the optional-capability pattern `worktree-session.ts` already established
(`readonly layout?: LayoutCapability`, prefer it when present, walk when absent) — but the bar for
that is a demonstrated problem with the walk on herdr (atomicity, or round-trip cost on a large
pool), not the fact that the verb exists.

One consequence worth naming, since it is the price paid: without an atomic tree-apply there is a
**partial-apply window** on every backend — a walk that throws halfway leaves half a pool standing
(§7.2). That is accepted uniformly rather than being solved on one backend and not the others, which
is itself the argument: a guarantee only herdr can make is not a guarantee cyber-mux can offer.

### 7.2 The walk

Every backend, one algorithm:

1. **Open the region.** `open({ cwd, at, label })` with **no `launch`** → the root pane `P0`.
   (`open` already supports a blank pane — no seam change.)
2. **Build geometry, depth-first, commands deferred.** Each node owns a region; the root node owns
   `P0`'s region.
   - `pane` node: the region's pane is this pane. Record `(label → paneId)`.
   - `split` node: split the region's current pane in `direction` at `ratio` → a new pane. `first`
     inherits the original pane, `second` takes the new one. Recurse into both.
3. **Launch, last.** For each leaf with a `command`, in template order:
   `submit(exec, pane, command)` — a shell string typed into the pane's shell, which is what `open`'s
   `launch` already is on both adapters. (Or, on a backend with no native env flag, the env-prefixed
   form — §7.3 Gap C.)
4. **Label**, if the backend did not take it at birth.

**Geometry before commands is a deliberate ordering.** `open`'s `launch` couples creation to
launching, which would mean splitting a pane that is already running an interactive agent — the split
lands mid-render, the ratio is computed against a pane whose child is reflowing, and a failed split
halfway through leaves half the pool running. Opening every pane blank first makes the whole geometry
phase side-effect-free from the agent's point of view, and makes `--dry-run` a real thing.

Partial failure: a throw mid-walk leaves the panes created so far. Apply does **not** roll back — it
reports what it built (the manifest is emitted for panes created before the throw) and exits 1.
Rolling back would mean killing panes, and a kill is not obviously safer than a half-built layout the
caller can see and finish. Called out so the behavior is chosen, not accidental.

### 7.3 The three seam gaps

The walk needs three things `SessionOpenOptions` did not have. These are the concrete implementation
prerequisites, and the reason this is a design and not a patch.

They are also, precisely, **the contract a new multiplexer must satisfy to get layouts** (§7.1). Gap
A is the real bar; B and C degrade. A backend that can split a named pane can host every template in
this schema. That bar is low but **not universal** — screen fails it outright (§12 Q7), which is what
makes layouts an optional capability rather than a guarantee.

Status since this design was written: **Gap A is implemented** (see below); B and C are answered and
native on both backends.

**Gap A — split relative to a *given* pane. (Blocking. IMPLEMENTED.)**

`open` could only ever split the **current** pane: herdr `pane split --current`, and tmux
`split-window` with no `-t`. A tree walk
must split a *specific* pane created three steps ago. Without this the schema tops out at a comb off
the current pane and no real tree is expressible.

```ts
interface SessionOpenOptions {
  /** Split relative to THIS pane rather than the caller's current one. Only meaningful for a
   *  `pane:*` placement. */
  from?: SessionTarget
}
```

tmux: `split-window -t <pane_id>` — documented and certain.
herdr: `pane split <pane_id>` in place of `--current` — **verified against herdr 0.7.4** (§12 Q1,
closed). The CLI takes the id positionally (`herdr pane split [<pane_id>|--pane ID|--current]`), and
the socket API exposes the same thing as `PaneSplitParams.target_pane_id` (`herdr api schema`,
protocol 16). No focus-stealing fallback is needed on either backend, so Gap A is clear on both and
the bar §7.1 sets is met by both.

**Shipped ahead of this design, as its own fix.** Implementing Gap A surfaced a bug that had nothing
to do with layouts: *neither* backend's default splits the calling pane, and they fail in opposite
directions — tmux ignores `$TMUX_PANE` and always splits the session's **active** pane (verified on
3.6b: a `split-window` run inside `%1` split the active `%0`), while herdr's `--current` falls back
to the **UI-focused** pane when `$HERDR_PANE_ID` is unset. Both track the pane the *user* is looking
at, which coincides with the caller only while a human is typing and diverges exactly when a program
drives. So `--at pane:*` meant two different things per backend, silently, and `$CYBER_MUX_PANE`
could not reach a split at all. The fix — `from`, plus `callerPane(adapter, env)` in `backend.ts` —
landed separately so it stays revertable on its own. The walk therefore builds on a seam that already
exists rather than one this design must add.

**Gap B — ratio. (Degradable.)**

```ts
ratio?: number   // fraction of the region retained by the ORIGINAL pane
```

Sign convention, which is easy to get backwards: template `ratio` is the fraction kept by `first`
(the original pane), so the **new** pane gets `1 - ratio`.

- **tmux** — `-l` sizes the **new** pane, so `split-window -h -t P -l <round((1-ratio)*100)>%`.
- **herdr** — `--ratio` sizes the **original** pane, which is the template's convention exactly, so
  it passes through **unconverted**. Verified empirically against 0.7.4 (§12 Q2, closed): splitting a
  201-column region `right` at `--ratio 0.333` left the original pane 67 columns (0.333) and gave the
  new pane 134 (0.667). Neither the socket schema nor herdr's docs state this — it was measured, so
  it is worth an integration-test assertion rather than trust.

The two backends therefore convert in *opposite* directions, which is exactly the trap this
subsection exists to name. Absent backend support, ratio degrades to the backend's 50/50 default and
apply warns once on stderr — a wrong-looking split is not worth failing an otherwise-correct pool
over.

**Gap C — env. (Degradable. Native on both real backends.)**

```ts
env?: Record<string, string>   // set in the new pane's environment at birth
```

- **tmux** — `split-window -e K=V` (repeatable). Verified against tmux 3.6b.
- **herdr** — `pane split --env KEY=VALUE`; `PaneSplitParams.env` is a native
  `Record<string,string>` in the socket schema. **Verified against 0.7.4** (§12 Q3, closed).

**Both backends do this natively, so the fallback below currently has no customer.** It is documented
because a future backend (§12 Q7 — `screen`) may need it, not because anything uses it today.

Fallback, if a backend has no env flag: prefix the launch command — `submit(pane, 'env K=V K2=V2
claude')`. Works anywhere, since it is just a command line. Its costs, which are the reason it is a
last resort: the values land in `ps` output and the pane's shell history, and it can only set env for
a pane that *has* a `command` to prefix.

**A pane with `env` and no `command` is valid** and works on both backends — `pane split --env
ROLE=worker` with no command yields a blank shell with `ROLE` set, which is a coherent warm pane for
something to attach to later. An earlier draft made that combination a *validation* error; that rule
was written when herdr's env was unverified and the prefix looked load-bearing, and it is now
removed. Rejecting it at the schema level would let the weakest hypothetical backend punch a hole in
a contract both real ones honor — precisely what §7.1 says not to do.

Preference order per backend: native flag where it exists; otherwise the prefix, degrading with one
stderr warning when a pane has `env` but no `command` and the backend has no native flag. This
mirrors Gap B exactly: **degrade and warn, never reject.** The schema is backend-agnostic, so a
template's validity cannot depend on which multiplexer happens to be running.

## 8. Module layout

Mirrors the existing separation, which is worth preserving exactly:

| File | Owns | Owes nothing to |
| --- | --- | --- |
| `layout.ts` | The schema types, `parseLayout`, `validateLayout`, `desugar`. Pure — no `Exec`, no fs, no mux. | everything |
| `layout-store.ts` | Resolution order, the `LayoutStore` seam, `resolveLayout(name)`. | the mux |
| `layout-session.ts` | Layouts × sessions — the walk, the manifest, `--if-populated`. The only module that knows both halves. | — |
| `cli.ts` | The `layout` command group. | — |

`layout-session.ts` is to `layout.ts` + `session.ts` exactly what `worktree-session.ts` is to
`worktree.ts` + `session.ts`, and for the same stated reason: *"Deciding between them is a third
concern, and it lives here."* Keeping `layout.ts` pure is what makes the schema, the desugarer, and
every validation rule testable with no `Exec` mock at all.

## 9. Use cases

### 9.1 Apply to a brand-new worktree (the primary flow)

```bash
cyber-mux worktree add --branch feat-x --layout agent-pool-3
```

1. `resolvePrimaryRoot` → resolve `agent-pool-3` from `<primaryRoot>/.cyber-mux/layouts/`. **Resolve
   and validate the template before creating anything** — a typo in the layout name must not leave a
   worktree behind.
2. `addAndOpenWorktree(..., { at: 'workspace', label })` with **no `launch`** → the worktree, its
   bound workspace, and the root pane `P0`.
3. **`P0` becomes the tree's root region.** Not a wasted pane, not a pane to close — the walk splits
   *into* it. This is why step 2 passes no `launch`: the template owns what runs.
4. Walk (§7.2) with `cwd` = the worktree root.
5. Report the manifest, including the `workspace` from step 2.

The `degraded` reporting already in `worktree-session.ts` carries through untouched: on tmux there is
no binding, `workspace` is `null`, and the layout still applies inside the new window.

### 9.2 A warm pool with per-pane roles

`pool-4.json` (§5.3) — four workers, `ROLE=worker`, one command each. `cyber-mux open --layout pool-4
--cwd <worktree> --format json` returns four `(label, pane)` pairs. That manifest is the entire
handoff to whatever routes work (§11). cyber-mux does not know what a "worker" is; `ROLE` is an
opaque string it puts in an environment.

### 9.3 Re-applying to an existing worktree

`--at workspace` (the default) opens a **new** workspace every time, so re-applying is not a
collision — it is a second pool. That is usually what someone re-applying actually wants, and it is
why `workspace` is the default rather than `pane:right`.

The collision case is real for `--at pane:*` / `--at tab`, and for someone who expects "apply to
*the* workspace for this worktree" to be idempotent. It is not, and cannot cheaply be:

**Detecting "already populated" is a heuristic, and this is the design's weakest joint.** The seam
offers `listPanes()` → `LivePane[]` with a `cwd`, and nothing else. There is no "list panes in
workspace X". So the check is: *does any live pane report a `cwd` at or under the target?* — via
`normalizeWorktreePath` on both sides, since a symlinked repo or macOS `/private/tmp` otherwise fails
to match (the reason that helper exists). It is imprecise in both directions: a pane someone opened
by hand in the worktree counts as "populated", and a pane whose shell has `cd`'d elsewhere does not.

Policies:

- **`fail` (default).** Refuse, name the panes found, exit 1. Safe, scriptable, and honest about the
  heuristic — the error says *"3 panes already report a cwd under <path>"*, not *"the workspace is
  populated"*.
- **`append`.** Apply anyway; the new region is opened alongside. The manifest reports only the panes
  this apply created.
- **`replace` — deliberately not offered in v1.** It means killing panes that are, by construction,
  likely to be running agents with unsaved context. A destructive default hiding behind a flag on a
  heuristic this loose is not a trade worth making. A caller who wants it composes it:
  `cyber-mux list --format json`, close what they mean, apply. Explicit and theirs.

### 9.4 tmux vs herdr: what actually degrades

| Capability | herdr | tmux | Effect on layouts |
| --- | --- | --- | --- |
| Split tree | via portable walk | via portable walk | **None.** Same code path, same geometry. |
| Workspace tier | real | collapses to a window | `--at workspace` yields a window. Already the documented behavior of `open`; layouts inherit it and add nothing. |
| Worktree binding | yes | no | `workspace: null` in the manifest. Already handled by `degraded`. |
| Ratio | `--ratio` (sizes the **original** pane) | `-l N%` (sizes the **new** pane) | **None.** Both native; they convert in opposite directions (§7.3 Gap B). |
| Env | `--env K=V` | `-e K=V` | **None.** Both native (§7.3 Gap C). The command-prefix fallback has no customer today. |
| **Agent status** | `working`/`idle`/`blocked`/`done` | **nothing** | **No effect — by design.** |

That last row is worth being explicit about, because the brief asks whether the schema must degrade
gracefully around it. **It does not, because the schema never mentions status.** A layout is
write-only: it takes a template and a cwd and produces running panes. Status is a *read* concern
about panes that already exist. The two never meet, so the largest capability gap between the
backends costs the layout system exactly nothing. That is not luck — it is the payoff of the
message-bus research's scope boundary (§11), and it is the strongest argument that the boundary is
drawn in the right place.

### 9.5 Edge cases, decided

| Case | Behavior |
| --- | --- |
| Template name not found | Exit 1, error lists the directories searched. Before any side effect. |
| Template invalid | Exit 1, all errors at once (not first-only), each with a JSON path. Before any side effect. |
| Template sets `cwd` | Validation error naming `--cwd` and `dir`. §5.2. |
| `dir` points outside the target | Validation error. Absolute and `..`-escaping both rejected. |
| `dir` does not exist in *this* worktree | Apply fails for that pane. A branch that predates a directory is a real case, so the error names the pane label and the resolved path. |
| `command` is not installed | cyber-mux does not check. The pane opens, the shell reports `command not found`. Verifying a command is not the mux's job, and a check would be wrong the moment a command is a shell function or an alias. |
| Duplicate `label` | Validation error — labels are manifest keys. |
| No multiplexer at all | `list`/`show`/`validate` work (their subject is a file). `apply` fails through the existing `adapter()` path with the message it already gives. |
| `ratio` of `0` or `1` | Validation error — a degenerate split is a mistake, not an intent. |
| Very deep / wide tree | Not limited by cyber-mux. herdr's own limits are untested (§12 Q4). |
| Partial failure mid-walk | No rollback; manifest of what was built; exit 1. §7.2. |

## 10. Testing

Everything above is reachable with the existing harness — no new infrastructure, which is part of why
this shape was chosen:

- `layout.test.ts` — parse, validate (every §9.5 row), desugar table test for `n = 1..8` per
  `arrange`. Pure; no mocks.
- `layout-store.test.ts` — resolution order, shadowing, name/traversal rejection. Fake `LayoutStore`.
- `layout-session.test.ts` — the walk emits the expected `open`/`submit` call sequence per backend,
  against the mocked `Exec` both adapters are already tested with. Covers the ratio sign convention
  **in both directions** (herdr passes `ratio` through, tmux emits `1 - ratio` — a mocked `Exec`
  asserting the literal flags is the cheapest guard against the inversion being applied twice, or to
  the wrong backend), native `env` on both backends, a pane with `env` and no `command`, the
  `--if-populated` heuristic, and partial failure. The env *prefix* fallback has no backend to
  exercise it, so it is tested against a fake adapter declaring no native env — or left untested
  until a backend needs it, which is the honest option.
- `cli.test.ts` — the command group, flags, `--format json` manifest, mutual exclusion of
  `--layout`/`--launch`.
- Integration (`*.integration.test.ts`, the existing opt-in tier) — one real 3-pane apply per
  backend. §12 Q1–Q3 are now closed ahead of it, so its job shifts from *discovering* the backend
  facts to *pinning* them — in particular Gap B's opposite-direction ratio conversion, which was
  measured rather than documented and is the single most likely thing to silently regress under a
  herdr update. The committed `herdr api schema` snapshot (protocol 16) is the companion guard: a
  test that diffs it catches a protocol move before the walk does. Also relevant is the research's
  own closing note:
  *"validate the depth-first split/send-keys sequence ... for correctness on nested (3+ level) trees,
  which wasn't tested here."*

## 11. Out of scope: dispatch

**No message bus, no mailbox, no routing, no "give this work to an idle pane".** The message-bus
research is unambiguous and this design holds the line: the multiplexer layer does pane lifecycle
plus a minimal status/event feed; something else does dispatch. cyberlegion already has a working
inter-agent mail system, and a second one inside cyber-mux would be two competing message systems in
one stack.

The layout system's whole job: **given a template and a target cwd, produce N running panes in the
right geometry, each running its own startup command.** It ends there.

The seam it leaves for a higher layer is deliberate and consists of exactly two things:

1. **The apply manifest (§6.5).** `open --layout --format json` (or `worktree add --layout`) returns
   every pane it created as `(label, paneId, dir, command)`. That is the complete, machine-readable
   answer to *"which panes exist and what are they for"*. cyberlegion stores it and addresses panes
   through the verbs that already exist — `read`, `submit`, `exists`, `focus`, `list`. **No new
   cyber-mux surface is needed for a dispatcher to be built on top of this.** That is the test of
   whether the boundary is right, and it passes. (The manifest was `layout apply --format json` in an
   earlier draft; folding `apply` into `open` changed the spelling, not the contract.)
2. **A future status *signal*, not a protocol.** The natural next step is `agent_status` on
   `LivePane` — populated on herdr (which has the feed natively), `undefined` on tmux (which has
   nothing), following the exact convention `isPaneFocused` already set for a fact a backend may not
   be able to answer. That is a field on an enumeration. It is not `dispatch`, not `worker_done`, not
   `@idle` addressing, and not a subscription. Orca's message taxonomy is worth mining — *for
   cyberlegion's protocol design, not for this package.*

The line, stated once so it is quotable in review: **cyber-mux tells you which panes exist and,
eventually, whether each is busy. It never decides who gets the work.**

## 12. Open questions

Flagged rather than guessed. **Q1–Q3 and Q5–Q7 are closed** — against herdr 0.7.4 (`herdr api
schema`, protocol 16, plus live probes), tmux 3.6b, and the GNU screen manual. Their findings are
folded into §6.4, §7.1, §7.3 and §9.4, and recorded here so the answers are not re-litigated. **Q4 is
the only one left, and it is a test rather than a question.**

Two of the closures moved the design, and it is worth being precise about which:

- **Q1–Q3, Q5 changed nothing** — each went the way §7.1 predicted, which is the evidence that the
  portable-walk bet is sound. (Q3 removed a schema *rule*, but that rule existed only to serve a
  fallback that turned out to have no customer.)
- **Q6 and Q7 changed the design**, in opposite directions: Q6's premise was simply wrong, and export
  gained a v1 verb; Q7 found the floor under §7.1's contract, and layouts became an optional
  capability. Both were worth asking precisely because neither answer was the expected one.

**Q1 — Can `herdr pane split` target a pane by id? — CLOSED: yes.** (§7.3 Gap A.) The CLI takes it
positionally, and the socket API exposes `PaneSplitParams.target_pane_id`. Gap A — the one blocking
bar — is clear on both backends. No focus-stealing fallback, no socket-only verb.

**Q2 — herdr's split ratio flag. — CLOSED: `--ratio`, sizing the ORIGINAL pane.** (§7.3 Gap B.) This
is the template's own convention, so herdr passes through unconverted while tmux inverts. Measured,
not documented: neither the socket schema nor herdr's docs state the convention, so §10's integration
test must assert it rather than trust it.

**Q3 — herdr's split env flag. — CLOSED: `--env KEY=VALUE`, native.** (§7.3 Gap C.) Both backends set
env natively, so the command-prefix fallback has no customer, and the "env without command is a
validation error" rule it justified is **removed from the schema**. This is the one closure that
changed a rule rather than confirming one.

**Q4 — Pane-count / depth ceiling for a large pool.** The research flagged herdr `layout.apply`'s
limits as untested; irrelevant here, since this design does not use it. The live question is the
walk's own ceiling — an 8-pane pool is 7 sequential splits, and no backend's minimum pane size is
known. The integration test in §10 should push past 4 and find where it breaks.

**Q5 — Workspace-scoped pane enumeration. — CLOSED: it exists. The recommendation is to not use it.**
`herdr pane list --workspace <id>` is real (`PaneListParams.workspace_id`), and it would make
§9.3's `--if-populated` precise on herdr. **Take it anyway? No.** The question already anticipated
why: the cwd heuristic is backend-agnostic and tmux will never do better, so adopting the precise
herdr answer buys accuracy on one backend at the cost of `--if-populated` meaning two different
things depending on which multiplexer is running — and §9.3's `fail` policy reports *"3 panes already
report a cwd under <path>"*, an honest sentence that a workspace-scoped query would quietly make
false on one backend only. A heuristic that is uniformly imprecise is easier to reason about than one
that is precise on Tuesdays. Revisit only if `--if-populated`'s false-positive rate is a real
complaint in practice, and if so, change the *reported sentence* too.

**Q6 — `layout export`? — CLOSED: the premise was wrong; it is a v1 verb (§6.4).** This question
deferred export on the claim that *"the portable path cannot do it at all (`listPanes` reports no
split structure)"*, making it "a genuinely backend-specific capability" whose only options were a
herdr-only verb or a new contract every adapter implements. The claim is true of the **seam** and
false of the **backends**: tmux reports a nested tree via `#{window_layout}` and herdr reports
`splits[]` with `direction`/`ratio` via `pane layout` — both verified live. So the second option — a
portable "report this region's geometry" verb — was available all along, and it is the cheap one.
Export moves into §6.4 with an honest limit: it recovers geometry, labels and dirs, but **never
commands**, because §7.2 types them with `submit` rather than passing them to the split.

**Q7 — Which multiplexer is next? — CLOSED: screen, and it fails Gap A.** The question asked whether
§7.3's Gap A is clearable on screen, and flagged it as worth answering before shipping. It is not
clearable, on three independent counts:

- **Regions have no ids.** The GNU manual never assigns them identifiers; commands reference regions
  only by focus state or direction. There is no region to name.
- **`split` splits only the current region** — the manual's words: *"Split the current region into two
  new ones."* Internally screen keeps regions as a flat list and `focus` merely walks it, so even the
  directional forms are navigation, not addressing.
- **No per-pane env var** — already recorded at `mux-probe.ts:23`. A screen caller cannot name its own
  pane either, so `callerPane` can never resolve there.

The only way to split a chosen region is `focus`-until-you-arrive-then-split, which is exactly the
racy, focus-stealing fallback Gap A rejects as unacceptable. On screen it is not a fallback; it is the
only road. Consequence, folded into §7.1: **layouts are an optional capability**, following the
`worktree?` precedent. A screen adapter is a different shape — `-p` targets *windows*, and send/read
per window work fine — not a degraded one. That is a floor on the contract, not a flaw in it.

*Trap for whoever writes that adapter:* screen **has** `layout new|select|save|dump` and
`layout autosave`. Same word, different feature — screen's layouts preserve region arrangements
across detach/reattach; they do not apply a named template to a new directory.
