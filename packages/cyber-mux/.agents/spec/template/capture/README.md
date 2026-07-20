---
spec-type: behavioral
concept: [cyber-mux, template, template-capture]
---

# template/capture — reading a live region back into a template

## What

This unit owns the **write direction** of the [`template`](../README.md) capability: `cyber-mux
template save <name>` reads the live region around a pane — or, with `--workspace`, every tab of the
workspace that region sits in — derives the template that would rebuild it, and writes that template
to a file.

It is the exact inverse of [apply](../apply/README.md). Apply injects a target directory and expands
sugar into a tree; capture derives a tree from the live screen and subtracts the target back out into
`dir`. That the same rules compose in both directions is the best evidence the schema is coherent
rather than arbitrary. It also closes the schema's one real authoring cost: a 4+ pane grid needs
nested `split` nodes nobody wants to type, so a pool built by hand once can be *named* rather than
transcribed.

The capability-level rule holds in this direction too: **nothing about the target directory is ever
written into the template.** A captured pane's location becomes a relative `dir`, or no `dir` at all —
never a `cwd`, never an absolute path.

Designed in
[`docs/design/layout-templates.md`](../../../../../../docs/design/layout-templates.md) — which keeps
its original name as a record of the design moment — against `.research/mux-workspace-layouts/`.

### Non-goals

**`template export` was here, and this CR reversed it.** It was recorded as *deferred, not rejected*,
and the deferral's own reasoning is what expired: it read the seam's inability to report split
structure as the backends' inability, and that premise was simply false — `listPanes` reports no
geometry, but both backends do. What the deferral got right is the part that survived: the capture
genuinely cannot recover `command`, and that is now a stated limit of a shipped verb rather than a
reason not to ship one. Two things changed on the way in: the verb is **`save`**, not `export`,
because it writes the file rather than printing it; and the honesty the original design bought by
printing to stdout is bought instead by the draft note the file carries in its own `description`.

**Commands are not recovered, and that is structural rather than a gap to close later.** No
multiplexer can report the command a pane was launched with, so no future backend closes it either;
see the reasoning under the first use case below.

**Widening `save`'s default subject** is out. `save`'s subject is a **region** and stays one — a bare
`save` in a 3-tab workspace still captures the caller's own region, because widening the default
silently would rewrite what `save` has always meant for every caller who already relies on it.
`--workspace` opts in.

## Use Cases

**Subject** — reading a live region or workspace and writing the template that would rebuild it:

