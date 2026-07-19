---
title: Worktrees
description: Git worktrees, and the workspace binding a multiplexer may give one.
---

`cyber-mux` manages **git worktrees**, and — on a backend whose UI groups a repo's checkouts by a
first-class binding — grouping one with its repo as a **workspace**.

## The checkout is always plain git

`worktree add` is host-neutral, no-multiplexer-required git: it defaults the checkout path to
`<parent>/<repo>.worktrees/<branch>`, a sibling of the primary checkout, on **every** backend, so a
path means the same thing everywhere. `--path` overrides it; `--base` sets the new branch's
start-point. `worktree remove` refuses the primary checkout (absolute — `--force` never overrides
it), tolerates a checkout already gone from disk, and refuses to discard uncommitted changes unless
`--force`.

## The binding is a separate, optional fact

A backend either binds a worktree to a workspace as a first-class record, or it doesn't — that
binding, not "knows what a worktree is", is the capability in question. herdr has one; tmux, with no
workspace tier at all, never binds; WezTerm, despite having a real Workspace tier, never binds either
— its CLI has no `worktree` subcommand or concept of one.

**git owns the worktree facts; a backend contributes only the binding.** `worktree list` reads path,
branch, linked, and prunable from git on every backend, so backends can never disagree about the same
worktree — only the `workspace` column comes from the multiplexer, and it reads blank outside herdr
entirely.

## `worktree add` — plain git until a placement is asked for

With **none** of `--at`, `--launch`, or `--env`, `add` creates the checkout and opens nothing —
nothing was opened, so nothing is grouped. `--launch` and `--env` each imply `--at workspace`: asking
for something *in* a pane is asking for the pane, and `workspace` is the only placement a binding can
attach to. A pane/tab placement still succeeds on a binding-capable backend, it just can't be
grouped — a **complete outcome, not a failure**, reported as `workspace: null` on stdout plus a
`help[N]:` note naming `--at workspace` as the fix.

## `worktree open` — group a checkout plain git already made

The remedy for a bare `add`: opens an **existing** worktree, grouping it with its repo where the
backend can bind. "Add now, group later" is a first-class story, not a dead end.

## Removal ordering

Removal is never delegated to a backend — only the binding's **release** is; a backend's own
worktree-removal primitive addresses a workspace, so it cannot reach an unbound worktree at all. The
gates (primary-checkout refusal, uncommitted-changes refusal) run **before** the workspace is
released, so a refused removal has no side effect; the release runs **before** git removes the
checkout, so no workspace is ever left pointing at a directory that no longer exists.

## See also

- [CLI reference — worktree](/cyber-mux/cli/worktree/) — the concrete `worktree add/open/list/remove` verbs.
- [Multiplexers](/cyber-mux/multiplexers/) — how herdr's binding and tmux's absence of one are each handled.
