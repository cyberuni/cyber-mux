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
  `workspace create`, tmux `new-window` (a window visible in the status bar). Every placement opens
  without stealing the caller's focus. `open` is placement and nothing more: the workspace it makes
  carries no worktree record even when its cwd is a checkout, so it is never grouped with a repo —
  that is the `worktree` verbs' job, below.
- **A split can be told which pane, how big, and what environment** — three options on the seam's
  own open contract shape a `pane:*` placement, and none of them is a CLI flag: a caller reaches them
  through the adapter. The layout capability is one such caller. What a template *does* with them is
  [`layout/`](../layout/README.md)'s business; what they *mean* is this node's.
  - **`from` names the pane to split, and passing it is the only way `pane:right` means the same
    thing on both backends.** Omitting it does not mean "the calling pane" — it means "whatever this
    backend defaults to", and the two defaults disagree while both tracking the pane the *user* is
    looking at: tmux always splits the session's active pane and ignores `$TMUX_PANE` entirely; herdr
    resolves `--current` from `$HERDR_PANE_ID`, silently falling back to the UI-focused pane when
    that is unset. They agree whenever a human is typing and diverge exactly when a program is
    driving — which is when this seam's callers are running. `tab` and `workspace` split nothing, so
    they ignore it.
  - **`ratio` is the fraction kept by the ORIGINAL pane, and the sign convention is the trap** — the
    two backends convert in **opposite** directions. herdr's `--ratio` sizes the original, so the
    number passes through unconverted; tmux's `-l` sizes the **new** pane, so it takes `1 - ratio`.
    Applying the inversion to both, or to neither, is the single most likely way to get a split
    backwards. Omitted, each backend takes its own even default. Ratio is a *split* concept: a tab or
    workspace is never sized against a pane, so it is not passed there.
  - **A backend declares whether it can size a split at all**, so a caller can degrade a ratio rather
    than fail on a backend that cannot honor one — the degrade *policy* is the caller's, not this
    seam's (layout warns once and takes the default). Both real backends can size, so both declare
    it; silence is taken as cannot.
  - **`env` is set natively at the birth of whatever tier opens — not just a split.** Both backends
    take a repeatable flag on every space-creating command (herdr `--env KEY=VALUE`, tmux
    `-e KEY=VALUE`), one per variable. That breadth is load-bearing rather than incidental: a pane
    pool's root pane is born by the region open and never by a split, so a seam that scoped env to
    `pane:*` would drop it silently exactly where a caller needs it. Valid with or without a launch —
    a pane with env and no command is a blank shell with that env set. The one exception is herdr's
    **worktree** verbs, whose create/open take no env parameter and refuse the flag outright; env is
    dropped there rather than failing the checkout.

  **Boundary — the seam does not validate `ratio`.** It renders whatever number it is given; the
  `0 < ratio < 1` bar belongs to the caller (layout's schema enforces it, and is where a degenerate
  ratio is refused). An adapter author owes the rendering, not the range check.

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

- **`open` returns the workspace the new pane landed in, and reports it** — not just the pane's id,
  so a caller holding several panes can group them by the space they occupy. The seam is the fact's
  source; every surface reads it from there rather than asking again — `open` prints it beside the
  pane, and the layout manifest ([`layout/`](../layout/README.md)) carries it for a whole pool.
  Reporting it costs **nothing**: the backend already answered when the pane was opened, so a
  surface that hid it would be discarding a fact it already held. A backend with no workspace tier
  reports **absent** rather than a false "none" — the same absent-rather-than-false convention the
  focus probe's `unknown` follows, and the reason tmux (where `workspace` and `tab` both collapse to
  a Window) reports nothing here. On herdr the answer costs **no extra call**: every route already
  emits the pane's own `workspace_id` in the output the pane id is read from — a created workspace
  reports itself, a new tab reports the workspace it was created in, and a split reports the
  workspace it landed in, which is the caller's. Established empirically against herdr 0.7.4.

  This is **occupancy** — which workspace a pane *lives in* — and it is a different question from the
  worktree **binding** below, though both concern the one workspace tier. A worktree opened at a
  `pane:right` placement lives in the caller's workspace while being bound to none: the pane has a
  workspace, the worktree is still ungrouped. The two are reported by separate outputs and neither
  answers for the other — `open` never claims a grouping, and a binding is never inferred from where
  a pane happens to sit.

