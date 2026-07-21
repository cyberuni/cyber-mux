---
'cyber-mux': patch
---

`CYBER_MUX=screen` is now **rejected with a named error** instead of the generic "run inside a
multiplexer" throw. GNU Screen is detected — an override pinning it, or a real `screen` ancestor, is
reported truthfully — but it is **not a drivable backend**, and pinning it now says so plainly.

The `CYBER_MUX` contract used to name `screen` as an accepted override value alongside
`tmux`/`herdr`/`wezterm`, but no adapter ever stood behind it, so setting `CYBER_MUX=screen` produced
`cyber-mux requires a session backend — run inside tmux, herdr, or wezterm` — a lie, since the caller
*had* declared a real multiplexer. The value looked supported and was not.

Probed live (GNU Screen 5.0.2): the blocker is identity, which is load-bearing across the whole
contract (`SessionTarget.id`, `currentPane`, `LivePane.id`). Screen addresses its split **regions**
positionally — no per-region id to send to or read from — and leaves `$WINDOW` **unset** in windows
opened via `screen -X`, exactly the panes a driver creates, so a pane cannot even self-identify. Every
supported backend ships a stable per-pane id (`$TMUX_PANE` / `$HERDR_PANE_ID` / `$WEZTERM_PANE`);
screen has no equivalent for driven panes.

Rather than ship a half-faithful adapter with unstable pane identity, `cyber-mux` keeps `screen`
recognized-but-rejected: the value is still honored as an override (so it is never silently ignored
and fallen through to discovery) and now fails with the reason. Detection of a real `screen` session
is unchanged; only the drive step rejects it. Full probe and decision: the `45-screen-adapter` ADR.
