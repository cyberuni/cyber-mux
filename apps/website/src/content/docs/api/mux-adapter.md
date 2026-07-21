---
title: MuxAdapter
description: The one contract over every multiplexer — selecting a backend, and the full method surface.
---

`MuxAdapter` is the contract the whole library exists to provide: one set of verbs that means the
same thing on tmux, herdr, and WezTerm. You rarely construct one — you *select* the one for the
multiplexer you are inside, then call its methods with an [`Exec`](#the-exec-seam).

Import from the main entry:

```ts
import {
  selectMuxAdapter,
  callerPane,
  nodeExec,
  type MuxAdapter,
  type OpenedPane,
} from 'cyber-mux'
```

## Selecting a backend

### `selectMuxAdapter(env, exec?)`

Run the [probe](/cyber-mux/api/probe/) and return the matching adapter (`tmux` / `herdr` / `wezterm`).
Throws if the process is in no supported multiplexer.

```ts
const adapter = selectMuxAdapter(process.env)
adapter.name // 'tmux' | 'herdr' | 'wezterm'
```

`exec` defaults to `nodeExec`; pass a fake to drive selection in a test.

### `callerPane(adapter, env)`

This process's *own* pane, as a `MuxTarget` the adapter can address — the value you pass as
[`open`](#open)'s `from` so a `pane:*` split lands on the caller rather than on whichever pane the
user happens to be looking at.

Returns `undefined` when this session is in no pane, or in a pane belonging to a *different*
multiplexer than `adapter` drives — in which case a `pane:*` open falls back to the backend's own
default rather than splitting a foreign pane id.

## Opening panes

### `open(exec, opts)` → `OpenedPane`

Create a pane, tab, or workspace and return its handle plus the workspace it landed in. The `at`
placement decides which:

| `at` | Opens |
| --- | --- |
| `'tab'` (default) | A new tab in the current (or `within`) workspace. |
| `'pane:right'` / `'pane:down'` | A split of the `from` pane. |
| `'workspace'` | A genuinely separate workspace/session, leaving the caller's untouched. |

Key `MuxOpenOptions` fields:

- **`cwd`** *(required)* — working directory the new pane starts in.
- **`launch`** — command line to run inside it; omit for a blank shell.
- **`from`** — the pane a `pane:*` placement splits. **Pass it** — omitting it does not mean "the
  caller", it means "whatever this backend defaults to", and the two backends default to opposite
  panes. Use [`callerPane`](#callerpaneadapter-env).
- **`within`** — the workspace a `tab` placement opens inside (a `workspace` value from a prior open).
- **`ratio`** — fraction of the split kept by the *original* pane (`0 < ratio < 1`); the adapter
  handles each backend's opposite sign convention for you.
- **`env`** — variables set at the new space's birth, split or not.
- **`label`** — a name for the space at birth, at whatever tier `at` opens.
- **`workspaceGroup`** — an opaque group id for a backend with no workspace tier to group opened
  spaces under; routed through [`group`](#naming-and-grouping).

`OpenedPane` carries `id` (the pane), `tab` (always present — every multiplexer has a tab tier), and
`workspace` (absent on a backend, like tmux, with no workspace tier).

## Naming and grouping

- **`rename(exec, target, tier, name)`** — name an already-open space at `'pane'` or `'tab'`. This
  is the one naming route birth cannot serve (herdr labels a new workspace's root tab `1` with no
  birth flag to change it).
- **`group(exec, target, group, name?)`** — group an already-open *tab* into `group`, storing the
  tab's own `name` beside it. `MuxOpenOptions.workspaceGroup` routes through this.

## Driving a pane

- **`sendText(exec, target, text)`** — type `text` literally, pressing **no** Enter. Text that names
  a key (`Enter`, `Up`) is typed as those characters, never interpreted.
- **`sendKeys(exec, target, keys)`** — press named keys in order (`Up` `Down` `Enter` `Escape` `Tab`
  `C-c` `F1`–`F12`, …). Never *adds* an Enter you did not write.
- **`submit(exec, target, text?)`** — take the pane's turn: type `text` if given, then **always**
  press Enter. With no text, sends a bare Enter only — flushing an already-staged buffer without
  re-typing it. See [`nudge`](/cyber-mux/api/nudge/) for the send-and-verify wrapper.
- **`read(exec, target, opts?)`** — capture the pane's current output; `opts.lines` bounds the tail.
- **`focus(exec, target)`** — beam the attached client to the pane, across workspace and tab.

## Inspecting and tearing down

- **`paneExists(exec, target)`** → `boolean` — whether the pane is still live.
- **`isPaneFocused(exec, target)`** → `boolean | undefined` — read-only focus probe; `undefined`
  means the backend cannot answer (callers fail open).
- **`listPanes(exec)`** → `LivePane[]` — enumerate every live pane the backend can see.
- **`teardown(exec, target)`** — close the pane.

## Optional capabilities

Two members are present only on backends that support the underlying concept — check for them before
use:

- **`worktree?`** — [`WorktreeWorkspaceCapability`](/cyber-mux/api/worktree/#binding-a-worktree-to-a-workspace),
  present on herdr. On tmux it is `undefined`; fall back to plain git plus an [`open`](#opening-panes).
- **`regions?`** — geometry introspection (`describeRegion` / `describeWorkspace`), present on tmux
  and herdr, absent on WezTerm. Backs `template save`.

- **`canSizeSplits?`** — whether the backend honors `ratio`; `false`/absent means a requested ratio
  degrades to the backend's own even split.

## The `Exec` seam

Every adapter method takes an `Exec` — a synchronous command runner returning trimmed stdout or
`null` on failure. Bind `nodeExec` at the edge of your program:

```ts
import { nodeExec, withReason, type Exec } from 'cyber-mux'
```

- **`nodeExec`** — the real runner, over `execFileSync`.
- **`exec.lastError`** — the backend's own words for why the most recent call returned `null`, when
  the runner supplies them. A diagnostic, never a control-flow signal — `null` stays the one failure
  sentinel.
- **`withReason(exec, message)`** — append `exec.lastError` to a failure message when there is one,
  so a refused split reports the backend's actual reason.

A test passes its own `Exec` that returns canned stdout, driving the whole adapter with no real
multiplexer.