- **The checkout itself is always plain `git worktree`** — host-neutral, no legion/unit-registry
  concepts. `add` defaults the checkout path to a sibling of the primary checkout
  (`<parent>/<repo>.worktrees/<branch>`, ported from `cyberlegion`'s `resolveUnitWorktreePath`
  convention), never nested inside the primary's own working tree; `--path` overrides it, `--base`
  sets the branch's start-point. The default holds on **every** backend rather than deferring to a
  multiplexer's own layout (herdr would use `~/.herdr/worktrees/<repo>/<branch>`), so a path means
  the same thing everywhere. `remove` is the safe path ported from `cyberlegion`'s `decommission`:
  it refuses the primary checkout (absolute — `--force` never overrides it), tolerates a worktree
  already gone from disk, and refuses to discard uncommitted changes unless `--force` is passed.

- **A backend either binds a worktree to a workspace, or it does not** — and that binding, *not*
  "knows what a git worktree is", is the capability a backend has or lacks. It is what a
  multiplexer's UI groups a repo's primary checkout and its worktrees by. Established
  **empirically**, because it is not visible in either tool's documentation: `git worktree add`
  followed by herdr `workspace create --cwd <checkout>` yields a workspace with **no worktree
  record** — herdr does not know it is a worktree and leaves it out of the repo's group; only
  routing through herdr's own `worktree create`/`worktree open` produces one. (herdr's `worktree
  list` still shows the ungrouped checkout with an `open_workspace_id`, matching it by path after
  the fact — the list view is misleading here; the workspace record is the truth.) tmux has no
  workspace tier at all and never binds.

- **git owns the worktree facts; a backend contributes only the binding** — path, branch, linked,
  and prunable are read from git on **every** backend, so two backends can never report a different
  branch for the same worktree. A multiplexer that also enumerates worktrees is merely re-reading
  git; the one fact git cannot answer is which workspace a worktree is currently open in, and that
  is the only thing asked of a backend.

- **`worktree add` is plain git until a placement is asked for** — with neither `--at` nor
  `--launch` it creates a checkout, opens nothing, and resolves no backend, so it works outside any
  multiplexer. There is nothing to group because nothing was opened. `--launch` implies
  `--at workspace`: a launch wants its own space rather than a pane crowding the caller's, and
  `workspace` is the only placement a binding can attach to.

