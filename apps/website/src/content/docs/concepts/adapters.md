---
title: Adapters
description: How the tmux, herdr, and WezTerm backends fulfill the mux seam.
---

An **adapter** is a concrete implementation of the [mux seam](/cyber-mux/concepts/mux-seam/) for one
multiplexer. `cyber-mux` ships three.

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

## WezTerm

Drives [WezTerm](https://wezterm.org)'s built-in multiplexer via `wezterm cli` (`spawn`,
`split-pane`, `list --format json`, `send-text`, `activate-pane`, …). Built from `wezterm cli
--help`/the CLI reference rather than empirically — no live WezTerm GUI was available to verify
against — so its gaps are real, spec'd adapter limitations rather than forced parity:

- **No `--env` flag on any space-creating command at all.** `spawn` and `split-pane` take no such
  option, so every WezTerm open takes the command-prefix-or-warn fallback herdr's one worktree
  route alone needs.
- **No way to title a pane, at birth or after.** `rename(..., 'pane', …)` throws rather than
  silently no-op'ing; `open`'s pane-tier `--label` degrades to a stderr warning instead. A new
  *tab's* label has no birth flag either (unlike tmux `-n` or herdr `--label`) — every tab is
  named by a post-birth `set-tab-title`. A new **workspace's** name, by contrast, *is* native at
  birth (it doubles as the `--workspace` value `spawn` already takes).
  `listPanes`/`describeRegion` never report a label at all — `title` is always the ambient
  running-program name, never something an author chose.
- **No focus-query primitive.** `list --format json` carries no active/focused field for a pane,
  tab, or window at all, so `isPaneFocused` always answers `unknown` — the whole backend's answer,
  not a per-query fallback the way tmux/herdr's `unknown` is.
- **`--percent` sizes the *new* pane** — the same direction as tmux's `-l`, not herdr's
  pass-through — when sizing a `pane:*` split.
- **Never binds a git worktree, despite having a real Workspace tier.** Its CLI has no `worktree`
  subcommand or concept of one, so — like tmux, for the opposite reason — it falls back to plain
  git plus a placement-appropriate `open()`.
- **A genuine fourth placement level.** WezTerm's own native tiers are Workspace › Window › Tab ›
  Pane. `--at workspace` maps to a real WezTerm **Window** spawned into a fresh (or caller-named)
  **Workspace**, never a bare new tab; `--at tab` maps to a real WezTerm **Tab** in the current
  window. tmux and herdr both collapse Workspace and Tab onto one level; WezTerm keeps them
  genuinely distinct.
- `spawn`/`split-pane` report only the bare pane id — unlike tmux/herdr, its tab (and, on a `tab`
  or `pane:*` placement, its workspace) cost one follow-up `list --format json` call.

## The common shape

Both adapters answer their **own** liveness and focus probes, so a herdr pane id is never queried
with a tmux command or vice versa. Anything they cannot determine (a missing pane, an unreadable
focus state) is reported as *unknown* — never a false negative.
