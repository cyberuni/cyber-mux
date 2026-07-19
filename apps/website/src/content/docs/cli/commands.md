---
title: Commands
description: The cyber-mux verb surface.
---

Every command runs against the multiplexer the current process is inside (resolved by
[detection](/cyber-mux/concepts/detection/)). Commands that produce data accept `--format
text|json|agent`. Every failure is a structured error on **stdout** with a stable `code` and an
actionable `help:` line — see [AXI](/cyber-mux/concepts/axi/) for the full output contract, exit
codes, and pane-addressing rules.

## Diagnostics

### `cyber-mux doctor`

Probe the multiplexer, your self pane, and the resolved backend; print a `CYBER_MUX` /
`CYBER_MUX_PANE` fast-path pin.

### `cyber-mux mode`

Print just the detected backend name: `tmux`, `herdr`, or `none`.

## Driving panes

### `cyber-mux open [--launch <cmd>] [--layout <name>] [--cwd <path>] [--at <placement>] [--env <KEY=VALUE>...] [--label <name>]`

Open a new pane and launch a command in it. `--at` is one of `pane:right`, `pane:down`, `tab`
(default), or `workspace`. `--env KEY=VALUE` is repeatable and sets the variable natively at the
pane's birth. `--layout <name>` builds a whole named pool in the opened space instead of a single
pane — see [Layouts](/cyber-mux/concepts/layouts/); it conflicts with both `--launch` and `--env`
(a template owns everything in the panes it declares). Prints the new pane id.

`--label` names whatever `--at` opened, at whatever tier it opened it — every backend names every
tier, so one flag works on both:

| `--at` | herdr | tmux |
| --- | --- | --- |
| `workspace` | workspace label | window name |
| `tab` | tab label | window name (`workspace` and `tab` are both a Window here) |
| `pane:right` / `pane:down` | pane label | pane title |

Omit it and each backend keeps its own default.

### `cyber-mux send text <pane> <text>`

Type literal text into a pane, pressing no Enter — a word that happens to name a key (`Enter`,
`Up`) is typed as characters, never interpreted as that key.

### `cyber-mux send keys <pane> <keys...>`

Press named keys in a pane, in order, typing nothing. Portable core vocabulary: `Up Down Left Right
Enter Escape Tab Space Backspace C-c F1`–`F12`; anything outside the core is forwarded verbatim to
the backend. `send keys <pane> Enter` does press Enter and does take the pane's turn — because the
caller asked for it.

Bare `cyber-mux send` (no `text`/`keys` subcommand) is incomplete input: help on stdout, exit `2`.

### `cyber-mux submit <pane> [text]`

Take a pane's turn: given `text`, types it literally then always presses Enter. Given no text (or
empty text), sends a bare Enter only — flushing an already-staged buffer without re-typing it, so a
repeated flush cannot duplicate the message. `open --launch` uses this verb internally.

### `cyber-mux read <pane> [--lines <n>]`

Capture a pane's output, optionally scoped to the last `n` lines.

### `cyber-mux focus <pane>`

Beam the attached client to a pane, across workspace and tab.

### `cyber-mux close <pane>`

Close a pane.

## Inspecting panes

### `cyber-mux list`

Enumerate every live pane the current backend can see.

### `cyber-mux exists <pane>`

Probe whether a single pane is still live. Exits `0` when live, `1` when gone.

## Worktrees

A multiplexer may bind a git worktree to a workspace as a first-class record — the binding its UI
groups a repo's checkouts by. herdr does; tmux has no workspace tier and does not. These verbs route
through that binding where it exists and fall back to plain git plus a normal `open` where it does
not, so the same command works on both. See [adapters](/cyber-mux/concepts/adapters/).

### `cyber-mux worktree add --branch <branch> [--path <path>] [--base <ref>] [--launch <cmd>] [--layout <name>] [--at <placement>] [--env <KEY=VALUE>...] [--label <name>]`

Create a git worktree, and open it when given a placement.

With **none of `--at`, `--launch`, or `--env`** this is plain git: it creates the checkout, opens
nothing, and needs no multiplexer. Nothing was opened, so nothing is grouped — use `worktree open`
to group it later.

