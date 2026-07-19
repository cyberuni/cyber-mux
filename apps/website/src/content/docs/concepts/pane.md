---
title: Pane
description: What a pane is, and how a <pane> argument is resolved — id first, then label.
---

A **pane** is the one addressable unit every pane-driving command targets: a single terminal
region a backend can send text to, read output from, or close. Every multiplexer surfaces this
concept, however it names its own layers above it (tmux windows, herdr tabs and workspaces, WezTerm
tabs and workspaces) — a `<pane>` argument always names a leaf pane, never one of those containers.

Discover the panes you can address with [`list`](/cyber-mux/cli/list/), which prints each pane's
`id`, `label`, `harness`, and `cwd`.

## Id vs label

A `<pane>` argument accepts either form, resolved by one rule: **id first, then label.**

1. **Id.** Every pane has a backend-assigned id (tmux `%3`, herdr's own pane id, …). If the locator
   matches a live pane's id, that pane wins — before labels are even considered.
2. **Label.** A pane may also carry a human-assigned label (set with `--label` on
   [`open`](/cyber-mux/cli/open/) or `worktree add`/`worktree open`). If the locator matches no id, it
   is checked against every pane's label instead.

An id can never be made to mean something else by a person renaming an unrelated pane, so anything
addressed by id keeps working no matter what anyone labels later — which is why id is checked first
and a label is only a fallback, never a peer.

**A locator is recognized by existence, not by shape.** Whether a string "looks like" an id is never
asked; only whether a live pane actually carries it as an id, then whether one carries it as a
label. This also means a label that happens to look like an id still resolves correctly, and an id
of a pane that has gone away is never mistaken for a label.

## Ambiguity and not-found

- **Two or more live panes share a label** the locator matches: this is reported as an ambiguity
  error (exit 1) naming every candidate pane (id, label, cwd) so you can pick the right one — cyber-mux
  never guesses (not "most recent", not "focused").
- **The locator matches neither an id nor a label:** it is handed to the backend as-is and takes
  that command's own not-found path (typically `pane-not-found`, exit 1) — the same outcome as
  passing a stale id.

## Which commands take `<pane>`

[`send`](/cyber-mux/cli/send/), [`submit`](/cyber-mux/cli/submit/), [`read`](/cyber-mux/cli/read/),
[`focus`](/cyber-mux/cli/focus/), [`close`](/cyber-mux/cli/close/), and
[`exists`](/cyber-mux/cli/exists/) all take a single `<pane>` argument resolved this way.
[`template save --from <pane>`](/cyber-mux/cli/template/) resolves its `--from` flag identically, and
defaults to the calling process's own pane when omitted.
