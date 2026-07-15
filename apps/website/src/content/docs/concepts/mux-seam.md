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
| `open` | Create a new pane/tab/workspace running a command |
| `worktree?` | Bind a git worktree to a workspace — only on a backend that has such a binding |
| `send` | Type text into a pane and submit it |
| `submit` | Flush an already-staged buffer with a bare Enter (never re-types) |
| `read` | Capture a pane's output |
| `focus` | Beam the attached client to a pane — across workspace and tab |
| `teardown` | Close a pane |
| `paneExists` | Whether a single pane is still live |
| `isPaneFocused` | Read-only focus probe (`true` / `false` / `undefined` = unknown) |
| `listPanes` | Enumerate every live pane the backend can see |

## Placement

`open` takes a placement relative to the caller:

- `pane:right` / `pane:down` — split the current pane.
- `tab` — a new tab/window in the current space (the default).
- `workspace` — a genuinely separate workspace/session; the caller's current space is left
  untouched.

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
