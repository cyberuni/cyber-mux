/**
 * The library barrel — the `.` entry. Pure re-exports of the cross-multiplexer core: the
 * `MuxAdapter` contract and its types, the mux probe, backend selection, the three adapters, the
 * turn-taking `nudge`, and the `Exec`/`NewId` seams (each a type PLUS its real implementation).
 *
 * Deliberately re-exports NONE of the CLI-only modules (`output.ts`, `cli-error.ts`, `cli-options.ts`,
 * `cli.ts`) — they call `console.log`/`process.exit`, and keeping them out of every entry is what makes
 * the CLI surface structurally unreachable from the library. The worktree and template surfaces are
 * their own subpaths (`cyber-mux/worktree`, `cyber-mux/template`), not re-exported here.
 */
export * from './backend.ts'
export * from './exec.ts'
export * from './mux.herdr.ts'
export * from './mux.tmux.ts'
export * from './mux.ts'
export * from './mux.wezterm.ts'
export * from './mux.zellij.ts'
export * from './mux-probe.ts'
export * from './new-id.ts'
export * from './nudge.ts'
