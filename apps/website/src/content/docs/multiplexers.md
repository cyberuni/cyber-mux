---
title: Multiplexers
description: The multiplexers cyber-mux drives — tmux, herdr, WezTerm, Zellij, cmux, otty, and rmux — and how their differing feature sets map onto the one contract.
---

`cyber-mux` drives seven terminal multiplexers through one contract, so callers never write
host-specific code. But the multiplexers are not the same shape: they disagree on how
many nesting tiers they have, whether they track git worktrees, and whether they can name a pane or
tell you which one is focused. This page is the map of those differences — what each multiplexer
supports and what cyber-mux does when it falls short.

## At a glance

| Capability            | tmux                    | rmux                    | herdr                   | WezTerm (alpha)         | Zellij (alpha)          | cmux (alpha)            | otty (alpha)            |
| --------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| Workspace tier        | ✗ (collapses to window) | ✗ (collapses to window) | ✓                       | ✓ (a real Window/Workspace split) | ✗ (placement collapses to tab, but occupancy is reported) | ✓ (Window/Workspace) | ✓ (Window) |
| Worktree binding      | ✗                       | ✗                       | ✓                       | ✗                       | ✗                       | ✗                       | ✗                       |
| Name a pane           | —                       | —                       | ✓                       | ✗ (throws / warns)      | ✓                       | ✓                       | ✓                       |
| Report focused pane   | best-effort             | best-effort             | best-effort             | ✗ (always `unknown`)    | ✓ (`list-panes --json`) | ✓                       | ✓                       |
| Knows the running harness | ✗                   | ✗                       | ✓                       | ✗                       | ✗                       | ✗                       | ✗                       |
| Size splits           | ✓                       | ✓                       | ✓                       | ✓                       | ✗                       | ✓                       | ✗                       |
| Floating pane         | ✓ (tmux 3.7+, `new-pane`) | ✗ (refused by name)   | ✗ (refused by name)     | ✗ (refused by name)     | ✓ (`new-pane --floating`) | ✗ (refused by name)   | ✗ (refused by name)     |

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
- **Floating panes need tmux 3.7 or newer.** `--at pane:float` drives `new-pane`, the command tmux
  added in 3.7 for a pane that sits above the tiled layout and so resizes none of the region's other
  panes. cyber-mux does not probe the version: on an older tmux the command does not exist and tmux
  answers with its own `unknown command`, which surfaces as a failed open naming the command. A
  float takes tmux's default size — half the window's width by a quarter its height — and `--ratio`
  is dropped, because a float takes no share of a split whose fraction it could be.

## rmux

Drives [rmux](https://github.com/Helvesec/rmux) via its CLI (`split-window`, `new-window`,
`send-keys`, `capture-pane`, `list-panes`, …) — an async Rust reimplementation of the tmux command
language: `rmux list-commands` reports roughly 90 commands under tmux's own names, flags, target
syntax, and `#{...}` format vocabulary.

rmux runs natively on Linux, macOS, and **Windows** — no other backend on this page runs natively on
Windows, and that is why cyber-mux added it. Read that as a fact about rmux's own portability: the
adapter was built and verified against a live rmux 0.10.0 on **Linux**, and has not been exercised
on Windows or macOS.

- **No workspace tier**, the same as tmux: both `workspace` and `tab` placements collapse to a new
  **window**, opened with `-d` so it never steals the caller's focus.
- **No worktree binding.** Like tmux, it has no workspace tier to bind a git worktree to, so it
  omits the optional `worktree` capability; callers fall back to plain git plus a
  placement-appropriate `open()`.
- **Pane identity is tmux-shaped and stable** (`%0`, `%1`, …), addressable from outside the session:
  `split-window -P -F '#{pane_id}'` and `new-window -P -F` report the new pane's id from the birth
  command itself.
- **Native cwd and env at birth.** `-c` and `-e` on both `split-window` and `new-window` set the new
  pane's working directory and environment directly — unlike WezTerm and Zellij, no
  command-prefix env compensation is needed.
- **Can size a split.** `-l N%` sizes the *new* pane, the same direction as tmux's `-l`, so
  cyber-mux inverts the caller's ratio (`1 - ratio`).
