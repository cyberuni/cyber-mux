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
one live pane is an ambiguity error (exit 2) naming every candidate; a locator matching nothing is
handed straight to the backend as an id and takes that verb's own not-found path. See
[Pane](/cyber-mux/concepts/pane/) for the full resolution rules and how to discover ids/labels with
[`list`](/cyber-mux/cli/list/).

**Exit codes**, consistent across every verb: `0` success, `1` a well-formed operation that failed
(no pane, no multiplexer, a refused removal), `2` a usage error (missing argument, unknown flag,
conflicting flags, a malformed value) — the fix is a different invocation, not a retry. A group run
without a subcommand (`cyber-mux send`) prints its help and exits `2`; `--help` exits `0`.

**Flags and positionals** can come in any order. A flag that takes a value takes exactly one
(`read --lines 5 <pane>`); a repeatable flag (`--env`, `--set`, `--until`) takes every value up to the
next flag, so put positionals before it or repeat the flag (`--env A=1 --env B=2`).

## Mounting the verbs in another CLI

`cyber-mux` also ships as a [clibuilder](https://github.com/clibuilder/clibuilder) plugin, so a CLI
built on clibuilder can offer every verb under `mux` — `<host> mux list` is `cyber-mux list`. Install
`cyber-mux` beside the host and list the plugin in the host's config:

```json
{ "plugins": ["cyber-mux/plugin"] }
```

The verbs, flags, output, and exit codes are the same as the standalone binary's. A usage error
spells its fix through the host (`provide path: <host> mux worktree open <path>`).

## Diagnostics

- [`doctor`](/cyber-mux/cli/doctor/) — probe the multiplexer, self pane, and resolved backend.
- [`mode`](/cyber-mux/cli/mode/) — print just the detected backend name.

## Driving panes

- [`open`](/cyber-mux/cli/open/) — open a new pane/tab/workspace, optionally launching a command.
- [`send`](/cyber-mux/cli/send/) — type text or press keys, without taking the pane's turn.
- [`submit`](/cyber-mux/cli/submit/) — take a pane's turn.
- [`read`](/cyber-mux/cli/read/) — capture a pane's output.
- [`wait`](/cyber-mux/cli/wait/) — block until a pane's output matches, or the timeout elapses.
- [`focus`](/cyber-mux/cli/focus/) — beam the attached client to a pane.
- [`close`](/cyber-mux/cli/close/) — close a pane.

## Inspecting panes

- [`list`](/cyber-mux/cli/list/) — enumerate every live pane.
- [`exists`](/cyber-mux/cli/exists/) — probe whether a single pane is still live.
- [`agent`](/cyber-mux/cli/agent/) — `status` a pane's agent-lifecycle state, or `wait` for it to
  reach one.

## Worktrees and templates

- [`worktree`](/cyber-mux/cli/worktree/) — `add` / `provision` / `open` / `list` / `prune` / `remove`
  git worktrees.
- [`template`](/cyber-mux/cli/template/) — `list` / `show` / `validate` / `save` / `edit` named pane
  pools.
