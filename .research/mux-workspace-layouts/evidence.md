# Evidence log — multiplexer workspace layout comparison

## E1

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: tmux has no native named/reusable layout-template concept with attached
  per-pane commands; `select-layout`/layout strings round-trip geometry only.
- source label: tmuxai.dev / tao-of-tmux
- source URL: https://tmuxai.dev/tmux-layouts/, https://tao-of-tmux.readthedocs.io/en/stable/manuscript/06-window.html
- source type: independent docs/tutorial
- notes: single research pass, not independently re-fetched, but consistent with
  well-known tmux behavior.

## E2

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: tmuxinator YAML (`windows[].panes[]`, `layout`, `root`) declares per-pane
  startup commands; ERB templating (`root: ~/<%= @args[0] %>`) parameterizes cwd per
  invocation.
- source label: tmuxinator README
- source URL: https://github.com/tmuxinator/tmuxinator/blob/master/README.md
- source type: official project docs
- notes: primary source, direct fetch.

## E3

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: tmux-resurrect/continuum are snapshot/restore tools of currently-running
  state, not design-time templates; not built to retarget a new directory.
- source label: tmux-resurrect README
- source URL: https://github.com/tmux-plugins/tmux-resurrect/blob/master/README.md
- source type: official project docs
- notes: single research pass.

## E4

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: Zellij KDL layouts support `pane command="..." { args ... close_on_exit ... }`
  for per-pane startup commands, and `--cwd` on `zellij --layout <name> --cwd <path>`
  (or `zellij action new-tab --layout <name> --cwd <path>`) overrides the layout's base
  cwd at apply time — first-class apply-time parameterization.
- source label: Zellij docs (Layouts, Creating a Layout, CLI Actions, Options)
- source URL: https://zellij.dev/documentation/layouts.html, https://zellij.dev/documentation/creating-a-layout.html, https://zellij.dev/documentation/cli-actions, https://zellij.dev/documentation/options.html
- source type: official project docs
- notes: primary source, direct fetch by research agent; not independently re-verified
  by a second fetch, but multiple corroborating official pages agree.

## E5

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: Zellij `pane_template`/`tab_template` are static, named, reusable KDL macros
  (defaults + per-use overrides), not a full variable-substitution templating system.
- source label: Zellij Creating a Layout
- source URL: https://zellij.dev/documentation/creating-a-layout.html
- source type: official project docs
- notes: single research pass.

## E6

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: WezTerm supports both declarative Lua spawn (`gui-startup` + `mux.spawn_window`/
  `pane:split`/`pane:send_text`) and imperative CLI spawn (`wezterm cli spawn --cwd`,
  `wezterm cli split-pane --pane-id --cwd`) for building multi-pane layouts; the CLI path
  requires no Lua and matches cyber-mux's existing scripting-layer architecture.
- source label: WezTerm docs (gui-startup, spawn_window, CLI index/spawn/split-pane)
- source URL: https://wezterm.org/config/lua/gui-events/gui-startup.html, https://wezterm.org/cli/cli/spawn.html, https://wezterm.org/cli/cli/split-pane.html
- source type: official project docs
- notes: primary source, direct fetch.

## E7

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: WezTerm has no native session-persistence across full process restart;
  third-party plugins (`resurrect.wezterm`, `wezterm-session-manager`) fill that gap.
- source label: WezTerm workspaces recipe + community plugin repos
- source URL: https://wezterm.org/recipes/workspaces.html, https://github.com/MLFlexer/resurrect.wezterm
- source type: official docs + community project
- notes: single research pass.

## E8

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: herdr's socket API `layout.apply` creates a fresh tab from a declarative
  binary split-partition tree in one call (`{workspace_id, tab_label, focus, root:
  {type, direction, ratio, first, second, label, cwd, command, env}}`); `layout.export`
  reads an existing tab's tree back out in the same shape.
