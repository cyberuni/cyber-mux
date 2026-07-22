# cli/template — the CLI template surface

This folder groups the **template** capability's specs by **public surface**: how the `cyber-mux
template` verbs and the `--template` flag invoke and present the capability. Where the capability
folder ([`template/`](../../template/README.md)) answers *what the template engine does* — resolving,
validating, desugaring, walking, and the geometry→tree derivation, all surface-independent — a
`cli/template/` node answers *how the command line reaches it*: which verbs exist, how their flags
default, which exit code a usage error takes, and what the `--format json` payload carries.

The surface split exists because one capability ships through **two divergent surfaces** — the CLI
and the library API — that expose different things (cyberuni/cyberplace#360). The engine's guarantees
are specified once at the capability node; the command line's own concerns earn their own node here,
the counterpart to the capability node it draws from.

This node is a **descriptive index**: it owns no suite of its own. The behavior lives in the surface
nodes below.

## The surfaces

| Surface | Owns | Library counterpart |
|---|---|---|
| [`apply/`](./apply/README.md) | The read verbs (`template list`, `show`, `validate`), the `--template` flag that applies through `open` and `worktree add` and its flag defaults, and the `--format json` manifest shape. | [`template/apply/`](../../template/apply/README.md) |
| [`capture/`](./capture/README.md) | The `template save` verb — which region `--from` names, `--workspace` and its bare-save reveal, `--description`, where the file goes (`--to`, `--force`), the `--format json` payload, and the exit code each refusal takes. | [`template/capture/`](../../template/capture/README.md) |