- **A region is captured back into a template, and the capture is a draft** — `template save <name>`
  reads the live region around a pane and writes the template that would rebuild it. This closes the
  schema's one real authoring cost: a 4+ pane grid needs nested `split` nodes nobody wants to type,
  so a pool built by hand once can be *named* rather than transcribed. It is the exact inverse of
  apply — apply injects a target and expands sugar into a tree; capture derives a tree and subtracts
  the target back out into `dir`. That the same rules compose in both directions is the best evidence
  the schema is coherent rather than arbitrary.

  **The capture recovers geometry, labels and dirs — never commands, and that limit is structural.**
  No multiplexer can report the command a pane was launched with: the walk types commands with
  `submit` rather than passing them to the split (herdr's `pane split` takes no command at all), so
  tmux's `pane_start_command` is empty for every pane cyber-mux creates, and `pane_current_command`
  reports `zsh` or `node`, never `claude --foo`. So a saved template carries the tree, its ratios,
  labels and dirs, with `command` left for the author. Geometry is the verbose part and a command is
  one word, so this is still the bulk of the value — but the result is a **draft**, and it says so in
  its own `description`, because `template list` shows it beside finished templates and a note that
  only ever reached the terminal that ran `save` would be gone by the time anyone read the file.

- **The geometry seam reports rectangles, and cyber-mux derives the tree** — the capability a
  multiplexer must supply is *"what does this region look like"*, answered as one rectangle per pane;
  the split tree is **derived** from those rectangles by recursive guillotine cuts, in a pure module.
  Reporting rects rather than a tree is the whole design of the seam. Both backends can describe a
  region and **both describe it in a structure the other cannot speak**: tmux encodes a nested tree in
  a bespoke string (`#{window_layout}` — `83ae,200x50,0,0{133x50,0,0[...],...}`), while herdr reports
  a **flat** `splits[]` array whose parent/child links exist only inside an undocumented id
  convention (`split_1_0`, meaning "split 1, child of split 0" — inferred from the shape, never
  specified). Neither survives being made portable: one needs a parser for a format tmux does not
  promise to keep, the other needs cyber-mux to bet on herdr's id spelling. Rectangles are the fact
  both report exactly and neither can spell differently, and deriving the tree from them is sound
  because a multiplexer region is *built by splitting* and is therefore always guillotine-cuttable.
  The payoff is that the hard part — n-ary rows, ratios, ambiguous grids — is a pure function of four
  numbers per pane, testable with no multiplexer at all, and a third backend owes the seam four
  numbers rather than a tree in its own dialect.

  Two derivations are load-bearing and easy to get wrong. **A ratio is the complement of what the
  second pane occupies** (`1 - second/total`), not `first/(first + second)`: tmux splitting a 50-row
  region reports 34 + 15, because the divider row belongs to the region and to neither pane, so the
  naive form reads 0.69 where the split was really 0.7. The complement puts that row where the
  backend's own sizing flag puts it. **An n-ary row lowers to a right-comb** — the desugarer's
  inverse, so a pool `arrange: even-horizontal` built captures back as the comb it was built from —
  and a 2x2's genuine ambiguity (a vertical or a horizontal cut first describe the same screen) is
  broken **columns-first**, to match what `tiled` emits rather than its transpose.

- **A whole workspace is captured back, and `--workspace` is what asks for it** — `save`'s subject is
  a **region** and stays one: a bare `save` in a 3-tab workspace still captures the caller's own
  region into a single-tree template, because widening the default silently would rewrite what `save`
  has always meant for every caller who already relies on it. `--workspace` opts in, and is the exact
  inverse of the tabs walk — one captured tab per live tab, each with its own derived tree. The bare
  form does not stay quiet about it: capturing one tab of three reports, in a `help[N]:` block **on
  stdout inside the payload**, what it left out and the `--workspace` invocation that captures it,
  rather than letting a caller believe a 3-tab workspace round-trips from a 1-tab template. That
  reveal is [`axi.md`](../../axi.md)'s #9 *reveal a truncated list* case verbatim, which puts the
  note on stdout, not stderr — so `save`'s stdout is a structured payload (a `path` field plus that
  optional `help[N]:` block), the note present only when there is a next move. The
  bare-path-for-`$(...)` ergonomic yields to it: a programmatic caller reads the path from
  `--format json` (`cyber-mux template save pool --format json | jq -r .path`).

  The seam this needs is a **workspace-wide** read beside the region one, and both backends can
  answer it — established empirically against herdr 0.7.4 and tmux 3.6b, the standing bar here. On
  **herdr** it is direct and race-free: a workspace's tabs enumerate by id, every pane comes stamped
  with its tab, and an **unfocused tab in another workspace reports live geometry**, so nothing has to
  be focused first. (herdr's own native per-tab layout export takes a `tab_id` and would be the
  obvious road — but `template` is **not a CLI verb** in 0.7.4; it is socket-API-only, and this adapter
  speaks the CLI by design, so the road is closed. `docs/design/layout-templates.md` asserts otherwise
  and is corrected.) On **tmux** the workspace is not a fact the backend holds at all, so the read is
  *"which windows carry this group id"* — the tag the walk wrote, never the label. A window carrying
  no tag is a **workspace of one**: the honest answer for a window nobody grouped.

  A backend that cannot enumerate a workspace's tabs **refuses** `--workspace` cleanly, naming itself
  and writing nothing — the same shape as a backend that cannot report a region's geometry. An absent
  optional seam member is a refusal, never a guess.

  What the capture recovers is unchanged and so is its limit: geometry, labels and dirs, and **never a
  command**, on any backend, for the reason that was structural before and is structural still. A
  captured workspace is a **draft** and says so in its own `description`.

