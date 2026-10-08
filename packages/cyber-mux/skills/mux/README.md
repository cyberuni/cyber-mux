# mux

Drive terminal multiplexer panes from an agent session through the `cyber-mux` CLI.

## When to use

Run `/cyber-mux:mux <command> [options]`, or `/cyber-mux:mux --help` to list the commands. The agent
also loads it when asked to open, send to, read, or close a pane through cyber-mux.

## What it does

- Resolves `cyber-mux` from `PATH`, then the repository's package manager, then a pinned `npx`.
- Passes the arguments through verbatim; with none, prints the CLI help.
- Reports the result, quoting any error unchanged.

## Install

Ships in the `cyber-mux` plugin. Add this repository as a marketplace, then install `cyber-mux`:

```text
/plugin marketplace add cyberuni/cyber-mux
/plugin install cyber-mux@cyberuni-cyber-mux-local
```
