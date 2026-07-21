# cyber-mux

## 0.3.0

### Minor Changes

- cd74775: Expose a library API. `cyber-mux` now publishes real entry points beside the CLI:

  - `cyber-mux` — the multiplexer core: `resolveMux`, which returns a `MuxSession` with `Exec` bound
    (`mux.open(opts)`, no runner threaded per call), over the raw exec-injected `MuxAdapter` contract
    and its types reached via `resolveMuxAdapter`; the mux probe (`probeMultiplexer`, `currentPane`);
    `callerPane`; the tmux/herdr/wezterm adapters; `nudge`; and the `Exec`/`NewId` seams (each a type
    plus its real implementation).
  - `cyber-mux/worktree` — the git-worktree adapter (`resolvePrimaryRoot`, `assertDistinctFromPrimary`,
    `gitWorktreeAdapter`, `listWorktreesFromGit`, `removeWorktreeSafely`, and the `WorktreeFs` seam),
    plus `worktreeApi(deps?)` — the same helpers with `Exec`/`WorktreeFs` bound.
  - `cyber-mux/template` — template resolution and the `TemplateStore` seam, plus `templateApi(env, deps?)`
    — resolution with `env`/`Exec`/`TemplateStore` bound.

  Every entry ships type declarations, and the core is pure: it takes its effects (`Exec`, `NewId`,
  `WorktreeFs`, `TemplateStore`) as parameters, with the real implementations exported as separate
  named values, so a host binds them once and tests drive fakes. `probeMultiplexer` gains an
  `envPrefix` option so a host embedding cyber-mux under its own namespace adopts the env fast-path
  without forking detection. The CLI bin is unchanged.

  The package also ships its TypeScript source (tests excluded) alongside declaration maps, so
  go-to-definition on any exported symbol lands in real source rather than a generated `.d.ts`.

  Pre-1.0, depend on this with a caret range (`^0.2.0`); a 0.x minor may still carry breaking changes.

- 90daa48: `cyber-mux template edit [<name>]` shows a template's panes and fills them in — the other half of
  `template save`, which captures geometry but lands with no `command` on any pane.

  The bare form **lists and mutates nothing**: a table of every pane with its position, label, dir and
  current value, plus `help[N]` suggestions for what to do next. Its `pane` column is verbatim what
  `--set` takes, so acting on the listing is a paste rather than a derivation. Panes are addressed by
  ordinal (`3`, or `2.3` for tab 2 pane 3) and never by label, since two panes may share a label by
  design. A `position` (`top-left`, `right`) is shown because apply order is a tree walk rather than a
  reading order — pane 2 of a 2x2 is the pane below pane 1, not the one beside it.

  `--set <pane>=<value>` writes without a terminal, is repeatable, splits on the first `=` only so a
  value may contain one, and clears the field when the value is empty. Re-running the same `--set` is a
  no-op that exits 0 and leaves the file's mtime alone, so a checked-in template is never dirtied by an
  edit that changes nothing. A batch naming one pane that does not exist writes none of them, and the
  error lists every identifier that would have worked.

  `--interactive` asks one question per pane instead, in apply order, with the current value pre-filled
  into the editable line: Enter keeps, `-` clears, `'-'` is a literal dash, Ctrl-D abandons the edit and
  leaves the file untouched. It refuses when stdin is not a tty or when `--format json|agent` was asked
  for, and points at `--set` instead.

  `--field command|label` picks what both modes write; `--dry-run` prints the result instead of writing
  it. A template's spelling survives either way — one written with the flat `panes`/`arrange` sugar
  comes back out flat rather than re-spelled as a tree.

