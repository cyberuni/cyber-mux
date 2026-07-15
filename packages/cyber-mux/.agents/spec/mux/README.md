---
spec-type: behavioral
concept: [cyber-mux]
---

# mux — the pane abstraction

The `cyber-mux` CLI's entire subject: which session backend (tmux or herdr) is available, where a
new pane opens, and how a caller detects the multiplexer it is really running inside. Ported from
`cyberlegion`'s `spec/mux/` (`packages/cyberlegion/.agents/spec/mux/`, ADR-0024/ADR-0021) when the
mux seam was extracted into this standalone repo (scaffold commit `21557b4`) — adapted from
`cyberlegion`'s command-group verbs (`unit spawn`, `cyberlegion mux doctor`) to this repo's flat
verb surface (`open`, `doctor`, `mode`) and env names (`CYBERLEGION_MUX*` → `CYBER_MUX*`).

## Use Cases

**Subject** — detecting and selecting the pane backend a session opens through, and driving a pane
once opened:

- **The session backend is selected by environment** — tmux when `$TMUX` is set, herdr when
  `$HERDR_ENV` is set and `$TMUX` is not; an environment with neither throws asking for one.
- **Placement maps each `--at` value onto the backend** — `--at pane:right|pane:down|tab|workspace`
  chooses where the new pane opens. Unlike `cyberlegion` (where `unit spawn` always resolved a
  concrete `--at` before calling this layer, making the adapter's own fallback unreachable),
  `cyber-mux open`'s `--at` is optional at the CLI: when omitted, **the adapter's own `at ?? 'tab'`
  fallback is reachable and observable** (`session.tmux.ts`, `session.herdr.ts`) — so it carries a
  scenario here. `tab` maps to each backend's native Tab primitive — tmux `new-window`, herdr
  `tab create` — never a split pane. `workspace` maps to each backend's own **visible** space — herdr
  `worktree create` (a new workspace nested under the source), tmux `new-window` (a window visible in
  the status bar). Every placement opens without stealing the caller's focus.
- **Multiplexer detection is two-mode** — `probeMultiplexer` first trusts `$CYBER_MUX`
  (`tmux`|`herdr`|`screen`|`none`) outright — this doubles as an override (`=none` forces no-mux even
  inside a real multiplexer). Failing that it walks the process ancestry from `$$` looking for a
  `tmux`/`tmux: server`, `herdr`, or `screen` ancestor; `$TMUX`/`$HERDR_ENV` are used only as a
  fast-positive hint the walk falls back to when it is itself inconclusive, never trusted alone.
  `doctor` runs discovery and prints an `export CYBER_MUX=<m> CYBER_MUX_PANE=<p>` hint so a caller
  can pin the fast-path.
- **The backend reports whether a pane is currently focused** — a pane locator resolves to `focused`,
  `not-focused`, or `unknown`, so a caller can tell whether a human is actually viewing a pane before
  spending a turn on it. A pane is **focused** only when a live client is currently displaying it.
  Each backend answers with its own primitive: on **tmux**, the pane is the active pane of the
  current window in a session with an attached client (`pane_active` + `window_active` +
  `session_attached`) — any of those unset is **not-focused**; on **herdr**, the pane record's own
  `focused` flag (`pane get <id>`). A backend that has no primitive to report focus — or a query that
  errors or names a pane the backend can no longer resolve — answers **unknown** (a tri-state, not a
  boolean) so callers **fail open** — treat unknown as "go ahead" rather than as "absent" — never
  suppressing behavior on a mux that simply can't tell. This is a **read-only** probe: it moves no
  focus and opens nothing (unlike `focus`, which drives the attached client's view to a pane).

**Non-goals** — the `nudge` (send-and-verify-turn-taken) and `worktree` (git-worktree) helpers
(`nudge.ts`, `worktree.ts`) — provisional standalone concerns per the `cli.ts` verb-surface note,
not yet exposed as CLI verbs and not yet specced; the unit registry, mail, and doorbell that
`cyberlegion` layers on top of a pane once opened — those stayed behind in `cyberlegion`, this repo
owns only backend selection, placement, multiplexer detection, and per-pane send/read/focus/close.

## Multiplexer concept vocabulary

`--at` names a **placement concept**, not a backend-specific command. Every multiplexer nests the
same four levels — **Session › Workspace › Tab › Pane** — but each calls them something different
(notably: a tmux/screen "Window" is the **Tab** level, not a workspace). The adapter maps the
concept onto whatever the live backend calls it:

| Concept       | tmux    | screen | zellij  | cmux                          | Orca                  | herdr     |
| ------------- | ------- | ------ | ------- | ----------------------------- | --------------------- | --------- |
| **Session**   | Session | Session| Session | App (state saved on restart)  | ----                  | Session   |
| **Workspace** | ----    | ----   | ----    | Window/Workspace              | Worktree (git branch) | Workspace |
| **Tab**       | Window  | Window | Tab     | Vertical Tab (w/ git status)  | Tab                   | Tab       |
| **Pane**      | Pane    | Region | Pane    | Split Pane                    | Pane                  | Pane      |

`cyber-mux` drives two of these backends (tmux, herdr). `--at` exposes three of the levels —
`pane:right`/`pane:down` (**Pane**), `tab` (**Tab**), `workspace` (**Workspace**). The property
`workspace` guarantees is **its own space, VISIBLE in the attached client and navigable** — not a
structural tier. tmux, having no Workspace level, maps `workspace` onto the finest unit that keeps
that property: a new **Window** (visible in the status bar, `select-window`-able) — the same unit
`tab` maps to, so under tmux `workspace` and `tab` collapse to a Window. It is deliberately **not** a
new detached **Session** (`new-session -d`): a detached session is invisible to the attached client
and unreachable by beaming (`focus`), so a pane is never opened there — a truly detached session
would be a separate explicit intent, out of scope. There is no `window` value — "window" is tmux's
local name for the **Tab** concept, already covered by `tab`.

Every scenario in [`mux.feature`](./mux.feature) maps to one of these behaviors:

| Behavior | What it covers |
|---|---|
| **backend selected by environment** | tmux vs herdr selection; neither present errors |
| **placement** | `--at` choices; tab honored per backend, never a split; `workspace` → each backend's own visible space (herdr nested workspace, tmux window), never a detached tmux session; omitted `--at` falls back to `tab` |
| **multiplexer detection is two-mode** | `$CYBER_MUX` fast-path + override; ancestry walk; hint fallback; `doctor` hint |
| **mux mode** | reports the detected session backend; "none" (exit 0) when no adapter is selectable |
| **pane focus reporting** | tri-state focused / not-focused / unknown per backend (tmux: pane+window active & session attached; herdr: pane record `focused`); a query that can't be answered → unknown so callers fail open |
