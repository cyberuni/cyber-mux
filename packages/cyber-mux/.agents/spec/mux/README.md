# mux — the pane abstraction

The `cyber-mux` CLI's entire subject: which session backend (tmux, herdr, or wezterm) is available,
where a new pane opens, how a caller detects the multiplexer it is really running inside, how a
pane's turn is driven, how a pane is addressed, and the git-worktree surface above all of it. Ported
from `cyberlegion`'s `spec/mux/` (`packages/cyberlegion/.agents/spec/mux/`, ADR-0024/ADR-0021) when
the mux seam was extracted into this standalone repo (scaffold commit `21557b4`) — adapted from
`cyberlegion`'s command-group verbs (`unit spawn`, `cyberlegion mux doctor`) to this repo's flat
verb surface (`open`, `doctor`, `mode`) and env names (`CYBERLEGION_MUX*` → `CYBER_MUX*`).

This node is an **index**: it owns no suite of its own. The behavior lives in the five unit specs
below, each with its own `.feature`. The unit registry, mail, and doorbell that `cyberlegion` layers
on top of a pane once opened stayed behind in `cyberlegion`; this repo owns only backend selection,
placement, multiplexer detection, per-pane send/read/focus/close, and the worktree surface.

> **The CLI surface of each unit lives under [`cli/`](../cli/README.md).** Each `mux/X` unit holds its
> **surface-independent contract** (adapters, detection/selection, resolution, drive primitives, git
> facts); the `cyber-mux <verb>` presentation for it — the verbs, flags, exit codes, table rendering,
> and the shared AXI error contract — lives in the mirror node `cli/X`, per the CLI-surface axis in the
> [root spec](../spec.md). So where a row below still reads as owning a verb's read-out or usage error,
> that surface now belongs to `cli/X`; the unit owns the contract that verb invokes.

## The units

| Unit | Owns |
|---|---|
| [`detection/`](./detection/README.md) | Detection and backend selection — the two-mode probe (`$CYBER_MUX` fast-path, else the process-ancestry walk), which adapter that selects, `doctor`'s pin hint, and `mode`'s report. |
| [`placement/`](./placement/README.md) | Where a new pane opens and what `open` reports back — the `--at` tiers, split options (`from`, `ratio`, `env`) and the `--env` CLI surface, the workspace group, naming a space at and after its birth, the optional `--launch`, and the tab/workspace a pane landed in. |
| [`driving/`](./driving/README.md) | Driving a pane's turn — `send text`, `send keys`, and `submit`; only `submit` presses Enter for you. |
| [`lookup/`](./lookup/README.md) | Addressing a pane and the error surface — the id-outranks-name ladder, the ambiguity report, the live pane listing, tri-state focus reporting, and the structured error every verb fails with. |
| [`worktree/`](./worktree/README.md) | The worktree surface — plain `git worktree` helpers plus the worktree/workspace binding a backend contributes. |

## Multiplexer concept vocabulary

The four placement tiers — **Session › Workspace › Tab › Pane** — and what each backend calls them
are defined once in [`glossary.md`](../glossary.md). What follows is this node's *behavior* against
that vocabulary, not a second definition of it.

`--at` exposes three of the levels — `pane:right`/`pane:down` (**Pane**), `tab` (**Tab**),
`workspace` (**Workspace**). The property
`workspace` guarantees is **its own space, VISIBLE in the attached client and navigable** — not a
structural tier. tmux, having no Workspace level, maps `workspace` onto the finest unit that keeps
that property: a new **Window** (visible in the status bar, `select-window`-able) — the same unit
`tab` maps to, so under tmux `workspace` and `tab` collapse to a Window. It is deliberately **not** a
new detached **Session** (`new-session -d`): a detached session is invisible to the attached client
and unreachable by beaming (`focus`), so a pane is never opened there — a truly detached session
would be a separate explicit intent, out of scope. There is no `window` value — "window" is tmux's
local name for the **Tab** concept, already covered by `tab`.