- **A composed tab label is never parsed back** — where the backend has no workspace tier, the walk
  labels a tab `<workspace> - <tab>` and stores the tab's own name beside the group id
  ([`apply/`](../apply/README.md)). Capture reads the stored name, never the display name: taking the
  display name verbatim would re-prefix it on every round trip (`pool - pool - editor`), and splitting
  it would be an unsound parse — `acme - beta - main` reads as workspace `acme` with tab `beta - main`
  just as well as workspace `acme - beta` with tab `main`. Both roads break the property capture is
  *for*.

- **`save` writes a file, and refuses rather than guessing** — the destination is the primary
  checkout's `.cyber-mux/templates` by default and the user's directory with `--to user`; an existing
  template is never overwritten without `--force`, and the refusal is checked *before* the region is
  read so it costs nothing. The refusals split across two exit codes by kind: a malformed **name** and
  **no pane to capture around** are usage errors and exit **2** per [`axi.md`](../../axi.md)'s #6,
  while a backend that cannot report geometry and a region no sequence of splits could have produced
  are genuine operation failures and exit **1**. Every refusal writes nothing.

Every scenario in [`capture.feature`](./capture.feature) maps to one of these behaviors:

| Behavior | What it covers |
|---|---|
| **the geometry seam reports rects, not a tree** | every pane of the region is reported with its rectangle; no backend's native split-tree encoding is parsed to obtain the tree — not tmux's `#{window_layout}` string, not herdr's flat `splits[]` |
| **a region is captured back into a template** | `save` captures the caller's own region, or `--from`'s; the ratio is the one the split was made with, not the one the pane sizes imply; an n-ary row lowers to the desugarer's right-comb; a 2x2 breaks columns-first to match `tiled`; re-applying a capture reproduces the region it came from |
| **the capture is a draft** | no pane node carries a `command`, on any backend; the written template says so in its own `description`; `--description` replaces that note |
| **the capture subtracts the target back out** | a pane under the captured root becomes a relative `dir`; no `cwd` and no absolute path ever reaches the template; a pane outside the root loses its dir and warns; a capture passes `validate` |
| **labels are the author's, or absent** | a label someone set is captured; a backend's default pane title is not (tmux titles every pane with the hostname); a label two panes share is captured onto both, because a human chose it and no label needs to be unique |
| **capturing a whole workspace** | `--workspace` captures one tab per live tab, each with its own tree; a captured tab's label is the tab's own name rather than the composed display name, so a round trip never compounds the prefix; a bare `save` still captures only the caller's region and says, in a `help[N]:` block on stdout, what it left out; captured tabs keep their labels; re-applying reproduces the tabs and every pane size; still a draft carrying no command; an untagged region captures as a single-tab workspace; a backend that cannot enumerate a workspace refuses cleanly, writing nothing |
| **`save` writes a file** | the repo templates directory by default, `--to user` for the user's; the path on stdout as a structured payload, with a `help[N]:` block riding along only when a bare `save` left tabs uncaptured (composition reads the path from `--format json`); an existing template is never overwritten without `--force`, and the refusal reads no region |
| **`save`'s refusals** | writing nothing in every case, but under two exit codes by kind: a malformed **name** and **no pane to capture around** (neither `--from` nor an ambient pane) are usage errors — the invocation is wrong, so they exit **2** per [`axi.md`](../../axi.md)'s #6; a backend that cannot report geometry and a region no sequence of splits could have produced are genuine operation failures, so they exit **1** |

## Logic

One sub-graph. `template save` enters it directly — capture never routes through
[apply](../apply/README.md)'s resolve-and-validate graph, because there is no template to resolve
yet; it is the artifact being produced. The one place the two meet is at the end: a written capture
must pass the same validator, which is edge `V12` of apply's resolve graph.

### Capture — `template save`

