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
| `openInNewWorktree?` | Atomically create a git worktree *and* open it (backends with a native primitive only) |
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

## The `Exec` seam

Every operation takes an `Exec` — a synchronous `(cmd, args) => string | null` command runner.
Injecting it keeps the adapters pure and lets tests drive them with a fake, so the whole suite runs
without a real multiplexer installed.
