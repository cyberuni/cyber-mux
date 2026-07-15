# Message-bus / orchestration patterns across multiplexers, with focus on Orca (July 2026)

## Question

Does any terminal multiplexer or agent-terminal product have a structured
message-bus/mailbox layer for routing work between panes/agent sessions — beyond a
bare busy-status field — and if so, does that layer belong at the multiplexer layer
(inside `cyber-mux`) or as an application-level concern layered on top (the way
`cyberlegion`'s existing inter-agent mail system already works)? Follow-up to
[[mux-workspace-layouts]], which flagged Orca's `orca orchestration` CLI as the most
structured dispatch/completion protocol surveyed but only at summary depth.

## Scope

In scope: Orca's orchestration message types and addressing model, in depth; any
comparable inter-pane/inter-agent messaging primitive in tmux, Zellij, WezTerm, herdr,
cmux; general prior-art categorization (actor mailbox / job queue / pub-sub) to judge
fit; explicit or inferable statements about whether such a layer is bundled with pane
primitives or kept separate. Out of scope: re-litigating layout-template design
(covered in [[mux-workspace-layouts]]); cyberlegion's own mail system internals (assumed
known from this session's context, not re-researched).

## Source angles

- Orca's own orchestration CLI docs, fetched directly
- Multiplexer plugin/API docs for inter-pane or inter-plugin messaging (Zellij `PipeMessage`, WezTerm `MuxNotification`, herdr `events.subscribe`)
- Community/third-party proposals (a cmux mailbox gist) as a signal of unmet demand, not documented behavior
- General distributed-systems prior art (actor mailboxes, job queues, pub/sub) for categorizing Orca's design

## Findings

### Orca's orchestration message bus (depth pass)

Commands: `orca orchestration task-create` (`--task-title`, `--display-name`,
`--spec`), `dispatch` (`--task`, `--to`, `--inject`), `send` (`--to`, `--subject`,
`--body`, `--type`), `ask` (`--question`, `--options`, `--timeout-ms`), `check`
(`--unread`, `--all`, `--wait`, `--types`), `run` (`--spec`, `--max-concurrent`,
`--worktree`), `reset`.

Message types: `status`, `dispatch`, `worker_done` (`--task-id`, `--dispatch-id`,
`--body`, optional `--files-modified`, `--report-path` — must be sent exactly once,
even on failure, to avoid stale-retry contamination), `escalation`, `decision_gate` (a
coordinator-owned blocking question), `heartbeat` (`--phase`). No full JSON
schema (field types, timestamps) is published — only the CLI flags each `send`-style
command accepts. Task lifecycle: `pending → ready → dispatched →
completed/failed/blocked`.

Implementation is not publicly documented. Docs state "The CLI talks to the running
Orca runtime, so `orca status --json` should succeed first" — implying a background
runtime process (daemon-like) rather than a bare file store, but this is inference from
phrasing, not a stated architecture. Scope is explicitly **runtime-global**: `reset`
"affects runtime-global orchestration state," not obviously scoped per-workspace.

Addressing: `@all`, `@idle`, `@codex`/`@cursor`/`@grok`/`@droid` (agent-type filters),
`@worktree:<worktreeId>`. Whether these resolve against a live roster query or a static
list wasn't confirmed from docs; phrasing ("coordinator determines idle status through
message checks and terminal state queries") suggests a live query, not blind
dispatch-and-reject, but this is not explicitly stated. No full CLI reference page with
every flag/JSON schema was found — `/docs/cli/reference` links back to
`/docs/cli/orchestration` without expanding it. Full internals likely require Orca's
closed-source Electron runtime — not documented publicly.

### Comparable primitives elsewhere

- **tmux**: no structured mailbox plugin found. Ecosystem is send-keys wrappers with
  ad hoc sender-tag conventions bolted on by users — no built-in primitive.
- **Zellij**: has a real structured plugin-to-plugin messaging primitive —
  `PipeMessage` (`source`, `name`, `payload: Option<String>`, `args:
  BTreeMap<String,String>`, `is_private`), delivered via a `pipe()` trait method on
  `ZellijPlugin`, sendable to all plugins (broadcast) or a specific plugin by ID. This
  is the closest thing to a real mailbox found in any *multiplexer's own* API (not an
  agent-orchestration product) — but it's plugin-level, not agent/task-level: it
  routes messages between Zellij plugins, not between arbitrary panes or "agents."
