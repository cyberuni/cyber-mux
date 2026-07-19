---
title: Layouts
description: Named, reusable pane pools — build several panes from one template.
---

A **layout** is a named, reusable template that builds a whole pool of panes in one call, instead of
one [`open`](/cyber-mux/cli/open/) at a time. Apply one with `open --layout <name>` or
`worktree add --layout <name>`, or manage templates directly with `cyber-mux layout`.

## Resolution

A template is looked up by name across, in precedence order:

1. `--file <path>` — an explicit path, skipping name resolution entirely.
2. A repo-local directory.
3. A user directory.

A malformed **name** (not a well-formed lookup key/filename) is a usage error, told apart from a
well-formed name that simply resolves nowhere (a failed lookup). Both are caught, and the template
is fully parsed and validated, **before** anything opens — a typo must never leave a half-built pool
or a stray worktree behind.

## The template shape

A template describes a tree of `split` and `pane` nodes (plus a flat-N shorthand and an `arrange`
sugar that expand to the same tree — `layout show --desugar` prints the canonical form). A pane node
never carries its own `cwd`: every pane in a pool shares the template's resolved target directory,
which is what makes the same template usable against any repo.

## Building a pool

`open --layout <name>` (or `worktree add --layout <name>`) resolves and validates the template
first, then walks it to build the pool — opening a `workspace` by default (a fresh space is empty by
construction), grouping every tab it creates under that workspace via the seam's `group` operation.
`--layout` conflicts with `--launch` and `--env`: the template owns everything in the panes it
declares.

A walk that fails partway reports what it **built** and exits `1` — it never rolls back. Killing
panes is not obviously safer than a half-built layout the caller can see and finish by hand.

## Capturing a pool: `layout save`

`layout save <name> --from <pane> [--workspace]` captures an already-open pool as a reusable
template. `--workspace` widens the capture from the one pane to every pane in its workspace. A
capture is a **draft**: the command each pane is running cannot be recovered from a live pane, so a
saved template's pane nodes carry no `command` — the schema's shape, not this capture path's, is what
makes a pane runnable again.

When a workspace holds more tabs than the capture pulled in, `layout save` surfaces that as a
`help[N]:` note in the structured payload (stdout) — [AXI](/cyber-mux/concepts/axi/)'s contextual
disclosure — rather than silently dropping them.

## See also

- [CLI reference — layout](/cyber-mux/cli/layout/) — the concrete `layout list/show/validate/save` verbs and `--layout` flag.