- ff91915: `worktree list` now answers whether a worktree is still **needed**, not only whether it is occupied.

  Entries carry two new booleans — `merged` (the branch's tip is an ancestor of the repo's default
  branch) and `dirty` (the checkout has uncommitted changes) — read from git on every backend, exactly
  as `linked` and `prunable` are. The default branch is resolved from `origin/HEAD`, falling back to the
  primary checkout's branch; `main` is never hardcoded.

  The table compresses those two, plus the workspace binding, into a single `(removable)` marker on `BRANCH`
  — merged **and** clean **and** unoccupied, i.e. safe to remove. It rides on `BRANCH` because the
  branch is what carries the work that landed, and it is mutually exclusive with `(*)`, so no row ever
  shows two markers. `--format json` is unmarked as always: consumers read the raw `merged` and `dirty`
  booleans and compose their own policy.

  A squash or rebase merge rewrites the commits, so such a branch reads `merged: false` and goes
  unmarked — the signal errs toward "still needed" deliberately. Any signal git cannot determine (a
  detached HEAD, a `prunable` entry, no default branch) is an **absent** field and an unmarked row, never
  a guess and never a failure.

  This reports only. Removal gating and pruning are unchanged: nothing consults `(removable)` before deleting
  anything.

- 6a36ad6: Add `worktree prune` to remove every disposable worktree in one call — the same gate `worktree list` marks `(removable)` with. The bare form previews the candidates; pass `--force` to actually remove them.
- 20da54f: Add a **Zellij** backend — the fourth multiplexer cyber-mux drives, after tmux, herdr, and WezTerm.

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

### Patch Changes

- c4f2293: `template save` now explains the command limit in terms of **portability** rather than availability,
  and its help text changes accordingly.

  The old wording — "no multiplexer can report the command a pane was launched with" — was true as
  literally phrased and misleading in effect. Probed against live binaries: herdr 0.7.4's `pane