- **WezTerm**: has `MuxNotification` pub/sub (`PaneOutput`, `WindowCreated`, etc.) and
  a PDU-based client/server RPC protocol, but this exists to propagate render/state
  changes to GUI clients — not an application-level message-passing primitive between
  panes.
- **herdr**: re-checked socket API beyond `agent_status` — has `events.subscribe`
  (pub/sub over `workspace.*`, `pane.*` incl. `pane.agent_status_changed`,
  `worktree.*`), `pane.send_text`/`send_keys`/`send_input` (still just keystroke
  injection, not structured messages), and `pane.report_metadata` (display-only
  key/value tokens like `$summary`/`$model`, explicitly not for coordination logic). No
  task/dispatch/mailbox primitive exists in herdr's own API.
- **cmux**: has no message-bus/mailbox/task-store today. A third-party public gist
  proposes *adding* one (`PI_TASKS` file-backed store + optional Unix-socket relay) on
  top of cmux's existing `send`/`read-screen`/`notify` primitives, explicitly labeled
  "not yet implemented" by its author — a useful signal of unmet demand in the
  ecosystem, not documented cmux behavior. Do not treat as a cmux feature.

### Prior-art categorization

Orca's design reads as a hybrid of three known patterns:
1. **Actor-model mailbox** — async point-to-point/broadcast messages, receiver-side
   inbox, blocking-with-timeout receive (`check --wait`).
2. **Job/task queue** — task records with lifecycle states (`pending → ready →
   dispatched → completed/failed/blocked`), similar to Celery/Sidekiq task states.
3. **Broker-style topic/group addressing** — `@all`/`@idle`/`@codex` resembles
   AMQP exchange routing or pub/sub topic filters, though with no replay/log-
   compaction semantics (no Kafka/NATS JetStream-style durable log was described).

### Architectural placement

Orca's own docs place orchestration as a layer **above** pane/terminal primitives, not
fused into pane creation: "For tracked multi-agent work, use Orchestration instead of
plain terminal prompts." Orchestration commands (`task-create`, `dispatch`, `send`)
operate on tasks/messages/terminals-as-targets, not on pane geometry/splits — distinct
command namespace, distinct concern. This is inferred from a single explicit sentence
plus command-namespace separation; no dedicated internal-architecture doc was found.

## Contradictions

- None found directly, but note the tension between "Orca bundles orchestration and
  pane creation in one product" (surface-level observation) versus "Orca's own docs
  still treat them as two separably-addressed subsystems" (the actual command
  structure) — the product bundles them for UX convenience, not because they're
  architecturally fused.

## Open questions

- Whether Orca's `@idle` addressing is a live roster query or a static list — not
  confirmed from public docs; would need the closed-source runtime or a live trial to
  settle.
- Full JSON wire schema for each Orca message type (timestamps, sender/recipient
  fields, delivery guarantees, at-most-once vs at-least-once) — not published.
- Whether Orca's orchestration state is truly global-only or has an undocumented
  per-workspace scope; `reset`'s "runtime-global" phrasing is the only signal found.
- Zellij's `PipeMessage` deserves a closer look if cyber-mux ever considers building on
  a Rust-plugin-based multiplexer rather than herdr/tmux — it's the one mailbox-like
  primitive that lives inside a multiplexer's own plugin API rather than a separate
  orchestration product.

## Sources consulted

- Orca CLI orchestration docs: https://www.onorca.dev/docs/cli/orchestration
- Orca CLI reference: https://www.onorca.dev/docs/cli/reference
- Orca CLI overview: https://www.onorca.dev/docs/cli/overview
- tmux send-keys wrapper conventions: https://stephenfeather.com/technical-log/addressing-tmux-panes-by-name-a-send-keys-wrapper-that-doesnt-lie-to-you/
- Zellij plugin pipes docs: https://zellij.dev/documentation/plugin-pipes
- Zellij PipeMessage API: https://docs.rs/zellij-tile/latest/zellij_tile/prelude/struct.PipeMessage.html
- WezTerm client/server protocol (deepwiki, secondary source): https://deepwiki.com/wezterm/wezterm/2.2.2-client-server-protocol
- herdr Socket API (re-checked): https://herdr.dev/docs/socket-api/
- cmux mailbox proposal gist (third-party, unimplemented): https://gist.github.com/joelhooks/11aea283acfd5a7f50e596bc63bbdd28
- cmux.com: https://cmux.com/
- job/task queue background: https://knowledgelib.io/software/system-design/job-task-queue/2026
