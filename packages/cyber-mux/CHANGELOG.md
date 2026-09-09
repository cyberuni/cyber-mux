# cyber-mux

## 0.7.1

### Patch Changes

- 31dea02: `mode`'s own `--help` line said it reports "tmux / herdr / none", three backends behind the seven it
  actually resolves. It now names them all, and says it reports the *drivable* backend — which is why a
  recognized-but-undrivable mux (GNU screen) answers `none` here while `doctor` still names it.
- 80c6687: Ship a readme with the package — the repository readme now lives in `packages/cyber-mux/` (symlinked
  from the repo root), so npm shows the badges, backend list, and command table instead of nothing.

## 0.7.0

### Minor Changes

- cd4db8e: Close the two focus gaps on the `MuxAdapter` seam (#152): `isPaneFocused` can now say "cannot
  determine" on every backend, and `opensWithoutStealingFocus` is replaced by the three-valued
  `focusOnOpen`.
  
  **`isPaneFocused` reaches its own `undefined`.** The member already returned `boolean | undefined`,
  but six of the seven adapters could not actually produce the `undefined` for the case it exists
  for — an unanswerable query came back as a confident `false`, which a caller cannot tell from a real
  negative.
  
  - **WezTerm gains a real probe.** It used to answer a blanket `undefined` on the claim that the
    backend has no focus primitive. It has one: `cli list-clients --format json` carries
    `focused_pane_id`, measured on `20240203-110809-5046fc22` with a GUI client attached to a headless
    mux server, moving with `cli activate-pane` in both directions. It deliberately does **not** read
    `cli list --format json`'s `is_active`, which is per-tab — measured, three rows reported it `true`
    at once across two tabs and two windows.
  - **Zellij stops believing `is_focused`.** That flag is true on more than one record at a time (a
    floating plugin pane and the tiled pane beneath it), so the probe could report `true` for a pane
    the client was not on. It now reads `list-clients`, the same authority the adapter's focus restore
    already used.
  - **tmux and rmux** presence-check every `-F` field before comparing any: a short line left the
    active flags `undefined`, and `undefined === '1'` is `false`.
  - **cmux and otty** presence-check the focus field, not just the row. Both row shapes are
    source/docs reads, so an absent field is the likeliest way they are wrong.
  
  **`focusOnOpen` replaces `opensWithoutStealingFocus`.** BREAKING for anyone reading that member.
  The boolean could not express a backend that moves focus and puts it back, so it called that "no
  theft" — which is how Zellij came to declare the same value as tmux while doing something visibly
  different. The new member is `'preserved' | 'restored' | 'stolen'`:
  
  | backend | value | why |
  | --- | --- | --- |
  | tmux, rmux | `'preserved'` | `-d` on every route, and `-t` targets the split directly |
  | herdr | `'preserved'` | `--no-focus` on every route, and `pane split --pane` names the anchor |
  | Zellij | `'restored'` | its `from` path focuses the anchor, opens, and focuses back |
  | WezTerm, cmux, otty | `'restored'` | **new** — every open now reads the focused pane first and restores it |
  
  No backend declares `'stolen'` today, which is #152's acceptance criterion: an open on any backend
  either leaves focus alone or deterministically restores it. The restore is spelled once
  (`restoringFocus`, exported from the package root alongside the `FocusOnOpen` type), reads before
  anything moves, runs in a `finally` so a throwing open cannot leave the caller's view relocated, and
  is skipped rather than guessed when nothing reports being focused.
  
  cmux's `--focus false` (#167) and otty's `pane split --no-focus` (#172) are deliberately still not
  passed: both are unverified without a Mac, and the restore is correct whether or not those documented
  defaults are what ships. Everything stated about cmux and otty here remains a source/docs read —
  neither can be driven on Linux CI (#128).
- 829e44f: herdr: `worktree.releaseWorkspace` closes the whole worktree group again
  
  herdr 0.9.0 put the cascade behind `workspace close --group`: a bare close of a PRIMARY workspace
  that still has worktree workspaces open no longer errors, it just releases the primary and leaves
  the group up. The adapter sent the bare verb, so the group silently stayed open.
  
  `releaseWorkspace` now takes `opts?: { group?: boolean }`, defaulting to `true` — cascading is what
  the verb has always done, and defaulting it off would narrow it for callers who never asked for a
  change. Pass `{ group: false }` to release only the workspace named.
  
  Pre-0.9.0 herdr rejects `--group` client-side, at argument parsing, without contacting the server, so
  the adapter retries the bare verb there — which already cascades on those releases. The retry keys on
  `Exec`'s `null` failure sentinel, so it works against every runner rather than only ones that report
  a diagnostic reason.
- e79f649: Implement `AgentLifecycle` on the otty backend, bound to `otty pane wait --pane <id>` — the second
  backend with a native per-pane agent-state wait, after herdr. `cyber-mux agent wait` now drives otty
  instead of refusing it, and `agentApi(env).supported()` is `true` there.
  
  otty's wait ends on `idle` and nothing else, so an `--until` naming any other state is refused by
  name with the new `AgentWaitStatesUnsupportedError` (exported from `cyber-mux/agent`) rather than
  narrowed to what the backend happens to support. `timeoutMs` rounds up to otty's whole-second
  `--timeout-secs` and never to `0`, which is otty's spelling for an unbounded wait.
  
  `LivePane.agentStatus` on otty is unchanged and still `undefined`: otty exposes no documented CLI
  read of per-pane agent state, so `supported()` and `status()` now answer differently on the same
  backend.
  
  Everything here is read off otty's published CLI documentation; otty is a GUI-only app with no
  binary in CI, so nothing in this change was verified against a live otty.
- 18e3269: otty can now size a split, and names a new tab at birth.
  
  `otty pane split` documents a `--size` flag, so the otty adapter declares `canSizeSplits: true` and
  renders `MuxOpenOptions.ratio` onto it. `--size` is the **new** pane's share, while `ratio` is the
  fraction kept by the **original**, so the value is inverted — the same inversion the cmux and WezTerm
  adapters already make, and the opposite of herdr's pass-through `--ratio`. otty's unit is a whole
  percent over a documented **10–90** range: `ratio: 0.7` becomes `--size 30`, and a ratio that lands
  outside the range (`0.95`, a 5% new pane) is clamped into it with a warning on stderr rather than
  sent as a size otty rejects, which would fail the split outright.
  
  The previous `canSizeSplits: false` did not merely undercount otty — it gave a reason that was wrong,
  implying otty has no sizing verb. The verb it does have that cyber-mux still cannot use is
  `pane resize`, which counts cells; `resizePane` stays refused on otty for exactly that reason, and
  the adapter now says which is which.
  
  `otty tab new` documents `--title`, so `open({ at: 'tab', label })` names the tab in the creating
  call instead of following up with a `rename` — one round trip fewer, and no window in which the tab
  carries otty's default name. Same fix the workspace tier already got with `otty open --title`.
  
  Read off otty's published CLI reference, **not verified against a live binary** — otty is a macOS-only
  GUI app with no public source, so the coverage is mocked-`Exec` argv assertions.
- 1a5f898: Add pane relocation to the `MuxAdapter` seam — `movePane(exec, target, destination, side)` and
  `breakPane(exec, target, at)`. Until now every pane cyber-mux opened stayed where it was born: the
  seam could create, read, name, resize, focus, zoom and close a pane, and never move one.
  
  `movePane` puts a live pane beside another one — the destination is a PANE plus a side
  (`'right' | 'down'`), never a tab or a workspace, because that is the only destination the capable
  backends can all name exactly. `breakPane` promotes a pane into its own tab or its own workspace.
  Both keep the pane's process and scrollback; neither opens or tears anything down.
  
  Both return `OpenedPane` rather than `void`, and that is load-bearing: herdr pane ids are
  workspace-scoped, so a relocation across that boundary rewrites the id and the old one drops out of
  `pane list`. The return is the pane's new identity plus the tab and workspace it now lives in.
  
  Real on tmux, rmux, herdr and wezterm, each driven live. Refused BY NAME elsewhere:
  `PaneMoveUnsupportedError` / `PaneBreakUnsupportedError`, never an emulation. zellij and otty refuse
  both; cmux refuses the move and declares the break-out. `canMovePanes` and `canBreakPanes` are how a
  caller asks before relocating — two flags rather than one, because cmux has exactly one of the two
  capabilities.
  
  New exports on the `.` entry: `PaneMoveUnsupportedError`, `PaneBreakUnsupportedError`,
  `refusePaneMove`, `refusePaneBreak`, `canMovePanes`, `canBreakPanes`, plus the `MuxMoveSide` and
  `MuxBreakTier` types. `MuxAdapter` gains two required members, so an out-of-tree adapter must
  implement them.
- 237ae29: Add pane zoom to the `MuxAdapter` seam — `setPaneZoom(exec, target, zoomed)` and
  `isPaneZoomed(exec, target)`. A zoomed pane fills its region while its siblings stay open behind it,
  which every backend but one can do and none of them could be asked to do before.
  
  This is **not** `focus()`. Focus moves the client; zoom makes the pane big. A caller that has just
  opened a worker pane and wants a human to actually read it needs the second, and only the first was
  expressible.
  
  - **Absolute, never a toggle**, for `resizePane`'s reason: a blind toggle can be asked for "big" and
    deliver "small", which is unusable by an agent. A caller that wants the toggle writes
    `setPaneZoom(e, t, !isPaneZoomed(e, t))`.
  - **Asking for the state a pane is already in touches the backend at all.** That is contract, not an
    optimization: two backends spell zoom at the tab tier, where an unguarded write acts on a pane the
    caller never named — `herdr pane zoom <p3> --off` unzooms whichever sibling was zoomed, and tmux's
    `resize-pane -Z` on a window zoomed elsewhere just unzooms it.
  - **Zooming moves focus to the pane** on every backend that has the verb. Declared rather than
    compensated: undoing it would be a second visible focus move. Unzooming moves nothing.
  - **Real on five of seven backends**, each driven against a live binary: tmux 3.7c and rmux 0.10.0
    (`resize-pane -Z`), herdr 0.8.0/0.9.0 (`pane zoom --on|--off`), zellij 0.45.0 (`action
    toggle-fullscreen`), and wezterm 20240203 (`cli zoom-pane --zoom|--unzoom`, the only natively
    absolute one).
  - **cmux and otty refuse BY NAME** with `PaneZoomUnsupportedError` rather than emulating: cmux has no
    pane-zoom verb at any programmable layer (its tmux-compat `resize-pane -Z` parses, does nothing and
    exits 0), and otty's documented `pane zoom` names no flags and reports no state, so an absolute set
    cannot be rendered. `canZoomPanes` is the pre-flight declaration, `canFloatPanes`'s exact shape.
  - `isPaneZoomed` answers `undefined` — never `false` — on those two: cmux binds pane zoom to a GUI
    keystroke, so a `false` would be a lie about a pane the user zoomed by hand.
  
  New exports on the `.` entry: `PaneZoomUnsupportedError`, `refusePaneZoom`, `canZoomPanes`.
  `MuxAdapter` gains two required members, so an out-of-tree adapter must implement them.
- dd95e70: Detect squash-merged branches when deciding whether a worktree is disposable.
  
  `git branch --merged` is structurally blind to a squash merge — the squash commit on the target is a
  rewritten tip with no ancestry link back to the branch — so a squash-merging repo under-reported every
  reusable worktree, and a pool built on `provision` never recycled: it only ever created.
  
  The landed signal is now LAYERED, in cost order, with the ancestry answer kept exactly where it was:
  
  - `ancestor` — `git branch --merged`, git's own proof, one call for the whole repo.
  - `upstream-gone` — the branch's remote-tracking ref has disappeared (`[gone]`), i.e. the forge merged
    the pull request and deleted its head branch. One call for the whole repo, offline, and correct for
    squash, rebase, and merge-commit strategies alike. Read, never refreshed: nothing here runs
    `git fetch --prune` for you, so the signal is as fresh as your last fetch.
  - `squash-patch` — the branch collapsed to one synthetic commit is already applied on the target
    (`commit-tree` + `git cherry`). Offline, and matches a clean squash or rebase merge.
  - `forge` — the forge's own word on whether a merged PR exists for the head branch. OPT-IN: pass a
    `signals.forge` probe (`ghForgeMergedProbe` ships as one). Nothing reaches the network without it.
  
  Entries carry a new `mergedSignal` field naming which layer established `merged: true`, absent for a
  negative or undeterminable verdict — the layers do not carry equal authority, and a caller auditing a
  reclaim needs to see which one spoke.
  
  Every layer after the first is POSITIVE-ONLY, so the composite is a monotone OR: a squash that was
  conflict-resolved or hand-edited does not match and degrades to "not reusable" rather than to a false
  positive, and a landed signal never outranks a guard — a dirty, occupied, stale, or primary checkout
  is refused however it was cleared. `isWorktreeRemovable`, `removeWorktreeSafely`, and the
  primary/dirty/occupied gates are unchanged, as is behavior on merge-commit and fast-forward repos.

### Patch Changes

- 94cc2d3: Drive cmux's real verbs for the six `MuxAdapter` members that could not work on it — fabricated flags,
  a JSON shape that is never emitted, a route that never emits JSON at all, and two verbs that do not
  exist.
  
  - **`open()` at `pane:right`/`pane:down`** sent `--cwd` and `--size` to `new-pane`, which accepts
    neither and validates no unknown flag, so both were silently ignored: the split opened in the wrong
    directory and the ratio did nothing. Both flags are gone. **`canSizeSplits` is no longer declared** —
    cmux has no split-size flag and `resize-pane` is cell-based, so a `ratio` now degrades to cmux's own
    even split, zellij's answer exactly. The directory is carried instead as a `cd` on the command line
    (a shell-level cd, so it lands in that surface's shell history), the same last-resort shape env
    already takes.
  - **`open()` at `workspace`** threw on every call: `new-workspace` hardcodes `honorJSONOutput: false`,
    so `cmux --json new-workspace` prints `OK workspace:3` and never JSON. It now runs the namespaced
    `cmux --json workspace create`, which does emit JSON — and takes `--name`, so a workspace is named at
    birth rather than renamed afterwards.
  - **`listPanes`, `paneExists` and `isPaneFocused`** were all dead. They read `list-panes`, which
    reports PANES as `{"panes":[…]}`, while the parse required a top-level array of panes each holding
    surface objects — a shape cmux never emits, so the listing was empty for every real response and the
    three members answered "no panes", "does not exist" and "cannot tell" always. They now read
    `list-panels` (the surface tier) with its real keys: `ref` for the id, `focused` for focus.
    **`LivePane.cwd` is now absent on cmux**: the listing carries the directory a surface was *created*
    with and nothing that tracks where its shell is, so reporting it would go stale at the first `cd`.
  - **`rename()`** ran `rename-surface`/`rename-pane`, neither of which exists in cmux at all. Both seam
    tiers now run `rename-tab --surface <id> --title <name>`; the `pane` tier retargets the surface the
    pane is showing, because cmux has no pane rename at any layer.
  - **`teardown()`** sent `close-surface --surface <id>` with no workspace. It now names the workspace
    whenever the adapter is bound to one — cmux resolves an explicit `--surface` *within* a workspace,
    falling back to `$CMUX_WORKSPACE_ID`, so the old form worked from inside cmux, refused for a library
    caller with no cmux env, and resolved against the wrong workspace for a surface outside the caller's.
  
  Also fixes a grouping bug this read uncovered: `workspace.create` reports no `pane_ref`, so a workspace
  open's tab id is a SURFACE ref, and the `group` lookup — which sent only `pane_id` against a handle
  registry keyed by ref string rather than by kind — silently resolved it to the caller's own workspace
  and would have grouped the wrong one. Each attempt is now verified against its own result.
  
  Read off cmux's own Swift source (`manaflow-ai/cmux` at `71eb616d`) — the CLI dispatch and parsers, the
  socket payload builders, and `docs/cli-contract.md` — and **not** verified against a live binary: cmux
  is macOS-GUI-only, and issue #128 tracks the missing real-boundary suite. `identify`-backed focus, a
  `capabilities` pre-flight, and cmux's native workspace `--env` all replace working behavior on
  source-only evidence and are deliberately left for someone with a Mac.
- 08b9b39: Group cmux workspaces through its real `workspace-group` family instead of dropping the caller's
  `workspaceGroup` silently.
  
  `group()` on the cmux adapter was a no-op, justified in the header by "cmux has a real workspace tier
  that already groups every surface in it, so there is nothing for this to add". That reasoning is sound
  for Pane → Surface and does not reach the tier the flag targets: cmux ships a first-class
  `workspace-group` family that groups multiple top-level **workspaces** into a named, collapsible
  sidebar section. A caller passing `workspaceGroup` on a cmux `{ at: 'workspace' }` open got nothing
  grouped and no error saying so.
  
  It now routes to `workspace-group create` then `workspace-group add`. cmux mints its own group ids, so
  the seam's opaque caller-chosen id cannot *be* the group id — it rides `--idempotency-key` (and
  `--name`, so the sidebar section carries it too), which makes a repeat call find the existing group
  rather than mint a second one. `add` is idempotent, so re-grouping needs no membership pre-check. Only
  the `workspace` route groups: a `tab` or `pane:*` open lands in the workspace the caller is already in,
  and grouping that would group a space the caller never opened.
  
  **Behavior change worth knowing:** cmux's `workspace-group create` always mints a brand-new *anchor*
  workspace, so the first grouping call for a given id adds a visible workspace to the sidebar — a
  deviation from the seam's "`group` opens nothing", accepted because the alternative was the silent drop
  above and cmux offers no membership-only create. It does not steal focus, and later calls for the same
  id open nothing.
  
  No seam member changed — `group()` / `workspaceGroup` was already the right shape; only the adapter was
  wrong. Read off cmux's own Swift source (`manaflow-ai/cmux` at `71eb616d`), **not** verified against a
  live binary: cmux is macOS-GUI-only, and issue #128 tracks the missing real-boundary suite.
- b1ce2d3: `probeMultiplexer` now reports the pane for an otty session discovered through the process-ancestry
  route. `paneFor` carried a hand-written list of the muxes with a per-pane env var and `otty` was
  missing from it, so an ancestry-discovered otty session answered "no pane" while `$OTTY_PANE_ID` was
  set and readable — `currentPane` self-identity silently came back empty. The `$CYBER_MUX` fast-path
  was unaffected.
  
  The guard is now a `PANE_ENV` lookup rather than a second list, and `PaneMux` is derived from `Mux`
  by subtracting the two muxes that genuinely carry no pane (`screen`, `none`) instead of re-listing
  the ones that do — so a new backend cannot be added without either giving it a pane var or excluding
  it on purpose. `screen` and `none` still report no pane.
- 6a57d2f: Fix two otty argv shapes that otty's CLI does not accept, and refuse pane-tier `rename` on otty.
  
  `otty open` always opens a new window and documents only `--command` and `--title`; the adapter was
  passing a `--new-window` that belongs to the different `otty view`/`otty edit` family, so every
  `open({ at: 'workspace' })` died at otty's argument parser. It now issues a bare `otty open` and
  names the new window at birth with the documented `--title` instead of renaming a tab afterward.
  
  `otty pane split` takes `--direction <right|left|up|down>`, not a bare directional flag. The adapter
  was passing `--right` / `--bottom` — and `bottom` is not a direction otty names at all — so every
  `pane:right` and `pane:down` split was broken too. It now passes `--direction right` / `--direction
  down`.
  
  otty scopes `rename` to windows and tabs, so `rename(…, 'pane', …)` now throws a named error rather
  than issuing a `otty pane rename` that otty rejects and this adapter discarded, and a `label` on a
  `--at pane:*` open degrades to a stderr warning — the same trade the WezTerm adapter makes for the
  same missing primitive.
  
  Read off otty's published CLI reference, NOT verified against a live binary — otty is GUI-only and
  absent from the machine this was written on.
- bdf7744: Stop sending `--cwd` on `otty tab new`, and keep it on `otty pane split` — where otty's own docs show
  it.
  
  Issue #163 read otty's CLI reference, found no `--cwd` anywhere on it, and concluded the adapter was
  sending a fabricated flag on both routes. Only half of that is right. otty's
  [orchestration guide](https://docs.otty.sh/agents/orchestration) runs
  `otty pane split --direction right --cwd "$PWD" --no-focus --json` as a command you can type by hand,
  so the split route's `--cwd` is documented by otty itself and is unchanged. The reference's
  `window / tab / pane` section carries no flag table at all — measured across all 141 URLs in
  `docs.otty.sh/sitemap.xml`, `--cwd` and `--no-focus` each appear on exactly one page, and it is not
  the reference.
  
  `tab new` has no such backing: nothing otty publishes puts a working directory on it, and otty ships
  no source to settle it either way. The costs of the two readings are not symmetric — if the flag
  exists, a `cd` works too; if it does not, `--cwd` fails **every** `--at tab` open at otty's argument
  parser. So the tab route drops the flag and carries the directory as a `cd` on the command line, the
  same shape cmux's `pane:*` route takes, with the env prefix inside the `&&`. It is a shell-level cd,
  so it lands in that tab's shell history and means nothing in a non-shell pane. The `cd` needs no
  launch command to ride, so a tab opened with a `cwd` and no `launch` still lands in the right
  directory. The workspace tier was never affected — `otty open [path]` takes the directory as a
  documented positional.
  
  Read off otty's published docs, NOT verified against a live binary — otty is a macOS/Windows GUI app
  absent from the machine this was written on, and #128 tracks the missing real-boundary suite.
- c973613: Fix the tmux adapter returning plausible-looking wrong answers when the calling process has no
  locale. Every tmux invocation now leads with `-u`.
  
  Without a `LANG`/`LC_ALL`/`LC_CTYPE` containing "UTF-8", tmux does not consider its command client
  UTF-8 and sanitizes what it prints: every byte outside printable ASCII becomes a literal `_`. The
  adapter separates the fields of its `-F` formats with a TAB, so the split found no separator and a
  listing of N panes collapsed into ONE record whose id was the whole line — `%0_zsh_/home/u_host_0`
  rather than a pane id. It did not throw and did not return empty, so anything culling or reconciling
  on that listing acted on a pane that does not exist.
  
  Reached by a caller that has neither a locale nor `$TMUX`: a systemd unit, a cron job, a container
  entrypoint, or a non-interactive ssh session driving tmux through `CYBER_MUX=tmux`. A caller running
  inside a pane was never affected — `$TMUX` gives the command client the containing client's UTF-8
  state.
  
  - **`-u` on every invocation, not only the ones that parse a tab.** The mangling is a whole byte
    class, measured on tmux 3.7c: every control byte, `0x7f`, and every non-ASCII byte comes back as
    `_`. So `#{pane_title}`, `#{pane_current_path}` and `#{session_name}` lost their non-ASCII content
    in the space-separated formats too, which re-picking the separator would not have fixed.
  - **rmux is unaffected and unchanged.** Measured on a live rmux 0.10.0 under `env -i`: it emits a
    real tab. The earlier note that it shared the defect was an inference from the shared `#{…}`
    vocabulary, not a measurement.
  - **The regression test drives the real tmux with the environment stripped** — `PATH` and `HOME` and
    nothing else, on its own socket — because the integration suite inherits a locale, which is why
    this survived every release.
  
  No API change.
- a30d58c: zellij: complete a `zellij action` that its own pre-flight dropped, and confirm a focus landed before
  anything is built on it
  
  `zellij action` resolves the session list before it honors `--session`, probing every socket and
  requiring a `ConnStatus` reply; against a busy server that probe loses a live session, and the command
  exits 1 with `There is no active session!` — or exits 0 printing nothing — having done nothing at all.
  Measured on a live 0.45.0 under CPU contention: 2 bad answers in 600 `list-clients` calls, both
  correct on an immediate re-ask.
  
  Three real consequences are fixed. `open({ from })` no longer skips its focus restore when the
  `list-clients` read behind it came back empty — a lost answer used to read as "no client is attached",
  which left the caller's client on the pane the open had just created. `setPaneZoom` now confirms the
  client actually reached the pane before toggling fullscreen, because `toggle-fullscreen -p <id>` on a
  pane the client is not on, in a tab that already has a fullscreen pane, leaves fullscreen and reports
  success. And a `rename`, `focus`, `teardown`, `send` or `read` that never reached the server is
  re-issued rather than silently lost.
  
  `new-pane` and `new-tab` are deliberately unchanged: they create, so they keep failing loudly by name
  rather than risking a stray pane.

## 0.6.0

### Minor Changes

- 8469598: Declare `MuxAdapter.opensWithoutStealingFocus`, and make it true on tmux, rmux, herdr, and Zellij.
  
  Opening a pane is not supposed to drag the user somewhere. Nothing on the seam said so, and four
  routes did not honor it. `open()` now leaves the caller's focus where it found it on tmux, rmux,
  herdr, and Zellij 0.45+, and every adapter declares which answer it gives.
  
  **Behavior changes**
  
  - **tmux** passes `-d` on `split-window` and `new-pane` as well as `new-window`. Previously a
    `pane:right`, `pane:down`, or `pane:float` open moved the attached client onto the new pane;
    `new-window -d` was the only route that did not. Measured on 3.7c.
  - **rmux** passes `-d` on `split-window` as well as `new-window`, the same hole tmux had and for the
    same reason — rmux reimplements tmux's command language. Verified live on 0.10.0, not inferred from
    the resemblance. It has no `new-pane`, so there is no float route to cover.
  - **herdr** passes `--no-focus` on `pane split` as well as `workspace create` and `tab create`. On
    0.8.2 the split already left focus alone, so this changes nothing observable — it is passed so the
    guarantee does not rest on a backend default.
  - **Zellij** requires **0.45.0** (up from 0.44.1), the release that added `--no-focus`. A `tab` or
    `workspace` open, and a `pane:*` open naming no `from`, pass the flag. A `pane:*` open that names a
    `from` cannot: under `--no-focus` Zellij anchors the split on the pane the command was issued from
    rather than the focused one, so passing it would split the wrong pane. That path focuses the target,
    splits it, then focuses back to the pane that had focus. On an older Zellij the open fails loudly
    with Zellij's own unknown-argument error instead of silently stealing focus.
  
  **New seam member**
  
  `opensWithoutStealingFocus: boolean` is **required** on `MuxAdapter`, so a third-party adapter must
  add it. It follows `canSizeSplits` — a declaration the caller reads, not a `MuxOpenOptions` flag —
  but is required rather than optional because `undefined` here cannot be distinguished from an author
  who never considered focus. `false` (WezTerm, cmux, otty) is a degrade, not a refusal: the open still
  returns the pane you asked for, it just moves the user to it.
  
  **Zellij users on 0.44.x must upgrade.** The adapter declared `≥ 0.44.1` and now declares `≥ 0.45.0`.
  A `--no-focus` open on an older binary is an unknown-argument error, so it fails loudly and creates
  nothing rather than mis-targeting a pane — the same way an old tmux answers `new-pane` with `unknown
  command`. The adapter version-probes nothing, by design.
  
  Zellij's `--no-focus` was written from the v0.45.0 source tree rather than a live binary, and is now
  driven in CI against a real Zellij 0.45.0.
- dc2d3f0: Add `RegionInspector.resizePane` — a pane's size can now be changed after birth, not only chosen at
  it. `resizePane(exec, target, ratio)` takes the same fraction-of-the-split-region
  `MuxOpenOptions.ratio` takes, so a caller that opened a split at a ratio restores it with the same
  number.
  
  Implemented on tmux, rmux and herdr, and verified against live binaries (tmux 3.7c, rmux 0.10.0,
  herdr 0.8.2). It rides the existing optional `regions` capability rather than a new `canResizePanes`
  declaration, because a ratio is not a primitive any backend has: every one of them needs the region's
  current geometry to turn it into its own resize argument, which is exactly what `regions` reports —
  so a backend that reports rects answers the member for free. wezterm, zellij, cmux and otty do not
  report geometry and so refuse by name with the new `PaneResizeUnsupportedError`, raised by the new
  `derivePaneResize` orchestrator.
- c498513: Add an rmux backend
  
  `cyber-mux` now drives [rmux](https://github.com/Helvesec/rmux), an async Rust reimplementation of
  the tmux command language, alongside tmux, herdr, WezTerm, Zellij, cmux and otty. rmux runs natively
  on Linux, macOS and Windows — it is the first backend that runs natively on Windows.
  
  The adapter realizes the existing `MuxAdapter` contract plus `RegionInspector`, with no seam change:
  placements, naming, workspace grouping, reads, waits, focus and region geometry all work, and
  splits can be sized. Detection recognizes rmux through `$RMUX` and `$RMUX_PANE`, through an
  `rmux-daemon` process ancestor, and through the explicit `CYBER_MUX=rmux` override.
  
  One capability is genuinely absent: rmux has no floating panes. `new-pane` — the tmux 3.7 command
  `--at pane:float` drives — is not part of rmux's command set, so a float is **refused by name**
  (`FloatingPanesUnsupportedError`) rather than quietly substituted with a tiled split, exactly as
  WezTerm, herdr, cmux and otty refuse it. Every other placement is available.
  
  **If you use rmux and tmux on the same machine, detection order matters and is now handled.** An
  rmux pane exports `$TMUX` and `$TMUX_PANE` as well as its own `$RMUX`/`$RMUX_PANE`, for tmux
  compatibility, and rmux puts a `tmux` shim on `$PATH`. `cyber-mux` therefore asks the rmux question
  first: a pane carrying both resolves to rmux. Nothing about tmux detection changes.
  
  Verified against a live rmux 0.10.0 binary on Linux, including a real-boundary suite
  (`pnpm --filter cyber-mux test:integration`) that drives the actual binary on a throwaway socket.
  Not exercised on Windows or macOS — the native-Windows claim is about rmux's own portability, not
  about a `cyber-mux` run anyone has observed there.

## 0.5.0

### Minor Changes

- 3fd1c3c: Add cmux backend adapter
  
  cmux is a Ghostty-based macOS terminal built for AI coding agents. This adds detection (`$CMUX_WORKSPACE_ID`) and a full `MuxAdapter` implementation using cmux's CLI (`cmux new-pane`, `cmux send`, etc.).
  
  - Detection via `$CMUX_WORKSPACE_ID` env variable
  - Pane identity via `$CMUX_SURFACE_ID` (cmux's "surface" is the terminal unit)
  - Supports workspace, tab (surface), and pane:right/pane:down placements
  - Supports split sizing via `--size` flag
  - No `--env` flag support (env compensation via command prefix)
  - No geometry/regions support (cmux CLI doesn't report positions)
  - macOS-only (cmux is a native Swift/AppKit app)
- 2c7de82: Add a `pane:float` placement — a pane that sits above the tiled layout instead of taking a share of
  it, so nothing else is resized.
  
  - `MuxPlacement` gains `'pane:float'`, and `--at pane:float` gains the matching CLI choice. A
    floating pane is an ordinary `OpenedPane` with a real id, so `read`/`sendText`/`submit`/
    `waitForOutput`/`teardown` drive it unchanged.
  - **tmux** (≥ 3.7, `new-pane`) and **zellij** (`new-pane --floating`) open a real one.
  - **wezterm** and **herdr** have no floating-pane concept and **refuse by name** — a new
    `FloatingPanesUnsupportedError` from `open`, surfaced by the CLI as `backend-unsupported` (exit 1)
    — rather than quietly substituting a tiled split, which would resize the region's other panes.
    `MuxAdapter.canFloatPanes` (with the `canFloatPanes(adapter)` helper) is how a caller asks before
    opening; the refusal is raised before any backend command, so a refused float opens nothing.
  - `ratio` is dropped on a float on every backend, tmux included: a float takes no share of the
    region, so there is no original pane whose fraction it could be.
- 2eefb02: `LivePane` now reports whether a pane FLOATS, so a caller can tell a float from a tiled pane after
  the open that made it — the read side of the `pane:float` placement.
  
  - `LivePane.floating` is **required**, the only required field on the type beyond `id`/`mux`. Every
    backend can answer, so absence is not one of its states: an optional field would leave a caller
    guessing whether a missing value meant *not floating* or *cannot tell*.
  - **tmux** reads `#{pane_floating_flag}` and **zellij** reads `is_floating`, each appended to the
    pane listing the adapter already asks for — no extra command on either.
  - **herdr**, **wezterm**, **cmux** and **otty** answer `false` **by construction**: they have no
    floating-pane concept, so every pane they can report really is tiled. Deliberately not a named
    refusal — the *create* side has no truthful pane to hand back and refuses by name, while the
    *read* side has one, which is why this rides `LivePane` rather than a capability object.
  - `cyber-mux list --format json` carries the new field per pane; the human table is unchanged.
- fd13d41: Add otty backend adapter
  
  otty is a native terminal-centric workspace app with integrated multiplexing, built for AI coding agents. This adds detection and a full `MuxAdapter` implementation using otty's CLI.
  
  - Detection via `$OTTY_PANE_ID` env variable
  - Supports workspace (window), tab, and pane:right/pane:down placements
  - Send-keys supports text and key tokens in one atomic call
  - No split sizing support (`canSizeSplits: false`)
  - No `--env` flag support (env compensation via command prefix)
  - No geometry/regions support (otty CLI doesn't report positions)
  - macOS/Windows desktop app
- 1535fab: `read` reports whether the capture dropped older rows, and `--full` takes the rest
  
  `MuxAdapter.read` (and the bound `MuxSession.read`) now answers with `{ text, truncated? }` instead
  of a bare string, so a caller matching against a snapshot can tell a short pane from a capture that
  hit its bound. Pass `MuxReadOptions.truncation` to have the backend determine it; leave it off and
  `truncated` is **absent** — never `false`, because a `false` that means "I did not check" is
  indistinguishable from "you have everything" (the conflation herdr itself shipped a fix for in 0.8.0,
  herdrdev/herdr#1717).
  
  `MuxReadOptions.lines` gains `'all'` — the same window knob at its limit, for the whole scrollback.
  One option rather than a second `full?: boolean`, so no caller can spell a contradiction the seam
  would need a precedence rule for. It also makes the truncation answer free at that end: an unbounded
  window omitted nothing by construction, so no adapter spends a probe on it.
  
  Real on every backend, by one rule: ask for one row more than the captured window and compare row
  counts (`isReadTruncated`, `read-window.ts`). tmux takes `-S -(N+1)` and spells `'all'` as `-S -`,
  WezTerm `--start-line -(N+1)`, Zellij compares against the full dump its `lines` read already holds
  (no extra query) and takes `--full` for `'all'`, and herdr probes `--source recent` — its CLI prints
  the read's text alone and never surfaces the `truncated` its socket API computes.
  
  Opt-in at the seam because the probe costs one extra backend query and `read` is the hottest verb
  there — `pollForOutput` runs it once per poll tick. Omitted, the argv is byte-identical to the read
  that has always been issued.
  
  CLI: `cyber-mux read` now carries one read window and one escape hatch — `--lines <n>` bounds it,
  `--full` takes the whole scrollback, and passing both is a usage error (exit 2). It **always** reports
  truncation, no flag needed: a truncated capture is followed by a `truncated` field and a `help:` entry
  naming `--full` as the fix (AXI #3's shape), while a complete capture stays the pane's raw bytes alone
  so `read | grep` is unchanged. `--format json` spells `truncated` either way. The answer is never on
  stderr, which agents do not read.
  
  Callers reading text from `read` now take `.text` (`nudge` and `waitForOutput` already do
  internally).

### Patch Changes

- f66590d: Refuse a `pane:float` open on **cmux** and **otty** instead of silently substituting a right split.
  
  Both adapters declared they cannot float (no `canFloatPanes`) but never enforced it: `open()`
  resolved placement as down-or-right, so `at: 'pane:float'` fell through to a tiled split and was
  reported as success — a pane with a real id and none of the property the caller asked for. They now
  throw `FloatingPanesUnsupportedError` naming the backend, before any command is issued, the same as
  wezterm and herdr.
  
  The CLI was already correct (it checks `canFloatPanes` and refuses before reaching an adapter); the
  hole was on the library surface, where a caller holding an adapter calls `open()` directly.
- 303a0e9: Fix two zellij `list-panes --json` field names, verified against a live 0.44.3 binary
  
  The zellij adapter was built from a documentation probe, and two of the field names it read do not
  exist in zellij's actual output. Driving the adapter against a real binary surfaced both.
  
  - `pane_command` is really `terminal_command`. The adapter drops a pane's title when that title is
    just the running command zellij gave an unnamed pane — a guard that stops every shell pane from
    reporting the same manufactured `label`. Reading the wrong name meant the guard compared against
    `undefined` and never fired, so unnamed panes exported their own command line as an authored
    label. It now fires.
  - `pane_cwd` does not exist; zellij's pane records carry no cwd field at all. `LivePane.cwd` was
    therefore never populated for zellij and the code that read it was dead. It is gone, so a zellij
    pane is honestly cwd-less rather than appearing to sometimes report one.
- 586f9a9: Stop a lost or misdelivered zellij CLI reply from becoming a wrong answer
  
  Zellij 0.44.3 can deliver a `zellij action` reply to the wrong command. Under CPU contention a
  command exits 0 having printed nothing, and the payload it should have received arrives on the
  stdout of the command issued after it. Reproduced by alternating `new-tab` and `list-panes --json`
  forty times on a loaded two-core box: twice in forty, the `new-tab` printed an empty string and the
  `list-panes` that followed it printed `27`. Two hundred back-to-back `list-panes --json` calls with
  no mutating verb between them lost nothing, so it is the mutating verbs that open the window.
  
  Two of the adapter's answers were wrong in the face of that. An empty reply to `list-panes --json`
  was read as an empty session — but a live zellij session always has at least one pane, and reading
  zero made every id the adapter resolves fail at once. And the id `new-pane`/`new-tab` printed was
  taken on trust, so a stale one could name a pane that had been standing all along and hand the
  caller somebody else's pane.
  
  The listing is now re-asked when a read does not come back as a pane array, so `[]` means zellij
  answered with no panes rather than that zellij did not answer. And an `open()` reads the listing
  before the command as well as after: a reported id is believed only where it names a pane that was
  not already there, which closes the phantom guard that `new-pane --direction` needs — the split
  prints a plausible id and exits 0 having created nothing when the attached client sits on a plugin
  pane. Where the id cannot be believed, a single pane that appeared over the open answers instead, so
  an open that genuinely happened is no longer failed for a reply zellij dropped.
  
  An `open()` also no longer resolves to a PLUGIN pane. Zellij loads plugin panes on its own schedule,
  so a tab opened by `new-tab` can be carrying one in the same listing as its own initial pane, and
  that record can sort first. Caught at the real boundary: an `open()` at `tab` returned `plugin_15`,
  an id that exists — so nothing downstream refused it — and the `rename()` after it renamed a pane the
  caller never opened. Both `new-tab` and `new-pane` create a terminal pane, so that is what an open
  now resolves to.
- 58061b3: Report a zellij pane's working directory, verified against a live 0.44.3 binary
  
  `LivePane.cwd` was never populated on zellij, so callers filtering a listing by directory got
  nothing back from this backend. The adapter carried the claim that `list-panes --json` has no cwd
  field at all on 0.44.3 — a probe conclusion drawn from a record that genuinely has none.
  
  `pane_cwd` is real, and so is `pane_command` beside it. Both are present on a **terminal** pane's
  record and omitted entirely on a **plugin** pane's, which is how a probe that sampled a plugin pane
  read them as absent from the schema. A driven 0.44.3 session reports `pane_cwd` on every terminal
  pane, and `listPanes` now fills `LivePane.cwd` from it — free, in the `list-panes --json` call the
  listing already makes. A record with no directory to report still carries no `cwd`, rather than an
  empty or invented one.
  
  The label guard is unchanged: it reads `terminal_command`, which is null for a plain shell, and that
  is the field it wants.
- d1da9a6: Give zellij's plugin and terminal panes distinct ids in the live listing
  
  A zellij pane number is unique only within a kind: zellij numbers plugin panes and terminal panes in
  separate spaces, so a live 0.44.3 session reports `id: 0` for both its suppressed `zellij:link`
  plugin pane and its first terminal pane. The adapter stringified that number as-is, so two genuinely
  different panes were reported under one `LivePane.id` — an identity hazard for everything that
  resolves by id, including the guard that catches an `open()` reporting a pane it never created.
  
  The listing now qualifies a bare number with the kind `is_plugin` names, so those two panes are
  reported as `plugin_0` and `terminal_0`. Both prefixed forms are what `zellij action --pane-id`
  itself accepts, and `terminal_N` is already what `new-pane` prints, so a qualified id is directly
  drivable. An id zellij already spelled out is passed through untouched.
  
  **A zellij `LivePane.id` therefore reads `terminal_3` where it used to read `3`.** A bare number
  still resolves — it addresses the terminal pane, on the backend and in this adapter alike — so ids
  already held by a caller keep working.

## 0.4.0

### Minor Changes

- 59865fd: Add the agent-lifecycle capability, normalized by truthful refusal rather than emulation.

  - **`cyber-mux/agent` subpath** — the new `AgentLifecycle` capability seam, its `deriveAgentWait`
    orchestrator, and the `AgentLifecycleUnsupportedError` refusal. The `AgentStatus` type
    (`idle | working | blocked | done | unknown`) rides out on the core `.` barrel via `LivePane`.
  - **`LivePane.agentStatus`** — herdr 0.7.5's per-pane `agent_status` feed, reported on the live pane
    listing exactly like the herdr-only `harness` field: filled where the backend can answer, OMITTED
    (never a false `unknown`) where it cannot.
  - **`agent status <pane>`** — a snapshot that degrades truthfully: it prints the resolved pane's
    `agentStatus` on herdr and, on a backend with no agent-state feed, still prints the pane with no
    status and exits 0 rather than refusing.
  - **`agent wait <pane> [--until <s...>] [--timeout <ms>]`** — a blocking drive of herdr's native
    `agent wait`, reporting the reached state. On tmux, wezterm and zellij — which have no native
    per-pane agent-state primitive — it is refused with `backend-unsupported` (exit 1) naming the
    herdr-only constraint, the exact mirror of how `template save` refuses a geometry-incapable backend.
  - **`agentApi(env, deps?)`** — the exec-bound `cyber-mux/agent` facade paralleling
    `worktreeApi`/`templateApi`: it resolves the backend from `env` once and exposes
    `supported()` / `status(target)` / `wait(target, opts?)` with the seams bound. It adds no logic of
    its own — `supported` reads the same capability presence, `status` the same `LivePane.agentStatus`,
    and `wait` routes through `deriveAgentWait`, so the refusal stays specified and enforced once.

  The refuse-not-emulate normalization is deliberate: a lookalike wait built from output polling would
  silently disagree with herdr's own state derivation, so a backend without the primitive is refused
  rather than guessed.

- fa91591: A missing `<pane>` on a pane verb now lists the live panes as candidates. It stays a usage error
  (exit 2), but instead of merely naming the missing argument it queries the backend and reports each
  live pane's id, label, and cwd under the new `missing-pane` code — the same rendering and code family
  as `ambiguous-pane` — so the caller's next move (`cyber-mux list`) is folded into the error. This
  covers `read`, `focus`, `close`, `submit`, `send text`, `send keys`, `exists`, and `agent status`.
  With no multiplexer the deeper `no-mux` failure (exit 1) still surfaces first, and `agent wait` on a
  backend without the agent-lifecycle capability is still refused with `backend-unsupported` (exit 1)
  ahead of any missing-pane check.

  `cyber-mux list` also gains a herdr-only agent-status column, shown only when the backend feeds a
  per-pane agent state (omitted entirely on tmux, wezterm, and zellij).

- 1914eb9: Add a portable `waitForOutput` to the seam, and a `wait` verb to the CLI: block until a pane's output
  matches a literal (`--match`) or a regex (`--regex`), or until a timeout elapses. Real support on
  every backend rather than a one-backend capability — herdr drives its native `pane wait-output`
  (0.7.5), while tmux, WezTerm and Zellij poll their existing read through one shared loop, so every
  backend searches exactly the snapshot its `read` returns and existing output counts as a match. The
  CLI puts the verdict in the exit code (0 matched, 1 timed out) and prints the pane's own output on a
  timeout, so a caller that guessed the wrong pattern keeps the evidence; a pane that is GONE fails with
  `pane-not-found` instead of quietly waiting out the deadline, and so does a wait that never ran (a
  herdr older than 0.7.5, which has no `pane wait-output`, fails loudly rather than reporting an instant
  false timeout). Resolves #97.
- 2b04288: Add the `cyber-mux worktree provision` CLI verb — the command-line surface over the
  `provisionWorktree` seam. It reuses a free worktree (the set `worktree list` marks `(removable)` and
  `prune` removes) or creates a fresh checkout at the sibling path, and reports whether it `reused` or
  `created`, the worktree, and on reuse the recycled entry. Flags: `--branch` (required), `--base`,
  `--path`, `--format`.

  The verb uses the **default availability gate only** and offers no flag to inject a host predicate —
  that is the deliberate surface divergence from the library seam, which takes an injectable one. A
  host that must exclude, say, a live-session worktree calls `WorktreeApi.provision` directly.

  The worktree spec is now split by public surface to make that divergence first-class: the
  `cyber-mux worktree <verb>` surface (verbs, flag defaults, table rendering, and this new verb) is
  specified under `cli/worktree/`, while the surface-independent library contract (the seam, git-owns-
  facts, removal ordering, and the injectable predicate) stays in `mux/worktree/`.

- 7df7b93: Add `worktree provision` — reuse a free worktree instead of always creating a fresh one. The twin of
  `prune`: prune removes disposable worktrees, `provisionWorktree` / `WorktreeApi.provision` recycles one
  through the same default gate (`isWorktreeRemovable`), else creates. Availability is an injected
  predicate so a host can add its own "no live session bound" check without leaking that concept into
  the worktree seam. A reused worktree is reset to a pristine tree on a fresh branch (`switch -c` →
  `reset --hard` → `clean -fdx`). The result reports whether it reused or created, and carries the
  recycled worktree in full.

### Patch Changes

- bad1d3f: Validate `MuxOpenOptions.ratio` at the seam: a sizing adapter (`tmux`, `herdr`, `wezterm`) now rejects
  a ratio outside `0 < ratio < 1` with a named error instead of rendering it into a silently broken split
  (above 1 produced a negative length; 0 or 1 gave a whole-region split). The check lives with the size
  render (`assertRatioInRange`), so a backend that cannot size a split (`zellij`, which drops the ratio)
  is unaffected, and `template`'s schema still refuses a degenerate ratio earlier per node. The range was
  already documented as a contract precondition; it is now enforced. Resolves #18.

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
