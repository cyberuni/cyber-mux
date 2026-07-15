---
title: Adapters
description: How the tmux and herdr backends fulfill the mux seam.
---

An **adapter** is a concrete implementation of the [mux seam](/cyber-mux/concepts/mux-seam/) for one
multiplexer. `cyber-mux` ships two.

## tmux

Drives `tmux` via its CLI (`split-window`, `new-window`, `send-keys`, `capture-pane`,
`list-panes`, …).

- tmux has no "workspace" tier and calls the tab concept a *window*, so both `workspace` and `tab`
  placements collapse to a new **window** — the finest "own visible space" tmux offers. New windows
  open with `-d` so spawning never steals the caller's focus.
- `focus` resolves the pane's session and window from `list-panes -a` first, then beams in order:
  `switch-client` → `select-window` → `select-pane`. An unresolvable pane throws rather than issuing
  a false-success beam.

## herdr

Drives [herdr](https://herdr.dev) via its CLI (`pane split`, `tab create`, `workspace create`,
`pane run`, `pane read`, …). herdr is agent-aware and returns rich JSON envelopes, which the adapter
parses defensively.

- herdr binds a git worktree to a workspace as a first-class record, and that binding is what its UI
  shows a repo's primary checkout and its worktrees as one **group** by — so herdr implements the
  optional `worktree` capability. tmux has no workspace tier to bind to and omits it; callers fall
  back to plain git plus a placement-appropriate `open()`.
- Only the `worktree` route binds. `git worktree add` followed by `workspace create --cwd <checkout>`
  yields a workspace with **no** worktree record — herdr does not know it is a worktree at all, and
  leaves it out of the group. Only `worktree create` / `worktree open` produce the binding. (herdr's
  `worktree list` still shows such a checkout with an `open_workspace_id`, matching it by path after
  the fact — the list view is misleading here; the workspace record is the truth.)
- Creating a worktree opens a workspace for the **source** checkout too when the repo has none — a
  group needs its parent.
- `listPanes` reports each pane's running harness (herdr knows which agent is in each pane); tmux
  cannot, so it leaves `harness` unset.

## The common shape

Both adapters answer their **own** liveness and focus probes, so a herdr pane id is never queried
with a tmux command or vice versa. Anything they cannot determine (a missing pane, an unreadable
focus state) is reported as *unknown* — never a false negative.
