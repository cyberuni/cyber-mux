# cli — specs grouped by public surface: the CLI

This folder groups specs by **public surface** rather than by capability. Where the capability folders
([`mux/`](../mux/README.md), [`template/`](../template/README.md)) answer *what the CLI does* — the
surface-independent contract — a `cli/` node answers *how the `cyber-mux` command line invokes and
presents it*: which verbs exist, how their flags default, and how git's facts render into a human
table.

It exists because one capability can ship through **two divergent surfaces** — the CLI and the
library API — that expose different things (cyberuni/cyberplace#360). A verb can only ever use the
default gate; a library seam can take an injected one. A single capability-first suite cannot express
that per-(capability × surface) divergence, so the surface that diverges earns its own node here, the
counterpart to the capability node it draws from.

This node is a **descriptive index**: it owns no suite of its own. The behavior lives in the surface
node below.

## The surfaces

| Surface | Owns |
|---|---|
| [`worktree/`](./worktree/README.md) | The `cyber-mux worktree <verb>` surface — add, provision, open, list, remove, prune: how each verb invokes the worktree seam, defaults its flags, groups a checkout where the backend binds, and renders git's facts into the human table. Its library counterpart is [`mux/worktree/`](../mux/worktree/README.md). |