```mermaid
graph TD
  SAVE["cyber-mux template save &lt;name&gt;"]
  SAVE -->|"S6: the name is not a plain stem"| ES6["exit 2; no file written, no region read"]
  SAVE --> SUBJ{"which region is the subject?"}
  SUBJ -->|"P1: no --from"| P1["the caller's own region, not the focused one"]
  SUBJ -->|"P2: --from names a pane"| P2["that pane's region"]
  SUBJ -->|"P3: no --from and no ambient pane"| P3["exit 2 naming --from; nothing written"]
  P1 --> SCOPE{"--workspace?"}
  P2 --> SCOPE
  SCOPE -->|"X1: --workspace given"| X1["one captured tab per live tab, each with its own tree"]
  SCOPE -->|"X2: --workspace omitted"| X2["the caller's own region alone; the template declares root"]
  X2 -->|"X3: the workspace has other tabs"| X3["a help entry on stdout naming what was left out and the --workspace command"]
  X1 -->|"X4: the tab carries a label"| X4["the captured tab keeps it"]
  X1 -->|"X5: the display name is composed"| X5["the captured label is the tab's own stored name, never the composed one"]
  X1 -->|"X6: the region carries no grouping tag"| X6["exactly one captured tab"]
  X1 -->|"X7: the backend cannot enumerate the workspace's tabs"| X7["exit 1 naming the backend; nothing written"]
  X1 --> GEO
  X2 --> GEO
  GEO{"derive the tree from the seam"}
  GEO -->|"Q1: the seam is asked for the region"| Q1["one rectangle per pane; no backend's native split-tree encoding is parsed"]
  Q1 -->|"Q2: two panes with a divider between them"| Q2["the ratio is the complement, the one the split was made with"]
  Q1 -->|"Q3: an n-ary row"| Q3["the right comb the flat sugar desugars to"]
  Q1 -->|"Q4: an ambiguous grid"| Q4["broken columns-first, matching tiled"]
  Q1 -->|"Q5: the capture is re-applied"| Q5["every pane, and every tab, matches its counterpart's size"]
  Q1 -->|"Q6: no sequence of splits could have produced the region"| Q6["exit 1; nothing written"]
  GEO -->|"Q7: the backend has no region-geometry primitive"| Q7["exit 1 naming the backend; nothing written"]
  Q1 --> SUB{"subtract the target back out"}
  SUB -->|"Z1: the pane runs under the captured root"| Z1["a relative dir; no cwd and no absolute path anywhere"]
  SUB -->|"Z2: the pane runs outside the captured root"| Z2["no dir, a stderr warning naming its directory, and the template is still written"]
  SUB -->|"Z4: a label a human chose, shared or not"| Z4["captured onto every pane carrying it, with no warning"]
  SUB -->|"Z5: the label is the backend's default pane title"| Z5["no label is captured for that pane"]
  SUB --> DRAFT{"the draft note"}
  DRAFT -->|"Y1: the panes are running commands"| Y1["no pane node carries a command"]
  DRAFT -->|"Y2: no --description"| Y2["the description says geometry only, and that a command must be added per pane"]
  DRAFT -->|"Y3: --description given"| Y3["it replaces the draft note"]
  DRAFT --> WRITE{"where does the file go?"}
  WRITE -->|"S1: no --to"| S1["the primary checkout's .cyber-mux/templates; the path on stdout as a structured payload"]
  WRITE -->|"S2: --format json"| S2["one JSON object carrying the path and a help array"]
  WRITE -->|"S3: --to user"| S3["the user templates directory; nothing in the repo one"]
  WRITE -->|"S4: the destination exists, no --force"| S4["exit 1 naming --force; the existing template unchanged; no region read"]
  WRITE -->|"S5: --force"| S5["exit 0; the file is replaced by the capture"]
```

## Scenario map

Grouped by use case, mirroring [`capture.feature`](./capture.feature)'s own sections. One row per
scenario; the `Edge` column names the edge in `## Logic`, the `Path (Given)` column the path class
reaching it.

### Capturing a live region — which region, and what tree

| Edge | Path (Given) | Scenario |
|---|---|---|
| P1 no `--from` | the caller is not the focused pane | `save captures the region around the calling pane, not the one the user is looking at` |
| P2 `--from` names a pane | the named pane is in another region | `--from captures the region around a named pane` |
| Q1 the seam is asked for the region | a region on any backend | `the geometry seam reports one rectangle per pane, not a backend's own tree` |
| Q2 two panes with a divider between them | a region split at 0.7 | `a captured ratio is the one the split was made with, not the one the pane sizes imply` |
| Q5 the capture is re-applied | one region of 4 panes | `re-applying a captured template reproduces the region it was captured from` |
| Q3 an n-ary row | 3 equal panes side by side | `an n-ary row captures as the right-comb the flat sugar desugars to` |
| Q4 an ambiguous grid | 4 panes in a 2x2 | `an ambiguous grid captures columns-first, matching tiled rather than its transpose` |

