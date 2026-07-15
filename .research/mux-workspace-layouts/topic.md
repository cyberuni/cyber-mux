# Multiplexer workspace layout features, compared for cyber-mux templates (July 2026)

## Question

How do major terminal multiplexers (tmux + ecosystem, Zellij, WezTerm, herdr, and
secondary tools: screen, iTerm2, Windows Terminal) let a user declare a reusable,
named "workspace layout" — multiple panes/tabs, each running a specific command, in a
specific split geometry — and re-apply that layout against a *new* working directory
(e.g. a freshly created git worktree) at invocation time? We want this to inform a
layout-template feature for `cyber-mux`, so a single named template can spin up a pool
of warm agent panes for a new worktree, ready for orchestration.

## Scope

In scope: declarative multi-pane/tab layout formats, per-pane startup-command support,
cwd/worktree parameterization at apply time, and (for herdr) its plugin ecosystem and
agent-status feed. Also in scope: purpose-built AI-agent terminal/orchestration
products (cmux, Orca) as direct-adjacent prior art, since they target the same
"multiple agent panes per worktree" problem cyber-mux is solving. Out of scope:
multiplexer detection/attach mechanics (already solved in `cyber-mux`'s
`mux-probe.ts`), full plugin authoring guides, non-terminal IDE workspace features.

## Source angles

- Native multiplexer primitives (tmux layout strings, Zellij KDL, WezTerm Lua/CLI, herdr socket API)
- Ecosystem/community tooling built on top (tmuxinator, tmuxp, tmux-resurrect/continuum, herdr community plugins)
- Purpose-built AI-agent terminal/orchestration products (cmux, Orca)
- Secondary/reference points (GNU screen, iTerm2, Windows Terminal) for contrast
- Direct verification of herdr's socket API (`layout.apply`/`layout.export`) and plugin docs

## Findings

### tmux + ecosystem

tmux itself only round-trips pane *geometry* — the compact layout string
(`bb62,159x48,0,0{79x48,0,0,79x48,80,0}`, a checksum + `WxH,x,y` tree) captured via
`tmux list-windows -F "#{window_layout}"` and reapplied with `select-layout`. It has no
native notion of a named, reusable template with attached per-pane commands.

**tmuxinator** (Ruby, YAML at `~/.config/tmuxinator/<project>.yml`) is the closest
ecosystem analog to what we want: `windows[].panes[]` is an array of pane commands
(declarative, one entry per pane), `layout` picks tmux's built-in layouts or a raw
layout string, `root` sets cwd — and because the YAML is ERB, `root: ~/<%= @args[0] %>`
lets `tmuxinator start project ~/some/worktree` **parameterize cwd per invocation**.
This is the one first-party-adjacent example in the tmux ecosystem of "one template,
many target directories."

**tmuxp** (Python/libtmux) offers the same shape (`windows[].panes[].shell_command`,
`start_directory` per session/window/pane) plus a full programmatic API
(`tmuxp.workspace.load_workspace()`, `libtmux` Server/Session/Window/Pane objects) —
relevant if cyber-mux wanted to generate/apply templates in-process rather than by
shelling to a CLI.

**tmux-resurrect/continuum** are *snapshot* tools (save running session state, restore
it later), not template authoring — they capture what was already running, not a
design-time named template, and aren't built to retarget a new directory.

Takeaway: no tmux tool has "one named template → many worktrees" as a first-class
built-in flag. tmuxinator gets there via ERB variable injection into `root`, which is
the same shape cyber-mux would implement natively in TypeScript.

### Zellij (KDL layouts)

