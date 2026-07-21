---
'cyber-mux': minor
---

Add a **Zellij** backend — the fourth multiplexer cyber-mux drives, after tmux, herdr, and WezTerm.

Detected via `$ZELLIJ` (fast-path override `CYBER_MUX=zellij`), with self-identity from
`$ZELLIJ_PANE_ID`. Driven through `zellij action …` and gated on **Zellij ≥ 0.44.1**, the release
that added per-pane CLI addressing (`--pane-id` across the action verbs, `focus-pane-id`,
`list-panes --json`, and ids returned from `new-pane`/`new-tab`) — the stable per-pane handle the
seam requires.

Capability shape: it names panes (`new-pane --name` / `rename-pane`) and reports the focused pane
(`is_focused`), unlike WezTerm. A `workspace` placement opens a new tab in the ambient session —
Zellij pane ids are session-scoped and the seam's pane target carries no session — but the occupied
workspace is still reported as the session name, unlike tmux. Tiled splits are always even (no
`ratio`), env rides in as a command prefix (no `--env` flag), and pane-geometry introspection
(`template save`) is not yet supported.
