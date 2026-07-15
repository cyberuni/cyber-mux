# Conclusion: multiplexer layout templates for cyber-mux warm-agent pools

## Last updated

July 2026

## Question

How do major multiplexers (tmux + ecosystem, Zellij, WezTerm, herdr) and purpose-built
AI-agent terminal/orchestration products (cmux, Orca) let a user define a named,
reusable workspace layout (multiple panes, each running a specific command, specific
split geometry) and re-apply it against a *new* directory (e.g. a fresh git worktree)
at invocation time — and what does that mean for designing a layout-template feature
in `cyber-mux` to spin up a pool of warm agent panes per new worktree?

## Verdict

Every serious contender converges on the same three-part shape for a layout template:
**(1) a tree of splits/panes with geometry, (2) a startup command + cwd + env per pane,
(3) an apply-time cwd override so one named template targets a new directory each
call.** Zellij has the most mature *first-party* version of this (`--layout name --cwd
path`, KDL `pane command=...`). WezTerm's `wezterm cli spawn/split-pane --cwd` is the
closest structural analog to how cyber-mux is already built (imperative CLI calls, not
a config-file DSL). tmux itself has nothing native; tmuxinator/tmuxp are third-party
YAML layers that add exactly this shape on top.

**herdr already has the primitive cyber-mux needs, natively, and it's stronger than
tmux's**: the socket API's `layout.apply` takes a declarative binary split-partition
tree in one call — `{root: {type: "split"|"pane", direction, ratio, first, second,
label, cwd, command, env}}` — expressing geometry + per-pane cwd + startup command + env
in a single request (verified directly against `herdr.dev/docs/socket-api/`, E8). The
"herdr has plugins for it too" the user mentioned is real: herdr's plugin system
(verified, E9) supports pane declarations and lifecycle event hooks including
`worktree.created`, and at least two **community** (not official) plugins/tools already
implement YAML-declarative layout templating on top of herdr's CLI — `herdr-plugin-
workspace-manager` (auto-applies a layout keyed by worktree path patterns on
`worktree.created`) and `herdr-spreader` (a standalone tmuxinator-alike with
`wait_for.match` sequencing). No official first-party layout plugin exists — herdr's own
docs explicitly call the example plugins "not maintained," so these are useful prior
art, not a dependency to build on.

**cmux and Orca — the two purpose-built AI-agent terminal products — confirm herdr's
design is ahead of the field, not behind it.** Both target almost exactly cyber-mux's
use case (multiple agent panes, one per git worktree), and neither has what herdr
already has:

- **cmux** (native macOS AI-agent terminal, E13) has no declarative layout config and
  no atomic tree-apply call — its socket API is purely imperative (`workspace.create`,
  `pane.create`, `surface.split`, `surface.send_text`, one call per pane, no `env`
  param). It has a "save layout as template" UI action with no documented schema, and
  no agent-status state machine at all (only one-shot notifications). It is the
  clearest **negative** example for cyber-mux's API design.
- **Orca** (open-source Agent Development Environment, E14) has no declarative layout
  file either — but it has something herdr doesn't: a real **orchestration message
  bus** (`task-create`/`dispatch`/`send`/`ask`/`decision_gate`/`worker_done`,
  addressable groups like `@idle`), a more structured dispatch/completion protocol than
  herdr's bare status feed. Orca defaults to one-agent-per-worktree, but that's Orca's
  own scope limit, not evidence it's the right ceiling for cyber-mux — a warm pool of
  *several* agent panes sharing one worktree (or split across a few) is squarely in
  scope for the orchestration goal here, and nothing in Orca's design argues against
  it, it simply doesn't attempt it. But Orca is a full Electron GUI app, not a
  scriptable backend — not something cyber-mux could drive as a thin adapter alongside
  tmux/herdr.

Net effect on the recommendation: build the layout-template schema in cyber-mux itself
(below), but when designing the *orchestration* half — routing work to an idle warm
agent — borrow Orca's message-taxonomy shape (typed dispatch/worker_done/decision_gate
messages with broadcast addressing) layered on top of herdr's `agent_status` feed,
rather than treating herdr's raw status field as sufficient on its own. Neither cmux
nor Orca is a dependency or integration target; they're reference points that validate
the gap cyber-mux would be filling.

**Recommendation: don't adopt any of tmuxinator/Zellij's file format or a herdr
community plugin directly.** Define a small, backend-agnostic layout-template schema
inside cyber-mux itself (JSON/YAML, cyber-mux's own format), and compile it down to
each `SessionAdapter`'s primitives at apply time:

- **herdr backend**: compile the template tree directly into one `layout.apply` socket
  call (or the equivalent CLI sequence `session.herdr.ts` already uses) — inject the
  target worktree path as `cwd` on every leaf pane node. This is a near-lossless
  mapping since herdr's own primitive already matches the target shape.
- **tmux backend**: compile the same tree into a sequence of `split-window`/`send-keys`
  calls (what `session.tmux.ts` already wraps), walking the split tree depth-first and
  injecting `-c <worktree>` per pane. tmux's five built-in layout names
  (`even-horizontal`, `tiled`, etc.) can be offered as schema sugar for the common
  "N equal panes" case, falling back to explicit split-tree nodes for anything bespoke.

A minimal template shape that fits both backends:

```yaml
name: agent-pool-3
root:
  split: right
  ratio: 0.5
  first:
    pane: { label: planner, command: "claude", env: { ROLE: planner } }
  second:
    split: down
    ratio: 0.5
    first:  { pane: { label: worker-a, command: "claude", env: { ROLE: worker } } }
    second: { pane: { label: worker-b, command: "claude", env: { ROLE: worker } } }
