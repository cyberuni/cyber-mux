# glossary — cyber-mux ubiquitous language

Every load-bearing `cyber-mux` term, defined once. A term used in a node, a suite, or a commit
message is expected to appear here; the node that *enacts* a term keeps the behavior, not a second
definition.

## The placement tiers

`--at` names a **placement concept**, not a backend-specific command. Every multiplexer nests the
same four levels, but each calls them something different — notably, a tmux/screen "Window" is the
**Tab** level, not a Workspace. The adapter maps the concept onto whatever the live backend calls it.

| Concept | Meaning |
|---|---|
| **Session** | the multiplexer's own top-level container: the thing a client attaches to. |
| **Workspace** | its own space, **visible in the attached client and navigable**. A property, not a structural tier: a backend without the tier maps it onto the finest unit that keeps that property. |
| **Tab** | the level every multiplexer has between a workspace and a pane. What a rename addresses at the tab tier, which a pane id cannot do portably. |
| **Pane** | the unit a command actually runs in — the thing `cyber-mux` opens, addresses, and drives. |

| Concept | tmux | screen | zellij | cmux | Orca | herdr | WezTerm |
| ------------- | ------- | ------ | ------- | ----------------------------- | --------------------- | --------- | ------- |
| **Session** | Session | Session| Session | App (state saved on restart) | ---- | Session | ---- |
| **Workspace** | ---- | ---- | ---- | Window/Workspace | Worktree (git branch) | Workspace (bindable to a git worktree) | Window (spawned into a fresh or named Workspace) |
| **Tab** | Window | Window | Tab | Vertical Tab (w/ git status) | Tab | Tab | Tab |
| **Pane** | Pane | Region | Pane | Split Pane | Pane | Pane | Pane |

`cyber-mux` drives three of these backends (tmux, herdr, wezterm) and exposes three of the levels —
`pane:right`/`pane:down`, `tab`, `workspace`. There is no `window` value: "window" is tmux's local
name for the **Tab** concept, already covered by `tab`. How each backend satisfies `--at`, and where
the tiers collapse, is [`mux/`](./mux/README.md)'s behavior.

## The seam

| Term | Meaning |
|---|---|
| **multiplexer** | the terminal program that owns the tiers above — tmux, herdr, wezterm. |
| **backend** | the multiplexer a given invocation actually resolved to drive. |
| **adapter** | one implementation of the seam for one multiplexer. An adapter is not a capability; it is an implementation of the pane abstraction. |
| **`SessionAdapter`** | the one contract every adapter implements — the seam the whole CLI is built on. |
| **detection** | deciding which multiplexer a caller is really running inside: the environment fast-path and override first, then a walk up the process ancestry, then a hint fallback. |
| **pane id** | the backend's own handle for a pane. Outranks a label when addressing, and is recognized by matching a live pane rather than by the string's shape. |
| **label** | a name a person set on the tier `--at` opened. Never a backend's own default. |
| **group id** | an opaque grouping the open contract carries — never parsed, split, or derived from the label. A backend with a real workspace tier ignores it; one without stores it natively. A group id is not a workspace. |

## Templates

| Term | Meaning |
|---|---|
| **template** | a recipe for standing up a working workspace, naming three things at once and re-targeting all of them on every apply. Called `layout` through its first implementation; that name was retired because it named only the arrangement and so undersold the artifact. |
| **arrangement** | the pane tree, and the ratios its splits cut at. |
| **environment** | the variables each pane is born with. A variable not set at a pane's birth cannot be set at all. |
| **launch command** | what runs as each pane is created or restored. |
| **apply** | building a pool from a template against a target directory supplied at that moment. Nothing about the target is ever written into the template. |
| **manifest** | what an applied pool reports back about the panes it opened. |

## Worktrees and turn-taking

| Term | Meaning |
|---|---|
| **primary checkout** | the repository's main working tree — the one `worktree remove` refuses, and the root a new worktree's default path is a sibling of. |
| **binding** | the association between a git worktree and a backend's workspace. Distinct from the git facts (path, branch, linked, prunable), which are read from git on every backend. |
| **degrade** | reporting that something was not carried, rather than failing, where a backend cannot honor it — with the caller told what would have worked. |
| **nudge** | the send-and-verify-turn-taken helper: taking the turn in a pane and confirming the turn was actually taken. |
| **submit** | the only verb that presses Enter *for* the caller. `send text` and `send keys` never add an Enter the caller did not write. |

## The output contract

| Term | Meaning |
|---|---|
| **AXI** | the Agent Experience Interface — the output contract every command follows so an agent spends the fewest tokens per interaction. Stated once in [`axi.md`](./axi.md). |
| **usage error** | an invocation that is wrong: a missing required parameter or an underspecified argument. Exits 2, distinct from an operation that was well-formed and failed. |
| **structured error** | an error reported as data on stdout honoring `--format`, never as raw backend text. |
