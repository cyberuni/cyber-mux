---
title: MuxAdapter
description: The one contract over every multiplexer — resolving a session, and the full method surface.
---

`MuxAdapter` is the contract the whole library exists to provide: one set of verbs that means the
same thing on tmux, herdr, and WezTerm. You rarely touch it directly — you *resolve* a `MuxSession`
for the multiplexer you are inside, with its `Exec` already bound, and call its methods.

Import from the main entry:

```ts
import {
  resolveMux,
  type MuxSession,
  type OpenedPane,
} from 'cyber-mux'
```

## Resolving a session

### `resolveMux(env, deps?)` → `MuxSession`

Run the [probe](/cyber-mux/api/probe/), pick the matching adapter (`tmux` / `herdr` / `wezterm`), and
return it as a `MuxSession` with `Exec` **bound**. Throws if the process is in no supported
multiplexer.

```ts
const mux = resolveMux(process.env)
mux.name // 'tmux' | 'herdr' | 'wezterm'
```

`deps.exec` (default `nodeExec`) is both the runner the detection probe uses AND the default every
session method binds. Gate on `probeMultiplexer(env).mux !== 'none'` first if a caller runs
with-or-without a multiplexer — see [Detection](/cyber-mux/api/probe/#probemultiplexerexec-env-opts--muxprobe).

A test binds a fake once instead of a real backend:

```ts
const mux = resolveMux(process.env, { exec: fakeExec })
```

### `mux.callerPane()`

This process's *own* pane, as a `MuxTarget` the session can address — the value you pass as
[`open`](#opening-panes)'s `from` so a `pane:*` split lands on the caller rather than on whichever
pane the user happens to be looking at.

Returns `undefined` when this session is in no pane, or in a pane belonging to a *different*
multiplexer than the session drives — in which case a `pane:*` open falls back to the backend's own
default rather than splitting a foreign pane id.

## The `deps` override

Every `MuxSession` method takes a trailing, optional `MuxDeps`:

```ts
export interface MuxDeps {
  exec?: Exec
}
```

Omit it in the common case — the method runs with the `Exec` bound at `resolveMux`. Pass `{ exec }`
for a one-off override (a recording fake in a test, a decorated runner) without re-resolving the
session:

```ts
mux.open(opts, { exec: fakeExec })
```

## Opening panes

### `mux.open(opts, deps?)` → `OpenedPane`

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
  panes. Use [`mux.callerPane()`](#muxcallerpane).
- **`within`** — the workspace a `tab` placement opens inside (a `workspace` value from a prior open).
- **`ratio`** — fraction of the split kept by the *original* pane (`0 < ratio < 1`); the adapter
  handles each backend's opposite sign convention for you.
- **`env`** — variables set at the new space's birth, split or not.
- **`label`** — a name for the space at birth, at whatever tier `at` opens.
- **`workspaceGroup`** — an opaque group id for a backend with no workspace tier to group opened
  spaces under; routed through [`group`](#naming-and-grouping).

`OpenedPane` carries `id` (the pane), `tab` (always present — every multiplexer has a tab tier), and
`workspace` (absent on a backend, like tmux, with no workspace tier).

```ts
const pane = mux.open({
  cwd: process.cwd(),
  at: 'pane:right',
  from: mux.callerPane(),
  launch: 'claude',
})
```

## Naming and grouping

- **`mux.rename(target, tier, name, deps?)`** — name an already-open space at `'pane'` or `'tab'`.
  This is the one naming route birth cannot serve (herdr labels a new workspace's root tab `1` with no
  birth flag to change it).
- **`mux.group(target, group, name?, deps?)`** — group an already-open *tab* into `group`, storing the
  tab's own `name` beside it. `MuxOpenOptions.workspaceGroup` routes through this.

## Driving a pane

- **`mux.sendText(target, text, deps?)`** — type `text` literally, pressing **no** Enter. Text that
  names a key (`Enter`, `Up`) is typed as those characters, never interpreted.
- **`mux.sendKeys(target, keys, deps?)`** — press named keys in order (`Up` `Down` `Enter` `Escape`
  `Tab` `C-c` `F1`–`F12`, …). Never *adds* an Enter you did not write.
- **`mux.submit(target, text?, deps?)`** — take the pane's turn: type `text` if given, then **always**
  press Enter. With no text, sends a bare Enter only — flushing an already-staged buffer without
  re-typing it. See [`nudge`](/cyber-mux/api/nudge/) for the send-and-verify wrapper.
- **`mux.read(target, opts?, deps?)`** — capture the pane's current output; `opts.lines` bounds the
  tail.
- **`mux.focus(target, deps?)`** — beam the attached client to the pane, across workspace and tab.
- **`mux.nudge(target, message, opts?, deps?)`** — `submit` with a receipt; see
  [`nudge`](/cyber-mux/api/nudge/).

## Inspecting and tearing down

- **`mux.paneExists(target, deps?)`** → `boolean` — whether the pane is still live.
- **`mux.isPaneFocused(target, deps?)`** → `boolean | undefined` — read-only focus probe; `undefined`
  means the backend cannot answer (callers fail open).
- **`mux.listPanes(deps?)`** → `LivePane[]` — enumerate every live pane the backend can see.
- **`mux.teardown(target, deps?)`** — close the pane.

## Optional capabilities

Two members are present only on backends that support the underlying concept — check for them before
use. Both are reached bound, the same way as the rest of the session (methods take `deps?`, no
`Exec`):

- **`mux.worktree?`** — a [`BoundWorktreeWorkspaceCapability`](/cyber-mux/api/worktree/#binding-a-worktree-to-a-workspace),
  present on herdr. On tmux it is `undefined`; fall back to plain git plus [`mux.open`](#opening-panes).
- **`mux.regions?`** — geometry introspection (`describeRegion` / `describeWorkspace`), present on
  tmux and herdr, absent on WezTerm. Backs `template save`.

- **`mux.canSizeSplits?`** — whether the backend honors `ratio`; `false`/absent means a requested
  ratio degrades to the backend's own even split.

## The raw seam

Everything above is the ergonomic, `Exec`-bound `MuxSession` surface. Underneath it is the pure,
**exec-injected** `MuxAdapter` — every method takes its `Exec` as the first argument instead of one
being bound. Reach for it when threading your own runner through per call rather than binding one,
or when composing at a layer below `resolveMux`.

```ts
import { resolveMuxAdapter, callerPane, nodeExec, withReason, type MuxAdapter, type Exec } from 'cyber-mux'
```

### `resolveMuxAdapter(env, exec?)` → `MuxAdapter`

Run the [probe](/cyber-mux/api/probe/) and return the matching raw adapter (`tmux` / `herdr` /
`wezterm`). Throws if the process is in no supported multiplexer. `exec` defaults to `nodeExec`;
`resolveMux` calls this internally and binds the result into a `MuxSession`.

```ts
const adapter = resolveMuxAdapter(process.env)
adapter.name // 'tmux' | 'herdr' | 'wezterm'
```

### `callerPane(adapter, env)`

The free-function form of [`mux.callerPane()`](#muxcallerpane), for the raw adapter — this process's
own pane as a `MuxTarget` the adapter can address.

### The raw method surface

Every `MuxSession` method above has a raw counterpart that takes `exec` first and drops `deps`:
`open(exec, opts)`, `rename(exec, target, tier, name)`, `group(exec, target, group, name?)`,
`sendText(exec, target, text)`, `sendKeys(exec, target, keys)`, `submit(exec, target, text?)`,
`read(exec, target, opts?)`, `focus(exec, target)`, `teardown(exec, target)`,
`paneExists(exec, target)`, `isPaneFocused(exec, target)`, `listPanes(exec)`. The optional
capabilities are reached the same way, exec-first: `adapter.worktree` (see
[Worktree](/cyber-mux/api/worktree/#binding-a-worktree-to-a-workspace)) and `adapter.regions`. The
semantics of every method are identical to its bound counterpart described above — only the calling
convention differs.

`callerPane` and [`nudge`](/cyber-mux/api/nudge/) stay exported as free functions for this raw seam,
in addition to being folded into `MuxSession` as methods.

### The `Exec` seam

Every raw adapter method takes an `Exec` — a synchronous command runner returning trimmed stdout or
`null` on failure. `resolveMux` binds `nodeExec` (or a supplied fake) into every `MuxSession` method
for you; the raw seam is where you'd bind it yourself.

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
multiplexer — or binds it once into a `MuxSession` with `resolveMux(env, { exec: fake })`.
