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
  recovers geometry, labels, and dirs but **never commands**. A backend can often report what is
  *running* — herdr's `pane process-info` gives full argv — but what it reports is the **resolved**
  command line, not the one you typed: `nr web dev` comes back as
  `node /run/user/1000/fnm_multishells/4223_1784479278417/bin/nr web dev`, a path carrying a uid, a
  pid, and a timestamp that is dead on the next machine. That is not portable, and a template is
  meant to be checked in and run elsewhere — so every captured pane needs its command filled in
  before the template is worth applying — `template edit` below lists the panes and fills them in.
- `--to repo|user` — which templates directory to write to; defaults to `repo`.
- `--force` — overwrite an existing template of the same name; refused without it, so a hand-edited
  template is never silently discarded.

Refuses (exit 1) when the backend cannot report the geometry `save` needs: plain `save` needs
`describeRegion`; `--workspace` needs `describeWorkspace`. Both tmux and herdr support both; WezTerm
and Zellij support neither, and `save` refuses on them by naming the backend.

**Examples**

```bash
# Capture the caller's own region
cyber-mux template save pool-4
```

```bash
# Capture every tab of a specific pane's workspace, overwriting an existing template
cyber-mux template save pool-4 --from %3 --workspace --force
```

### `cyber-mux template edit [<name>] [--set <pane>=<value>] [--interactive] [--field command|label] [--dry-run]`

Show a template's panes, and fill them in. This is `save`'s other half: a capture lands with no
`command` on any pane, and filling them in by hand means opening the JSON and counting braces to
work out which leaf is the pane on the left.

Three modes. **The bare form lists and mutates nothing**, so finding out what is there can never
change it:

```bash
cyber-mux template edit pool-4
```

```
template  pool-4
path      ~/.config/cyber-mux/templates/pool-4.json
source    user
PANE  POSITION      LABEL    DIR           COMMAND
----  ------------  -------  ------------  -----------
1     top-left      planner
2     bottom-left   web      apps/website
3     top-right     logs                   tail -f log
4     bottom-right  shell
help[0]: 3 of 4 panes have no command — a template applies without one, but the pane just sits at a shell
  -> cyber-mux template edit pool-4 --set 1=<command>
help[1]: Fill them in one prompt at a time, with the current value pre-filled
  -> cyber-mux template edit pool-4 --interactive
```

The `PANE` column is verbatim what `--set` takes. Panes are addressed by **ordinal, never by label** —
two panes may share a label by design, and an ambiguous selector in a non-interactive API is a silent
wrong-pane write. `POSITION` is there because apply order is a tree walk rather than a reading order:
pane 2 of a 2x2 is the pane *below* pane 1, not the one beside it.

- `--set <pane>=<value>` — set the field on one pane. Repeatable. Splits on the first `=` only, so a
  value may contain one (`--set 1=FOO=bar make`). An empty value clears the field (`--set 1=`).
  Needs no terminal.
- `--interactive` / `-i` — ask one question per pane instead, in apply order, with the current value
  pre-filled into the editable line.
- `--field command|label` — which field `--set` and `--interactive` write; defaults to `command`.
- `--dry-run` — print the edited template to stdout instead of writing it.
- `--file <path>` — edit this path instead, skipping name resolution entirely.

`--set` and `--interactive` cannot be given together (exit 2).

**Setting values**

```bash
# One call, several panes; "2.3" addresses tab 2, pane 3 in a tabs template
cyber-mux template edit pool-4 --set 1=claude --set 2="pnpm dev" --set 3=
```

Re-running the same `--set` is a **no-op that exits 0** — it reports `changed 0` and leaves the file's
mtime alone, so a template that is checked in is never dirtied by an edit that changes nothing. A
batch naming one pane that does not exist writes **none** of them, and the error lists every
identifier that would have worked:

```
error: invalid-set: no pane "9" in this template — it has 4 panes: 1, 2, 3, 4
help: list the panes and their identifiers with: cyber-mux template edit <name>
```

**Interactive**

```bash
cyber-mux template edit pool-4 --interactive
```

| Input | Meaning |
| --- | --- |
| Enter | keep the current value |
| `-` | clear the field |
| `'-'` | a literal `-` |
| anything else | set the field |

Nothing is written until every pane has been answered and the result validates, so **Ctrl-D abandons
the edit** and leaves the file untouched (exit 1, code `edit-aborted`).

Refuses (exit 2, code `not-interactive`) when stdin is not a tty, or when `--format json|agent` was
asked for — a caller wanting machine output has said it is not a human. Use `--set` instead.

A template's spelling survives an edit either way: one written with the flat `panes` + `arrange`
sugar comes back out flat, never re-spelled as a `root` tree.

### `--template <name>` on `open` / `worktree add` / `worktree open`

Build a whole named pool in the newly opened space instead of a single pane or bare checkout.
Resolved and validated **before** anything opens, so a typo in the name or an invalid template
leaves nothing behind. Conflicts with `--launch` and `--env` — the template owns everything in the
panes it declares.
