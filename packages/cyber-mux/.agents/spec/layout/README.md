---
spec-type: behavioral
concept: [cyber-mux, layout]
---

# layout — named, reusable pane layouts

A **layout template** names a pane pool once — geometry, a startup command, an environment per pane
— and re-targets it at a different directory on every apply. Spinning up a pool for a fresh worktree
was a hand-driven sequence of `open` calls, one per pane, each carrying its own `--cwd`/`--launch`/
`--label`, with no way to say anything about geometry beyond "right" or "down" relative to wherever
the caller happened to be sitting.

The rule the whole capability exists to enforce: **nothing about the target directory is ever written
into the template.** `cwd` is not an optional field — it is not in the schema, and a template
carrying one fails validation. The target is injected at apply time and only there.

Designed in [`docs/design/layout-templates.md`](../../../../../docs/design/layout-templates.md),
against `.research/mux-workspace-layouts/` and `.research/mux-message-bus/`.

## Use Cases

**Subject** — resolving a named template, validating it, and building the panes it describes against
a target directory supplied at apply time:

- **A template is resolved by name, and the repo's answer wins** — three sources, in order:
  `--file <path>` (explicit, skips resolution; the escape hatch for a template that is not checked
  in), then `<primaryRoot>/.cyber-mux/layouts/<name>.json`, then
  `${XDG_CONFIG_HOME:-~/.config}/cyber-mux/layouts/<name>.json`. Repo beats user **deliberately**: a
  project that ships a layout is making a statement about how the project is worked on, and a
  personal template of the same name should not silently shadow it — so `layout list` reports each
  name's source and marks a user template a repo template shadows. The repo location resolves
  through **`resolvePrimaryRoot`** (`worktree.ts`), not `./.cyber-mux` relative to the caller's cwd,
  and that is load-bearing rather than incidental: cyber-mux is used across many worktrees of one
  project, and a worktree branched from a commit that predates a template would otherwise silently
  see a stale template, or none. Resolving through the primary checkout gives one canonical answer
  from every worktree. A name is `[a-z0-9][a-z0-9-]*` and must equal the file's stem, so a name can
  never traverse out of the layouts directory.

- **The template is a binary split tree, and `cwd` is not in it** — `split` nodes carry
  `direction: right|down`, an optional `ratio`, and `first`/`second`; `pane` nodes carry an optional
  `label`, `command`, `env`, and `dir`. `type` is an explicit discriminant rather than inferred from
  which keys are present, because an inferred union produces terrible errors on a typo. `direction`
  is deliberately the vocabulary already in `SessionPlacement` (`pane:right`/`pane:down`) — not
  `horizontal`/`vertical`, where tmux's `-h` means "side by side" while most readers take
  "horizontal" to mean "a horizontal divider". `right` and `down` say where the new pane goes and
  cannot be misread. `dir` is the pressure valve for "the test-watcher pane starts in
  `packages/cyber-mux`": a **relative** subdirectory joined onto the apply-time cwd, where an
  absolute path or any `..` escape is a validation error — a machine-specific path never reaches a
  template by either road.

- **The flat form is sugar cyber-mux desugars itself, so one template means one geometry
  everywhere** — `panes: [...]` plus `arrange: tiled|even-horizontal|even-vertical` expands into a
  canonical nested split tree. tmux's native `select-layout tiled` is deliberately **not** used even
  though it exists and would be one call: it implements tmux's own grid algorithm, herdr has no
  equivalent, and reaching for it would mean the same template producing a visibly different
  geometry per backend — and a third on whatever backend comes next, each with its own edge cases at
  odd `n`. Owning the desugaring is what makes a backend-agnostic schema worth having, and it costs
  one saved call. The expansion is a pure function of `n` and `arrange` alone, which is what lets
  `layout show --desugar` print exactly what apply will build.

