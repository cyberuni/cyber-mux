---
name: mux
description: Run the cyber-mux CLI to drive terminal multiplexer panes (tmux, herdr, wezterm, and others) — detect the multiplexer, open, send to, read, focus, and close panes, nudge a peer, or open a git worktree. Use when the user invokes /mux or asks to control a pane through cyber-mux.
argument-hint: "<command> [options] | --help"
---

# mux

Pass the invocation through to the `cyber-mux` CLI and report what it printed.

## Read the arguments

Take the arguments from the invocation. Claude Code appends them as `ARGUMENTS: <value>`; other
runtimes pass them as the text after the skill name.

## Run

| Arguments | Run |
| --- | --- |
| none, `--help`, or `-h` | `npx -y cyber-mux --help` |
| `<command> --help` or `<command> -h` | `npx -y cyber-mux <command> --help` |
| anything else | `npx -y cyber-mux <arguments>` |

Pass the arguments verbatim, quoted as the user wrote them. Do not invent flags or commands; if
the user's intent is unclear, run `npx -y cyber-mux --help` and pick from what it lists.

Commands: `doctor`, `mode`, `open`, `send`, `submit`, `read`, `wait`, `focus`, `close`, `list`,
`exists`, `worktree`, `template`, `agent`. Add `--format json` when you need to parse the output.

## Report

- For `--help`, show the help text as printed.
- Otherwise, summarize the result in a line or two, and quote any error verbatim.
- A `screen` backend error is expected: GNU Screen is detected but not drivable.
