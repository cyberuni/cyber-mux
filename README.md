# cyber-mux

Cross-multiplexer pane control for AI-agent tooling. One contract over terminal multiplexers
(**tmux**, **herdr**) — open, send, read, focus, and close panes without caring which multiplexer
you are inside.

`cyber-mux` is the mux seam extracted from [`cyberlegion`](https://github.com/cyberuni/cyberplace),
kept deliberately narrow: it drives panes and nothing else.

## Install

```bash
npx cyber-mux mux mode
```

## What it does

- **Detects** the multiplexer you are running under — env fast-path (`CYBER_MUX` / `CYBER_MUX_PANE`),
  otherwise a process-ancestry walk falling back to `$TMUX` / `$HERDR_ENV`.
- **Drives panes** through one `SessionAdapter` contract: `open`, `send`, `submit`, `read`, `focus`,
  `close`, `list`, `exists`.
- **Nudges** a peer pane and verifies the turn was actually taken (recovers a submit swallowed by a
  booting harness).
- **Worktrees**: create a git worktree and open it in a new workspace/session in one step.

## Commands

| Command | Description |
| --- | --- |
| `cyber-mux doctor` | Report the detected multiplexer, self pane, and backend; print fast-path pins |
| `cyber-mux mode` | Report the detected session backend (`tmux` / `herdr` / `none`) |
| `cyber-mux open` | Open a new pane/tab/workspace running a command |
| `cyber-mux send` / `submit` | Type text into a pane / flush a staged buffer |
| `cyber-mux read` | Capture a pane's output |
| `cyber-mux focus` | Beam the attached client to a pane |
| `cyber-mux close` | Close a pane |
| `cyber-mux list` / `exists` | Enumerate live panes / probe one |

> The verb surface is provisional — the behavior spec is the next milestone.

## Development

```bash
pnpm install
pnpm verify   # build + typecheck + lint + test
```

Docs site lives in `apps/website` (Astro + Starlight).

## License

MIT