**WezTerm's own native tiers are Workspace › Window › Tab › Pane** — a genuine fourth level between
Workspace and Tab that neither tmux nor herdr has, and it is what `--at workspace` maps onto: a new
**Window**, spawned into a fresh (or caller-named) **Workspace** via `wezterm cli spawn --new-window
--workspace <name>` — never a bare new tab in the current window/workspace, and never wezterm's own
higher-level "switch workspace" affordance, which the CLI does not expose a command for at all.
`--at tab` maps onto a real wezterm **Tab** in the current window (`wezterm cli spawn`, no
`--new-window`) — never a new Window, and never a new Workspace. Both collapse onto tmux's one
Window level; wezterm keeps them genuinely distinct.

Every scenario across the five unit suites maps to one of these behaviors:

| Behavior | What it covers |
|---|---|
| **backend selected by environment** | tmux vs herdr selection; neither present errors |
| **placement** | `--at` choices; tab honored per backend, never a split; `workspace` → each backend's own visible space (herdr `workspace create`, tmux window), never a detached tmux session; a workspace `open` makes is bound to no repo; omitted `--at` falls back to `tab` |
| **split options — which pane, how big, what environment** | `from` targets a `pane:*` split on both backends (tmux `-t`, herdr positional) and is ignored by `tab`/`workspace`; omitted, each backend takes its own default, which tracks the user's focus rather than the caller's. `ratio` is the fraction kept by the ORIGINAL pane and converts in opposite directions (herdr passes it through, tmux inverts to `1 - ratio`); omitted, each backend splits evenly; never passed to a tab or workspace. Each backend declares whether it can size a split at all. `env` is native at the birth of every tier on both backends, one repeated flag per variable, with or without a launch — except herdr's worktree verbs, which take no env param and refuse the flag; that route reports to its caller that it could not carry env (both directions of the report are pinned, so neither answer can be hardcoded), and the caller then compensates — prefixing `env K=V` onto the command where there is one, warning on stderr where there is none, and never prefixing over a native set |
| **open returns the pane's tab, and reports it** | the tab the new pane landed in, per placement on every backend (herdr: a new tab reports itself, a created workspace its root tab, a split the caller's; tmux: the Window the pane landed in); reported by every backend and absent on none, because every multiplexer has the Tab level; read from the output the pane id already comes from on tmux/herdr, so it costs no extra call there — wezterm's spawn/split-pane report only the bare pane id, so its tab (and, on a tab or pane:* placement, its workspace) cost one follow-up `list --format json` call; it is what addresses a rename at the tab tier, which a pane id cannot do portably |
| **naming a space after its birth** | every backend renames every tier it can name at birth (tmux a window name or pane title; herdr a tab or pane rename); a new workspace's root tab is named this way because herdr offers no flag to name it at birth; a rename moves no focus and opens nothing |
| **the workspace group — carrying a grouping a backend has no tier for** | the open contract carries an opaque group id, never parsed, split, or derived from the label; a backend with no workspace tier stores it natively (tmux: a window option it can filter on, surviving a rename); a backend with a real workspace tier ignores it, its tier being the group; no id is invented for a caller that did not ask; the id is not a workspace, so `open` still reports the workspace absent; grouping is also a **verb** over an already-open space, which `open`'s own option routes through; a backend whose display name is composed stores the space's **own name** beside the group, since one name field means composing destroys the original |
| **text and keys are separate; only submit presses Enter for you** | `send text` types literal characters and presses no Enter (a key-named word is typed, not interpreted; no text → rejected); `send keys` presses named keys in order and types nothing — core keys normalized onto each backend, a non-core token forwarded verbatim to the backend's own semantics (no tokens at all → rejected); `send keys Enter` presses Enter and takes the turn, because the caller wrote it; bare `send` is incomplete input — help to **stdout**, **exit 2**, axi #6's `usage error` for a missing required parameter (it is #6 that decides this, not #8); `submit` always presses Enter — with text it types it literally then Enters, with none (or empty text) it bare-Enter flushes without retyping; `open --launch` submits |
| **addressing a pane by name or id** | every pane-taking verb accepts either; an id outranks a name and is recognized by matching a live pane rather than by the string's shape; exactly one match resolves; zero is the existing not-found path (exit 1); two or more fail with the candidates (id, label, cwd — each id usable as the retry) as a structured `ambiguous-pane` error on **stdout** honoring `--format`, exit 2 on every verb — axi #6's own `usage error`, an underspecified argument, applied rather than amended; `exists` keeps `live`/`gone` on stdout and spends the code rather than a fourth word; the listing reports only a label a person set, never tmux's hostname default |
| **multiplexer detection is two-mode** | `$CYBER_MUX` fast-path + override; ancestry walk; hint fallback; `doctor` hint |
| **mux mode** | reports the detected session backend; "none" (exit 0) when no adapter is selectable |
| **pane focus reporting** | tri-state focused / not-focused / unknown per backend (tmux: pane+window active & session attached; herdr: pane record `focused`); a query that can't be answered → unknown so callers fail open |
| **open returns the pane's workspace, and reports it** | the workspace the new pane landed in, per placement on herdr (a created workspace reports itself; a tab reports the workspace it was created in; a split reports the caller's); absent on a backend with no workspace tier; read from the output the pane id already comes from, so it costs no extra call; reported beside the pane by `open` itself and carried for a pool by the template manifest; occupancy is never a worktree binding |
| **git worktree helpers** | `worktree add` defaults the path to a sibling of the primary checkout on every backend; `--base` sets the start-point; `worktree remove` refuses the primary checkout, tolerates an already-gone worktree, and refuses uncommitted changes unless `--force` |
| **worktree/workspace binding** | a bare `add` — none of `--at`, `--launch` or `--env` — opens nothing and resolves no backend, which is what makes it the only route that works outside a multiplexer at all; `--launch` and `--env` each imply `--at workspace`, both being a request for something IN a pane; `--at workspace` groups where the backend binds and falls back where it does not; a pane/tab placement degrades (reports no workspace) rather than failing, and only where a grouping was on offer, the caller told through a stdout `help[N]:` entry naming `--at workspace` per [`axi.md`](../axi.md)'s #9; `open` groups a checkout plain git made |
| **`--env`, the CLI surface for the seam's env option** | repeatable `--env KEY=VALUE` on every verb that opens a pane (`open`, `worktree add`, `worktree open`) — the one split option with a flag, since a variable not set at birth cannot be set at all; it names the pane the verb opens, exactly one being opened on each route, **except** on herdr's worktree bind route, where it degrades to a prefix on `--launch` or a stderr warning with no command to ride — stated on BOTH worktree verbs, which are exposed identically; refused alongside `--template`, which owns its own panes' env; implies a placement; a missing `=` is rejected before anything opens, a trailing `=` sets the variable empty, and a value's own `=` survives by splitting on the first only |
| **naming what was opened** | `--label` names the tier `--at` opened, on every backend (herdr workspace/tab/pane label; tmux window name or pane title); taken at birth where the backend's CLI allows, set immediately after where it does not; omitted leaves the backend's own default |
| **worktree facts vs binding** | `list` reads path/branch/linked/prunable/merged/dirty from git on every backend and reports only the binding from the backend; `list`/`remove` answer with no multiplexer |
| **disposability — needed, not merely free** | `merged` (tip is an ancestor of the repo's default branch, itself resolved rather than assumed) and `dirty` (uncommitted changes) join the binding into one composite the table compresses to `(removable)` on the branch; the composite is a rendering and never a payload field, every signal degrades to an absent field rather than `false`, and the listing reports without ever acting on what it reports |
| **the listing's render contract** | a one-bit fact earns a **marker on the column it is about**, never a column of its own — primary checkout `<branch> (*)`, vanished checkout `<path> (gone)`; a home-rooted path collapses to `~` (matched at a path boundary, the same shortening axi/'s #10 owes the home view); every marker is human-surface only — the boundary being the surface, not one `--format` value, so **every** structured payload keeps each field and the absolute path |
| **worktree removal ordering** | never delegated to a backend — cyber-mux's gates plus git, the backend only releasing its binding; gates run before the release (a refused removal has no side effect); the release runs before git's removal (no workspace on a dead directory), including for a checkout already gone |
