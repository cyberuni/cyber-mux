---
title: Introduction
description: What cyber-mux is and why it exists.
---

`cyber-mux` is a small CLI for **cross-multiplexer pane control**. It gives you one way to drive
panes — open, send, submit, read, focus, close, list — regardless of the terminal multiplexer you
happen to be inside. It also manages **git worktrees** bound to a workspace, and can build a whole
named **template** of panes in one call.

Today it supports four backends:

- **tmux** — the ubiquitous terminal multiplexer ([tmux](https://github.com/tmux/tmux)).
- **herdr** — an agent-aware multiplexer ([herdr.dev](https://herdr.dev)).
- **WezTerm** (alpha) — a GUI terminal with a built-in multiplexer ([wezterm.org](https://wezterm.org)), driven through `wezterm cli`.
  Built against `wezterm cli --help`/the CLI reference rather than a live GUI — treat it as
  unverified until confirmed against a real WezTerm session.
- **Zellij** (alpha) — a terminal workspace with a built-in multiplexer ([zellij.dev](https://zellij.dev)), driven through `zellij action`.
  Requires Zellij ≥ 0.44.1. Built from the Zellij docs and CHANGELOG rather than a live binary —
  treat it as unverified until confirmed against a real Zellij session.

It is kept deliberately narrow: it drives panes and nothing else. No mail, no dispatch, no agent
registry — those live in the tools that build *on top of* it. Those tools can skip the CLI and import
the same core directly — see the [Library API](/cyber-mux/api/).

## Try it

```bash
# What multiplexer am I in?
npx cyber-mux doctor

# Just the backend name (tmux / herdr / wezterm / zellij / none)
npx cyber-mux mode
```

`doctor` reports the detected multiplexer, your current pane, and a fast-path pin you can export to
skip detection entirely.

## Where next

- [Multiplexers](/cyber-mux/multiplexers/) — the tmux, herdr, WezTerm, and Zellij backends and how
  their feature sets differ.
- [Detection](/cyber-mux/concepts/detection/) — how cyber-mux figures out where it is running.
- [Templates](/cyber-mux/concepts/templates/) — named, reusable pane pools.
- [Worktrees](/cyber-mux/concepts/worktrees/) — git worktrees bound to a workspace.
- [AXI](/cyber-mux/concepts/axi/) — the agent-facing output contract every command follows.
- [Library API](/cyber-mux/api/) — import the core directly instead of shelling out to the CLI.
- [CLI Reference](/cyber-mux/cli/) — the full verb surface, one page per command.
