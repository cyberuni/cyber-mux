---
todos:
  - content: Grill mux use cases + mux.feature for the WezTerm adapter, draft session.wezterm.ts contract
    status: completed
  - content: Spec gate — additive-only diff confirmed (gherkin-cli structural diff, check:features), self-asserted
    status: completed
  - content: Widen LivePane.mux / backend union and probeMultiplexer for wezterm ($WEZTERM_PANE fast-path)
    status: completed
  - content: Implement session.wezterm.ts against the frozen suite (split ratio inversion, env fallback, workspace tier, focus unknown, no worktree binding)
    status: completed
  - content: Update tests (wezterm unit, mux-probe, backend.ts selection)
    status: completed
  - content: Impl gate — pnpm verify green (7/7 tasks, 638 tests)
    status: completed
  - content: Changeset + commit + handoff
    status: in_progress
---

# A WezTerm adapter

CR (#47): add a third `SessionAdapter` backend for WezTerm's built-in multiplexer, driven through
`wezterm cli` (`split-pane`, `spawn`, `list`, `send-text`, `get-text`, `activate-pane`). Filed by an
agent from a fleet-level review of which multiplexers cyber-mux supports.

## Why WezTerm, per the issue

- Stable numeric pane ids from `wezterm cli list --format json` (id, tab id, workspace, cwd, title
  in one call) — lands close to `LivePane` directly, no per-pane follow-up.
- `$WEZTERM_PANE` set in every pane — extends `currentPane`'s env fast-path the same way
  `$TMUX_PANE` / `$HERDR_PANE_ID` already do.
- A genuine workspace tier (`wezterm cli list` reports it, `--workspace` selects it) — like herdr,
  unlike tmux, `OpenedPane.workspace` need not be absent.

## What to check (from the issue, carried into the grill)

- `--percent` on `split-pane` sizes the **new** pane — same inversion trap as tmux
  (`1 - ratio`), not herdr's pass-through. Pin a non-midpoint ratio in tests so a missed inversion
  cannot hide at the midpoint (the same trap #22 named).
- Whether `wezterm cli spawn`/`split-pane` sets per-pane env natively at birth, or whether it must
  ride in through the launch command — if it cannot be set natively, the adapter must report that
  the same way herdr's worktree route already does (env-at-birth use case in `mux/README.md`).
- `LivePane.mux` is presently a closed union (`'tmux' | 'herdr'`) — widens to include `'wezterm'`.
- Whether WezTerm's workspace tier can bind a git worktree the way herdr's can, or whether it only
  answers occupancy (like tmux, which has neither) — probe empirically, don't assume from docs.

## NEXT

`session.wezterm.ts` implemented and wired (backend.ts, mux-probe.ts, session.ts's `LivePane.mux`
union); `mux.feature`/`mux/README.md` extended additively (confirmed via `gherkin-cli diff` — 0
removed, all "modified" scenarios are pure Examples-row additions or comment extensions, no
narrowing); `pnpm verify` green (638 tests). No live WezTerm GUI was available in this sandbox, so
the adapter is built from `wezterm cli --help`/CLI docs, not empirically verified the way
tmux/herdr's adapters are — flagged everywhere in the code/spec as such. Real capability gaps found:
no native `--env` on any route, no pane-title primitive (rename throws), no focus-query primitive
(`isPaneFocused` always `unknown`), no pane geometry (`describeRegion`/`describeWorkspace` omitted),
no worktree-binding concept in the CLI at all.

Follow-ups to record: (1) live verification against a real WezTerm instance once someone has one
available — the whole adapter is currently unverified; (2) `wezterm cli activate-pane`'s
cross-workspace/cross-window focus behavior is unconfirmed by docs.

Next: changeset added; commit and hand off.