- **Grouping happens iff the backend binds and the placement is `workspace`** — herdr's `worktree
  create` *always* opens a workspace, so it cannot serve a pane or tab placement. (It also opens a
  workspace for the **source** checkout when the repo has none — a group needs its parent.)

- **A placement the binding cannot serve degrades; it never fails** — `--at pane:right --branch b`
  on herdr yields a worktree open in a split pane: a complete, useful outcome, just not a grouped
  one. Refusing would make identical flags succeed on tmux and fail on herdr — precisely the backend
  leak this seam exists to prevent. The report is a **field, not prose**: `workspace: null`, with a
  note on stderr so `--format json` stays machine-readable on stdout. Degradation is claimed only
  where the backend *could* have grouped and the placement is what cost it — never on tmux, where no
  grouping was ever on offer.

- **`worktree open` groups a worktree plain git created earlier** — the remedy that makes "add now,
  group later" a first-class story rather than a dead end, and the counterpart to a bare `add`.

- **`worktree list` and `worktree remove` answer outside a multiplexer** — both are git questions; a
  backend can only ever add a binding to the answer, so its absence must not deny one.

- **Removal is never delegated to a backend** — only the binding's release is. A backend's own
  worktree-removal primitive addresses a *workspace* (herdr's takes a workspace id), so it cannot
  reach an unbound worktree at all, and whether it dirty-checks is unknown; delegating would make a
  destructive operation's safety depend on whether a workspace happened to be open. **Gate order is
  a specified property, not an implementation detail**: every gate runs *before* the workspace is
  released, so a refused removal has no side effect; the release runs *before* git removes the
  checkout, so no workspace is left pointing at a directory that no longer exists.

- **`--label` names whatever `--at` opened, at whatever tier it opened it** — host-neutral, because
  every backend names every tier: on herdr a workspace/tab/pane label, on tmux a window name (where
  `workspace` and `tab` both collapse to a Window) or a pane title. Each backend takes it at birth
  where its own CLI allows (herdr `workspace create --label`/`tab create --label`, tmux
  `new-window -n` — which also turns tmux's `automatic-rename` off, so the name survives whatever
  the pane goes on to run) and names it immediately after where it does not (herdr `pane rename`,
  tmux `select-pane -T`). Omitted, each backend keeps its own default.
- **A worktree's default label is the backend's own** — worth knowing that `worktree add` always
  passes `--path` (to hold the sibling convention across backends), and herdr labels a workspace by
  the checkout path's **basename** when given one, using the branch only when it picks the location
  itself. So branch `feat/deep/name` defaults to a workspace labeled `name`. `--label` is the
  override.

**Non-goals** — the `nudge` (send-and-verify-turn-taken) helper (`nudge.ts`) — a provisional
standalone concern per the `cli.ts` verb-surface note, not yet exposed as a CLI verb and not yet
specced; the unit registry, mail, and doorbell that `cyberlegion` layers on top of a pane once
opened — those stayed behind in `cyberlegion`, this repo owns only backend selection, placement,
multiplexer detection, per-pane send/read/focus/close, and the worktree surface above.

Also a non-goal: **any worktree fact a backend reports of its own** — git answers those on every
backend, so a multiplexer is never asked; see the use cases above. Naming a **tab inside** a
workspace is likewise out: herdr labels a new workspace's root tab `1` with no flag to change it
(only `tab rename` after the fact), and the workspace label is what its UI groups by.

- **Typing text and pressing keys are separate verbs; only `submit` presses Enter *for you*** —
  driving a pane's input splits on whether Enter is **implied**. `send text` and `send keys` never add
  an Enter the caller did not write; `submit` always adds one. Three verbs cover it:
  - **`send text <pane> <text>`** — type literal characters, press **no** Enter. A word that happens
    to name a key (`Enter`, `Up`) is typed as those characters, never interpreted as that key.
  - **`send keys <pane> <keys...>`** — press named keys in order, each its own key, typing nothing.
    Keys are named in a **portable core vocabulary** — `Up` `Down` `Left` `Right` `Enter` `Escape`
    `Tab` `Space` `Backspace` `C-c` `F1`–`F12` — normalized onto whatever each backend calls them
    (`Backspace` → tmux's `BSpace` is the only rename). A token **outside** the core is forwarded
    verbatim: it reaches backend-specific keys (`Home`, `M-x`) at the cost of portability, and its
    failure is the backend's own — herdr refuses an unknown key (`unsupported key <k>`), while
    **tmux has no refusal path** and types the token as characters. Neither reaches the caller today:
    the `Exec` seam discards a backend's stderr and reports failure as `null`, so `send keys` exits 0
    either way. That gap is the seam's, not this verb's — it predates the split and affects every
    verb; a follow-up owns it. `Enter` is a key like any other: `send keys <pane>
    Enter` **does** press it and **does** take the pane's turn — because the caller asked for it, not
    because the verb implied it. `send keys` adds nothing.
  - **`submit <pane> [text]`** — **always** presses Enter. Given text it types it — **literally, on
    the same guarantee `send text` gives**: text that happens to name a key is typed, never
    interpreted — and presses Enter, taking the pane's turn. Given no text (or empty text) it sends a
    **bare Enter only**, flushing an already-staged input buffer without re-typing it, so a repeated
    flush cannot duplicate the message. `submit` is the verb *for* taking a turn — `open --launch`
    uses it — and the only one that supplies the Enter itself. The guarantee is that **outcome**,
    never a particular
    backend command: a backend with an atomic text-plus-Enter primitive uses it, one without composes
    typing and Enter.

  Every live view a bare `cyber-mux send` could derive already belongs to a verb — the pane
  enumeration to `list`, the current pane to `doctor` — so rather than ship a second name for an
  existing verb, a bare `send` is treated as *incomplete input*: help to stderr, exit 1, stdout clean.
  That is an acknowledged **amendment** to [`axi/`](../axi/README.md)'s content-first principle (#8),
  scoped and filed there — not an application of it.

  The core vocabulary is **probed, not derived** from either backend's documentation, and it is the
  whole of the portable set: everything else diverges, `C-c` is the only portable control key, and
  the `Backspace` spelling is a judgment call the probe underdetermines. Why each of these was
  decided the way it was — and what it costs — is logged in
  [`design/decisions/`](../design/decisions/README.md), not restated here.

**Non-goals** — the `nudge` (send-and-verify-turn-taken) and `worktree` (git-worktree) helpers
(`nudge.ts`, `worktree.ts`) — provisional standalone concerns per the `cli.ts` verb-surface note,
not yet exposed as CLI verbs and not yet specced; the unit registry, mail, and doorbell that
`cyberlegion` layers on top of a pane once opened — those stayed behind in `cyberlegion`, this repo
owns only backend selection, placement, multiplexer detection, and per-pane
send/submit/read/focus/close.

## Multiplexer concept vocabulary

`--at` names a **placement concept**, not a backend-specific command. Every multiplexer nests the
same four levels — **Session › Workspace › Tab › Pane** — but each calls them something different
(notably: a tmux/screen "Window" is the **Tab** level, not a workspace). The adapter maps the
concept onto whatever the live backend calls it:

| Concept       | tmux    | screen | zellij  | cmux                          | Orca                  | herdr     |
| ------------- | ------- | ------ | ------- | ----------------------------- | --------------------- | --------- |
| **Session**   | Session | Session| Session | App (state saved on restart)  | ----                  | Session   |
| **Workspace** | ----    | ----   | ----    | Window/Workspace              | Worktree (git branch) | Workspace (bindable to a git worktree) |
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
| **placement** | `--at` choices; tab honored per backend, never a split; `workspace` → each backend's own visible space (herdr `workspace create`, tmux window), never a detached tmux session; a workspace `open` makes is bound to no repo; omitted `--at` falls back to `tab` |

| **placement** | `--at` choices; tab honored per backend, never a split; `workspace` → each backend's own visible space (herdr nested workspace, tmux window), never a detached tmux session; omitted `--at` falls back to `tab` |
| **split options — which pane, how big, what environment** | `from` targets a `pane:*` split on both backends (tmux `-t`, herdr positional) and is ignored by `tab`/`workspace`; omitted, each backend takes its own default, which tracks the user's focus rather than the caller's. `ratio` is the fraction kept by the ORIGINAL pane and converts in opposite directions (herdr passes it through, tmux inverts to `1 - ratio`); omitted, each backend splits evenly; never passed to a tab or workspace. Each backend declares whether it can size a split at all. `env` is native at the birth of every tier on both backends, one repeated flag per variable, with or without a launch — except herdr's worktree verbs, which take no env param and drop it |
| **text and keys are separate; only submit presses Enter for you** | `send text` types literal characters and presses no Enter (a key-named word is typed, not interpreted; no text → rejected); `send keys` presses named keys in order and types nothing — core keys normalized onto each backend, a non-core token forwarded verbatim to the backend's own semantics (no tokens at all → rejected); `send keys Enter` presses Enter and takes the turn, because the caller wrote it; bare `send` is incomplete input — help to stderr, exit 1, stdout clean (an acknowledged amendment to axi #8, not an application of it); `submit` always presses Enter — with text it types it literally then Enters, with none (or empty text) it bare-Enter flushes without retyping; `open --launch` submits |
| **multiplexer detection is two-mode** | `$CYBER_MUX` fast-path + override; ancestry walk; hint fallback; `doctor` hint |
| **mux mode** | reports the detected session backend; "none" (exit 0) when no adapter is selectable |
| **pane focus reporting** | tri-state focused / not-focused / unknown per backend (tmux: pane+window active & session attached; herdr: pane record `focused`); a query that can't be answered → unknown so callers fail open |
| **open returns the pane's workspace, and reports it** | the workspace the new pane landed in, per placement on herdr (a created workspace reports itself; a tab reports the workspace it was created in; a split reports the caller's); absent on a backend with no workspace tier; read from the output the pane id already comes from, so it costs no extra call; reported beside the pane by `open` itself and carried for a pool by the layout manifest; occupancy is never a worktree binding |
| **git worktree helpers** | `worktree add` defaults the path to a sibling of the primary checkout on every backend; `--base` sets the start-point; `worktree remove` refuses the primary checkout, tolerates an already-gone worktree, and refuses uncommitted changes unless `--force` |
| **worktree/workspace binding** | a bare `add` opens nothing and resolves no backend; `--launch` implies `--at workspace`; `--at workspace` groups where the backend binds and falls back where it does not; a pane/tab placement degrades (reports no workspace) rather than failing, and only where a grouping was on offer; `open` groups a checkout plain git made |
| **naming what was opened** | `--label` names the tier `--at` opened, on every backend (herdr workspace/tab/pane label; tmux window name or pane title); taken at birth where the backend's CLI allows, set immediately after where it does not; omitted leaves the backend's own default |
| **worktree facts vs binding** | `list` reads path/branch/linked/prunable from git on every backend and reports only the binding from the backend; `list`/`remove` answer with no multiplexer |
| **worktree removal ordering** | never delegated to a backend — cyber-mux's gates plus git, the backend only releasing its binding; gates run before the release (a refused removal has no side effect); the release runs before git's removal (no workspace on a dead directory), including for a checkout already gone |