### The capture is a draft

| Edge | Path (Given) | Scenario |
|---|---|---|
| Y1 the panes are running commands | a region on tmux, and one on herdr | `no pane in a captured template carries a command, on either backend` |
| Y2 no `--description` | a bare `save` | `a captured template records in its own description that it is geometry only` |
| Y3 `--description` given | `save --description` | `--description replaces the draft note` |

### The capture subtracts the target back out

| Edge | Path (Given) | Scenario |
|---|---|---|
| Z1 the pane runs under the captured root | a pane in the target's `services/api` | `a pane under the captured root becomes a relative dir` |
| Z2 the pane runs outside the captured root | one pane outside the root | `a pane outside the captured root loses its dir and says so` |
| V12 valid *(edge owned by [`apply/`](../apply/README.md))* | a template captured from a live region | `a captured template passes validate` |
| Z4 a label a human chose, shared or not | two panes both labeled `worker` | `a label two panes share is captured onto both, because a human chose it` |
| Z5 the label is the backend's default pane title | one renamed pane among tmux defaults | `a label the author set is captured, and a backend's default pane title is not` |

### Capturing a whole workspace

| Edge | Path (Given) | Scenario |
|---|---|---|
| X1 `--workspace` given | a caller in a workspace of 3 tabs | `save --workspace captures every tab of the caller's workspace` |
| X2 `--workspace` omitted | a caller in a workspace of 3 tabs | `save without --workspace captures only the caller's own region` |
| X3 the workspace has other tabs | a bare `save` in a workspace of 3 tabs | `a bare save in a multi-tab workspace says what it left out, in a help block on stdout` |
| X4 the tab carries a label | tabs labeled `editor` and `logs` | `a captured tab keeps the label its tab carries` |
| X5 the display name is composed | a tmux tab displaying as `pool - editor` | `a captured tab's label is the tab's own name, never the composed one` |
| Q5 the capture is re-applied | a workspace of 2 tabs of 2 panes | `re-applying a captured workspace reproduces the tabs it was captured from` |
| Y1 the panes are running commands | a workspace of 2 tabs | `a captured workspace is still a draft carrying no command` |
| X6 the region carries no grouping tag | a tmux window nobody grouped | `on a backend with no workspace tier, an untagged region captures as a single-tab workspace` |
| X7 the backend cannot enumerate the workspace's tabs | `save --workspace` on that backend | `a backend that cannot enumerate a workspace's tabs refuses save --workspace cleanly` |

### `save` writes a file

| Edge | Path (Given) | Scenario |
|---|---|---|
| S1 no `--to` | a bare `save` whose region is the whole workspace | `save writes to the repo templates directory and reports the path on stdout` |
| S2 `--format json` | a caller in a workspace of 3 tabs | `--format json reports the saved path and any help as one structured object` |
| S3 `--to user` | a bare `save --to user` | `--to user writes to the user templates directory instead` |
| S4 the destination exists, no `--force` | the repo directory already holds that name | `save refuses to overwrite an existing template, and reads no region finding out` |
| S5 `--force` | the repo directory already holds that name | `--force overwrites an existing template` |

### `save`'s refusals

| Edge | Path (Given) | Scenario |
|---|---|---|
| S6 the name is not a plain stem | `save "../escape"` | `save validates the name before touching the filesystem or the multiplexer` |
| P3 no `--from` and no ambient pane | a caller in no pane at all | `save with no pane to capture around refuses rather than guessing` |
| Q7 the backend has no region-geometry primitive | a bare `save` on that backend | `a backend that cannot report its region's geometry refuses save cleanly` |
| Q6 no sequence of splits could have produced the region | a region no straight cut separates | `a region no sequence of splits could have produced is refused` |
