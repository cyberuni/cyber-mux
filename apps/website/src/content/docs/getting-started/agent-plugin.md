---
title: Agent plugin
description: Install the cyber-mux agent plugin and drive panes with its mux skill from Claude Code, Cursor, Codex, or GitHub Copilot CLI.
---

`cyber-mux` also ships as an **agent plugin**. The plugin carries one skill, `mux`, that lets a coding
agent drive multiplexer panes through the `cyber-mux` CLI: you type a command in the agent session,
and the agent runs it and reports the result.

The plugin follows the [Agent Plugins Specification](https://agent-plugins.org). One manifest,
`packages/cyber-mux/plugin.json`, generates the vendor manifests, so the same skill loads in every
supported runtime:

| Runtime | Manifest |
| --- | --- |
| Claude Code | `.claude-plugin/plugin.json` |
| Cursor | `.cursor-plugin/plugin.json` |
| Codex | `.codex-plugin/plugin.json` |
| GitHub Copilot CLI | `plugin.json` |

The plugin files also ship inside the [`cyber-mux` npm package](https://www.npmjs.com/package/cyber-mux).
For the current version, see npm or the
[releases page](https://github.com/cyberuni/cyber-mux/releases).

## Requirements

- Node.js 22 or later, and a POSIX shell.
- A supported multiplexer to drive. See [Multiplexers](/cyber-mux/multiplexers/).

You do not need to install the CLI first. The skill finds `cyber-mux` in this order:

1. `cyber-mux` on your `PATH`.
2. The repository's package manager (`pnpm exec`, `yarn exec`, or `bunx`), when the lockfile is
   present and the package is installed.
3. `npx --yes cyber-mux@<version>`, pinned to the plugin's own version.

## Install

The repository is its own marketplace. Its catalogs sit at the repository root and name the
marketplace `cyberuni-cyber-mux-local`.

### Claude Code

Add the marketplace, then install the plugin:

```text
/plugin marketplace add cyberuni/cyber-mux
/plugin install cyber-mux@cyberuni-cyber-mux-local
```

`/plugin install` opens the plugin's details, where you choose the install scope. From a shell, run
`claude plugin marketplace add cyberuni/cyber-mux` and
`claude plugin install cyber-mux@cyberuni-cyber-mux-local` instead. See
[Discover and install plugins](https://code.claude.com/docs/en/discover-plugins).

### GitHub Copilot CLI

From a shell:

```bash
copilot plugin marketplace add cyberuni/cyber-mux
copilot plugin install cyber-mux@cyberuni-cyber-mux-local
```

In an interactive session, run the same commands as `/plugin marketplace add cyberuni/cyber-mux` and
`/plugin install cyber-mux@cyberuni-cyber-mux-local`. See
[Finding and installing plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing).

### Codex

Add the marketplace from a shell:

```bash
codex plugin marketplace add cyberuni/cyber-mux
```

Then run `codex`, open `/plugins`, switch to the `cyberuni-cyber-mux-local` tab, and install
`cyber-mux`. Start a new session before you use the skill. See
[Build plugins](https://developers.openai.com/codex/plugins/build) and
[Plugins](https://developers.openai.com/codex/plugins).

### Cursor

Cursor documents importing a marketplace from a repository only for Teams and Enterprise admins:

1. In the Cursor dashboard, open **Plugins & MCPs**.
2. Under **Team Marketplaces**, select **Add Marketplace**, then **Import from Repo**.
3. Paste `https://github.com/cyberuni/cyber-mux` and add the `cyber-mux` plugin.

Each user then opens **Customize** in the sidebar, finds `cyber-mux`, selects **Install**, and picks a
project or user scope. See [Plugins](https://cursor.com/docs/plugins).

## Use the `mux` skill

In Claude Code, invoke the skill as `/cyber-mux:mux <command> [options]`. Other runtimes load the same
skill under the name `mux`; call it the way that runtime calls skills, or ask in plain words. List
the commands with:

```text
/cyber-mux:mux --help
```

The skill passes your arguments to the CLI unchanged:

- With no arguments, `--help`, or `-h`, it prints the CLI help.
- With `<command> --help`, it prints that command's help.
- Otherwise it runs `cyber-mux <arguments>`. When the command accepts `--format` and you gave none,
  it adds `--format agent`, the compact [AXI](/cyber-mux/concepts/axi/) output for agents.

The skill summarizes a successful run in a line or two and names any pane id it returned. When a
command fails, it quotes the CLI's error and exit code verbatim and does not retry with different
flags.

### Examples

Report which multiplexer the session is inside (see [`mode`](/cyber-mux/cli/mode/)):

```text
/cyber-mux:mux mode
```

Open a pane to the right that runs the test watcher, then read its output (see
[`open`](/cyber-mux/cli/open/) and [`read`](/cyber-mux/cli/read/)):

```text
/cyber-mux:mux open --at pane:right --label tests --launch "pnpm test --watch"
/cyber-mux:mux read tests --lines 20
```

You can also ask in plain words, such as "open a pane on the right and run the tests". The agent loads
the skill, reads `--help` for the command it needs, and builds the call from the flags the help lists.

The skill only runs `cyber-mux`. It never calls `tmux`, `herdr`, or another multiplexer's own CLI. Inside
GNU Screen, commands that drive a pane fail with a named `screen` error. Screen is detected but
cannot be driven, so the skill reports that error rather than trying to fix it.

## Next steps

- [CLI Reference](/cyber-mux/cli/): every command and flag the skill can pass through.
- [AXI](/cyber-mux/concepts/axi/): the output contract behind `--format agent`.
