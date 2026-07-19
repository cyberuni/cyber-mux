---
title: The mux seam
description: The SessionAdapter contract every multiplexer backend implements.
---

The heart of `cyber-mux` is a single interface, `SessionAdapter`. Every multiplexer backend
implements it, and everything else in the tool is expressed in terms of it. It carries **no
host-specific concepts**, so it composes with any caller.

## The contract

| Operation | What it does |
| --- | --- |
| `open` | Create a new pane/tab/workspace, optionally running a command |
| `worktree?` | Bind a git worktree to a workspace — only on a backend that has such a binding |
| `sendText` | Type literal text into a pane, pressing no Enter |
| `sendKeys` | Press named keys in a pane, in order, typing nothing |
| `submit` | Type text (if given) then always press Enter; no text is a bare-Enter flush (never re-types) |
| `read` | Capture a pane's output |
| `focus` | Beam the attached client to a pane — across workspace and tab |
| `teardown` | Close a pane |
| `paneExists` | Whether a single pane is still live |
| `isPaneFocused` | Read-only focus probe (`true` / `false` / `undefined` = unknown) |
| `listPanes` | Enumerate every live pane the backend can see |
| `rename` | Name a space after its birth — the route for the one tier no backend can name at birth (herdr's new-workspace root tab) |
| `group` | Tag an already-open space with an opaque group id, on a backend with no tier to group in (`open`'s own `workspaceGroup` option routes through this) |
| `canSizeSplits` | Whether this backend can size a `pane:*` split at all, so a caller can degrade a `ratio` instead of failing |
| `describeRegion` | The caller's own pane/tab/workspace, read back (used to resolve `--from`) |
| `describeWorkspace` | Every pane in a given workspace — the walk [layouts](/cyber-mux/concepts/layouts/) use to capture a pool |

## Placement and naming

`open` takes a placement relative to the caller:

- `pane:right` / `pane:down` — split the current pane.
- `tab` — a new tab/window in the current space (the default).
- `workspace` — the backend's own **visible** space: herdr `workspace create`, tmux a new
  **Window**. It is deliberately **not** a detached tmux session (`new-session -d`) — a detached
  session is invisible to the attached client and unreachable by `focus`, so a pane is never
  opened there.

...and an optional `label` for whatever it opens, at whatever tier it opens it. That is host-neutral
because every backend names every tier: on herdr a workspace, tab, or pane label; on tmux a window
name (`workspace` and `tab` both collapse to a Window there) or a pane title. An adapter passes it in
the opening call where its CLI allows and names the space immediately after where it does not.

## `SessionOpenOptions`

Beyond placement and `label`, `open` takes:

- `from` — the pane to split (`pane:*` only); omitted, each backend defaults to whatever pane the
  *user* is looking at, not necessarily the calling pane.
- `ratio` — the fraction kept by the **original** pane. The two backends convert in opposite
  directions: herdr's own `--ratio` passes through unconverted, tmux's `-l` sizes the **new** pane
  so it takes `1 - ratio`. Split-only; ignored by `tab`/`workspace`.
- `env` — a map of variables set natively at the birth of whatever tier opens, on every
  space-creating command, not just a split. herdr's worktree-bind route is the one exception: it
  takes no env parameter, reports that back to its caller, and the caller compensates (a
  `--launch` command-line prefix, or a stderr warning when there is nothing to prefix onto).
- `workspaceGroup` — an opaque group id for a backend with no tier to group spaces in (tmux stores
  it in a window option); a backend with a real workspace tier ignores it, its tier already being
  the group.

## The `worktree` capability

The one optional member. A backend implements it when it binds a git worktree to a workspace as a
**first-class record** — the binding a multiplexer's UI groups a repo's checkouts by. herdr has one;
tmux, with no workspace tier at all, leaves it `undefined`.

| Member | What it does |
| --- | --- |
| `createInWorkspace` | Create a worktree *and* open its bound workspace, in one call |
| `openInWorkspace` | Open an existing worktree in a workspace bound to it |
| `bindings` | Which workspace each worktree is open in, by path |
| `releaseWorkspace` | Close the workspace, leaving the checkout on disk |

The binding — not "understands git worktrees" — is what a backend either has or lacks, which is why
these ship as one object rather than four optional methods. Two things it deliberately does **not**
own:

- **The worktree facts.** Path, branch, linked, and prunable are git's, read from git on every
  backend. A multiplexer that also enumerates worktrees is only re-reading git; letting it answer
  would let two backends disagree about the same worktree's branch. A backend contributes
  `bindings` alone — the one fact git cannot know.
- **Removal.** A backend's own worktree-removal primitive addresses a workspace, so it cannot reach
  an unbound worktree. Removal is always `cyber-mux`'s gates plus `git worktree remove`; a backend
  is asked only to release its binding.

## The `Exec` seam

Every operation takes an `Exec` — a synchronous `(cmd, args) => string | null` command runner.
Injecting it keeps the adapters pure and lets tests drive them with a fake, so the whole suite runs
without a real multiplexer installed.