```

Apply it with `cyber-mux layout apply agent-pool-3 --cwd <new-worktree-path>` — cwd is
never baked into the template, only injected at apply time (matching Zellij's `--cwd`
flag and tmuxinator's ERB `root: <%= @args[0] %>` pattern, E2/E4), so the same template
is reusable across every new worktree.

The "pool of warm agents" half of the ask is *also* already solvable via herdr, and
this is the strongest single finding: herdr's agent-status feed (`working`/`idle`/
`blocked`/`done`/`unknown`, verified E11) is queryable per pane over the socket API
(`agent_status` field, `events.subscribe` → `pane.agent_status_changed`) — cyber-mux can
apply a template to spawn N warm panes, then poll or subscribe to that status stream to
find an idle pane and route orchestration work to it, without polyfilling
busy-detection itself. No other multiplexer researched (tmux, Zellij, WezTerm, screen,
iTerm2, Windows Terminal) has an equivalent native busy-state primitive — this is a
herdr-only capability among the multiplexers researched — Orca (E14) is the *second*
tool overall with a comparable status feed, which strengthens rather than weakens this
finding: two independent products (herdr, Orca) converged on the same idea
(working/idle/blocked-or-waiting state, queryable/subscribable), while cmux (E13)
explicitly chose not to build one. This is the main reason a herdr-first design makes
sense for the "pool of warm agents" orchestration goal specifically, even though the
layout-template schema itself should stay backend-agnostic for the tmux fallback.

## Confidence

High on the core architectural conclusion (define a backend-agnostic split-tree schema,
compile to `layout.apply` for herdr / split+send-keys for tmux, parameterize cwd at
apply time). Medium on exact community-plugin schema details (E10) — not load-bearing
since the recommendation is to not depend on them. Medium on herdr's own
session-restore-on-restart mechanics (thin docs) — not load-bearing since that's a
different feature (crash recovery) from template application. Medium on cmux/Orca
findings (E13/E14) — each is a single research pass, not independently re-verified by a
second fetch, though both are directionally consistent with public marketing/docs
framing of each product.

## Strongest supporting evidence

- herdr `layout.apply`/`layout.export` socket API, directly re-verified (E8) — matches
  the target shape almost exactly, no plugin required.
- herdr plugin system + `worktree.created` event, directly re-verified (E9) — confirms
  the user's "herdr has plugins for it too" and shows the escape hatch (event-driven
  auto-apply) is available if cyber-mux later wants it, without requiring it now.
- Zellij's `--layout name --cwd path` (E4) as the cleanest existing precedent for
  "named template, apply-time cwd override" — validates the design direction
  independent of herdr.
- herdr's agent-status feed (E11) — the concrete mechanism for "orchestration within a
  pool of warm agents," corroborated by Orca independently building a comparable
  status feed (E14), suggesting this is a converging best practice, not a one-off.
- Orca's orchestration message taxonomy (E14) — a proven shape (typed dispatch/
  worker_done/decision_gate messages, `@idle` broadcast addressing) for the dispatch
  layer cyber-mux would need on top of raw pane status.
- cmux's imperative, no-atomic-tree, no-status-feed API (E13) as a clear negative
  example — reinforces that herdr's `layout.apply` + status feed combination is
  unusually strong, not table-stakes.

## Strongest weakening or contradictory evidence

- No tool researched — including herdr — has a first-party "template registry with
  named saved templates you `apply --cwd`" as a single built-in verb; every tool either
  needs a config-file convention (Zellij's `layout_dir`), a third-party layer
  (tmuxinator/tmuxp on tmux), or, for herdr, a from-scratch cyber-mux feature on top of
  the lower-level `layout.apply` primitive. This means cyber-mux is building new
  surface area, not just wrapping an existing "layout templates" feature — the research
  narrows the design, it doesn't hand over a ready-made one.
- herdr's binary split-partition tree (`first`/`second`) has no flat "N equal panes"
  shortcut the way tmux's `tiled`/`even-horizontal` do — a 4+ pane grid requires nested
  split nodes in both the herdr primitive and any cyber-mux schema built on it, which
  is more verbose to author by hand (mitigated by schema sugar, per recommendation
  above, but worth flagging as an authoring-ergonomics cost).

## What is not supported

- Claims about herdr's community layout plugins (E10) beyond what's stated — do not
  assume `herdr-plugin-workspace-manager` or `herdr-spreader`'s exact YAML field names
  are stable or that either is maintained; they were not independently re-verified.
- Any claim that WezTerm, Zellij, or tmux has an agent/busy-status feed equivalent to
  herdr's — confirmed absent in all sources checked.

## Where evidence is thin

- herdr's own session-state restore-on-restart behavior (`docs/session-state/`) — page
  content was thin/unverifiable in the fetch. Irrelevant to the template-application
  design but worth a direct check before cyber-mux tries to distinguish "restore" from
  "apply template" as user-facing verbs.
- Whether herdr's `layout.apply` has any practical limit on split-tree depth/pane count
  for large agent pools (e.g. 8+ panes) — not tested, only the shape of the primitive
  was confirmed.

## What should be checked again later

- Direct verification of `docs/session-state/` if/when cyber-mux implements a
  "restore last session" verb alongside "apply named template."
- Whether herdr ships an official layout plugin or first-party template registry in a
  future release (as of July 2026, none exists) — would reduce how much cyber-mux needs
  to build itself.
- If cyber-mux ships a tmux-backend compiler for the split-tree schema, validate the
  depth-first split/send-keys sequence against `session.tmux.ts`'s existing
  `open`/`sendText`/`submit` verbs for correctness on nested (3+ level) trees, which
  wasn't tested here.