process-info` returns full argv for a pane's whole foreground tree, and `/proc` reaches the same from
  a pid on any backend, so "there is nothing to be had here" was false.

  The real reason a capture writes no `command` is that what a backend reports is the **resolved**
  command line, not the one that was typed: `nr web dev` comes back as
  `node /run/user/1000/fnm_multishells/4223_1784479278417/bin/nr web dev`, a path carrying a uid, a pid
  and a timestamp that is dead on the next machine. A template is meant to be checked in and run
  elsewhere, and applying one **submits** whatever `command` says — so a wrong one fails by executing
  something. Absent beats wrong.

  Behavior is unchanged: a capture still records no `command` on any pane. `template save --help` now
  also names the two `template edit` calls that fill them in.

- 1fa102d: Place every tab of a multi-tab template in the workspace the apply opened. Previously only the first tab landed there — each later tab was created beside the pane the command was run from, because a `tab` placement with no anchor is resolved against the workspace the user is looking at. `SessionOpenOptions` gains `within`, the workspace a `tab` placement opens inside, honored by the herdr and WezTerm backends and ignored by tmux, which has no workspace tier.
- 9af5af2: `CYBER_MUX=screen` is now **rejected with a named error** instead of the generic "run inside a
  multiplexer" throw. GNU Screen is detected — an override pinning it, or a real `screen` ancestor, is
  reported truthfully — but it is **not a drivable backend**, and pinning it now says so plainly.

  The `CYBER_MUX` contract used to name `screen` as an accepted override value alongside
  `tmux`/`herdr`/`wezterm`, but no adapter ever stood behind it, so setting `CYBER_MUX=screen` produced
  `cyber-mux requires a session backend — run inside tmux, herdr, or wezterm` — a lie, since the caller
  _had_ declared a real multiplexer. The value looked supported and was not.

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

- 9c06f45: `worktree list` drops the LINKED column from the table. The primary checkout is marked `(*)` after
  its branch instead, so the one bit that column carried costs no width. `--format json` is unchanged:
  every entry still carries the `linked` boolean.
- 68c28a1: `worktree list` marks a prunable worktree — one whose checkout no longer exists on disk — with
  `(gone)` after its `root` in the table. It rides on `root` because the path is the thing that
  vanished, and `(gone)` is git's own word for it (`branch -vv` prints the same). `--format json` is
  unchanged: entries still carry the `prunable` boolean.
- cc3c5d8: `worktree list` shortens a `root` under your home directory to `~/…` in the table. The match is on a
  path boundary, so `/home/annex` is untouched by a home of `/home/ann`. `--format json` is unchanged:
  consumers still get the absolute path.

## 0.1.0

### Minor Changes

- 0ae7980: Add `cyber-mux worktree add` and `cyber-mux worktree remove` — plain `git worktree` helpers ported from cyberlegion. `add` defaults the checkout path to a sibling of the primary checkout (`<parent>/<repo>.worktrees/<branch>`), never nested inside the primary's own working tree; `--path` overrides it. `remove` refuses the primary checkout (even with `--force`), tolerates a worktree already gone from disk, and refuses to discard uncommitted changes unless `--force` is passed.
- 9665402: Address a pane by name or by id. Every pane-taking verb — `read`, `submit`, `exists`, `focus`,
  `close`, `send text`, `send keys`, and `template save --from` — now accepts a pane's label wherever it
  took an id, so a caller holding a template manifest's `(label, pane)` pairs can address "the `worker`
  pane" without doing the lookup itself.

  An id still wins. A string is taken as an id when a live pane carries that id, and resolved as a name
  only otherwise — so every existing id-based call keeps working and cannot be made to mean something
  else by someone renaming an unrelated pane. An id is recognized by matching a live pane rather than by
  the shape of the string, so a pane labeled `%9` is still reachable by that name.

  A label is a human name, not a key, and nothing requires one to be unique. So a name matching two or
  more live panes **fails rather than guessing**, reporting each candidate's id, label and working
  directory — every id directly usable as the retry — as a structured `ambiguous-pane` error on stdout,
  honoring `--format`. A name matching nothing is the existing not-found path.

  **`cyber-mux exists` gains a third exit code.** `0` still means one match and `1` still means none,
  but `2` now means the locator matched two or more panes — there is no single pane the question is
  about. Exit `2` means ambiguous on every pane verb. Nothing that exits `0` or `1` today changes: a
  name could not be passed at all before this release, so exit `2` is only reachable through the new
  capability.

  **`cyber-mux list` replaces its `mux` column with `label`.** The label is what you now type instead of
  an id, so it is the fact that row exists to carry; `mux` was constant on every row by construction —
  one adapter is selected per session — so the column discriminated nothing. `cyber-mux doctor` is where
  the backend is a live question, and it still reports it.

- 9d027b3: The CLI's error surface now follows [AXI](https://github.com/kunchenguid/axi) on every command, not
  just the one path that already did.

  - **Errors go to stdout, not stderr.** AXI reserves stdout for everything the agent consumes — data,
    errors and suggestions alike — and defines stderr as debug the agent does not read. An error on
    stderr is a report its own reader never sees, so every structured error now writes to stdout.
    Diagnostics (warnings, progress) stay on stderr. This diverges from `cyberplace`, which still puts
    errors on stderr; correcting that shared node is tracked separately.
  - **Every error carries a stable `code` and an actionable `help:` line**, honoring `--format json`.
    A caller matches on the code instead of parsing prose, and the help names the `cyber-mux` command
    that fixes the problem — never `see --help`, and never the underlying multiplexer's raw diagnostic.
  - **Usage errors exit `2`; operation failures exit `1`.** An unrecognized flag, a missing required
    argument, a malformed template name, a mutually exclusive flag pair, and a bare `cyber-mux send` are
    usage errors — the invocation is wrong and the fix is a different one — so they exit `2`. A genuine
    operation failure (no multiplexer, a pane that resolves to nothing, a backend that cannot answer)
    exits `1`. An unknown flag also lists the command's valid flags so the agent self-corrects in one
    turn, validated against the subcommand actually invoked.

  `cyber-mux exists` keeps `1` for `gone` — a predicate answering its question, not an error — as a
  deliberate, documented divergence from AXI's `1 = error`.

- 5d7b7b4: Add `--env KEY=VALUE` (repeatable) to every verb that opens a pane — `open`, `worktree add`, and `worktree open`. The seam and both adapters already set env natively at every tier; this gives it a CLI door, so a caller no longer has to reach for a template to set an environment variable in the pane they open.

  - `--env` splits on the **first** `=`, so a value may contain `=` (`URL=k=v`); a trailing `=` sets an empty value (`ROLE=`); a pair with no `=` is rejected **before** anything opens, so a typo never leaves a half-created worktree behind.
  - On `worktree add`, `--env` implies `--at workspace` for the same reason `--launch` does — asking for something in a pane is asking for the pane. It conflicts with `--template`, whose template owns its own panes' env.
  - On the one route that cannot set env at birth — herdr's `worktree create`/`worktree open`, which take no env parameter — env rides in as an `env KEY=VALUE` prefix on the launch command, and when there is no command to carry it the drop is reported on stderr rather than passing in silence.

- 96dbe39: A failed backend command now says **why** it failed, in the backend's own words: `Exec` gained an optional `lastError`, and every adapter throw site that runs a command carries it through.

  **The gap.** `realExec` ran with `stdio: ['ignore', 'pipe', 'ignore']` and mapped any failure to `null`, so a backend's stderr was discarded **by the seam itself**. Asking for a pane pool too large for the terminal got you:

  ```
  tmux split-window failed
  ```

  while tmux was saying `no space for new pane` the whole time, to a stream nobody read. The failure was _correct_ — the walk stops, reports the panes it built, exits 1, kills nothing — but gave the caller nothing to act on.

  **The change.**

  - `Exec` is now a callable interface rather than a bare function type, carrying an optional `lastError?: string` — the reason the most recent call returned `null`. **A plain arrow function still satisfies it**, so every existing call site and every test fake is unchanged; a runner that never sets it degrades to no reason at all.
  - `realExec` captures stderr and records it, **clearing it on every success** so a reason can never outlive the command that produced it.
  - `withReason(exec, message)` (new, from `exec.ts`) appends the reason when there is one. The eight adapter throw sites that run a command use it.

  ```
  tmux split-window failed — no space for new pane
  ```

  **Why a mutable field and not a result object.** Widening the return to `{ ok, stdout, stderr }` is the tidier seam, and it rewrites 45 production call sites and 40 test fakes for a diagnostic. `Exec` is **synchronous by construction** (`execFileSync`), so "the most recent call" is unambiguous and a throw site reads it on the line after the call that set it. Forwarding stderr to the terminal instead was rejected for a concrete reason: `exists` and the multiplexer probe run commands that fail **routinely**, so it would spam every normal run.

  **Deliberately not everywhere.** `lastError` is a diagnostic, never a control-flow signal — `null` remains the only failure sentinel. Sites that do not run a command do not use it: resolving a pane id out of `list-panes` output is a parse failure, not a command failure, so attributing the runner's most recent reason there would be a confident lie. `send keys` still does not read it, so an unknown key still exits 0 on both backends.

  No behavior changes for a command that succeeds, and no error message changes for a runner that reports no reason.

- 95ec62b: Add `cyber-mux template save <name>` — capture the live pane region around a pane into a named template, so a pool built by hand once can be named rather than transcribed. This closes the schema's one real authoring cost: a 4+ pane grid needs nested `split` nodes nobody wants to type.

  It captures the region around the calling pane by default, or `--from <pane>`'s; writes to the repo's templates directory (`--to user` for your own), refusing to overwrite without `--force`; and prints the written path alone on stdout, so `$(cyber-mux template save pool-4)` composes. Absolute paths never reach the template — a pane under the captured root becomes a relative `dir`, and one outside it loses its directory with a warning.

  **A capture recovers geometry, labels and dirs — never commands**, and that limit is structural rather than a gap: no multiplexer reports the command a pane was launched with, because cyber-mux types commands with `submit` rather than passing them to the split. So a saved template is a draft, and it says so in its own `description`. Fill the commands in before applying it.

  This adds an optional `describeRegion?` member to the `SessionAdapter` seam — "report this region's geometry", answered as one rectangle per pane, with the split tree derived from those rectangles rather than from any backend's own encoding. Both tmux and herdr implement it; a backend that cannot describe its region refuses `save` rather than degrading.

- c456ef9: The two contextual-disclosure suggestions (AXI #9) now ride on **stdout** inside the structured payload as a `help[N]:` block, not on stderr.

  **What moved.** Two "here is your next move" notes were written to stderr, the stream AXI defines as the one an agent does not read — so scope information an agent must act on was landing where it never sees it:

  - `template save` in a multi-tab workspace, when a bare save captured only the caller's own region, noted the tabs it left out.
  - `worktree add`/`open`, when the chosen placement cost the workspace grouping, named the flag (`--at workspace`) that would have grouped it.

  Both now ride in the command's own stdout payload as a `help[N]:` block — a message line and the concrete command that acts on it (`{ message, command }`) — emitted only when there is a next move (AXI #9's omit-when-self-contained rule).

  **Breaking: `template save`'s stdout is now a structured payload, not a bare path.** Its text output is a `path` field (plus the help block when a bare save left tabs behind), and `template save` gained `--format json`, which emits `{ "path": ..., "help": [...] }`. Programmatic composition that read the bare path from `$(cyber-mux template save x)` must move to:

  ```
  cyber-mux template save x --format json | jq -r .path
  ```

  `worktree add`/`open` gain a `help` field on their `--format json` object only when a grouping was lost; the bare, non-degraded shape is unchanged.

- a530024: Add named workspace templates — a reusable template applied against a target directory supplied at
  invocation time. A template names a pool once (geometry, a startup command, and an environment per
  pane) and re-targets it on every apply; nothing about the target directory is ever written into the
  template, and a template carrying a `cwd` fails validation rather than being silently ignored.

  Templates are JSON, resolved by name from `<primaryRoot>/.cyber-mux/templates/<name>.json` and then
  `${XDG_CONFIG_HOME:-~/.config}/cyber-mux/templates/<name>.json`, with the repo winning and `template list`
  marking a user template a repo template shadows. Resolving through the primary checkout means every
  worktree of a project sees the same templates, including a worktree whose branch predates one.

  The schema is a binary split tree (`split`/`pane` nodes, `direction: right|down`, `ratio`,
  `first`/`second`; panes carry `label`/`command`/`env`/`dir`), plus a flat `panes` + `arrange`
  (`tiled`/`even-horizontal`/`even-vertical`) sugar that cyber-mux desugars itself — so one template
  yields one geometry on every backend rather than deferring to each multiplexer's own grid algorithm.

  New verbs: `cyber-mux template list | show [--desugar] | validate`, which take a file as their subject
  and answer with no multiplexer at all. Applying a template is not its own verb — it is `--template` on
  the commands that already open a space (`open`, `worktree add`), the exact sibling of `--launch` and
  mutually exclusive with it. `--format json` emits the apply manifest: every pane created, as
  `(label, pane, dir, command)`.

  Also adds `ratio` and `env` to `SessionOpenOptions`, native on both backends (herdr `--ratio`/`--env`,
  tmux `-l`/`-e`) at both the split and region tiers.

- ad1d15f: `open` now reports the workspace the new pane landed in — both beside the pane it opened and in the `--template` manifest, which stops emitting a `workspace` that is always `null` even on a backend that had just opened a real workspace.

  The manifest is framed as the complete machine-readable answer to _"which panes exist and what are they for"_, but a consumer grouping panes by workspace had nothing to group on: `SessionAdapter.open` returned only a pane id, so nothing downstream had a workspace to report. Only the worktree capability surfaced one, which is why `worktree add --template` got it right and `open --template` did not.

  `open` now returns an `OpenedPane` — the pane handle widened with an optional `workspace`. This is **additive**: the field is optional, so an implementor returning only a pane id still satisfies the seam. On herdr the answer costs no extra call, since every route (`workspace create`, `tab create`, `pane split`) already emits the pane's own `workspace_id` in the output the pane id is read from. A backend with no workspace tier reports it **absent** rather than a false "none" — the same convention `isPaneFocused`'s `undefined` follows — which is why it stays `null` on tmux, where `workspace` and `tab` both collapse to a Window.

  `open` reports it too, not just `--template`: `cyber-mux open --format json` now carries `{ pane, workspace }`. Nothing is looked up to answer that — the backend said so when the pane was born and the seam already held it, so the previous report was discarding a fact it had. `null` on a backend with no workspace tier; the text report omits the line entirely rather than printing a bare null.

  **The reported workspace is occupancy, never a worktree binding.** It says which workspace a pane _lives in_; it does not say a worktree was _grouped_ there. A worktree opened at a `pane:right` placement lives in the caller's workspace while bound to none, and the worktree report keeps answering that question separately and unchanged.

- 5271bfa: `open --launch` is now optional. Running `cyber-mux open` with no `--launch` opens a blank pane instead of requiring a command to launch.
- 1d6c744: Split the turn-driving verbs so that typing text and pressing keys are separate intents, and only `submit` supplies an Enter.

  **Breaking.** `cyber-mux send <pane> <text>` and `SessionAdapter.send()` are gone, replaced by:

  - `cyber-mux send text <pane> <text>` / `sendText()` — type literal characters, press no Enter. Text that happens to name a key (`Enter`, `Up`) is typed, never interpreted as that key.
  - `cyber-mux send keys <pane> <keys...>` / `sendKeys()` — press named keys in order, typing nothing. Keys use a portable core vocabulary (`Up` `Down` `Left` `Right` `Enter` `Escape` `Tab` `Space` `Backspace` `C-c` `F1`–`F12`) normalized per backend; anything outside it is forwarded to the backend as-is.
  - `cyber-mux submit <pane> [text]` / `submit(exec, target, text?)` — gains the optional text `send` used to have: types it, then always presses Enter. With no text (or empty text) it keeps its existing bare-Enter flush, which retypes nothing.

  This fixes a real fault. `send`/`submit` previously passed text straight to `tmux send-keys`, which resolves each argument as a key name before falling back to characters — so submitting text that named a key pressed that key instead of typing it. Submitting `Up` pressed the arrow, recalling the pane's previous command from shell history, and the trailing Enter then **re-ran it**. Typing now goes through `send-keys -l`, which disables key-name lookup.

  Migration: `send(exec, t, text)` → `submit(exec, t, text)` for taking a turn; `submit(exec, t)` is unchanged. On the CLI, `cyber-mux send <pane> <text>` → `cyber-mux submit <pane> <text>`. Bare `cyber-mux send` is now a command group: with no subcommand it prints help to stderr and exits 1.

- e0dc5fa: `--at pane:*` now splits the **calling** pane on both backends, and `SessionOpenOptions` gained `from` to name the pane a split targets.

  **The bug.** `SessionPlacement` is documented as placement "relative to the caller's current one", but neither backend's default delivers that, and they fail in opposite directions:

  - **tmux** ignores `$TMUX_PANE` entirely and splits the session's **active** pane. Verified on tmux 3.6b: a `split-window` run inside pane `%1`, with `$TMUX_PANE` correctly reading `%1`, split the active `%0` instead.
  - **herdr** resolves `--current` from `$HERDR_PANE_ID`, then silently falls back to the **UI-focused** pane when that is unset. Verified on herdr 0.7.4.

  Both defaults track the pane the _user_ is looking at. That coincides with the caller whenever a human is typing, and diverges exactly when a program is driving — so `cyber-mux open --at pane:right` could split whatever pane happened to be focused, with no error. The same command also meant different things on different backends, in the one seam this package exists to make uniform.

  `$CYBER_MUX_PANE` — the documented pane-id fast-path a spawn propagates — was also unreachable from a split, since a backend's own default cannot see it.

  **The fix.** Callers now resolve their own pane and name it, rather than trusting either backend's default: `herdr pane split <id>` instead of `--current`, `tmux split-window -t <id>` instead of no `-t`.

  - `SessionOpenOptions.from?: SessionTarget` — the pane a `pane:*` placement splits. Ignored by `tab`/`workspace`, which split nothing.
  - `callerPane(adapter, env)` (new, from `backend.ts`) — this session's own pane as a target, resolved through the same `$CYBER_MUX_PANE` → `$TMUX_PANE`/`$HERDR_PANE_ID` chain as `currentPane`, so the documented override reaches a split. `undefined` when the pane belongs to a different multiplexer than the adapter drives, rather than handing one backend the other's pane id.
  - `addAndOpenWorktree` / `openExistingWorktree` accept and forward `from`.

  **Behavior change.** On tmux, `--at pane:*` from a pane that is not the active one now splits the caller instead of the active pane. That is the documented contract being honored rather than a new intent.

  Omitting `from` is unchanged: it falls back to the backend's own default, so a caller that cannot identify itself (a cron job, a shell outside any pane) still opens a pane rather than failing.

- 4ecd471: **No label has to be unique any more — not a pane's, not a tab's.** A duplicate `label` was a validation error, and `template save` dropped a shared label from both panes to keep the template valid. That was backwards: a label reaches a live pane because a _person_ renamed it by hand, and `save` exists to capture exactly that — so the rule discarded the very fact the capture was there to preserve. Neither backend asks for uniqueness (herdr labels every new workspace's root tab `1`, so it manufactures duplicates by default), and nothing keys on a name: the manifest's unique handle is the pane id, and it reports a pane's tab by index. A pool of three panes all named `worker` is now a legal template, and a capture keeps every label the user set. Ambiguity belongs to whoever looks a pane up, not to the author.

  A template can describe a **workspace of tabs**, not just one pane tree. `tabs: [...]` is the two-level form — each tab carries its own pane tree in the very same shape `root`/`panes` already accept, sugar included. A template declares exactly one of `root`, `panes`, or `tabs`; the first two are the one-tab spelling and are unchanged. Pane labels stay unique across the whole template (the manifest is one flat list, so its keys are global); tab labels are a separate namespace. `open --template` and `worktree add --template` both build every tab, and the manifest reports the `tab` each pane landed in.

  `template save --workspace` captures a whole workspace back — one tab per live tab, each with its own derived tree. A bare `template save` is **unchanged**: it still captures only the caller's own region, and now notes on stderr when the workspace held more tabs than it took.

  On a backend with a real workspace tier (herdr) a workspace of N tabs maps directly. On one without (tmux, where `workspace` and `tab` both collapse to a Window) the grouping is carried two ways, because one carrier cannot serve both readers: a human reading the status bar gets it in the tab label (`<workspace> - <tab>`, never shortened), while capture reads an opaque window option. The label is **never parsed back** — `acme - beta - main` is ambiguous under every split rule, so parsing would silently mis-group a legal label.

  `SessionAdapter` gains `rename` (name a space after its birth — the one case `--label` cannot serve, since herdr labels a new workspace's root tab `1` with no flag) and `group` (group a space that is already open). `OpenedPane` now carries the `tab` the pane landed in, reported by every backend because every multiplexer has the Tab level, and required to address a rename at that tier: herdr refuses a pane id there while tmux resolves one, so a caller reaching for the pane id would be green on one backend and silently broken on the other.

- a71c120: Add a WezTerm `SessionAdapter`, driven through `wezterm cli` — cyber-mux now runs inside WezTerm's built-in multiplexer alongside tmux and herdr. Detection extends the existing env fast-path via `$WEZTERM_PANE`, the same way `$TMUX_PANE`/`$HERDR_PANE_ID` already work.

  Several real capability gaps fell out of building this adapter against the WezTerm CLI's own reference (no live WezTerm GUI was available to verify against, so this is probed from `wezterm cli --help`/the CLI docs rather than a live binary the way the tmux/herdr adapters are):

  - **No `--env` on `spawn`/`split-pane` at all.** Unlike herdr, which is native everywhere except one worktree route, WezTerm's CLI has no env flag on any space-creating command — every open takes the command-prefix-or-warn fallback, not just one.
  - **No way to title a pane**, at birth or after. `set-tab-title`/`set-window-title` exist; there is no pane equivalent. Renaming a pane throws rather than silently doing nothing; `open`'s pane-tier `--label` degrades to a stderr warning instead of failing the whole open.
  - **No focus-query primitive.** `wezterm cli list --format json` carries no active/focused field for a pane, tab, or window, so `isPaneFocused` always answers `unknown` for this backend — the seam's own honest answer for "no primitive to ask", not a per-query fallback the way it is on tmux/herdr.
  - **No per-key press primitive.** There is no `send-keys`-shaped verb, only `send-text` — the portable core vocabulary is instead realized by encoding each key as its own raw terminal byte sequence and typing it via `send-text --no-paste`.
  - **No pane geometry.** `list --format json` reports a pane's size but never its position, so there is nothing to build a rect from — `describeRegion`/`describeWorkspace` are omitted, same as any backend that cannot describe its own region.
  - **No git-worktree concept in the CLI at all** — like tmux, this backend never binds a worktree to a workspace; callers fall back to plain git plus a placement-appropriate `open()`.

  `--percent` on `split-pane` sizes the **new** pane, the same inversion direction tmux's `-l` needs — not herdr's pass-through of the original pane's fraction. `spawn`/`split-pane` report only the new pane's bare id on stdout, unlike tmux/herdr, so the tab (and, on a tab or pane:* placement, the workspace) cost a follow-up `wezterm cli list --format json` lookup rather than a free read of output already held; the `workspace` placement is the one exception, since the workspace name is chosen by `open()` itself.

- dff6276: Route worktree creation through the multiplexer that binds worktrees to workspaces, so a worktree is **grouped with its repo** where the backend supports it. herdr binds a worktree to a workspace as a first-class record — the binding its UI groups a repo's primary checkout and its worktrees by — and only its own `worktree create`/`worktree open` produce one: `git worktree add` followed by `workspace create --cwd <checkout>` yields a workspace herdr does not know is a worktree at all. tmux has no workspace tier and binds nothing, so callers fall back to plain git plus a normal `open` — same command, both backends.

  `cyber-mux worktree add` takes `--at`, `--launch`, and `--base`. With neither `--at` nor `--launch` it is unchanged: plain git, no backend resolved, works outside any multiplexer (nothing is opened, so nothing can be grouped). `--launch` implies `--at workspace`, the only placement a binding can attach to. A placement that cannot carry a binding degrades rather than failing — a worktree in a split pane is a complete outcome — reported as `workspace: null` plus a note on stderr, so `--format json` stays clean.

  New `cyber-mux worktree open <path>` groups a checkout that plain git created earlier, making "add now, group later" a real story. New `cyber-mux worktree list` reports every worktree of the repo and the workspace each is open in; its path/branch/linked/prunable always come from git on every backend, so two backends can never disagree about the same worktree. `worktree list` and `worktree remove` now answer outside a multiplexer.

  `cyber-mux open`, `worktree add`, and `worktree open` take `--label`, naming whatever `--at` opened at whatever tier it opened it — a workspace, tab, or pane label on herdr; a window name or pane title on tmux (`workspace` and `tab` both collapse to a Window there). Each backend takes it at birth where its own CLI allows (`workspace create --label`, `tmux new-window -n` — which also disables tmux's `automatic-rename`, so the name survives what the pane runs) and names the space immediately after where it does not. Note what you get without it: since `worktree add` always passes `--path` to hold the sibling convention across backends, herdr labels the workspace after the checkout path's basename — `--branch feat/deep/name` yields a workspace named `name` unless you pass `--label`.

  `cyber-mux worktree remove` releases a bound workspace instead of orphaning it, with the gates unchanged and identical on every backend: the checks run _before_ the workspace is released (a refused removal has no side effect) and the release runs _before_ git removes the checkout (no workspace left on a dead directory).

### Patch Changes

- 76ee25b: Fix `list` on the herdr backend to report every live pane, including one with no agent/harness running in it. Previously such panes (a plain tab, an extra split, or a blank pane from `open` with no `--launch`) were silently dropped, contradicting `list`'s own "enumerate every live pane" contract.
- 5de47c3: `cyber-mux worktree add`/`open`/`list`/`remove` no longer leak the multiplexer's raw diagnostic on the
  `worktree-failed` error. Previously, when opening or binding a worktree's pane failed on the backend
  (tmux or herdr), the generic catch-all forwarded that failure's message verbatim — including the
  backend's own name and its raw stderr — the one path AXI's "never leak a dependency's name or text"
  rule didn't yet reach. This CLI's own worktree refusals (a dirty-checkout guard, a primary-checkout
  guard) are unaffected and still report their own text as before; a genuine backend failure now reports
  a generic, coded `worktree-failed` message, with the raw diagnostic written to stderr as a
  non-load-bearing detail instead.
