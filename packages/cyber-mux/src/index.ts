/**
 * The library barrel — the `.` entry. Pure re-exports of the cross-multiplexer core: the
 * `MuxAdapter` contract and its types, the mux probe, backend selection, the adapters, the
 * turn-taking `nudge`, the portable output wait (`wait-output.ts`), the read-window rule
 * (`read-window.ts`), the floating-pane refusal (`floating.ts` — here rather than on a subpath
 * because the verb it refuses, `open`, is on the surface everybody gets), the pane-resize refusal
 * (`resize.ts`, here for the same reason), and the `Exec`/`NewId` seams
 * (each a type PLUS its real implementation).
 *
 * Deliberately re-exports NONE of the CLI-only modules (`output.ts`, `cli-error.ts`, `cli-options.ts`,
 * `cli.ts`) — they call `console.log`/`process.exit`, and keeping them out of every entry is what makes
 * the CLI surface structurally unreachable from the library. The worktree and template surfaces are
 * their own subpaths (`cyber-mux/worktree`, `cyber-mux/template`), not re-exported here.
 */
export * from './backend.ts'
export * from './exec.ts'
export * from './floating.ts'
export * from './mux.herdr.ts'
export * from './mux.rmux.ts'
export * from './mux.tmux.ts'
export * from './mux.ts'
export * from './mux.wezterm.ts'
export * from './mux.zellij.ts'
export * from './mux-probe.ts'
export * from './new-id.ts'
export * from './nudge.ts'
export * from './read-window.ts'
export * from './resize.ts'
export * from './wait-output.ts'