- **The engine is cyber-mux's, and it compiles to the portable verbs** — the compiler is a tree-walk
  emitting `open`/`submit` against the `SessionAdapter` contract, never a backend's native layout
  primitive. herdr's `layout.apply` is not a fallback this design defers; it drops out entirely.
  Two reasons, the second load-bearing: `session.herdr.ts` speaks herdr's CLI rather than its
  Unix-socket API (deliberately, so it composes with the synchronous `Exec` seam every adapter and
  every test is built on), and `layout.apply` is a socket verb — but more importantly, herdr's
  native tree-apply is unique in the field. tmux, cmux, WezTerm and screen have nothing equivalent,
  so leaning on it yields a design where the good path exists on exactly one backend and every other
  backend needs the portable walk anyway. The walk gets written regardless; `layout.apply` would be
  a second implementation of an already-solved problem, gated on a transport, serving one adapter.
  The capability a multiplexer must supply is *"split **this** pane, that way"* — that is the whole
  ask, and it is `SessionOpenOptions.from`, which already exists.

- **Geometry is built before any command runs** — apply opens the region blank (no `launch`), builds
  the whole tree depth-first, and only then submits each leaf's `command` in template order.
  Ordering is deliberate, not incidental: `open`'s `launch` couples creation to launching, so
  reusing it would mean splitting a pane already running an interactive agent — the split lands
  mid-render and the ratio is computed against a pane whose child is reflowing. Opening blank first
  makes the geometry phase side-effect-free from the agent's point of view. The root pane the region
  opens with is **not** a wasted pane to close: it is the tree's root region, which the walk splits
  *into*.

- **Apply does not roll back** — a walk that throws halfway leaves the panes it already built,
  reports them in the manifest, and exits 1. Rolling back would mean killing panes, and a kill is
  not obviously safer than a half-built layout the caller can see and finish. This is the price of
  owning the engine rather than delegating to an atomic tree-apply, and it is paid **uniformly**:
  a guarantee only herdr could make is not a guarantee cyber-mux can offer. Resolution and
  validation, by contrast, happen **before any side effect** — a typo in a layout name must never
  leave a worktree behind.

- **Applying is `--layout`, the exact sibling of `--launch`** — there is no `layout apply` verb.
  Both flags answer *"what runs in the space you are opening"*, one for a single pane and one for a
  pool, so applying belongs to the verbs that already open a space (`open`, `worktree add`) and the
  two are mutually exclusive. The `layout` group is left doing only what its name says: managing
  templates. `--at` defaults to `workspace` when `--layout` is given, because a fresh space is empty
  by construction; `--label` defaults to the template name. One acknowledged wart, recorded rather
  than hidden: `--format json` on `open` becomes conditional — bare `open` reports `{ pane }` and
  `open --layout` reports the manifest.

- **The manifest is the whole handoff** — `--format json` reports every pane apply created as
  `(label, pane, dir, command)`, plus the `layout`, the injected `cwd`, and the `workspace`
  (`null` on tmux, matching how `reportOpenedWorktree` already reports it). `label` is the manifest
  key — which is why a duplicate label is a validation error rather than a warning. That manifest is
  the complete machine-readable answer to *"which panes exist and what are they for"*, and a
  dispatcher built on it needs **no new cyber-mux surface**: it addresses panes through `read`,
  `submit`, `exists`, `focus`, `list`, which all already exist.

- **Managing templates never touches a multiplexer** — `list`, `show`, and `validate` take a file as
  their subject, so they answer with no mux present at all, the same way `worktree list` does.
  `validate` is the CI hook: exit 0 valid, 1 invalid, every error at once rather than first-only,
  each naming a JSON path.

- **Ratio and env degrade; they never reject** — the schema is backend-agnostic, so a template's
  validity cannot depend on which multiplexer happens to be running. Both are native on both real
  backends, and the sign convention is the trap: template `ratio` is the fraction kept by `first`
  (the **original** pane), so herdr's `--ratio` — which sizes the original — passes through
  unconverted, while tmux's `-l` sizes the **new** pane and takes `1 - ratio`. The two backends
  convert in opposite directions. A backend that cannot size a split degrades to its own 50/50
  default with one stderr warning; a wrong-looking split is not worth failing an otherwise-correct
  pool over.

**Non-goals** — **dispatch**, in all its forms: no message bus, no mailbox, no routing, no "give
this work to an idle pane". A layout is **write-only** — it takes a template and a cwd and produces
running panes, and it ends there. Status is a *read* concern about panes that already exist, so the
two never meet; this is why the largest capability gap between the backends (herdr has an agent-status
feed, tmux has nothing) costs the layout system exactly nothing. cyberlegion already has a working
inter-agent mail system, and a second one here would be two competing message systems in one stack.

