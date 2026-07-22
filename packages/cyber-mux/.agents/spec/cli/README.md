# cli — the CLI surface, one node per capability

This folder holds the **CLI surface** of cyber-mux: how the `cyber-mux <verb>` command line invokes and
presents each capability — which verbs exist, how their flags parse and default, the exit-code
taxonomy, what lands on stdout vs stderr, how facts render into human tables, and the shared AXI error
contract. It is organized by **public surface**, the counterpart axis to the capability folders
([`mux/`](../mux/README.md), [`template/`](../template/README.md)), which hold the
**surface-independent contract** — *what* each capability guarantees however invoked.

**One `cli/X` node mirrors each library node.** A scenario lives here when stating it *needs the CLI
surface* — a verb, a flag, an exit code, a rendered marker, an error payload; a surface-independent
guarantee (an adapter's behavior, a resolution rule, a git fact, a library seam) stays in the
capability node. Separating **presentation from contract** is the principle: a change to how a verb
renders never touches the contract, and vice-versa. A *genuine capability divergence* — worktree's
`provision` verb takes only the default availability gate while the library seam takes an injected
predicate (cyberuni/cyberplace#360) — is one reason for the split but not the only one; clean
presentation-vs-contract separation stands on its own. `cli/` is never a layered dumping ground: a
`cli/X` node exists only as the counterpart to a real library node, and never duplicates a contract
the capability node already owns.

This node and [`cli/template/`](./template/README.md) are **descriptive indexes** — they own no suite;
the behavior lives in the surface nodes below.

## The surfaces

| Surface | Mirrors | Owns |
|---|---|---|
| [`detection/`](./detection/README.md) | [`mux/detection/`](../mux/detection/README.md) | `doctor`, `mode` — the detection read-outs and their pin hint. |
| [`placement/`](./placement/README.md) | [`mux/placement/`](../mux/placement/README.md) | `open` — the `--at`/`--env`/`--label`/`--launch` flag surface (KEY=VALUE parsing, conflicts, defaults, usage errors) over the library `open()` contract. |
| [`driving/`](./driving/README.md) | [`mux/driving/`](../mux/driving/README.md) | `send` (text/keys), `submit` — the verb usage/help surface over the drive primitives. |
| [`lookup/`](./lookup/README.md) | [`mux/lookup/`](../mux/lookup/README.md) | `read`, `focus`, `close`, `list`, `exists` — the pane verbs, **and the shared AXI error/usage contract every `cyber-mux` verb routes through** (structured error on stdout, per-failure codes, the exit-code taxonomy, `--format json`, no raw-diagnostic leak). |
| [`worktree/`](./worktree/README.md) | [`mux/worktree/`](../mux/worktree/README.md) | `add`, `provision`, `open`, `list`, `remove`, `prune` — flag defaults, table rendering, and the `provision` verb's default-gate-only invocation. |
| [`template/`](./template/README.md) | [`template/apply/`](../template/apply/README.md), [`template/capture/`](../template/capture/README.md) | `template list/show/validate` (apply-side) and `template save` (capture-side) — the verbs, flags, and manifest/`--format` output over the template engine. Two subnodes mirror the two-node library split. |

Every `cli/` node cross-references [`lookup/`](./lookup/README.md) for the shared AXI failure contract
rather than restating it.
