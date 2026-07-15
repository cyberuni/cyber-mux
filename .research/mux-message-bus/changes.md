# Change log — Message-bus/orchestration patterns across multiplexers

## 2026-07-15

- What changed: initial research saved — depth pass on Orca's `orca orchestration`
  message bus, survey of comparable primitives in tmux/Zellij/WezTerm/herdr/cmux, and
  an architectural-placement assessment (multiplexer layer vs. application layer,
  e.g. cyberlegion's mail system).
- Why it changed: follow-up to mux-workspace-layouts, to inform whether cyber-mux
  should own a dispatch/mailbox protocol itself or only expose an agent-status signal
  for a higher layer to consume.
- Whether the conclusion changed materially: n/a (initial save).
- Which evidence or source triggered the update: M1-M8, direct fetch of Orca's
  orchestration/overview docs and Zellij's plugin-pipes docs; herdr socket-api
  re-checked specifically for a mailbox primitive (none found).