- **Naming mirrors tmux exactly.** A tab is a window, renamed with `rename-window`; a pane has no
  rename verb, so its name is its title, set via `select-pane -T` — which moves no focus.
- **Workspace grouping uses tmux's own mechanism.** cyber-mux tags panes with `@`-prefixed window
  user options (`@cm_ws`, `@cm_tab`) and lists a group with the server-side filter
  `list-windows -f '#{==:#{@cm_ws},<id>}'`.
- **Reports region geometry.** `list-panes -t <id> -F '#{pane_left}…'` reports window-relative
  rects with the divider column excluded, so rmux implements the optional `regions` capability and
  `template save` works on it.
- **No harness awareness and no agent-state feed** — herdr is the only backend with either.
- `focus` resolves the pane's session and window from `list-panes -a`, then beams
  `switch-client` → `select-window` → `select-pane`, the same sequence as tmux.
- **Floating panes: not supported.** `new-pane` — the tmux 3.7 command `--at pane:float` drives —
  does not exist on rmux (`unknown command: new-pane`), so `--at pane:float` is refused by name,
  exactly as WezTerm, herdr, cmux, and otty refuse it — never substituted with a tiled split.
- **Detection runs before tmux's.** An rmux pane exports `$RMUX` (tmux's own `<socket>,<pid>,<session>`
  triple) and `$RMUX_PANE` (a `%N` pane id) — but it also sets `$TMUX`/`$TMUX_PANE` for tmux
  compatibility, so cyber-mux checks the rmux variables first; otherwise an rmux session would
  resolve to the tmux adapter. The process-ancestry walk matches the `rmux-daemon` process;
  `CYBER_MUX=rmux` is the explicit override.

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

## Zellij (alpha)

