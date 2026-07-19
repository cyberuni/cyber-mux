---
title: Introduction
description: What cyber-mux is and why it exists.
---

`cyber-mux` is a small CLI for **cross-multiplexer pane control**. It gives you one way to drive
panes — open, send, submit, read, focus, close, list — regardless of the terminal multiplexer you
happen to be inside. It also manages **git worktrees** bound to a workspace, and can build a whole
named **layout** of panes from a template in one call.

Today it supports two backends:

- **tmux** — the ubiquitous terminal multiplexer.
- **herdr** — an agent-aware multiplexer ([herdr.dev](https://herdr.dev)).

It is the mux seam extracted from [`cyberlegion`](https://github.com/cyberuni/cyberplace), kept
deliberately narrow: it drives panes and nothing else. No mail, no dispatch, no agent registry —
those live in the tools that build *on top of* this seam.

## Try it

```bash
# What multiplexer am I in?
npx cyber-mux doctor

# Just the backend name (tmux / herdr / none)
npx cyber-mux mode
```

`doctor` reports the detected multiplexer, your current pane, and a fast-path pin you can export to
skip detection entirely.

## Where next

- [The mux seam](/cyber-mux/concepts/mux-seam/) — the one contract every backend implements.
- [Adapters](/cyber-mux/concepts/adapters/) — how tmux and herdr each fulfill it.
- [Detection](/cyber-mux/concepts/detection/) — how cyber-mux figures out where it is running.
- [Layouts](/cyber-mux/concepts/layouts/) — named, reusable pane pools.
- [Worktrees](/cyber-mux/concepts/worktrees/) — git worktrees bound to a workspace.
- [AXI](/cyber-mux/concepts/axi/) — the agent-facing output contract every command follows.
- [CLI commands](/cyber-mux/cli/commands/) — the full verb surface.
