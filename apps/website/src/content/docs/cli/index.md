---
title: CLI Reference
description: The cyber-mux verb surface — conventions shared by every command.
---

Every command runs against the multiplexer the current process is inside (resolved by
[detection](/cyber-mux/concepts/detection/)). Commands that produce data accept `--format
text|json|agent` — human table by default, machine-readable with `--format json` or `--format
agent`. Every failure is a structured error on **stdout** with a stable `code` and an actionable
`help:` line — see [AXI](/cyber-mux/concepts/axi/) for the full output contract, exit codes, and
pane-addressing rules.

**Pane arguments** (`<pane>`) take either a pane **id** or a human **label** — an id is matched
first, and only a locator that matches no id is checked against labels. A label matching more than
one live pane is an ambiguity error (exit 1) naming every candidate; a locator matching nothing is
handed straight to the backend as an id and takes that verb's own not-found path. See
[Pane](/cyber-mux/concepts/pane/) for the full resolution rules and how to discover ids/labels with
[`list`](/cyber-mux/cli/list/).

**Exit codes**, consistent across every verb: `0` success, `1` a well-formed operation that failed
(no pane, no multiplexer, a refused removal), `2` a usage error (missing argument, unknown flag,
conflicting flags) — the fix is a different invocation, not a retry.

## Diagnostics

- [`doctor`](/cyber-mux/cli/doctor/) — probe the multiplexer, self pane, and resolved backend.
- [`mode`](/cyber-mux/cli/mode/) — print just the detected backend name.

## Driving panes

- [`open`](/cyber-mux/cli/open/) — open a new pane/tab/workspace, optionally launching a command.
- [`send`](/cyber-mux/cli/send/) — type text or press keys, without taking the pane's turn.
- [`submit`](/cyber-mux/cli/submit/) — take a pane's turn.
- [`read`](/cyber-mux/cli/read/) — capture a pane's output.
- [`focus`](/cyber-mux/cli/focus/) — beam the attached client to a pane.
- [`close`](/cyber-mux/cli/close/) — close a pane.

## Inspecting panes

- [`list`](/cyber-mux/cli/list/) — enumerate every live pane.
- [`exists`](/cyber-mux/cli/exists/) — probe whether a single pane is still live.

## Worktrees and templates

- [`worktree`](/cyber-mux/cli/worktree/) — `add` / `open` / `list` / `remove` git worktrees.
- [`template`](/cyber-mux/cli/template/) — `list` / `show` / `validate` / `save` named pane pools.
