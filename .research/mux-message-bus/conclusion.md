# Conclusion: message-bus/orchestration patterns for cyber-mux's warm-agent pool

## Last updated

July 2026

## Question

Does any multiplexer or agent-terminal product have a structured message-bus/mailbox
layer for routing work between agent sessions (beyond a bare busy-status field), and
does that layer belong inside `cyber-mux` (the multiplexer layer) or as an
application-level concern on top of it — the way `cyberlegion`'s existing inter-agent
mail system already works?

## Verdict

**Orca is the only product researched with a real, structured dispatch/completion
protocol** (`orca orchestration`): typed messages (`status`, `dispatch`, `worker_done`,
`escalation`, `decision_gate`, `heartbeat`), a task lifecycle
(`pending→ready→dispatched→completed/failed/blocked`), and group addressing
(`@all`/`@idle`/`@codex`/`@worktree:<id>`). It reads as a hybrid of an actor-model
mailbox (async point-to-point/broadcast, blocking `check --wait` receive), a job/task
queue (Celery/Sidekiq-shaped task states), and broker-style topic addressing
(AMQP/pub-sub-like group filters) — with no durable-log/replay semantics (not
Kafka/NATS-JetStream-like). Full wire schema (field types, delivery guarantees,
live-vs-static roster resolution for `@idle`) is not publicly documented; several
claims here are inferred from phrasing, not confirmed architecture (flagged low-
confidence in evidence M2/M3).

**No multiplexer's own core API has anything comparable.** tmux: nothing built-in.
WezTerm: pub/sub exists but only for GUI state sync, not application messaging. herdr:
re-checked specifically for this — beyond `agent_status` and `events.subscribe`
(pane/workspace/worktree event pub-sub), there is no task/dispatch/mailbox primitive.
cmux: none, only a third-party unimplemented proposal. **The one exception is Zellij**,
whose plugin API has a genuine structured message-passing primitive
(`PipeMessage` — source, name, payload, args, broadcast-or-targeted) — but it operates
between *Zellij plugins*, not between arbitrary panes or agents, so it's a narrower
mechanism than what "route work to an idle agent pane" would need.

**On the architectural placement question**: the evidence leans toward keeping a
message-bus/mailbox layer as an application-level concern above cyber-mux, not folding
it into the multiplexer adapter itself — for three converging reasons:

1. Orca itself, despite owning both pane creation and orchestration in one product,
   still documents them as two distinct subsystems with separate command namespaces
   and an explicit framing ("use Orchestration *instead of* plain terminal prompts") —
   even the one product that bundles both treats them as separable concerns, not a
   single fused primitive (M8).
2. None of the actual multiplexer backends surveyed (tmux, WezTerm, herdr, cmux) bundle
   a mailbox into their pane/session API — the pattern in the wild is "multiplexer
   does pane lifecycle + minimal status/event feed; something else does dispatch."
   herdr's design (pane lifecycle + `agent_status` + `events.subscribe`) fits this
   split cleanly — it gives you the *signal* (who's idle) without trying to own the
   *protocol* (how work gets routed and acknowledged).
3. `cyberlegion` already has a working inter-agent mail system at the application
   layer. Duplicating a mailbox inside cyber-mux would create two competing message
   systems in the same stack rather than one that consumes cyber-mux's pane-status
   signal as an input.

This doesn't mean cyber-mux should do nothing here — it means cyber-mux's job is to
expose the *signal* well (pane identity, agent status, status-change events, ideally
normalized across herdr/tmux backends where tmux can't natively supply it), and let a
higher layer (cyberlegion's mail system, or a cyberlegion-adjacent dispatch layer)
consume that signal to decide who gets work. Orca's message-type taxonomy (`dispatch`/
`worker_done`/`decision_gate`/`escalation`/`heartbeat`) is worth mining for *that*
higher layer's protocol design — not for cyber-mux itself — if/when this gets pulled
in, per your framing.

## Confidence

High on the comparison itself (Orca is the only tool with a real message-bus; no
multiplexer's core API has one; Zellij's `PipeMessage` is the sole partial exception).
Medium-to-low on Orca's internal implementation details (runtime scoping, `@idle`
resolution semantics, wire schema) — these are inferred from doc phrasing, not
confirmed against source code or a live trial (M2, M3). Medium on the architectural-
placement recommendation — it's a reasoned synthesis from the evidence, not a
settled fact from any single source, and is offered as input to your call, not as a
verdict that overrides your own judgment on cyberlegion/cyber-mux boundaries.

## Strongest supporting evidence

- Orca's own command-namespace separation and explicit "use Orchestration instead of
  plain terminal prompts" framing (M8) — direct evidence the one product that owns
  both layers still treats them as separable.
- Consistent absence of a mailbox primitive across tmux/WezTerm/herdr/cmux's own APIs
  (M5, M6, M7) — the multiplexer layer not owning dispatch is the norm, not an
  outlier.
- Zellij's `PipeMessage` (M4) as a genuine counterexample worth studying if cyber-mux
  ever considers a Rust-plugin-based backend, since it shows a mailbox *can* live
  inside a multiplexer's plugin API — it's just not what any current cyber-mux backend
  (tmux, herdr) offers.

## Strongest weakening or contradictory evidence

- Orca bundles both layers in one shipped product and one coherent CLI namespace tree
  (`orca ...`) — a user of Orca doesn't experience "two systems," even if the docs
  frame them separably. If ergonomics/adoption matters more than architectural purity,
  this is a real point in favor of tighter coupling than the recommendation above
  suggests.
- The inference chain for "Orca's bus is a separate layer" rests on phrasing in docs,
  not a stated architecture decision or source-code confirmation (M8's own confidence
  is only medium) — treat the placement recommendation as informed opinion, not a
  proven fact.

## What is not supported

- No evidence that any multiplexer *should not* eventually grow a mailbox primitive —
  only that none currently has one. Zellij shows it's technically feasible inside a
  multiplexer's plugin architecture.
- No confirmed detail on Orca's actual message delivery guarantees (at-most-once vs
  at-least-once, ordering, persistence across runtime restart) — do not assume parity
  with any specific reference system (Celery, NATS, etc.) beyond the loose structural
  resemblance noted above.

## Where evidence is thin

- Orca's runtime/daemon architecture and orchestration-state scoping (global vs
  per-workspace) — inferred from phrasing only (M2).
- Orca's `@idle` addressing resolution mechanics — inferred, not confirmed (M3).
- WezTerm's client/server protocol claim (M5) came from a third-party doc aggregator
  (deepwiki), not WezTerm's own docs — lower-confidence than the rest of this research.

## What should be checked again later

- If cyber-mux or cyberlegion ever seriously considers building a dispatch protocol
  inspired by Orca, a live trial of Orca (or a source read, since it's open source at
  `github.com/stablyai/orca`) would resolve M2/M3's open questions with actual
  confirmation instead of doc-phrasing inference.
- Revisit Zellij's `PipeMessage` in depth if cyber-mux ever adds or considers a Zellij
  backend — it's the one multiplexer-native mailbox primitive found and wasn't
  explored beyond its top-level shape.
