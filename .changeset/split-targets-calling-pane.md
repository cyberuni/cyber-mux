---
"cyber-mux": minor
---

`--at pane:*` now splits the **calling** pane on both backends, and `SessionOpenOptions` gained `from` to name the pane a split targets.

**The bug.** `SessionPlacement` is documented as placement "relative to the caller's current one", but neither backend's default delivers that, and they fail in opposite directions:

- **tmux** ignores `$TMUX_PANE` entirely and splits the session's **active** pane. Verified on tmux 3.6b: a `split-window` run inside pane `%1`, with `$TMUX_PANE` correctly reading `%1`, split the active `%0` instead.
- **herdr** resolves `--current` from `$HERDR_PANE_ID`, then silently falls back to the **UI-focused** pane when that is unset. Verified on herdr 0.7.4.

Both defaults track the pane the *user* is looking at. That coincides with the caller whenever a human is typing, and diverges exactly when a program is driving — so `cyber-mux open --at pane:right` could split whatever pane happened to be focused, with no error. The same command also meant different things on different backends, in the one seam this package exists to make uniform.

`$CYBER_MUX_PANE` — the documented pane-id fast-path a spawn propagates — was also unreachable from a split, since a backend's own default cannot see it.

**The fix.** Callers now resolve their own pane and name it, rather than trusting either backend's default: `herdr pane split <id>` instead of `--current`, `tmux split-window -t <id>` instead of no `-t`.

- `SessionOpenOptions.from?: SessionTarget` — the pane a `pane:*` placement splits. Ignored by `tab`/`workspace`, which split nothing.
- `callerPane(adapter, env)` (new, from `backend.ts`) — this session's own pane as a target, resolved through the same `$CYBER_MUX_PANE` → `$TMUX_PANE`/`$HERDR_PANE_ID` chain as `currentPane`, so the documented override reaches a split. `undefined` when the pane belongs to a different multiplexer than the adapter drives, rather than handing one backend the other's pane id.
- `addAndOpenWorktree` / `openExistingWorktree` accept and forward `from`.

**Behavior change.** On tmux, `--at pane:*` from a pane that is not the active one now splits the caller instead of the active pane. That is the documented contract being honored rather than a new intent.

Omitting `from` is unchanged: it falls back to the backend's own default, so a caller that cannot identify itself (a cron job, a shell outside any pane) still opens a pane rather than failing.
