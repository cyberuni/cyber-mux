---
title: Template
description: The cyber-mux/template entry — the pane-pool schema, its validator, the desugarer, and resolution.
---

The `cyber-mux/template` subpath is the [template](/cyber-mux/concepts/templates/) layer as a
library: the schema types, a validator that reports **every** error at once, the flat-N desugarer
that turns a pane pool into a split tree, and the filesystem-backed resolution seam. The schema and
desugaring are **pure** — no `Exec`, no filesystem — which is what makes them testable with no mock.

```ts
import {
  validateTemplate,
  parseTemplate,
  resolveTree,
  resolveTemplate,
  listTemplates,
  realTemplateStore,
  type Template,
} from 'cyber-mux/template'
```

## The schema

A `Template` names a pane layout in one of three spellings — exactly one of `root`, `panes`, or
`tabs`:

- **`root`** — an explicit `TemplateNode` tree of `PaneNode` leaves and binary `SplitNode`s
  (`direction: 'right' | 'down'`, optional `ratio`).
- **`panes`** — the flat sugar: a pool of `FlatPane`s plus an `arrange`
  (`'tiled' | 'even-horizontal' | 'even-vertical'`), desugared into a tree.
- **`tabs`** — the two-level form: a workspace of `TabNode`s, each its own tree.

The rule the whole capability enforces: **`cwd` is not in the schema.** A template carrying one
*fails validation* — an ignored key would quietly make a template non-reusable, the one thing a
template must be. Use a pane's relative `dir` for a subdirectory under the apply-time target.

## Validating and parsing

### `validateTemplate(template, stem?)` → `string[]`

Every validation error, not the first — an empty array means valid. Each error names its own JSON
path (`root.second.first.cwd`), so it points at a place in the file. Pass `stem` (the filename's
stem) to enforce that the `name` field matches it, so a copied template that kept its old name fails
loudly.

```ts
const errors = validateTemplate(parseTemplate(raw), 'dev')
if (errors.length) throw new Error(errors.join('\n'))
```

- **`parseTemplate(raw)`** — parse the bytes; throws on malformed JSON (schema validity is
  `validateTemplate`'s job).
- **`isValidTemplateName(name)`** / **`assertTemplateName(name)`** — a name is `[a-z0-9][a-z0-9-]*`
  and must be a plain filename stem, checked *before* any file read so a name can never traverse out
  of the templates directory.

## Desugaring

### `resolveTree(tree)` → `TemplateNode`

The one place `panes`/`arrange` becomes a tree, so `template show --desugar` and the apply walk can
never disagree about what a flat template means. Takes either carrier of a tree (a `Template` or a
`TabNode`), so the tab tier and the template tier resolve through the same desugarer.

Also exported: **`desugar(panes, arrange)`**, **`collectPanes(node)`** (every pane in template
order), and **`firstPane(node)`** (the pane that lands on a subtree's existing region).

## Resolution

The filesystem-backed seam that finds a template's bytes across the searched directories.

### `resolveTemplate(opts)` → `ResolvedTemplate`

Resolve a template to its bytes: `--file` (explicit path, skips search), then the repo directory,
then the user directory. **Repo beats user** — a project shipping a template should not be silently
shadowed by a personal one of the same name. Throws when nothing resolves, naming both directories
searched.

- **`templateDirs(exec, env, homedir?)`** → `{ repo, user }` — the two searched directories. The repo
  location resolves through `resolvePrimaryRoot`, so every worktree of a project sees one canonical
  answer.
- **`listTemplates(store, dirs)`** → `TemplateListing[]` — every resolvable template, repo first,
  with a shadowed user template *reported* (`shadowed: true`) rather than omitted.

`store` is a `TemplateStore` seam (`list` / `read` / `dirExists` / `write`); `realTemplateStore` is
the default over the filesystem.

:::note
The **apply engine** (building a live region from a template) stays internal — no consumer exercises
it yet, and exporting it would freeze a much larger contract. The library gives you the schema,
validation, and resolution; drive the geometry through [`adapter.open`](/cyber-mux/api/mux-adapter/#opening-panes)
or the [`template` CLI](/cyber-mux/cli/template/).
:::