Driven via `zellij action` (`new-pane`, `new-tab`, `write-chars`, `send-keys`, `dump-screen`,
`focus-pane-id`, `list-panes --json`, `rename-pane`, `rename-tab-by-id`, `close-pane`, …) against
[Zellij](https://zellij.dev)'s built-in multiplexer. Requires Zellij ≥ 0.44.1, the release that
added per-pane CLI addressing. Built from the Zellij docs and CHANGELOG rather than empirically — no
live Zellij binary was available to verify against — so, like WezTerm, its gaps are real, spec'd
limitations rather than forced parity:

- **Has a real session tier, but a placement can't reach it.** Zellij's workspace-equivalent is a
  session, and pane ids are session-scoped — cyber-mux's pane target carries no session, so it can
  only ever operate inside the ambient session. A `workspace` placement therefore **collapses to a
  new tab**, the same way tmux collapses `workspace` to a window, even though the underlying tier is
  real. It still **reports** the occupied session, though: `OpenedPane.workspace` carries the ambient
  `$ZELLIJ_SESSION_NAME` — occupancy is answered even where placement can't reach the tier.
- **Never binds a git worktree.** Its CLI has no `worktree` subcommand or concept of one, so — like
  WezTerm — it falls back to plain git plus a placement-appropriate `open()`.
- **No `--env` flag on `new-pane`/`new-tab`.** Every Zellij open takes the same
  command-prefix-or-warn fallback as WezTerm: env rides in as an `env K=V` prefix on the launch
  command when there is one, or a stderr warning when there isn't.
- **Can name a pane, at birth or after.** `new-pane --name` sets it at birth; `rename-pane` and
  `rename-tab-by-id` rename an already-open space.
- **Reports focused pane for real.** `list-panes --json` carries an `is_focused` field per pane, so
  `isPaneFocused` answers `true`/`false` rather than `unknown`.
- **Cannot size a split.** Zellij's tiled splits are always even; sizing a pane requires a floating
  pane, which cyber-mux does not use. A requested `ratio` is dropped and the caller gets Zellij's own
  even split, the same degrade path as a backend with no `canSizeSplits`.
- **No region introspection yet.** Pane geometry is deliberately not implemented (a follow-up), so
  `template save` refuses on Zellij by naming the backend, the same as WezTerm.

## The common shape

Each multiplexer answers its **own** liveness and focus probes, so a herdr pane id is never queried
with a tmux command or vice versa. Anything a multiplexer cannot determine — a missing pane, an
unreadable focus state — is reported as *unknown*, never a false negative.

## cmux (alpha)

Driven via `cmux` CLI (`new-pane`, `new-surface`, `new-workspace`, `send`, `send-key`, `read-screen`,
`focus-panel`, `close-surface`, `list-panes`, …) against [cmux](https://cmux.com), a Ghostty-based
macOS terminal built for AI coding agents. Built from the cmux docs and CLI reference rather than
empirically — no live cmux GUI was available to verify against — so, like WezTerm and Zellij, its
gaps are real, spec'd limitations rather than forced parity:

- **Has a real workspace tier.** cmux's hierarchy is Window → Workspace → Pane → Surface, where a
  **Surface** is the terminal unit (a tab within a pane). `--at workspace` maps to a new workspace;
  `--at tab` maps to a new surface in the current pane; `--at pane:*` maps to a new pane (a split).
- **Never binds a git worktree.** Its CLI has no `worktree` subcommand or concept of one, so — like
  WezTerm and Zellij — it falls back to plain git plus a placement-appropriate `open()`.
- **No `--env` flag on any space-creating command.** Every cmux open takes the same
  command-prefix-or-warn fallback as WezTerm and Zellij.
- **Can name a pane/surface.** `rename-surface` and `rename-pane` rename an already-open space; no
  birth flag, so naming is always post-birth.
- **Reports focused surface.** `list-panes --json` carries an `is_focused` field per surface, so
  `isPaneFocused` answers `true`/`false` rather than `unknown`.
- **Can size a split.** `new-pane --size` sizes the new pane; `ratio` is inverted (same as tmux).
- **No region introspection.** Pane geometry is not reported by the CLI, so `template save` refuses
  on cmux by naming the backend.
- **macOS only** (cmux is a native Swift/AppKit app).

## otty (alpha)

Driven via `otty` CLI (`pane split`, `pane send-keys`, `pane capture`, `pane focus`, `pane close`,
`tab new`, `open`, `panes`, …) against [otty](https://otty.sh), a native terminal-centric workspace
app built for AI coding agents. Built from the otty docs rather than empirically — no live otty GUI
was available to verify against:

- **Has a real workspace tier.** otty's hierarchy is Windows > Tabs > Splits > Panes. `--at workspace`
  maps to a new window; `--at tab` maps to a new tab; `--at pane:*` maps to a split.
- **Never binds a git worktree.** Its CLI has no `worktree` subcommand, so — like the other GUI-based
  backends — it falls back to plain git plus `open()`.
- **No `--env` flag on any space-creating command.** Every otty open takes the command-prefix-or-warn
  fallback.
- **Can name a pane.** `pane rename` and `tab rename` rename an already-open space.
- **Reports focused pane.** `panes --json` carries an `is_focused` field, so `isPaneFocused` answers
  `true`/`false` rather than `unknown`.
- **Cannot size a split.** Split sizing is not available via the CLI; a requested `ratio` is dropped.
- **Atomic send-keys.** `pane send-keys` can mix literal text and `key:` tokens in one call — cyber-mux
  composes `sendText` and `sendKeys` from this.
- **No region introspection.** Pane geometry is not reported, so `template save` refuses on otty.
- **macOS/Windows desktop app.**

## GNU Screen — detected, not driven

`cyber-mux` **detects** GNU Screen (a `CYBER_MUX=screen` override, or a `screen` ancestor) so it can
say so honestly, but it does **not** drive it: pinning `CYBER_MUX=screen` yields a named error, not a
backend. The blocker is identity, which is load-bearing across the whole contract
(`SessionTarget.id`, `currentPane`, `LivePane.id`). Screen addresses its split **regions**
positionally — there is no per-region id to send to or read from — and `$WINDOW` is left **unset** in
windows opened via `screen -X`, exactly the panes a driver creates, so a pane cannot even identify
*itself*. Every backend above ships a stable per-pane id (tmux `$TMUX_PANE`, rmux `$RMUX_PANE`, herdr
`$HERDR_PANE_ID`, WezTerm `$WEZTERM_PANE`, cmux `$CMUX_SURFACE_ID`, otty `$OTTY_PANE_ID`); screen has no equivalent for
driven panes. Rather than ship a half-faithful adapter whose pane identity is unstable, `cyber-mux`
rejects the value with the reason — an honest "no" beats a backend that silently drives the wrong pane.
