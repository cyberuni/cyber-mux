---
title: open
description: Open a new pane/tab/workspace, optionally launching a command in it.
---

### `cyber-mux open [--launch <cmd>] [--template <name>] [--cwd <path>] [--at <placement>] [--env <KEY=VALUE>...] [--label <name>]`

Open a new pane and launch a command in it. Prints the new pane's `id`, and its `workspace` when the
backend bound one (`null` otherwise).

- `--launch <cmd>` — command line to run in the new pane; omit for a blank pane.
- `--template <name>` — build a whole named pool in the opened space instead of a single pane, from a
  resolvable [template](/cyber-mux/concepts/templates/). Resolved and validated **before**
  anything opens, so a typo in the name leaves nothing behind. Conflicts with both `--launch` and
  `--env` (a template owns everything in the panes it declares); rejected by commander (exit 2) if
  combined with either.
- `--cwd <path>` — working directory for the new pane; defaults to the caller's own `cwd`.
- `--at <placement>` — one of `pane:right`, `pane:down`, `pane:float`, `tab` (default), or
  `workspace`. `workspace` is the backend's own visible space (herdr `workspace create`, tmux a new
  window) — never a detached tmux session, which would be invisible to `focus`. `pane:float` opens a
  **floating pane** — one that sits above the tiled layout rather than taking a share of it, so
  nothing else is resized. It is the one placement that is not universal: **tmux 3.7+** (`new-pane`)
  and **zellij** (`new-pane --floating`) open a real one, while **wezterm** and **herdr** have no such
  concept and refuse it with `backend-unsupported` (exit 1) rather than quietly substituting a split.
  The value is always accepted by the flag — which backend can realize it is a runtime answer.
- `--env <KEY=VALUE>` — repeatable; sets each variable natively at the pane's birth.
- `--label <name>` — names whatever `--at` opened, at whatever tier it opened it:

  | `--at` | herdr | tmux |
  | --- | --- | --- |
  | `workspace` | workspace label | window name |
  | `tab` | tab label | window name (`workspace` and `tab` are both a Window here) |
  | `pane:right` / `pane:down` / `pane:float` | pane label | pane title |

  Omit it and each backend keeps its own default.

See also [`worktree add`](/cyber-mux/cli/worktree/#cyber-mux-worktree-add) and
[`template`](/cyber-mux/cli/template/), which share `--template`/`--at`/`--env`/`--label`.

## Examples

```bash
# Blank pane, split to the right of the caller
cyber-mux open --at pane:right
```

```bash
# A floating pane above the layout — tmux 3.7+ or zellij; refused elsewhere
cyber-mux open --at pane:float --launch "watch -n5 git status"
```

```bash
# Launch a command in a new tab, in a specific directory
cyber-mux open --launch "npm run dev" --cwd ~/code/my-app --at tab
```

```bash
# A labeled workspace with an env var set at birth
cyber-mux open --at workspace --label logs --env LOG_LEVEL=debug --launch "tail -f app.log"
```

```bash
# Build a whole pane pool from a template
cyber-mux open --template pool-4 --cwd ~/code/my-app
```
