---
title: Detection
description: The multiplexer probe and self-identity helper — and adopting the env fast-path under your own namespace.
---

`selectMuxAdapter` picks a backend for you. When you want the *detection result* itself — the backend
name, the pane, and how it was found — call the probe directly. See
[Detection](/cyber-mux/concepts/detection/) for the two-mode algorithm this implements.

```ts
import { probeMultiplexer, currentPane, nodeExec, type MuxProbe } from 'cyber-mux'
```

## `probeMultiplexer(exec, env, opts?)` → `MuxProbe`

Two-mode detection:

1. **Fast-path** — `$CYBER_MUX` (`tmux | herdr | wezterm | screen | none`) is trusted outright, and
   also serves as an **override** (`=none` forces no-mux even inside a real multiplexer).
   `$CYBER_MUX_PANE` carries the pane id.
2. **Discovery** — otherwise, walk the process ancestry from `$$`, falling back to the
   `$TMUX`/`$HERDR_ENV`/`$WEZTERM_PANE` hint only when the walk is inconclusive.

```ts
const probe = probeMultiplexer(nodeExec, process.env)
// { mux: 'tmux', pane: '%3', via: 'ancestry' }
```

`MuxProbe` carries `mux`, an optional `pane`, and `via` (`'env'` when the fast-path answered,
`'ancestry'` when the walk did).

### `ProbeOptions`

- **`discover`** — set `false` to skip the ancestry walk and answer `none` when the fast-path misses,
  for a caller that only trusts the explicit override.
- **`envPrefix`** — the environment-variable namespace the fast-path reads, without the trailing
  `_PANE`. Defaults to `CYBER_MUX`. See [below](#embedding-under-your-own-namespace).

## `currentPane(env)`

This session's own pane, resolved from **env alone** (no `ps` walk): the `$CYBER_MUX_PANE` fast-path,
then `$TMUX_PANE`, `$HERDR_PANE_ID`, `$WEZTERM_PANE`. Returns `{ mux, pane }` tagged with the
multiplexer, or `undefined` when the session is in no pane-carrying multiplexer. This is the
mux-agnostic self-identity key that [`callerPane`](/cyber-mux/api/mux-adapter/#callerpaneadapter-env)
is built on.

## Embedding under your own namespace

If you embed cyber-mux inside a host tool with its own environment convention, pass `envPrefix` so
the fast-path reads *your* variables instead of `CYBER_MUX`, without forking detection:

```ts
// Reads $MYTOOL_MUX and $MYTOOL_MUX_PANE for the fast-path;
// discovery still walks the process ancestry unchanged.
const probe = probeMultiplexer(nodeExec, process.env, { envPrefix: 'MYTOOL_MUX' })
```

`<prefix>` names the mux and `<prefix>_PANE` the pane. This is one prefix per call — the host's — not
an alias list; an unset `envPrefix` is exactly the default `CYBER_MUX` behavior.
