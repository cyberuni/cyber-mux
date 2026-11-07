---
title: AXI — the agent output contract
description: The shared output contract every cyber-mux command follows.
---

`cyber-mux` is driven almost entirely by AI agents orchestrating panes, so every command follows one
shared output contract — [AXI](https://github.com/kunchenguid/axi) (Agent Experience Interface) — that
treats an agent's token budget as a first-class constraint.

## Output formats

`--format` takes `text` (the default, a human table), `json`, or `agent` (`toon` also works). The
CLI runs on [clibuilder](https://clibuilder.github.io/clibuilder/)'s `axi` output: a command returns
its answer and clibuilder prints it, so the two machine forms are clibuilder's own encoders. `json` is
compact JSON for a pipe into `jq`, and `agent` is [TOON](https://github.com/toon-format/toon), the same
payload in fewer tokens. `text` is cyber-mux's own aligned fields and tables.

## Exit codes

- **`0`** — success, including a no-op.
- **`1`** — the invocation was fine; the operation failed.
- **`2`** — usage error: an unrecognized flag, a missing required argument, incomplete input (a bare
  `cyber-mux send`), or an ambiguous pane locator. clibuilder reports the top-ranked one under its own
  code (`unknown-option`, `missing-argument`, `conflicting-options`, `invalid-value`,
  `missing-command`). An unknown flag names both the flag and the options of the **subcommand** asked,
  not the group.

One exception: **`exists`** is a predicate, not an error report — it spends `1` on `gone` the same
way `grep`/POSIX `test`/`systemctl is-active` do, so it keeps answering `live`/`gone` on stdout rather
than inventing a fourth code.

## Structured errors, on stdout

Every failure is reported on **stdout** — the stream AXI reserves for everything an agent consumes —
under a stable `code`, with an actionable `help` line naming the `cyber-mux` command that fixes it
(never a wrapped multiplexer's raw diagnostic, never "see `--help`"). `--format` is honored on error
output the same as on success. The error is one flat object: `error` (the message), `code`, any
detail fields, then `help`:

```
$ cyber-mux close worker --format agent
error: "\"worker\" matches 2 panes — an id resolves it"
code: ambiguous-pane
locator: worker
candidates[2]: %1,%2
labels[2]: worker,worker
cwds[2]: /repo/a,/repo/b
help[1]: "retry with one of the ids: %1 %2"
```

**stderr** carries diagnostics only — warnings, progress, debug — nothing on it is ever load-bearing;
discarding it entirely loses no part of the answer. An error landing on stdout never corrupts a
result: a command either succeeds and writes its payload, or fails and writes its error — never both
— so a caller branches on the exit code before parsing.

## Contextual disclosure — `help` lines

A command that leaves an obvious next move names it as a `help` line inside its stdout answer, a
string that ends with the command to run — never a bare "see `--help`", and omitted when the output is
already self-contained (a detail view, a count, a confirmation). `worktree add`/`open` names the flag
that would have grouped what it just placed, `template save` reveals when a workspace held more tabs
than were captured, `read` names `--full` after a truncated capture, and `worktree prune` names
`--force` after a preview.

## Ambiguous pane addressing

Every verb that takes a pane (`read`, `submit`, `exists`, `focus`, `close`, `send text`, `send keys`,
`template save --from`) accepts either an **id** or a **label**. An id outranks a label and is
recognized by matching a live pane — never by the shape of the string. Two or more label matches fail
as a structured `ambiguous-pane` error (exit `2`) listing each candidate's id, label, and cwd, as the
index-aligned `candidates`, `labels`, and `cwds` lists — each id directly usable as the retry. Zero matches is the ordinary not-found path (exit `1`), not an
ambiguity.

## What's still catching up

TOON as the *default* output format (it ships today behind `--format agent`), `--fields`, and
truncation with a size hint on `--full` are contract principles this bin has not yet built against.
The structured error surface (stdout, exit codes, `help`), the `help` suggestion sites, the
no-argument home view, and translated backend-failure text are shipped.

## See also

- [CLI reference](/cyber-mux/cli/) — the concrete verbs this contract governs.
