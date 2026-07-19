---
"cyber-mux": minor
---

Add named workspace templates — a reusable template applied against a target directory supplied at
invocation time. A template names a pool once (geometry, a startup command, and an environment per
pane) and re-targets it on every apply; nothing about the target directory is ever written into the
template, and a template carrying a `cwd` fails validation rather than being silently ignored.

Templates are JSON, resolved by name from `<primaryRoot>/.cyber-mux/templates/<name>.json` and then
`${XDG_CONFIG_HOME:-~/.config}/cyber-mux/templates/<name>.json`, with the repo winning and `template list`
marking a user template a repo template shadows. Resolving through the primary checkout means every
worktree of a project sees the same templates, including a worktree whose branch predates one.

The schema is a binary split tree (`split`/`pane` nodes, `direction: right|down`, `ratio`,
`first`/`second`; panes carry `label`/`command`/`env`/`dir`), plus a flat `panes` + `arrange`
(`tiled`/`even-horizontal`/`even-vertical`) sugar that cyber-mux desugars itself — so one template
yields one geometry on every backend rather than deferring to each multiplexer's own grid algorithm.

New verbs: `cyber-mux template list | show [--desugar] | validate`, which take a file as their subject
and answer with no multiplexer at all. Applying a template is not its own verb — it is `--template` on
the commands that already open a space (`open`, `worktree add`), the exact sibling of `--launch` and
mutually exclusive with it. `--format json` emits the apply manifest: every pane created, as
`(label, pane, dir, command)`.

Also adds `ratio` and `env` to `SessionOpenOptions`, native on both backends (herdr `--ratio`/`--env`,
tmux `-l`/`-e`) at both the split and region tiers.
