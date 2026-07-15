---
status: draft
project-path: packages/cyber-mux
---

# cyber-mux — the CLI: cross-multiplexer pane control

> Root project spec — the **descriptive** top index for the `cyber-mux` npm package
> (`packages/cyber-mux`). Behaviors live in the capability folders below.

`cyber-mux`: one contract (`SessionAdapter`) over terminal multiplexers (tmux, herdr) — detection,
pane identity, placement, git worktree, and turn-taking (nudge) helpers — decoupled from legion
(no store/identity/doorbell). Env namespace is `CYBER_MUX` / `CYBER_MUX_PANE`.

## Capabilities

| Node | Concern |
|---|---|
| [`mux/`](./mux/README.md) | the pane abstraction — backend selection, placement, multiplexer detection, focus reporting |
| [`axi/`](./axi/README.md) | the Agent Experience Interface output contract every CLI command follows |