- source label: herdr Socket API docs
- source URL: https://herdr.dev/docs/socket-api/
- source type: official project docs
- notes: **directly re-verified by WebFetch in this session** (not just the initial
  research agent's summary) — exact JSON example quoted in topic.md.

## E9

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: herdr's plugin system uses `herdr-plugin.toml` manifests, supports
  `[[panes]]` (id/title/placement/command) and `[[events]]` hooks (including a
  confirmed `worktree.created` event), installed via `herdr plugin install
  owner/repo[/subdir]`. herdr's own docs list no official/maintained layout plugin —
  only unmaintained examples (`ogulcancelik/herdr-plugin-examples`).
- source label: herdr Plugins docs
- source URL: https://herdr.dev/docs/plugins/
- source type: official project docs
- notes: **directly re-verified by WebFetch in this session.**

## E10

- date: 2026-07-15
- status: confirmed
- confidence: medium (schema fields not independently re-verified)
- claim: at least two community plugins/tools already implement YAML-declarative
  layout templating on top of herdr's CLI: `razajamil/herdr-plugin-workspace-manager`
  (per-worktree auto-apply via `worktree.created`/`workspace.created` events + glob
  `layoutMatching`) and `yuk1ty/herdr-spreader` (standalone tmuxinator-alike with
  `wait_for.match/timeout_ms` for sequencing pane startup).
- source label: GitHub project READMEs
- source URL: https://github.com/razajamil/herdr-plugin-workspace-manager, https://github.com/yuk1ty/herdr-spreader
- source type: community code repos
- notes: reported by one research agent; not independently re-fetched by a second
  verification pass. Treat exact YAML field names as indicative, not authoritative.

## E11

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: herdr's per-pane agent status feed has five states (`working`, `idle`,
  `blocked`, `done`, `unknown`) surfaced via CLI (`herdr agent list/get`, `herdr wait
  agent-status`), socket API (`agent_status` field, `pane.report_agent`,
  `events.subscribe` with `pane.agent_status_changed` push events keyed by `pane_id`),
  and UI sidebar rollup.
- source label: herdr Concepts, CLI reference, Socket API docs
- source URL: https://herdr.dev/docs/concepts/, https://herdr.dev/docs/cli-reference/, https://herdr.dev/docs/socket-api/
- source type: official project docs
- notes: socket API portion directly re-verified by WebFetch in this session; CLI/
  Concepts portions from the initial research agent's fetch, not independently
  re-verified but internally consistent with the verified socket API.

## E12

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: GNU screen, iTerm2 native Arrangements, and Windows Terminal `wt` CLI are all
  weaker than tmuxinator/Zellij/WezTerm/herdr for declarative, cwd-parameterizable,
  reusable multi-pane templates — screen has geometry-only static persistence, iTerm2's
  native Arrangement feature is a frozen non-editable snapshot (parameterizable only via
  its Python API), Windows Terminal requires hand-built `wt` command strings rather than
  a structured template file.
- source label: GNU screen manual, iTerm2 docs, Microsoft Learn
- source URL: https://www.gnu.org/software/screen/manual/html_node/Layout.html, https://iterm2.com/documentation-preferences-arrangements.html, https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments?tabs=windows
- source type: official docs
- notes: single research pass, secondary/reference tools — low priority for
  re-verification since they're not candidates for cyber-mux's design.

## E13

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: cmux's socket API (`/tmp/cmux.sock`, JSON-RPC) is imperative-only —
  `workspace.create` (cwd), `pane.create` (direction, type), `surface.split`,
  `surface.send_text` — with no `env` parameter and no atomic whole-tree call
  analogous to herdr's `layout.apply`. cmux has a "Save current workspace layout as a
  template" UI action (⌃⌘S) with no documented schema for the saved format or
  reapplication against a new cwd. cmux has no enumerated agent-status state machine —
  only one-shot OSC/`cmux notify` notifications, no working/idle/blocked/done feed.
- source label: cmux GitHub + Mintlify docs (socket-api, cli/workspaces, cli/panes,
  cli/surfaces, features/splits-and-panes, integrations/custom-agents)
- source URL: https://github.com/manaflow-ai/cmux, https://mintlify.wiki/manaflow-ai/cmux/automation/socket-api.md
- source type: official project docs
- notes: single research pass, not independently re-verified by a second fetch.

## E14

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: Orca has no declarative layout config file (panes arranged via GUI); its
  "Orchestration" layer is a real CLI-scriptable message bus (`orca orchestration
  task-create/dispatch/send/ask/check/run`, typed messages `status`/`dispatch`/
  `worker_done`/`escalation`/`decision_gate`/`heartbeat`, broadcast groups `@all`/
  `@idle`/`@codex`); each agent session is one terminal bound to one git worktree,
  freshly configured per task rather than templated and reapplied; Orca has a real
  agent-status feed (working/waiting/idle via OSC title sequences); Orca is a full
  Electron GUI app (MIT, stablyai/orca), not a scriptable backend cyber-mux could
  drive the way it drives tmux/herdr.
- source label: Orca docs (cli/orchestration, model/agents-sessions,
  cli/worktree-checkpoints) + GitHub
- source URL: https://www.onorca.dev/docs/cli/orchestration, https://www.onorca.dev/docs/model/agents-sessions, https://github.com/stablyai/orca
- source type: official project docs + code repo
- notes: single research pass, not independently re-verified by a second fetch. The
  "checkpoints" feature initially looked template-like but was confirmed to be a
  free-text status comment, not a saved config — worth a spot-check if cyber-mux ever
  wants to lift ideas from Orca's checkpoint UX.
