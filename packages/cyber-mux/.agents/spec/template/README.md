---
concept: [cyber-mux, template]
---

# template — named, reusable workspace templates

A **template** is a recipe for standing up a working workspace. It names three things at once, and
re-targets all of them at a different directory on every apply:

- **arrangement** — the pane tree, and the ratios its splits cut at
- **environment** — the variables each pane is born with
- **launch commands** — what runs as each pane is created or restored

All three, not just the first. A template that only described arrangement would leave the two things
that make a restored workspace actually *work* to be re-supplied by hand on every apply, which is the
whole cost the capability exists to remove.

> **On the name.** This capability was called `layout` through its first implementation. That name was
> retired because it named only the arrangement and so undersold the artifact: a reader seeing
> "layout" would not expect environment and launch commands to be part of it, and they are.
> `template` names the recipe rather than one of its three ingredients. The rename was wholesale and
> carries no deprecated alias — the package was unpublished when it landed, so there was no consumer
> to break.

The rule the whole capability exists to enforce, and which both units below hold in their own
direction: **nothing about the target directory is ever written into the template.** `cwd` is not an
optional field — it is not in the schema, and a template carrying one fails validation. The target is
injected at apply time and only there, and a capture subtracts it back out.

Designed in [`docs/design/layout-templates.md`](../../../../../docs/design/layout-templates.md) —
which keeps its original name as a record of the design moment — against
`.research/mux-workspace-layouts/` and `.research/mux-message-bus/`.

## The units

| Unit | Owns |
|---|---|
| [`apply/`](./apply/README.md) | The **read** direction. Resolving a template by name (repo before user, through the primary checkout), validating it, desugaring the flat `panes`/`arrange` form, and walking the tree — or the `tabs` two-level form — into live panes against a target supplied at apply time. Also the manifest that hands the result back, the `--template` flag that is `--launch`'s sibling, the ratio and env degrades, and the mux-free `list`/`show`/`validate` verbs. |
| [`capture/`](./capture/README.md) | The **write** direction. `template save` reads a live region — or, with `--workspace`, every tab of the workspace it sits in — derives the split tree from the rectangles the geometry seam reports, subtracts the target directory back out into `dir`, and writes the resulting draft template. Also where the file goes, and what `save` refuses. |

The seam between them is real rather than an artifact of ordering: capture has its own entry point
and never routes through resolve-and-validate, because the template it would resolve is the artifact
it is producing. The two meet at exactly one edge — a written capture must pass the same validator
apply resolves through — and that edge is specified once, in `apply/`, and referenced from `capture/`.