Also out, each for its own reason:

- **`layout export`** (capture a live region back into a template) — deferred, not rejected. Both
  backends can report their geometry (tmux `#{window_layout}`, herdr `pane layout`), so it is
  reachable via a new portable *report-this-region's-geometry* seam verb rather than a herdr-only
  one. It is scoped out of this CR because that verb is a second seam, and export could never
  recover `command` anyway — the walk types commands with `submit` rather than passing them to the
  split, so tmux's `pane_start_command` is empty for every pane cyber-mux creates.
- **`--if-populated` and `--dry-run`** — cut. `--if-populated` is moot at the default `workspace`
  placement (a fresh space is empty), and detecting "already populated" is only a heuristic — the
  seam offers no "list panes in workspace X", so the check would be *does any live pane report a cwd
  under the target?*, imprecise in both directions. `--dry-run` overlaps `show --desugar` and its
  manifest is a half-truth: pane ids do not exist yet, so every `pane` field would be `null`.
- **`wait_for` / sequencing** — a template that waits on output is a workflow, and a workflow belongs
  to the caller.
- **Focus** — apply never steals it, matching every existing spawn path. A caller who wants to land
  somewhere calls `focus` with a pane id from the manifest.
- **Named windows/tabs inside a layout** — v1 builds one region and splits inside it. An honest
  deferral: the schema leaves room by keeping `root` a single node rather than a list.

**Layouts are an optional capability**, exactly as `worktree?` already is — present on a backend
that can split a *named* pane, absent on one that cannot. The floor is real rather than hypothetical:
screen fails it on three independent counts (its regions have no ids, `split` splits only the current
region, and it has no per-pane env var, so a caller cannot name its own pane *or* the pane to split).
The only way to split a chosen region there is focus-until-you-arrive-then-split — the racy,
focus-stealing road `from` exists to reject. A screen adapter would be a genuinely different shape,
not a degraded one. Finding the floor does not move the argument: the walk is the implementation
everywhere it is possible at all.

Every scenario in [`layout.feature`](./layout.feature) maps to one of these behaviors:

| Behavior | What it covers |
|---|---|
| **a template is resolved by name, repo winning** | `--file` skips resolution; repo before user; shadowing reported; resolution through `resolvePrimaryRoot` so every worktree gets one answer; not-found lists the directories searched; a name that is not the stem, or would traverse, is refused |
| **the tree, and no `cwd` in it** | `split`/`pane` nodes, explicit `type`, `right`/`down`; a template setting `cwd` fails validation naming `--cwd` and `dir`; `dir` is relative-only, absolute and `..` refused; `ratio` of 0 or 1 refused; duplicate `label` refused; `root` xor `panes`; every error at once with a JSON path |
| **flat-N sugar is desugared by cyber-mux** | `panes` + `arrange` expands to a canonical tree, a pure function of `n` and `arrange`; `n = 1` yields one pane and no split; the same tree on every backend, never tmux's `select-layout`; `show --desugar` prints what apply builds |
| **the walk** | region opened blank; geometry depth-first; each split targets the pane it names via `from`, never the current one; commands submitted last in template order; `dir` joined onto the apply-time cwd; a missing `dir` fails naming the pane and the resolved path |
| **ratio and env degrade, never reject** | the sign convention in both directions (herdr passes `ratio` through, tmux emits `1 - ratio`); `env` native on both backends; a pane with `env` and no `command` is valid; a backend that cannot size a split warns once and takes its default |
| **resolution precedes side effects; apply does not roll back** | a bad layout name leaves no worktree behind; a throw mid-walk reports what was built and exits 1 without killing anything |
| **`--layout` is `--launch`'s sibling** | mutually exclusive with `--launch`; `--at` defaults to `workspace`; `--label` defaults to the template name; `worktree add --layout` reports the manifest alongside `root`/`branch` |
| **the manifest is the handoff** | `--format json` reports `(label, pane, dir, command)` per created pane, plus `layout`/`cwd`/`workspace`; `workspace` is `null` on tmux |
| **managing templates needs no multiplexer** | `list`/`show`/`validate` answer with no mux; `validate` exits 0/1 with one error per line |
