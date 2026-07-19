---
title: Workspace
description: The top tier a multiplexer groups panes and tabs under — real on herdr and WezTerm, absent on tmux, and where a git worktree binds.
---

A **workspace** is the outermost container a multiplexer groups its tabs and panes under — its "own
visible space" a caller can switch to as a whole. It is the one tier cyber-mux treats as **optional**:
[herdr](/cyber-mux/multiplexers/) and WezTerm have a real Workspace level, tmux does not. Everything
below — tabs and [panes](/cyber-mux/concepts/pane/) — every multiplexer has.

Because the tier is optional, cyber-mux never invents it. A command that lands a pane in a workspace
reports which one; a backend with no workspace tier reports **nothing** there, rather than a made-up
name. That absence is the honest answer, and callers are expected to read it as one.

## As a placement

`workspace` is one of the four placements [`open`](/cyber-mux/cli/open/) (and
[`worktree`](/cyber-mux/cli/worktree/)) accept, and it is the odd one out: `pane:right`, `pane:down`,
and `tab` all add something *inside* the caller's current space, but `workspace` opens a **genuinely
separate** space and leaves the caller's own untouched.

Where the tier is real, that is exactly what you get:

| Placement   | herdr / WezTerm            | tmux                                  |
| ----------- | -------------------------- | ------------------------------------- |
| `workspace` | a new workspace            | a new window                          |
| `tab`       | a new tab                  | a new window                          |

tmux has no level above its window, so `workspace` and `tab` **both collapse to a new window** — the
finest own-visible-space tmux offers. This is why an `open --at workspace` on tmux still succeeds; it
just cannot report a `workspace`, because there is no such tier to name.

## Occupancy vs binding

Two different facts both get called "workspace", and cyber-mux keeps them apart:

- **Occupancy** — *which workspace a pane lives in*. Reported as `open`'s `workspace` field. Every
  pane opened on a workspace-tier backend has one, whatever placement opened it.
- **Binding** — *a git worktree tied to a workspace as a first-class record*, the thing herdr's UI
  groups a repo's checkouts by. This is a stronger claim than occupancy, and only the
  [`worktree`](/cyber-mux/concepts/worktrees/) route produces it.

A worktree opened at `pane:right` **lives in** the caller's workspace while being **bound to** none:
the pane has a workspace, the worktree is still ungrouped. Do not read a reported occupancy as proof
a worktree was grouped — only the worktree capability grants that.

## When the tier is missing

For a backend with no Workspace level, cyber-mux offers an opaque **workspace group** id instead — a
tag stamped on the spaces one caller opens so they stay recognizable as a set afterwards. It is a
convenience for grouping, not a tier: a group id is **not** a workspace, and `open` still reports its
`workspace` field absent on tmux, tag or no tag. Where a real Workspace tier exists the tier already
*is* the group, so the tag is ignored.

## Where workspace shows up

- [`open --at workspace`](/cyber-mux/cli/open/) — open a separate workspace (or a window on tmux).
- [`worktree`](/cyber-mux/cli/worktree/) — binds a git worktree to a workspace where the backend can;
  see [Worktrees](/cyber-mux/concepts/worktrees/).
- [`focus`](/cyber-mux/cli/focus/) — beams the attached client to a pane *across* workspace and tab.
- [`template save --workspace`](/cyber-mux/cli/template/) — widens a capture from one region to every
  tab of the workspace it sits in.
- [Multiplexers](/cyber-mux/multiplexers/) — which backends have the tier, and what each does without
  it.
