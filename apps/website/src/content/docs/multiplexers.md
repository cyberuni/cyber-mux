---
title: Multiplexers
description: The multiplexers cyber-mux drives — tmux, herdr, and WezTerm — and how their differing feature sets map onto the one contract.
---

`cyber-mux` drives three terminal multiplexers through one contract, so callers never write
host-specific code. But the multiplexers are not the same shape: they disagree on how
many nesting tiers they have, whether they track git worktrees, and whether they can name a pane or
tell you which one is focused. This page is the map of those differences — what each multiplexer
supports and what cyber-mux does when it falls short.

## At a glance

| Capability            | tmux                    | herdr                   | WezTerm (alpha)         |
| --------------------- | ----------------------- | ----------------------- | ----------------------- |
| Workspace tier        | ✗ (collapses to window) | ✓                       | ✓ (a real Window/Workspace split) |
| Worktree binding      | ✗                       | ✓                       | ✗                       |
| Name a pane           | —                       | ✓                       | ✗ (throws / warns)      |
| Report focused pane   | best-effort             | best-effort             | ✗ (always `unknown`)    |
| Knows the running harness | ✗                   | ✓                       | ✗                       |

## tmux

Drives [tmux](https://github.com/tmux/tmux) via its CLI (`split-window`, `new-window`, `send-keys`,
`capture-pane`, `list-panes`, …).

- **No workspace tier.** tmux calls the tab concept a *window* and has nothing above it, so both
  `workspace` and `tab` placements collapse to a new **window** — the finest "own visible space"
  tmux offers. New windows open with `-d` so spawning never steals the caller's focus.
- **No worktree binding.** tmux has no workspace tier to bind a git worktree to, so it omits the
  optional `worktree` capability; callers fall back to plain git plus a placement-appropriate
  `open()`.
- **No harness awareness.** tmux cannot say which agent runs in a pane, so `listPanes` leaves
  `harness` unset.
- `focus` resolves the pane's session and window from `list-panes -a` first, then beams in order:
  `switch-client` → `select-window` → `select-pane`. An unresolvable pane throws rather than issuing
  a false-success beam.

## herdr

Driven via its CLI (`pane split`, `tab create`, `workspace create`, `pane run`, `pane read`, …).
[herdr](https://herdr.dev) is agent-aware and returns rich JSON envelopes, which cyber-mux parses
defensively.

- **Has a workspace tier, and binds git worktrees to it.** herdr binds a git worktree to a workspace
  as a first-class record, and that binding is what its UI groups a repo's primary checkout and its
  worktrees by — so herdr implements the optional `worktree` capability where tmux and WezTerm
  cannot.
- **Only the `worktree` route binds.** `git worktree add` followed by `workspace create --cwd
  <checkout>` yields a workspace with **no** worktree record — herdr does not know it is a worktree
  at all, and leaves it out of the group. Only `worktree create` / `worktree open` produce the
  binding. (herdr's `worktree list` still shows such a checkout with an `open_workspace_id`, matching
  it by path after the fact — the list view is misleading here; the workspace record is the truth.)
- **Creating a worktree opens a workspace for the *source* checkout too** when the repo has none — a
  group needs its parent.
- **Knows the running harness.** `listPanes` reports each pane's running harness, because herdr knows
  which agent is in each pane.

## WezTerm (alpha)

Driven via `wezterm cli` (`spawn`, `split-pane`, `list --format json`, `send-text`, `activate-pane`,
…) against [WezTerm](https://wezterm.org)'s built-in multiplexer. Built from `wezterm cli
--help`/the CLI reference rather than empirically — no live WezTerm GUI was available to verify
against — so its gaps are real, spec'd limitations rather than forced parity:

- **A genuine fourth placement level.** WezTerm's native tiers are Workspace › Window › Tab › Pane.
  `--at workspace` maps to a real WezTerm **Window** spawned into a fresh (or caller-named)
  **Workspace**, never a bare new tab; `--at tab` maps to a real WezTerm **Tab** in the current
  window. tmux and herdr both collapse Workspace and Tab onto one level; WezTerm keeps them
  genuinely distinct.
- **Never binds a git worktree, despite having a real Workspace tier.** Its CLI has no `worktree`
  subcommand or concept of one, so — like tmux, for the opposite reason — it falls back to plain git
  plus a placement-appropriate `open()`.
- **No `--env` flag on any space-creating command.** `spawn` and `split-pane` take no such option,
  so every WezTerm open takes the command-prefix-or-warn fallback that herdr needs only for its one
  worktree route.
- **No way to title a pane, at birth or after.** `rename(..., 'pane', …)` throws rather than silently
  no-op'ing; `open`'s pane-tier `--label` degrades to a stderr warning instead. A new *tab's* label
  has no birth flag either (unlike tmux `-n` or herdr `--label`) — every tab is named by a post-birth
  `set-tab-title`. A new **workspace's** name, by contrast, *is* native at birth (it doubles as the
  `--workspace` value `spawn` already takes). `listPanes`/`describeRegion` never report a label at
  all — `title` is always the ambient running-program name, never something an author chose.
- **No focus-query primitive.** `list --format json` carries no active/focused field for a pane, tab,
  or window, so `isPaneFocused` always answers `unknown` — the whole backend's answer, not a
  per-query fallback the way tmux's and herdr's `unknown` is.
- **`--percent` sizes the *new* pane** — the same direction as tmux's `-l`, not herdr's pass-through
  — when sizing a `pane:*` split.
- `spawn`/`split-pane` report only the bare pane id — unlike tmux/herdr, its tab (and, on a `tab` or
  `pane:*` placement, its workspace) cost one follow-up `list --format json` call.

## The common shape

Each multiplexer answers its **own** liveness and focus probes, so a herdr pane id is never queried
with a tmux command or vice versa. Anything a multiplexer cannot determine — a missing pane, an
unreadable focus state — is reported as *unknown*, never a false negative.
