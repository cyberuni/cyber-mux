---
"cyber-mux": minor
---

Add a WezTerm `SessionAdapter`, driven through `wezterm cli` — cyber-mux now runs inside WezTerm's built-in multiplexer alongside tmux and herdr. Detection extends the existing env fast-path via `$WEZTERM_PANE`, the same way `$TMUX_PANE`/`$HERDR_PANE_ID` already work.

Several real capability gaps fell out of building this adapter against the WezTerm CLI's own reference (no live WezTerm GUI was available to verify against, so this is probed from `wezterm cli --help`/the CLI docs rather than a live binary the way the tmux/herdr adapters are):

- **No `--env` on `spawn`/`split-pane` at all.** Unlike herdr, which is native everywhere except one worktree route, WezTerm's CLI has no env flag on any space-creating command — every open takes the command-prefix-or-warn fallback, not just one.
- **No way to title a pane**, at birth or after. `set-tab-title`/`set-window-title` exist; there is no pane equivalent. Renaming a pane throws rather than silently doing nothing; `open`'s pane-tier `--label` degrades to a stderr warning instead of failing the whole open.
- **No focus-query primitive.** `wezterm cli list --format json` carries no active/focused field for a pane, tab, or window, so `isPaneFocused` always answers `unknown` for this backend — the seam's own honest answer for "no primitive to ask", not a per-query fallback the way it is on tmux/herdr.
- **No per-key press primitive.** There is no `send-keys`-shaped verb, only `send-text` — the portable core vocabulary is instead realized by encoding each key as its own raw terminal byte sequence and typing it via `send-text --no-paste`.
- **No pane geometry.** `list --format json` reports a pane's size but never its position, so there is nothing to build a rect from — `describeRegion`/`describeWorkspace` are omitted, same as any backend that cannot describe its own region.
- **No git-worktree concept in the CLI at all** — like tmux, this backend never binds a worktree to a workspace; callers fall back to plain git plus a placement-appropriate `open()`.

`--percent` on `split-pane` sizes the **new** pane, the same inversion direction tmux's `-l` needs — not herdr's pass-through of the original pane's fraction. `spawn`/`split-pane` report only the new pane's bare id on stdout, unlike tmux/herdr, so the tab (and, on a tab or pane:* placement, the workspace) cost a follow-up `wezterm cli list --format json` lookup rather than a free read of output already held; the `workspace` placement is the one exception, since the workspace name is chosen by `open()` itself.
