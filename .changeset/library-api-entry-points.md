---
'cyber-mux': minor
---

Expose a library API. `cyber-mux` now publishes real entry points beside the CLI:

- `cyber-mux` — the multiplexer core: the `MuxAdapter` contract and its types, the mux probe
  (`probeMultiplexer`, `currentPane`), backend selection (`selectMuxAdapter`, `callerPane`), the
  tmux/herdr/wezterm adapters, `nudge`, and the `Exec`/`NewId` seams (each a type plus its real
  implementation).
- `cyber-mux/worktree` — the git-worktree adapter (`resolvePrimaryRoot`, `assertDistinctFromPrimary`,
  `gitWorktreeAdapter`, `listWorktreesFromGit`, `removeWorktreeSafely`, and the `WorktreeFs` seam).
- `cyber-mux/template` — template resolution and the `TemplateStore` seam.

Every entry ships type declarations, and the core is pure: it takes its effects (`Exec`, `NewId`,
`WorktreeFs`, `TemplateStore`) as parameters, with the real implementations exported as separate
named values, so a host binds them once and tests drive fakes. `probeMultiplexer` gains an
`envPrefix` option so a host embedding cyber-mux under its own namespace adopts the env fast-path
without forking detection. The CLI bin is unchanged.

The package also ships its TypeScript source (tests excluded) alongside declaration maps, so
go-to-definition on any exported symbol lands in real source rather than a generated `.d.ts`.

Pre-1.0, depend on this with a caret range (`^0.2.0`); a 0.x minor may still carry breaking changes.
