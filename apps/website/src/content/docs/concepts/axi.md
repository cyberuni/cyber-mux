---
title: AXI — the agent output contract
description: The shared output contract every cyber-mux command follows.
---

`cyber-mux` is driven almost entirely by AI agents orchestrating panes, so every command follows one
shared output contract — [AXI](https://github.com/kunchenguid/axi) (Agent Experience Interface) — that
treats an agent's token budget as a first-class constraint.

## Exit codes

- **`0`** — success, including a no-op.
- **`1`** — the invocation was fine; the operation failed.
- **`2`** — usage error: an unrecognized flag, a missing required argument, incomplete input (a bare
  `cyber-mux send`), or an ambiguous pane locator. An unknown flag names both the flag and the valid
  set for the **subcommand** asked, not the group.

One exception: **`exists`** is a predicate, not an error report — it spends `1` on `gone` the same
way `grep`/POSIX `test`/`systemctl is-active` do, so it keeps answering `live`/`gone` on stdout rather
than inventing a fourth code.

## Structured errors, on stdout

Every failure is reported on **stdout** — the stream AXI reserves for everything an agent consumes —
under a stable `code`, with an actionable `help:` line naming the `cyber-mux` command that fixes it
(never a wrapped multiplexer's raw diagnostic, never "see `--help`"). `--format` is honored on error
output the same as on success.

**stderr** carries diagnostics only — warnings, progress, debug — nothing on it is ever load-bearing;
discarding it entirely loses no part of the answer. An error landing on stdout never corrupts a
result: a command either succeeds and writes its payload, or fails and writes its error — never both
— so a caller branches on the exit code before parsing.

## Contextual disclosure — `help[N]:` blocks

A command that leaves an obvious next move names it as a `help[N]:` block inside its stdout payload
— never a bare "see `--help`", and omitted when the output is already self-contained (a detail view,
a count, a confirmation). Two ship today: `worktree add`/`open` names the flag that would have
grouped what it just placed, and `layout save` reveals when a workspace held more tabs than were
captured.

## Ambiguous pane addressing

Every verb that takes a pane (`read`, `submit`, `exists`, `focus`, `close`, `send text`, `send keys`,
`layout save --from`) accepts either an **id** or a **label**. An id outranks a label and is
recognized by matching a live pane — never by the shape of the string. Two or more label matches fail
as a structured `ambiguous-pane` error (exit `2`) listing each candidate's id, label, and cwd — each
id directly usable as the retry. Zero matches is the ordinary not-found path (exit `1`), not an
ambiguity.

## What's still catching up

TOON as the default output format, `--fields`, truncation with a size hint on `--full`, and the
no-argument home view are contract principles this bin has not yet built against. The structured
error surface (stdout, exit codes, `help:`), the two `help[N]:` suggestion sites, and translated
backend-failure text are shipped.

## See also

- [CLI reference](/cyber-mux/cli/commands/) — the concrete verbs this contract governs.