With a placement, it opens too. `--launch` and `--env` each imply `--at workspace`, the only
placement a backend can bind a worktree to (asking for something *in* a pane is asking for the
pane):

```bash
# Grouped with the repo on herdr; a working, ungrouped worktree on tmux.
cyber-mux worktree add --branch feat/x --at workspace --launch "claude"
```

`--path` defaults to `<parent>/<repo>.worktrees/<branch>` — a sibling of the primary checkout, never
nested inside it — on **every** backend, so a path means the same thing everywhere. `--base` sets the
new branch's start-point.

`--label` names the opened workspace (see [`open`](#cyber-mux-open---launch-cmd---cwd-path---at-placement---label-name)).
Worth knowing what you get without it: because `worktree add` always passes `--path`, herdr labels
the workspace after the checkout path's **basename** — it would use the branch only if it chose the
location itself. So `--branch feat/deep/name` gives you a workspace named `name` unless you pass
`--label`.

Prints `root`, `branch`, `pane`, and `workspace`. A `workspace` of `null` means the worktree opened
**ungrouped** — either the backend binds nothing (tmux), or the placement could not carry a binding
(herdr's native call always makes a workspace, so a pane or tab placement falls back to plain git).
That is a complete outcome, not a failure: it succeeds, and — where a placement could have grouped
but didn't — names `--at workspace` as the fix in a `help[N]:` block on **stdout**, inside the
structured payload (not stderr).

`--env` on herdr's worktree-bind route is the one route that cannot carry env natively: it degrades
to an `env KEY=VALUE` prefix on `--launch`'s command line, or a stderr warning when there is no
command to ride.

### `cyber-mux worktree open <path> [--launch <cmd>] [--layout <name>] [--at <placement>] [--env <KEY=VALUE>...] [--label <name>]`

Open an existing worktree, grouping it with its repo where the backend can bind. This is the remedy
for a checkout made by a bare `worktree add` — add now, group later.

### `cyber-mux worktree list`

Every worktree of the repo, and the workspace each is currently open in.

Path, branch, linked, and prunable always come from **git**, on every backend — only the workspace
binding comes from the multiplexer, so backends can never disagree about a worktree. Works outside a
multiplexer, where every `workspace` is simply blank.

### `cyber-mux worktree remove <path> [--force]`

Remove a worktree, releasing its workspace if one is bound.

The gates are identical on every backend: it refuses the primary checkout (absolute — `--force` never
overrides it), tolerates a checkout already gone from disk, and refuses to discard uncommitted
changes unless `--force`. A refused removal has no side effect: the workspace stays open. When the
gates pass, the workspace is closed *before* git removes the checkout, so none is ever left pointing
at a directory that no longer exists.

## Layout

Named, reusable pane pools — build several panes at once from a template instead of one `open` at a
time. See [Layouts](/cyber-mux/concepts/layouts/) for the template schema and resolution rules.

### `cyber-mux layout list`

Every layout template resolvable from here, with its source and pane count.

### `cyber-mux layout show [<name>] [--file <path>] [--desugar]`

Print a resolved template as JSON. `--file <path>` reads that path directly, skipping name
resolution. `--desugar` prints the canonical `panes`/`arrange` tree exactly as `apply` builds it —
useful for seeing what a flat-N shorthand expands to.

### `cyber-mux layout validate [<name>] [--file <path>]`

Check a template's schema without opening anything.

### `cyber-mux layout save <name> --from <pane> [--workspace] [--description <text>] [--to <path>] [--force]`

Capture an already-open pane pool as a reusable template. `--workspace` captures every pane in the
`--from` pane's workspace, not just the one pane. `--force` overwrites an existing template of the
same name. A workspace holding more tabs than were captured surfaces a `help[N]:` note on stdout
naming what was left out.

### `--layout <name>` on `open` / `worktree add` / `worktree open`

Build a whole named pool in the newly opened space instead of a single pane or bare checkout.
Resolved and validated **before** anything opens, so a typo in the name or an invalid template
leaves nothing behind. Conflicts with `--launch` and `--env` — the template owns everything in the
panes it declares.
