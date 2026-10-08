---
name: mux
description: "Drive terminal multiplexer panes with the cyber-mux CLI: /mux <command>, /mux --help, or a request to open, send to, read, or close a pane."
argument-hint: "<doctor|mode|open|send|submit|read|wait|focus|close|list|exists|worktree|template|agent> [args] [options] | <command> --help | --help"
compatibility: Requires Node.js 22+ and a POSIX shell.
---

# mux

Pass the invocation through to the `cyber-mux` CLI and report the result.

## When to use

- The user invokes `/mux` (`/cyber-mux:mux`), with or without arguments.
- The user asks to detect the multiplexer, or to open, send to, read, wait on, focus, list, or close a
  pane, nudge a peer pane, or open a git worktree in a new pane, through cyber-mux.

Out of scope: editing cyber-mux source, configuring a multiplexer, and driving a multiplexer with its
own CLI (`tmux`, `herdr`, …) instead of cyber-mux.

## Workflow

1. **Read the arguments.** Claude Code appends them as `ARGUMENTS: <value>`; other runtimes pass the
   text after the skill name. No text means no arguments.
2. **Resolve the CLI once.** Use the first command that succeeds for every later call:

   ```bash
   if command -v cyber-mux >/dev/null 2>&1 && cyber-mux --version >/dev/null 2>&1; then
     CMD="cyber-mux"
   elif [ -f pnpm-lock.yaml ] && pnpm exec cyber-mux --version >/dev/null 2>&1; then
     CMD="pnpm exec cyber-mux"
   elif [ -f yarn.lock ] && yarn exec cyber-mux --version >/dev/null 2>&1; then
     CMD="yarn exec cyber-mux"
   elif { [ -f bun.lock ] || [ -f bun.lockb ]; } && bunx cyber-mux --version >/dev/null 2>&1; then
     CMD="bunx cyber-mux"
   else
     CMD="npx --yes cyber-mux@0.9.1"
   fi
   ```

3. **Choose the command.**

   | Arguments | Run |
   | --- | --- |
   | none, `--help`, or `-h` | `$CMD --help` |
   | `<command> --help` or `<command> -h` | `$CMD <command> --help` |
   | a request in words, not CLI arguments | `$CMD --help`, then `$CMD <command> --help`, then build the call from the flags it lists |
   | anything else | `$CMD <arguments>` |

4. **Run it** with the arguments verbatim, in the user's quoting. When the command's `--help` lists
   `--format` and the user gave none, add `--format agent`.
5. **Report.**
   - Help: show the text as printed.
   - Success: summarize the output (the `--format agent` form when added) in one or two lines; name
     any pane id it returned.
   - Failure: quote the error verbatim with the exit code. Do not retry with altered flags unless
     the error names the fix.

## Anti-patterns

- Inventing a command or flag that `--help` does not list.
- Calling `tmux`, `herdr`, or another multiplexer CLI directly in place of cyber-mux.
- Treating the `screen` backend error as a failure to fix: GNU Screen is detected but not drivable.

## Validate

- Every command run starts with the resolved `$CMD`; none calls a multiplexer binary directly.
- Every flag in a run command appears in `$CMD --help` or `$CMD <command> --help` output.
- With no arguments, `--help`, or `-h`, the only command run is `$CMD --help`.
- A failed run's report contains the CLI's error text unchanged.

## References

- cyber-mux docs: <https://cyberuni.github.io/cyber-mux/>
