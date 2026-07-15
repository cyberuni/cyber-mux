# Evidence log — message-bus/orchestration patterns across multiplexers

## M1

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: Orca's `orca orchestration` CLI exposes `task-create`/`dispatch`/`send`/
  `ask`/`check`/`run`/`reset`, with typed messages `status`/`dispatch`/`worker_done`/
  `escalation`/`decision_gate`/`heartbeat`, and a task lifecycle `pending → ready →
  dispatched → completed/failed/blocked`. `worker_done` must be sent exactly once
  (`--task-id`, `--dispatch-id`, `--body`, optional `--files-modified`,
  `--report-path`) to avoid stale-retry contamination.
- source label: Orca CLI orchestration docs
- source URL: https://www.onorca.dev/docs/cli/orchestration
- source type: official project docs
- notes: CLI flags confirmed; full JSON wire schema (field types, timestamps,
  delivery guarantees) is NOT published — flag documented at command-flag level only.

## M2

- date: 2026-07-15
- status: unconfirmed / inferred
- confidence: low
- claim: Orca's orchestration bus is backed by a background runtime process
  (daemon-like) that the CLI talks to, and orchestration state is scoped
  runtime-global rather than per-workspace.
- source label: Orca CLI docs phrasing
- source URL: https://www.onorca.dev/docs/cli/orchestration, https://www.onorca.dev/docs/cli/overview
- source type: official project docs (inferred, not stated architecture)
- notes: inference from "the CLI talks to the running Orca runtime" and `reset`
  affecting "runtime-global orchestration state" — no dedicated architecture doc
  found. Needs a live trial or source-code read to confirm.

## M3

- date: 2026-07-15
- status: unconfirmed
- confidence: low
- claim: `@idle` and similar addressing groups resolve against a live roster query
  of current agent/terminal state, not a static/stale list.
- source label: Orca CLI docs
- source URL: https://www.onorca.dev/docs/cli/orchestration
- source type: official project docs
- notes: inferred from "coordinator determines idle status through message checks and
  terminal state queries" — not an explicit confirmation of live-vs-static resolution.

## M4

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: Zellij plugins support a structured message-passing primitive —
  `PipeMessage` (`source`, `name`, `payload: Option<String>`, `args:
  BTreeMap<String,String>`, `is_private`) delivered via the `pipe()` trait method on
  `ZellijPlugin`, broadcastable to all plugins or targeted to one by ID. This is
  plugin-to-plugin messaging, not pane-to-pane or agent-to-agent.
- source label: Zellij plugin-pipes docs + zellij-tile API docs
- source URL: https://zellij.dev/documentation/plugin-pipes, https://docs.rs/zellij-tile/latest/zellij_tile/prelude/struct.PipeMessage.html
- source type: official project docs
- notes: the only mailbox-like primitive found living inside a multiplexer's own
  plugin API (as opposed to a separate orchestration product layered on top).

## M5

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: WezTerm's `MuxNotification` pub/sub and PDU-based client/server protocol
  exist to propagate render/state changes to GUI clients (e.g. `PaneOutput`,
  `WindowCreated`), not to provide application-level message passing between panes or
  agents.
- source label: WezTerm client/server protocol (deepwiki, secondary/community source)
- source URL: https://deepwiki.com/wezterm/wezterm/2.2.2-client-server-protocol
- source type: secondary/community-generated documentation, not official WezTerm docs
- notes: single research pass via a third-party doc aggregator, not cross-checked
  against WezTerm's own source or official docs — lower confidence than official-docs
  claims elsewhere in this research.

## M6

- date: 2026-07-15
- status: confirmed
- confidence: high
- claim: herdr's socket API has no task/dispatch/mailbox primitive beyond
  `events.subscribe` (pub/sub over `workspace.*`/`pane.*` including
  `pane.agent_status_changed`/`worktree.*`), plain keystroke-injection sends
  (`pane.send_text`/`send_keys`/`send_input`), and `pane.report_metadata` (display-only
  key/value tokens, explicitly not for coordination logic).
- source label: herdr Socket API docs (re-checked)
- source URL: https://herdr.dev/docs/socket-api/
- source type: official project docs
- notes: re-verification pass specifically checking for a mailbox primitive beyond
  what mux-workspace-layouts' evidence (E8/E11) already covered; none found.

## M7

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: cmux has no message-bus/mailbox/task-store today. A third-party (non-cmux)
  public gist proposes adding a file-backed `PI_TASKS` store + optional Unix-socket
  relay on top of cmux's existing primitives, explicitly labeled "not yet
  implemented" by its own author.
- source label: community gist (unofficial proposal)
- source URL: https://gist.github.com/joelhooks/11aea283acfd5a7f50e596bc63bbdd28
- source type: community proposal, not vendor documentation
- notes: signal of unmet ecosystem demand, not a documented cmux feature — do not
  cite as "cmux has X."

## M8

- date: 2026-07-15
- status: confirmed
- confidence: medium
- claim: Orca's own docs treat orchestration as a layer above pane/terminal
  primitives, not fused into pane creation — distinct command namespace
  (`orca orchestration ...` vs pane/workspace commands), and explicit framing
  ("use Orchestration instead of plain terminal prompts" for tracked multi-agent
  work).
- source label: Orca CLI overview
- source URL: https://www.onorca.dev/docs/cli/overview
- source type: official project docs
- notes: inferred from one explicit sentence plus command-namespace separation; no
  dedicated internal-architecture doc was found to confirm this is a deliberate,
  documented design boundary rather than incidental code organization.
