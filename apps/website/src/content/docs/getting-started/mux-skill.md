---
title: The mux skill
description: Drive multiplexer panes from a coding agent with the /mux skill — invocation, argument forms, commands, CLI resolution, output, and examples.
---

The `mux` skill is the one skill in the [cyber-mux agent plugin](/cyber-mux/getting-started/agent-plugin/).
It passes what you type to the `cyber-mux` CLI, runs it, and reports the result. The skill adds
nothing of its own: every command and flag it uses comes from the CLI's `--help`.

## Invoke the skill

In Claude Code, plugin skills are namespaced by plugin, so the skill is `/cyber-mux:mux`:

```text
/cyber-mux:mux <command> [args] [options]
```

Cursor, Codex, and GitHub Copilot CLI load the same skill under the name `mux`. Call it the way that
runtime calls skills, or ask in plain words. The agent loads the skill when your request is about
opening, sending to, reading, waiting on, focusing, listing, or closing a pane, detecting the
multiplexer, nudging a peer pane, or opening a git worktree in a new pane.

The skill needs Node.js 22 or later and a POSIX shell.

## Argument forms

The skill reads its arguments as one of four forms:

| You pass | The skill runs |
| --- | --- |
| nothing, `--help`, or `-h` | `cyber-mux --help` |
| `<command> --help` or `<command> -h` | `cyber-mux <command> --help` |
| `<command> [args] [options]` | `cyber-mux <command> [args] [options]`, verbatim and in your quoting |
| a request in plain words | `cyber-mux --help`, then `cyber-mux <command> --help`, then the call built from the flags that help lists |

With no arguments or `--help`, the CLI help is the only command the skill runs.

## Commands

Each row lists the command's key arguments and flags as its `--help` prints them. Most commands also
accept `--format`. A `<pane>` argument takes a pane id or a label; see
[Pane](/cyber-mux/concepts/pane/).

| Command | What it does | Key arguments and flags |
| --- | --- | --- |
| [`doctor`](/cyber-mux/cli/doctor/) | Probe the multiplexer, self pane, and backend; print the fast-path pins | — |
| [`mode`](/cyber-mux/cli/mode/) | Report the detected drivable backend | — |
| [`open`](/cyber-mux/cli/open/) | Open a new pane, tab, or workspace, optionally running a command in it | `--at`, `--launch`, `--template`, `--cwd`, `--env`, `--label` |
| [`send`](/cyber-mux/cli/send/) | Drive a pane without taking its turn: `send text` types text with no Enter, `send keys` presses named keys | `text <pane> <text>`, `keys <pane> <keys...>` |
| [`submit`](/cyber-mux/cli/submit/) | Take a pane's turn: type the text if given, then press Enter | `<pane> [text]` |
| [`read`](/cyber-mux/cli/read/) | Capture a pane's output | `<pane>`, `--lines` or `--full` |
| [`wait`](/cyber-mux/cli/wait/) | Block until a pane's output matches or the timeout elapses | `<pane>`, `--match` or `--regex`, `--timeout`, `--lines` |
| [`focus`](/cyber-mux/cli/focus/) | Move the attached client to a pane | `<pane>` |
| [`close`](/cyber-mux/cli/close/) | Close a pane | `<pane>` |
| [`list`](/cyber-mux/cli/list/) | List every live pane the backend can see | — |
| [`exists`](/cyber-mux/cli/exists/) | Check whether a pane is still live (exit 0 live, 1 gone) | `<pane>` |
| [`worktree`](/cyber-mux/cli/worktree/) | Git worktree helpers: `add`, `provision`, `open`, `list`, `remove`, `prune` | `add --branch [--at]`, `open <path>`, `remove <path> [--force]`, `prune [--force]` |
| [`template`](/cyber-mux/cli/template/) | Manage named templates: `list`, `show`, `validate`, `save`, `edit` | `show <name>`, `save <name> [--from]`, `edit <name> [--set]` |
| [`agent`](/cyber-mux/cli/agent/) | Inspect and wait on a pane's agent-lifecycle state: `status`, `wait` | `status <pane>`, `wait <pane> [--until] [--timeout]` |

The [CLI Reference](/cyber-mux/cli/) documents every flag.

## How the skill finds the CLI

You do not need to install the CLI first. The skill resolves the command once per invocation and
uses it for every call, taking the first that works:

1. `cyber-mux` on your `PATH`.
2. The repository's package manager, when its lockfile is present and the package is installed:
   `pnpm exec cyber-mux`, `yarn exec cyber-mux`, or `bunx cyber-mux`.
3. `npx --yes cyber-mux@<version>`, pinned to the plugin's version.

## Output

- **Help** is shown as the CLI prints it.
- **Success** is summarized in a line or two, naming any pane id the command returned. When the
  command's help lists `--format` and you gave none, the skill adds `--format agent`, the compact
  [AXI](/cyber-mux/concepts/axi/) output for agents.
- **Failure** is quoted verbatim, with the exit code. The skill does not retry with different flags
  unless the error names the fix.

The skill only runs `cyber-mux`. It never calls `tmux`, `herdr`, or another multiplexer's own CLI.
Inside GNU Screen, commands that drive a pane fail with a named `screen` error: Screen is detected
but cannot be driven, so the skill reports the error rather than trying to fix it. See
[Multiplexers](/cyber-mux/multiplexers/).

## Examples

### Detect the multiplexer

```text
/cyber-mux:mux mode
```

The skill runs `cyber-mux mode --format agent` and reports the backend, such as `tmux` or `herdr`.

### Open a pane and read it

Open a pane to the right that runs the test watcher, then read its last 20 lines:

```text
/cyber-mux:mux open --at pane:right --label tests --launch "pnpm test --watch"
/cyber-mux:mux read tests --lines 20
```

### Send to a peer pane

Type a message into a pane and press Enter, then press `C-c` in another pane to stop what it runs:

```text
/cyber-mux:mux submit reviewer "the tests pass, please review"
/cyber-mux:mux send keys tests C-c
```

`submit` takes the pane's turn. `send text` and `send keys` drive the pane without pressing Enter for
it.

### Open a worktree in a new pane

Create a worktree on a new branch and open it in a workspace that runs your agent:

```text
/cyber-mux:mux worktree add --branch feat/login --at workspace --launch claude
```

### Ask in plain words

```text
open a pane below and tail the server log
```

The agent loads the skill, reads `cyber-mux --help` and `cyber-mux open --help`, and runs
`cyber-mux open --at pane:down --launch "tail -f server.log" --format agent`.
