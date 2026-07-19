---
title: template
description: Manage named templates.
---

Named, reusable pane pools — build several panes at once from a template instead of one
[`open`](/cyber-mux/cli/open/) at a time. See [Templates](/cyber-mux/concepts/templates/) for the
template schema and resolution rules. There is deliberately no `template apply` — applying is what
`open` and [`worktree add`/`worktree open`](/cyber-mux/cli/worktree/) already do, told to build N
panes instead of one via `--template`.

### `cyber-mux template list`

Every template resolvable from here, with its source and pane count. Table columns: `name`,
`source`, `panes`, `shadowed` (a template of the same name exists in a higher-precedence directory).
A template that fails to parse still lists — with `panes: 0` — since `list` answers "what is here",
not "is it any good" (that's `validate`).

**Example**

```bash
cyber-mux template list
```

### `cyber-mux template show [<name>] [--file <path>] [--desugar]`

Print a resolved template as JSON. Needs either a template `name` or `--file <path>` — missing both
is a usage error (exit 2). `--file <path>` reads that path directly, skipping name resolution.
`--desugar` prints the canonical `panes`/`arrange` tree exactly as `apply` builds it — useful for
seeing what a flat-N shorthand expands to.

**Examples**

```bash
cyber-mux template show pool-4
```

```bash
cyber-mux template show --file ./pool-4.json --desugar
```

### `cyber-mux template validate [<name>] [--file <path>]`

Check a template's schema without opening anything. Same name-or-`--file` requirement as `show`.
Every error is reported at once, one per line, each naming its own JSON path — silent (no output) on
a valid template, which is what a CI hook checks for; exit `1` on an invalid one.

**Example**

```bash
# CI hook: exits non-zero on the first invalid template
cyber-mux template validate pool-4
```

### `cyber-mux template save <name> --from <pane> [--workspace] [--description <text>] [--to repo|user] [--force]`

Capture an already-open pane pool as a reusable template.

- `--from <pane>` — the pane whose region to capture; defaults to the calling process's own pane.
  Takes either a pane id or a label — see [Pane](/cyber-mux/concepts/pane/) for resolution rules.
- `--workspace` — captures every pane in the `--from` pane's **workspace**, not just the one
  region, as a `tabs` template. Opt-in: the bare form only ever captured one region, and widening
  the default silently would change what `save` has always meant. A bare capture of a
  multi-tab workspace notes on stdout (a `help[N]:` block) how many tabs were left out.
- `--description <text>` — recorded in the template; defaults to a draft warning, since a capture
  recovers geometry, labels, and dirs but **never commands** — no multiplexer reports the command a
  pane was launched with, so every captured pane needs one filled in by hand before the template is
  worth applying.
- `--to repo|user` — which templates directory to write to; defaults to `repo`.
- `--force` — overwrite an existing template of the same name; refused without it, so a hand-edited
  template is never silently discarded.

Refuses (exit 1) when the backend cannot report the geometry `save` needs: plain `save` needs
`describeRegion`; `--workspace` needs `describeWorkspace`. Both tmux and herdr support both.

**Examples**

```bash
# Capture the caller's own region
cyber-mux template save pool-4
```

```bash
# Capture every tab of a specific pane's workspace, overwriting an existing template
cyber-mux template save pool-4 --from %3 --workspace --force
```

### `--template <name>` on `open` / `worktree add` / `worktree open`

Build a whole named pool in the newly opened space instead of a single pane or bare checkout.
Resolved and validated **before** anything opens, so a typo in the name or an invalid template
leaves nothing behind. Conflicts with `--launch` and `--env` — the template owns everything in the
panes it declares.