Zellij's **layout file** *is* the template — no separate "session template" concept.
KDL: `layout { tab name="..." split_direction="vertical" { pane; pane } }`, with
`pane command="cargo" { args "test"; close_on_exit true }` for per-pane startup
commands (each is an independent process — directly matches "one pane = one agent
session").

`cwd` composes hierarchically (layout-level base + pane-level relative/absolute
override), and critically: **`zellij --layout <name> --cwd <path>`** (or
`zellij action new-tab --layout <name> --cwd <path>`) lets the caller override the
layout's base cwd at apply time — exactly the "same named template, new worktree each
apply" mechanism, done as a first-class CLI flag rather than a workaround.

Zellij also has `pane_template`/`tab_template` — named, reusable KDL macros with
defaults, expandable per use (static macros, not full variable substitution beyond cwd
composition and per-use overrides). Named layouts resolve from
`~/.config/zellij/layouts/` (or a configured `layout_dir`) by filename — i.e. a
directory convention, not a registry. A newer Session Manager plugin adds a UI for
browsing/applying/saving layouts, but it's a convenience layer over the same KDL files.

This is the most mature, first-party version of "layout template + cwd parameter" of
any tool researched.

### WezTerm (Lua + CLI)

Two paths, both relevant:

1. **Declarative Lua** (`gui-startup` event + `wezterm.mux`): `mux.spawn_window{workspace=..., cwd=..., args=...}`
   then `pane:split{direction=..., size=..., cwd=...}` then `pane:send_text(...)` builds
   a full multi-pane workspace at GUI startup. `cmd.args` (from `wezterm start -- ...`)
   is the parameterization hook — a fixed Lua config can branch on invocation-time args
   or env vars.

2. **`wezterm cli`** — imperative layout construction from *outside* Lua entirely:
   `wezterm cli spawn --cwd DIR -- PROG` → returns pane-id → `wezterm cli split-pane
   --pane-id ID --right --percent N --cwd DIR -- PROG` → `wezterm cli activate-pane
   --pane-id ID`. Since cyber-mux is itself a scripting/CLI layer (not a Lua config),
   this imperative CLI-driven model is the closer structural analog to what
   `session.tmux.ts`/`session.herdr.ts` already do — build the layout by issuing a
   sequence of spawn/split calls with an injected cwd, rather than authoring a
   templating DSL for WezTerm to interpret.

`workspace` is just a string label; multiple named workspaces coexist on the mux
server without needing to be active, so named templates can be re-invoked by name at
will. No native session-persistence-across-restart (third-party plugins like
`resurrect.wezterm` fill that gap) — WezTerm's own model is one-shot declarative/
imperative spawn, not snapshot/restore, which matches what we want more than tmux-
resurrect's model does.

### herdr (agent-aware multiplexer)

herdr's own config (`~/.config/herdr/config.toml`) has no layout-declaration section —
layout composition is imperative via CLI (`workspace create`, `tab create`, `pane
split`) or the socket API, matching what `session.herdr.ts` already drives.

**Verified socket API primitive** (`https://herdr.dev/docs/socket-api/`): `layout.apply`
creates a fresh tab from a declarative binary-split-partition tree in one call —
`{workspace_id, tab_label, focus, root: {type: "split"|"pane", direction, ratio, first,
second, label, cwd, command: [...], env: {...}}}`. `layout.export` reads an existing
tab's tree back out (same shape, plus `pane_id`s) — so herdr already has a first-party,
socket-level "declare a whole tab's pane tree + cwd + startup command + env in one
call" primitive. This is architecturally the *strongest* native primitive of any tool
surveyed for expressing exactly the (geometry, per-pane command, per-pane cwd) shape a
layout template needs — but it operates per-tab, and cwd is set per-pane-node inside
the call, not composed from one hierarchical apply-time override the way Zellij's
`--cwd` flag is. A caller (cyber-mux) would inject the target worktree path into every
leaf `cwd` field itself when building the request.

**Plugin system** (verified, `https://herdr.dev/docs/plugins/`): plugins are declared by
`herdr-plugin.toml` (`id`, `name`, `version`, `min_herdr_version`), can declare their own
panes (`[[panes]]`: `id`, `title`, `placement` — overlay/popup/split/tab/zoomed —
`command`), and subscribe to lifecycle events (`[[events]]`, confirmed
`worktree.created` is a real hook) that run a callback command. Install via `herdr
plugin install owner/repo[/subdir]`. herdr's own docs list only
`ogulcancelik/herdr-plugin-examples` as "examples to copy, not maintained official
plugins" — **no official first-party layout plugin exists**.

Two **community** layout plugins/tools were found (not independently re-verified beyond
the initial research agent's fetch, so treat as secondary-confidence):
- `razajamil/herdr-plugin-workspace-manager` — YAML `layouts:` (tabs/panes/split/size)
  + `workspaces:` mapping a repo root to a `defaultLayout`, with `layoutMatching` glob
  rules keyed on worktree path patterns, auto-applying on `worktree.created`/
  `workspace.created` events via ordinary `herdr` CLI calls.
- `yuk1ty/herdr-spreader` — a standalone tmuxinator/tmuxp-alike CLI, YAML
  workspace→tab→pane hierarchy with `wait_for.match/timeout_ms` (wait for pane output
  before proceeding — relevant for sequencing agent startup), driving `herdr workspace
  create` → `tab create` → `pane split` → `pane run` → `wait output`.

Both plugins confirm the community has already converged on "YAML declarative
tree + per-node command/cwd/split, applied via the ordinary CLI" as the template shape
— independently arriving at roughly the tmuxinator/Zellij shape on top of herdr's more
primitive imperative CLI.

**Session persistence**: herdr auto-restores workspace/tab/pane/cwd/focus shape on
server restart (referenced in docs, page content thin — low confidence on exact
mechanics) — this is snapshot/restore of *actual* prior state, same category as
tmux-resurrect, not a design-time template.

**Agent status feed** (verified): five states — `working`, `idle`, `blocked`, `done`,
`unknown` — surfaced three ways: CLI (`herdr agent list`, `herdr agent get <target>`,
`herdr wait agent-status <pane_id> --status <state>`), socket API (`agent_status` field
on pane get/list, `pane.report_agent` to set it, `events.subscribe` with
`pane.agent_status_changed` for a live push stream keyed by `pane_id`), and a UI sidebar
rollup. This is the mechanism that makes "a pool of warm agents" more than a spawn
trick — cyber-mux can poll or subscribe to know which pane in the pool is actually idle
and route new orchestration work to it, something no other multiplexer researched has a
native equivalent for.

### cmux (AI-agent terminal, Manaflow, macOS-native, AGPL-3.0)

cmux is a native macOS terminal purpose-built for running parallel AI coding agents
(vertical tabs with per-tab git branch/dirty/PR status, notification rings, libghostty
GPU rendering). It's the closest product to cyber-mux's actual use case, but its
automation surface is thinner than herdr's:

- **No declarative layout config.** `~/.config/cmux/cmux.json` covers app prefs/
  shortcuts/colors, not per-pane commands. There IS a "Save current workspace layout as
  a template" UI action (⌃⌘S), but no documented schema for what's captured or how a
  saved template is reapplied against a new cwd — effectively a black box from an
  external-integration standpoint.
- **Socket API is imperative-only, no atomic tree call.** JSON-RPC over
  `/tmp/cmux.sock`: `workspace.create` (takes `cwd`), `pane.create` (takes `direction`,
  `type` terminal|browser), `surface.split`, `surface.send_text`. Building a multi-pane
  layout means N sequential calls (create workspace → create pane → split → send_text
  the command into each) — **no `env` parameter and nothing analogous to herdr's
  `layout.apply`** (one call, whole tree, cwd/command/env per node).
- **Session restore is partial**, explicitly not process-resumption: cmux preserves
  layout/cwd/scrollback across relaunch but processes "restart in the same working
  directory but don't resume mid-execution" — docs point users at tmux/screen for true
  resumption. `cmux new-workspace --cwd <path> --command <text>` exists per-workspace
  but there's no "reapply this template to a fresh worktree" primitive.
- **Git-worktree awareness is passive display only** (branch/dirty/PR badge per tab),
  not a worktree-creation or template-targeting mechanism.
- **No agent-status state machine.** cmux is notification/event-driven (OSC 9/99/777,
  `cmux notify --title/--body`), showing a ring/badge with latest notification text —
  not an enumerated working/idle/blocked/done feed queryable for pool routing. A
  `custom-agents` hook example references `cmux set-status`/`clear-status`, but no
  documented state model or query API comparable to herdr's `agent_status`.

Verdict for cyber-mux: cmux is useful as a UX reference (per-tab git metadata,
notification rings) and as a negative example for the API design — its imperative,
per-object, no-env, no-atomic-tree, no-status-feed socket API is exactly the kind of
integration surface cyber-mux should NOT try to build a rich layout-template feature
on top of, in contrast to herdr's single-call declarative primitive.

### Orca (open-source Agent Development Environment, stablyai)

Orca is a full open-source Electron desktop app (MIT) for orchestrating a fleet of
parallel coding agents (Claude Code, Codex CLI, OpenCode, etc.), each bound to its own
git worktree, arranged in split panes alongside browser/diff/file views.

- **No declarative layout config file.** Panes/splits/tabs are arranged via the GUI;
  no JSON/YAML schema for a named, reusable multi-pane layout was found in docs.
- **Orchestration is a real, CLI-scriptable layer** (`orca orchestration
  task-create/dispatch/send/ask/check/run`) — a message bus with typed messages
  (`status`, `dispatch`, `worker_done`, `escalation`, `decision_gate`, `heartbeat`),
  task lifecycle `pending → ready → dispatched → completed/failed/blocked`, and
  addressable broadcast groups (`@all`, `@idle`, `@codex`). This is architecturally the
  closest thing researched to "orchestration within a pool of agents" as a named
  concept, but it's driven by sequential CLI calls, not a static template file.
  `/docs/cli/worktree-checkpoints` sounded template-like but turned out to be just a
  free-text status comment, not a saved/reapplicable config.
- **One agent = one terminal = one worktree**, spawned per-task through the UI/CLI; no
  evidence of a parameterized "template applied to a new worktree" mechanic — each task
  setup is freshly configured, not templated and reapplied.
- **Agent status feed exists and is comparable to herdr's**: color-coded
  working/waiting-on-input/idle states, detected via OSC terminal-title sequences,
  propagated to a mobile companion app, and reachable via the `@idle` orchestration
  broadcast address — the second tool researched (after herdr) with a real busy-state
  primitive for pool routing.
- **Not a scriptable backend for cyber-mux to drive.** Orca is a full competing GUI
  product, not a multiplexer/terminal backend analogous to tmux/herdr that a thin
  adapter could wrap — its CLI is oriented at agents automating *within* Orca, not at
  exposing Orca headlessly to an external orchestrator.

Verdict for cyber-mux: Orca is the strongest feature/UX reference for the
*orchestration* half of the ask (message-bus taxonomy, worktree-per-agent,
`@idle`-style routing) even though it's not an integration target — its message-bus
design (dispatch/worker_done/decision_gate) is a better model to borrow for "route work
to a warm agent" than herdr's status feed alone provides, since herdr only exposes
*state*, not a structured dispatch/completion protocol.

### Secondary tools (screen, iTerm2, Windows Terminal)

All three are weaker than tmuxinator/Zellij/WezTerm/herdr for this use case.

- **GNU screen**: `.screenrc` `layout save`/`layout dump` persists region *geometry*
  only; per-region `chdir` is static, not parameterizable per invocation without
  editing the file. No named/parameterized template mechanism.
- **iTerm2**: native "Save/Restore Window Arrangement" is a frozen, non-editable
  snapshot. Declarative + cwd-parameterizable multi-pane layouts require dropping into
  the Python API (`iterm2` package) and scripting window/pane creation — no built-in
  YAML-style template format.
- **Windows Terminal**: `wt` CLI chains `new-tab`/`split-pane` with `;`, each accepting
  `-d` (start dir) and a trailing command — cwd-parameterizable in principle (swap `-d`
  per invocation) but as a hand-built command string, not a structured/reusable file
  format.

## Contradictions

- herdr's exact session-persistence behavior on restart (`docs/session-state/`) could
  not be independently confirmed beyond a thin summary — flagged, not load-bearing for
  the design proposal below since it's snapshot/restore, not the template mechanism we
  want anyway.
- The two herdr community layout plugins were reported by one research agent and not
  independently re-fetched/re-verified by a second pass, unlike the socket API and
  plugin-system claims above which were directly re-verified. Treat their exact schema
  fields as indicative, not authoritative, if cyber-mux ever depends on them directly
  (it shouldn't — see conclusion: build on herdr's own `layout.apply`, not a community
  plugin).

## Open questions

- Exact mechanics of herdr's own workspace/tab/pane state restore on server restart
  (`docs/session-state/`) — not needed for the template design, but worth knowing if
  cyber-mux ever wants to distinguish "restore prior session" from "apply named
  template" as two different verbs.
- Whether herdr's `layout.apply` supports pane counts beyond a simple binary
  split-partition tree cleanly for layouts with many panes (e.g. 4+ agents in a grid) —
  the binary-tree shape can express any tiling via nesting, but template authors would
  be writing nested `split` nodes rather than a flat "N panes, tiled" declaration the
  way tmux's `even-horizontal`/`tiled` built-ins offer a shortcut for.
- Whether tmux's five built-in layout names (`even-horizontal`, `tiled`, etc.) are
  worth exposing as sugar in a cyber-mux template schema for the tmux backend, given
  herdr's backend only has the binary-tree primitive.

## Sources consulted

- tmuxai.dev layouts: https://tmuxai.dev/tmux-layouts/
- tao-of-tmux windows: https://tao-of-tmux.readthedocs.io/en/stable/manuscript/06-window.html
- tmuxinator README: https://github.com/tmuxinator/tmuxinator/blob/master/README.md
- tmuxp docs: https://tmuxp.git-pull.com/
- libtmux: https://github.com/tmux-python/libtmux
- tmux-resurrect README: https://github.com/tmux-plugins/tmux-resurrect/blob/master/README.md
- Zellij Layouts: https://zellij.dev/documentation/layouts.html
- Zellij Creating a Layout: https://zellij.dev/documentation/creating-a-layout.html
- Zellij 0.32.0 announcement: https://zellij.dev/news/config-command-layouts/
- Zellij Using Layouts for Personal Automation: https://zellij.dev/tutorials/layouts/
- Zellij Session Management: https://zellij.dev/tutorials/session-management/
- Zellij Options: https://zellij.dev/documentation/options.html
- Zellij CLI Actions: https://zellij.dev/documentation/cli-actions
- WezTerm gui-startup: https://wezterm.org/config/lua/gui-events/gui-startup.html
- WezTerm spawn_window: https://wezterm.org/config/lua/wezterm.mux/spawn_window.html
- WezTerm spawn_tab: https://wezterm.org/config/lua/mux-window/spawn_tab.html
- WezTerm pane split: https://wezterm.org/config/lua/pane/split.html
- WezTerm workspaces recipe: https://wezterm.org/recipes/workspaces.html
- WezTerm CLI index: https://wezterm.org/cli/cli/index.html
- WezTerm cli spawn: https://wezterm.org/cli/cli/spawn.html
- WezTerm cli split-pane: https://wezterm.org/cli/cli/split-pane.html
- resurrect.wezterm: https://github.com/MLFlexer/resurrect.wezterm
- wezterm-session-manager: https://github.com/danielcopper/wezterm-session-manager
- herdr Concepts: https://herdr.dev/docs/concepts/
- herdr CLI reference: https://herdr.dev/docs/cli-reference/
- herdr Configuration: https://herdr.dev/docs/configuration/
- herdr Socket API (verified directly): https://herdr.dev/docs/socket-api/
- herdr Plugins (verified directly): https://herdr.dev/docs/plugins/
- herdr-spreader: https://github.com/yuk1ty/herdr-spreader
- herdr-plugin-workspace-manager: https://github.com/razajamil/herdr-plugin-workspace-manager
- herdr-plus: https://github.com/cloudmanic/herdr-plus
- GNU screen Layout manual: https://www.gnu.org/software/screen/manual/html_node/Layout.html
- iTerm2 Dynamic Profiles: https://iterm2.com/documentation-dynamic-profiles.html
- iTerm2 Arrangements: https://iterm2.com/documentation-preferences-arrangements.html
- iTerm2 Python API Window: https://iterm2.com/python-api/window.html
- Windows Terminal command line arguments: https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments?tabs=windows
- Windows Terminal Panes: https://learn.microsoft.com/en-us/windows/terminal/panes
- cmux GitHub: https://github.com/manaflow-ai/cmux
- cmux docs (splits/panes, custom agents, socket API, CLI, workspaces/tabs, notifications): https://manaflow-ai-cmux.mintlify.app/features/splits-and-panes, https://manaflow-ai-cmux.mintlify.app/integrations/custom-agents, https://mintlify.wiki/manaflow-ai/cmux/automation/socket-api.md, https://mintlify.wiki/manaflow-ai/cmux/cli/workspaces.md
- cmux.com: https://cmux.com/, https://cmux.com/docs/configuration
- Orca docs: https://www.onorca.dev/docs/, https://www.onorca.dev/docs/cli/orchestration, https://www.onorca.dev/docs/model/agents-sessions, https://www.onorca.dev/docs/cli/worktree-checkpoints
- Orca GitHub: https://github.com/stablyai/orca
