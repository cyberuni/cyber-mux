# cyber-mux

[![npm version](https://img.shields.io/npm/v/cyber-mux.svg)](https://www.npmjs.com/package/cyber-mux)
[![npm downloads](https://img.shields.io/npm/dm/cyber-mux.svg)](https://www.npmjs.com/package/cyber-mux)
[![release](https://github.com/cyberuni/cyber-mux/actions/workflows/release.yml/badge.svg)](https://github.com/cyberuni/cyber-mux/actions/workflows/release.yml)
[![docs](https://img.shields.io/badge/docs-cyberuni.github.io-blue)](https://cyberuni.github.io/cyber-mux/)
[![license](https://img.shields.io/npm/l/cyber-mux.svg)](https://www.npmjs.com/package/cyber-mux)

Cross-multiplexer pane control for AI-agent tooling. One contract over terminal multiplexers — open,
send, read, focus, and close panes without caring which multiplexer you are inside.

`cyber-mux` is the mux seam used by [`cyberlegion`](https://github.com/cyberuni/cyberplace), kept
deliberately narrow: it drives panes and nothing else.

## Install

```bash
npx cyber-mux mode
```

## What it does

- **Detects** the multiplexer you are running under — env fast-path (`CYBER_MUX` / `CYBER_MUX_PANE`),
  otherwise a process-ancestry walk falling back to the multiplexer's own env hints.
- **Drives panes** through one `MuxAdapter` contract: `open`, `send`, `submit`, `read`, `wait`,
  `focus`, `close`, `list`, `exists`.
- **Nudges** a peer pane and verifies the turn was actually taken (recovers a submit swallowed by a
  booting harness).
- **Worktrees**: create a git worktree and open it in a new workspace/session in one step.

## Backends

Drivable: **tmux**, **rmux**, **herdr**, **wezterm**, **zellij**, **cmux**, **otty**.

GNU **screen** is recognized and reported truthfully, then rejected with a named error rather than
driven — it addresses panes positionally, so a driver-created pane has no stable identity to send to,
read from, or self-identify by.

## Commands

| Command | Description |
| --- | --- |
| `cyber-mux doctor` | Probe the multiplexer, self pane, and backend; print fast-path pins |
| `cyber-mux mode` | Report the detected session backend |
| `cyber-mux open` | Open a new pane/tab/workspace, optionally launching a command in it |
| `cyber-mux send` | Drive a pane without taking its turn (text or keys) |
| `cyber-mux submit` | Take a pane's turn: type the text if given, then press Enter |
| `cyber-mux read` | Capture a pane's output |
| `cyber-mux wait` | Block until a pane's output matches (exit 0), or the timeout elapses (exit 1) |
| `cyber-mux focus` | Beam the attached client to a pane |
| `cyber-mux close` | Close a pane |
| `cyber-mux list` / `exists` | Enumerate live panes / probe whether one is still live |
| `cyber-mux worktree` | Git worktree helpers for spawning and tearing down a session |
| `cyber-mux template` | Manage named templates (apply one with `open`/`worktree --template`) |
| `cyber-mux agent` | Inspect and wait on a pane's agent-lifecycle state |

Full reference: <https://cyberuni.github.io/cyber-mux/>

## Development

Node and pnpm are pinned in `mise.toml` and managed by [mise](https://mise.jdx.dev):

```bash
mise install  # node + pnpm at the pinned versions
pnpm install
pnpm verify   # build + typecheck + lint + test
```

The CLI lives in `packages/cyber-mux`; the docs site in `apps/website` (Astro + Starlight).

## License

MIT
