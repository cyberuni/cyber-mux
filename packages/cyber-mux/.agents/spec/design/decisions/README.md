# decisions — cyber-mux ADR log

Append-only, descriptive, ungated project-scope decisions. The project sibling of a unit's
`<unit>.solution.md`. Organize no node as an ADR body — this folder only logs decisions.

Decisions (`send-submit-realign` grill — the `send`/`submit` seam):

- **text and keys are separate verbs** — DECIDED: `send text` / `send keys`, not one fused verb.
  The CR asked for `send` to be a thin passthrough over "the mux's own send-keys primitive"; the
  backends **share no such primitive**. Probed: herdr separates `pane send-text` from `pane
  send-keys` and refuses a non-key token (`unsupported key hello`); tmux fuses both into `send-keys`,
  whose documented fallback — *"if the string is not recognised as a key, it is sent as a series of
  characters"* (tmux(1)) — silently types what it cannot parse. Inheriting either shape would make
  one verb behave differently per backend, which is the seam's whole reason to exist. Verb shape
  chosen by the requester.

- **only `submit` presses Enter *for you*** — DECIDED: `send text`/`send keys` never *add* an Enter
  the caller did not write; `submit <pane> [text]` always supplies one. The split is on whether Enter
  is **implied**, not on whether it can occur.
  An earlier draft stated this as the stronger "`send keys` never Enters", justified as "leaves
  exactly one verb to audit for turn-taking". **Both were false, and the strong form is
  unachievable** under this design — verified live: `Enter` is a declared core member, so `send keys
  <pane> Enter` presses it and takes the turn; and even struck from the core, verbatim passthrough
  forwards `C-m`, which tmux presses. Holding the strong claim would need an Enter-equivalent
  denylist — precisely the tmux key table the passthrough decision below refuses.
  **Accepted cost:** turn-taking is **not** auditable by grepping one verb. `send text` + `send keys
  Enter` is an unguarded equivalent of `submit <text>` that bypasses submit's literal-typing and
  no-retype guarantees. That is the price of a raw key verb, and it is the caller's explicit act —
  `send keys` still never supplies an Enter on its own.

- **`submit` guarantees an outcome, not a command** — DECIDED: the contract is *text typed
  literally, then Enter*; atomicity is a backend capability, not a contract term. herdr's `pane run`
  is atomic; tmux has no literal-text+Enter primitive (`-l` would type a trailing `Enter` argument as
  characters), so it composes `send-keys -l` + `send-keys Enter`. The CR originally pinned tmux to
  `send-keys <text> Enter`; probed, that **re-runs the pane's previous command** when the text names
  a key (`submit <pane> Up` → Up recalls history → Enter runs it). Pinning a command in the contract
  is what let that through.

- **the key vocabulary is a probed core plus verbatim passthrough** — DECIDED: core = `Up Down Left
  Right Enter Escape Tab Space Backspace C-c F1`–`F12`; anything else forwarded untranslated.
  Requester chose core-plus-passthrough over a strict portable vocabulary or a raw passthrough. The
  core is **probed, not derived from either backend's docs or from other tools**: herdr rejects
  `Home End Delete Insert PageUp PageDown S-Tab` and every `M-` form, and — measured across all 26
  letters — accepts **only `C-c`** of `C-<letter>`; tmux types `F13`+ and `Esc` literally.

- **core spelling: `Escape` and `Backspace`** — DECIDED, and the two names have **different
  grounds**:
  - `Escape` is **forced by the probe**: tmux types `Esc` as literal characters, herdr takes either,
    so `Escape` is the only spelling that works on both.
  - `Backspace` is **not forced** — the probe *underdetermines* it. Neither name is portable
    (`Backspace` is typed literally by tmux; `BSpace` is rejected by herdr), so the portability rule
    eliminates both and each choice costs exactly one rename. The tiebreak is **legibility and
    backend-neutrality**: `BSpace` is tmux's own private shorthand (tmux(1) lists it among "the
    following special key names are accepted"; no other backend here takes it), and a cross-backend
    vocabulary should not inherit one backend's abbreviation. Recorded as a judgment call, not a
    derivation.
  - Known cost of that call: if the rename is ever missed, `Backspace`-as-core degrades to *silent
    typing* on tmux, whereas `BSpace`-as-core would have degraded to a *loud error* on herdr. That
    cuts against the seam's own loudness preference, and is accepted on legibility grounds with the
    rename covered by its own scenario.

- **passthrough failure semantics are asymmetric, and that is not fixable here** — DECIDED: accepted,
  documented, not papered over. **At the backend boundary** herdr refuses an unknown key
  (`unsupported key <k>`) while **tmux has no refusal path at all** and types the token, so a mistyped
  non-core key is an error on one backend and silent garbage on the other. `cyber-mux` does not
  maintain a tmux key table to close this — that would make the passthrough a second vocabulary to
  keep current.
  Correction, caught at the impl gate: an earlier draft called herdr's refusal **the loud half** and
  argued "the core exists so that the portable path is also the loud one". False from where a caller
  sits — `Exec` discards stderr and reports failure as `null`, so `send keys <pane> Home` exits 0 and
  prints nothing on **both** backends. The asymmetry is real at the backend boundary and invisible at
  the CLI. That is a pre-existing property of the `Exec` seam affecting every verb, not something this
  split introduced; a follow-up owns caller-observable failure.

- **bare `send` fails loud** — DECIDED: help to stderr, exit 1, stdout clean — commander's default,
  no custom code. **SUPERSEDED by the `36-axi-error-surface` grill below: help to stdout, exit 2.**
  The reasoning below is also retracted, not just the shape — see there. Left standing as the record
  of what was decided, per this log's append-only rule; it is not the current behavior.
  Requester chose this shape. AXI's content-first principle (#8) says a bare group
  shows live data rather than help, and `send` does not satisfy it: every view `send` could derive
  already belongs to a verb — the pane
  enumeration to `list`, the current pane to `doctor` (`src/cli.ts`) — and the key vocabulary is a
  spec constant, not live data. Binding one of them to bare `send` would ship a second name for a
  shipped command. Whether #8 should carve out such a group is **open, and belongs to the contract
  rather than to this project** — the contract is shared with two other adopters, so `cyber-mux`
  states its own behavior, asserts nothing about theirs, and files the question. **Accepted cost:**
  `cyber-mux` diverges from #8's letter until that question is answered.

- **`nudge`'s future stays undecided** — DECIDED: out of scope per the CR. `nudge` is rewired to the
  new contract (`submit(exec, target, message)` for the initial turn, bare `submit` for the flush
  retry) and nothing else about it is settled.

Decisions (`36-axi-error-surface` grill — the CLI error surface vs AXI):

- **errors move to stdout** — DECIDED: every structured error is written to stdout, and stderr is
  reduced to diagnostics (warnings, progress, debug). Requester chose to follow AXI here rather than
  fork. AXI defines stdout as "all structured output the agent consumes — data, errors, suggestions"
  and stderr as what "agents don't read", so an agent-facing report on stderr is a report its own
  reader never sees. This bin's node had stated the inversion, and `cyberplace`'s node states it word
  for word — so the divergence was the org's adoption, not this bin's slip. **Accepted cost:** until
  `cyberplace` follows, an agent moving between the two bins meets errors on different streams. Fixing
  a node this bin does not own is recorded as a follow-up rather than ridden in here.

- **bare `send` is a #6 usage error, not a #8 amendment** — DECIDED: help to stdout, exit 2, and the
  earlier entry's reasoning is **retracted**. Two things were wrong with it. The shape: exit 1 was
  commander's default restated as the contract, where AXI puts incomplete input — a missing required
  parameter — at 2. The reasoning: it conceded an "amendment to #8" this repo never had to concede.
  AXI's #8 governs the bare **binary** ("running your CLI with no arguments", example `$ tasks`) and
  says nothing about a command **group** invoked with no subcommand. So #8 was never violated; it was
  never addressed to this case, and #6 alone decides it. The "accepted cost" it recorded was a cost
  paid for nothing.

- **bare `worktree` is left alone, on scope** — DECIDED: the error-surface pass corrects the
  `worktree` *subcommands* (`add`/`open`/`list`/`remove`) like every other verb and does **not** touch
  the bare group, which still ships help + exit 1. That is the CR's scope (issue #36 names the
  subcommands), and it is the only reason. An earlier draft of this CR justified it by arguing #8
  wants bare `worktree` to print its live listing — that argument is **withdrawn**, resting on the
  same #8 widening retracted above. Whether a data-bearing group should show its view is a real
  question, still open, still the contract's.

- **`exists` keeps `1` = `gone`, and it is a divergence, not an amendment** — DECIDED: unchanged
  behavior, corrected label. `exists` is a predicate and spends `1` on an answer rather than an error,
  the framing `grep`, POSIX `test` and `systemctl is-active` take. AXI reserves `1` for an error, so
  this genuinely diverges — but the corpus called it "an amendment to axi #6's 0/1 code set", which
  was wrong twice: the set was always 0/1/2 (nothing was amended), and what `exists` diverges on is
  the *meaning* of `1`, which no amendment ever covered. Recorded rather than mislabeled; whether to
  keep it is a separate question this CR does not settle.

- **`layout`'s frozen exit codes are reclassified in the same pass** — DECIDED: the `36` grill's
  Clearance was extended a second time, ratified in-session, to re-open `layout/`'s frozen suite —
  because leaving it untouched was not a gap but a **Conflict**: one validator (`isValidLayoutName`)
  was contracted at exit 1 by `layout.feature` and at exit 2 by this CR's new `layout save` row,
  through the same function, so no implementation could satisfy both. The reclassification is narrow
  and principled, not a sweep of all 22 exit-1 pins: only a **malformed name**, a **mutually
  exclusive flag pair**, and a **missing required parameter** (`save` with no pane and no `--from`)
  become `2` — four scenarios. Everything else stays `1`, and deliberately: a `validate` reporting a
  template's content invalid is a predicate answer (the same shape as `exists`), and a mutating verb
  (`apply`, `worktree add --layout`) refusing a bad template or a not-found name is a genuine
  operation failure. Neither is the malformed-argument family AXI puts at `2`. The stream and
  structure halves reached `layout` with **no** frozen conflict — no `layout` error was ever pinned to
  a stream — so only the exit codes needed the re-open.

Decisions (`pane-command-probe` — what a backend can say about a pane's command):

- **the "no multiplexer can report the command" premise was false, and is retracted** — DECIDED: the
  corpus, the `save` help text, `template-capture.ts` and the website all asserted that no backend
  reports a pane's command. **Probed live** (herdr 0.7.4, tmux 3.6b, wezterm 20240203, Linux/WSL2):
  herdr's `pane process-info` returns full argv for a pane's entire foreground tree
  (`{"argv":["claude"],...,"shell_pid":730648}`, and seven entries for a `pnpm dev` pane); tmux's
  `#{pane_current_command}` gives a bare process **name** (`python3`, never `python3 -u -c "…"`) and
  `#{pane_start_command}` the full launch line but **only** when tmux itself spawned it; wezterm's
  `cli list --format json` has **no** command field at all, only a free-text `title` that was measured
  **stale** — a pane genuinely running python still reported `"title": "zsh"`. `/proc` (tpgid →
  `cmdline`) recovers full argv from a pid on any backend, Linux only. So the claim was true only of
  the *launch record*, and false of what is knowable.

- **the limit is PORTABILITY, and the capture still writes no command** — DECIDED: `template save`
  keeps emitting no `command`, and every site now says why in portability terms. What a backend
  reports is the **resolved** command line, and resolution is not invertible: `nr web dev` comes back
  as `node /run/user/1000/fnm_multishells/4223_1784479278417/bin/nr web dev` — a uid, a pid and a
  timestamp in one path, dead on the next machine and often on the next login. An idle pane reports
  its shell; a `claude` pane reports exactly `claude`, the flags that made it that session already
  gone. A template is checked in and run elsewhere, and `apply` **submits** whatever `command` says,
  so a wrong one fails *by executing something*. Absent beats wrong, as it already does for `label`.
  **Accepted cost:** a captured template still needs its commands filled in by hand; `template edit`
  exists to make that cheap rather than to remove the need.

- **capturing the running command behind a flag was considered and rejected** — DECIDED: not built.
  A `--capture-commands` that wrote resolved argv would produce a file that *looks* portable, is not,
  and executes on apply. The alternative worth having instead is a capture-time **warning** naming
  what was observed, through the `TemplateCapture.warnings` channel that already carries the
  out-of-root-`cwd` note — the author gets the fact next to the pane it belongs to, without it landing
  in a file that will later be run. **Not implemented in this pass**; recorded so the option is not
  re-litigated from scratch.

- **`RegionPane.running` was designed and left unbuilt** — DECIDED: the seam, if ever pursued, is one
  optional field on `RegionPane` filled by the herdr adapter from `pane process-info` (shallowest
  `foreground_processes` entry, dropped when its pid equals `shell_pid` — the exact idle-shell test),
  with tmux limited to `#{pane_current_command}` and wezterm contributing **nothing**, since reporting
  a demonstrably stale `title` would be reporting a lie. Deliberately no `/proc` walk: it is Linux-only
  and would put an OS-specific branch inside an adapter whose whole design is a synchronous `Exec` over
  a CLI.

- **shell history is rejected as a source** — DECIDED: never read `~/.zsh_history` or equivalent to
  guess an idle pane's last command. It is per-**user** rather than per-pane (unattributable across
  concurrent panes, which is this project's normal case), it is written on shell exit so a live pane's
  most recent command is frequently absent, and it routinely contains secrets typed inline. `save`
  writes a file the user is expected to commit; scraping history into it would exfiltrate by default.

Decisions (`59-suite-format-repair` — closing the `56-spec-corpus-drift` suite-format backlog item):

- **the three flagged classes are FORM-only rewrites, never a behavioral change** — DECIDED: repaired
  in place against the frozen suites, no scenario dropped or narrowed in meaning.
  - `template/apply/apply.feature` named the internal `open`/`submit` adapter calls directly
    ("`open` is called with no launch", "`submit` is called…", "no submit is issued for it") across 5
    `Then`/`And` steps. Rewritten to the observable trace those calls actually leave — a pane opened
    with no command yet running, or a pane receiving (or never receiving) its command text — per
    suite-format's "never assert internal state or a function name" rule.
  - `template/apply/apply.feature` carried 4 evaluative `Then it is valid` steps (schema-validation
    scenarios for shared pane/tab labels). Rewritten to `Then it exits 0`, the artifact `template
    validate` already produces and the same shape the file's own `validate exits 0 on a valid
    template` scenario already uses — no new vocabulary introduced.
  - `mux/lookup/lookup.feature` carried two 3-way disjunctive `Given`s (tmux not-focused: not-active
    OR window-not-current OR no-attached-client; an unanswerable focus query: no primitive OR
    unresolvable pane OR erroring query). Both are genuine convergence shapes — three edges the CFG
    reconverges to one outcome — so both became `Scenario Outline`s with one condition per `Examples`
    row instead of an OR-chain in one `Given`, matching the "genuinely uniform enumerated set" carve-out
    suite-format reserves `Scenario Outline` for.
  - Scenario **titles** were preserved everywhere except the tmux not-focused case, whose title named
    only one of the three conditions ("no attached client is viewing it"); it became
    `tmux reports a pane not focused when <condition>` to cover all three rows, and the sibling
    `README.md` scenario-map row was updated to match (map binding is by exact title text — `checkSuite`
    would otherwise report every renamed scenario as unmapped).
  - Verified via the suite-format `check-suite` engine (`sdd`'s
    `plugins/sdd/skills/spec-gate/scripts/check-suite.mts`, both `--files` per-suite and `--root
    .agents/spec` corpus-wide) — clean before and after, since the mechanical linter does not catch
    these three classes; they were located by grepping each suite directly for the disjunction/
    internal-call/evaluative shapes the audit named, then confirmed against `sdd:suite-format-governance`
    by hand. `check-suite`'s scenario-map binding check caught the one title rename that needed a
    README update. `pnpm verify` green after.

Decisions (`45-screen-adapter` — a screen adapter, or an honest rejection):

- **`screen` is DROPPED as a drivable backend, kept as a DETECTED-but-rejected value** — DECIDED after
  an empirical probe. The `CYBER_MUX` contract, the docs, and the code disagreed: `screen` was named
  as an accepted override value alongside `tmux`/`herdr`/`wezterm`, but no adapter stood behind it, so
  pinning `CYBER_MUX=screen` produced the generic "run inside a multiplexer" throw — a lie, since the
  caller had declared a real multiplexer. Issue #45 framed it as a fork: build the adapter, or drop
  the value. **Dropped.** The value stays KNOWN (the probe still recognizes an override pinning it and
  a screen ancestor), but `selectSessionAdapter`/`resolveMuxAdapter` reject it with a message that
  NAMES screen and states the reason. Keeping it recognized-then-rejected is what makes the override
  honest: pinning it tells the caller the truth immediately instead of being silently ignored and
  fallen through to discovery.

- **the probe that decided the fork — screen has no stable per-pane identity for DRIVEN panes** —
  DECIDED against `implement`, on evidence, not on a self-imposed design limit. Probed live against
  **GNU Screen 5.0.2** (installed via linuxbrew; no apt/root in the sandbox), driving a detached
  session exactly as an adapter would (`screen -dmS`, `screen -X`, `-p <n> -X stuff`, `-X hardcopy`):
  - **Windows have stable numbers, addressable for send/read.** `screen -p N -X stuff` reaches window
    N; `screen -p N -X hardcopy <tmpfile>` captures it. So a *window*-modeled pane is externally
    addressable — the one affordance that works.
  - **Self-identity is broken for driver-created panes.** `$WINDOW` is set (`=0`) only for windows
    screen itself spawns (the initial window); it is **empty** for windows created via `screen -X
    screen` — exactly how an adapter opens a pane. `$STY` is likewise truncated to the session name
    (not the canonical `PID.tty.host`) for remote-created windows. tmux/herdr/wezterm each guarantee a
    per-pane env var (`$TMUX_PANE`/`$HERDR_PANE_ID`/`$WEZTERM_PANE`); screen does not, so `currentPane`
    would have to be **synthesized** by cyber-mux (inject `CYBER_MUX_PANE` through a `bash -c 'export
    …; exec'` launch wrapper), not read.
  - **No enumeration primitive when driven.** `screen -Q windows` returns empty in a detached/driven
    session; only `-Q number` (the *current* window) answers. `listPanes`/`paneExists` — and the
    free-window-number pick a silent `-X screen` would need to know the id it just created — have no
    clean backend query; they would have to parse a rendered `windowlist` hardcopy. Fragile.
  - **Regions have no id at all** — screen's native split unit is positional-only (`focus
    next/prev/up/down`), so a faithful adapter must remodel "pane" as "window" with fragile,
    positional, ephemeral viewports, not use screen's own splits.
  Contrast wezterm (#47), which fit cleanly: `$WEZTERM_PANE` in every pane, `list --format json`
  returning id/tab/workspace/cwd/title, a real workspace tier. Screen fails on the **two** most
  load-bearing seam operations — self-identity and enumeration — and the id-injection workaround for
  the first is itself blocked by the second. That is not the "clearly favorable" probe that would
  justify a large, empirically-unverifiable adapter build; per the seam's own preference, a
  half-faithful adapter with unstable identity is worse than an honest rejection.

- **the drop is deliberately NOT a removal of `screen` from the known set** — DECIDED, and the
  alternative was considered and rejected. Removing `screen` from `KNOWN_MUX`/`MUX_COMM` would make
  `CYBER_MUX=screen` an *unknown* value that falls through to ancestry discovery — silently ignoring
  the override and driving whatever else is out there. That is the exact failure the override exists to
  prevent (it exists to PIN detection when the ancestry walk cannot). So `screen` stays detected; only
  the drive step rejects it. `none` is the precedent for "known but not a backend"; `screen` joins it,
  with its own message because — unlike `none` — a screen caller *is* inside a multiplexer.

- **the fork was ratified by the Council, not decided unilaterally** — DECIDED to surface the priced
  fork rather than silently commit to either path: the probe was favorable enough on the
  windows-have-ids axis to be worth a ratification, and DROP (the recommended default) was chosen. The
  large-CR IMPLEMENT path (a `session.screen.ts` modeling panes as windows, synthesizing identity via
  a launch wrapper, parsing windowlist hardcopy for enumeration, widening `LivePane.mux` +
  consumers, omitting `regions`/`worktree`, all empirically unverifiable end-to-end) remains on record
  here should someone ever want to reprice it — the probe is the input that would decide it again.

Decisions (`46-zellij-adapter` — the fourth backend, and the pane-identity gate it turned on):

- **the identity gate resolved to BUILD — Zellij CAN yield a stable per-pane handle, as of 0.44.0** —
  DECIDED: a full adapter, not a deferral. This was the decisive question (issue #46 flagged it, and
  #45's screen adapter faces the same one): `zellij action` was, historically, almost entirely
  FOCUS-relative — `write-chars`/`dump-screen`/`rename-pane`/`close-pane` all acted on the focused
  pane, with no per-pane target and no "focus pane X" primitive, only directional `move-focus`. On
  that surface no faithful adapter is possible and the honest answer would have been to decline, at
  #45's bar. **Probed, not assumed** (the whole point — an assistant reasoning from a stale knowledge
  cutoff would have declared Zellij focus-only and been confidently wrong): Zellij **0.44.0
  (2026-03-23)** added `-p, --pane-id` across the write/dump/rename/close action family, `focus-pane-id
  <id>` (0.44.1), `list-panes --json`, and ids returned from `new-pane`/`new-tab` — a stable,
  discoverable, CLI-addressable per-pane handle. So the adapter is gated on **Zellij ≥ 0.44.1**; on an
  older binary the commands fail and the adapter surfaces the failure rather than silently driving the
  focused pane. Evidence is the Zellij docs + CHANGELOG only — Zellij is not installed in the build
  sandbox — so the adapter carries the same "not verified against a live binary" disclaimer
  `mux.wezterm.ts` does, with two literals flagged for a live spot-check (the exact id form `new-pane`
  prints, and the shell value of `$ZELLIJ_PANE_ID`). Both are handled either way — ids are carried
  verbatim and compared through a normalizer that folds a bare `N` to its `terminal_N` twin, per the
  docs' own `terminal_N | plugin_N | bare N` scheme.

- **self-identity is `$ZELLIJ_PANE_ID`** — DECIDED: the fast-path pane var, alongside
  `$TMUX_PANE`/`$HERDR_PANE_ID`/`$WEZTERM_PANE`. `$ZELLIJ`/`$ZELLIJ_SESSION_NAME` name the SESSION, not
  the pane — the issue's own worry — but Zellij also exports `$ZELLIJ_PANE_ID` in every terminal pane,
  so `currentPane` gets a real fast path and does not fall to the ancestry walk. Detection uses `$ZELLIJ`
  as the fast-positive hint (the role `$TMUX`/`$HERDR_ENV` play), with the pane riding separately in
  `$ZELLIJ_PANE_ID`. **Shared with #45/mux-screen:** this is the identity answer for a session-scoped
  multiplexer — a per-pane env var plus a per-pane CLI target is exactly what screen would need and, on
  probing, lacks; the two backends' feasibility genuinely diverges here despite the surface similarity.

- **the workspace tier COLLAPSES to a tab, but occupancy is still reported — and the limit is the
  SEAM's, not Zellij's** — DECIDED, and this is the load-bearing design finding. Zellij's native tiers
  are Session › Tab › Pane, and the issue's thesis was that Session answers `OpenedPane.workspace` where
  tmux cannot. Half of that holds and half does not, for a reason worth recording. Zellij pane ids are
  **session-scoped**: driving a pane in another session requires `zellij --session <name> action …`, and
  `MuxTarget` carries only an opaque pane id with **no session qualifier**. So a `workspace` placement
  that created a fresh session (`zellij attach --create-background`, which does work non-interactively)
  would hand back a pane that fails on the very next `write`/`read`/`focus` — a trap, not a tier. The
  adapter therefore operates within the AMBIENT session and collapses `workspace` onto a new **tab**, the
  same collapse tmux makes onto a Window. **Unlike tmux, occupancy IS answered:** every `OpenedPane`
  reports `workspace = $ZELLIJ_SESSION_NAME` (injected at resolution via `createZellijAdapter({session})`),
  because every pane genuinely lives in that session. So the issue's "workspace is answerable rather than
  absent" is delivered for occupancy, while separate DRIVABLE workspaces are out of reach. **The fix, if
  ever pursued, is a seam change, not an adapter change:** an optional session/workspace qualifier on
  `MuxTarget` would let the adapter address a second session and lift the collapse. Recorded as a
  follow-up; not built here, and not Zellij's shortcoming to route around.

- **`group` is a complete no-op, herdr/wezterm-style** — DECIDED: the session is a real workspace tier
  that already groups every tab in it (exactly what `OpenedPane.workspace` reports), and Zellij has no
  per-tab opaque metadata store — no tmux-style window option — to hold a finer per-caller tag in. So
  there is nothing for `group` to write, the same complete answer wezterm gives at its window/workspace
  tier; the granularity is the whole session, coarser than tmux's per-window tag but honest.

- **tiled splits cannot be sized, so `canSizeSplits` is omitted** — DECIDED: `new-pane`'s
  `-x/-y/--width/--height` all require `--floating`; a tiled `pane:*` split is always even. Rather than
  reach for floating panes (a different pane model cyber-mux does not use elsewhere) to honor a ratio,
  the adapter omits `canSizeSplits` and drops a `ratio`, and callers degrade to the even default with one
  warning — the exact path the flag's absence already documents.

- **`from` is honored by focusing the target pane first** — DECIDED, with the focus move as an accepted
  cost. `new-pane` has no split-target flag (only `--tab-id`); it splits the focused pane. The seam's
  `from` names WHICH pane a `pane:*` split lands beside, and the only way to choose it is
  `focus-pane-id <from>` before `new-pane`. That is a real, visible focus move — accepted because
  splitting the RIGHT pane matters more than avoiding it, and an omitted `from` still takes Zellij's own
  focused-pane default (the backend default the seam documents, never silently "the caller's pane").

- **pane geometry (`regions`) is deliberately unbuilt, though Zellij reports it** — DECIDED: omitted, a
  follow-up. `list-panes --json` carries `pane_x`/`pane_y`/`pane_rows`/`pane_columns`, so unlike wezterm
  (which has no position at all) Zellij COULD implement `describeRegion`/`describeWorkspace` and unlock
  `template save`. But the cell-vs-divider semantics of Zellij's rects (does `pane_columns` include the
  divider column between panes, the way tmux's width excludes it?) cannot be pinned from docs and would
  be a guess baked into a captured template a user commits. So `regions` is omitted — `template save`
  refuses on zellij by naming the backend, the same optional-absence it handles for wezterm — and left
  as a clean follow-up for a live-binary pass. This keeps this CR's scope at the core adapter.

- **wins Zellij has that wezterm does not, recorded so they are not re-questioned** — DECIDED: Zellij CAN
  name a pane (`new-pane --name` / `rename-pane --pane-id`), so `rename(…, 'pane', …)` is a real rename,
  not a throw; and it CAN report which pane is focused (`list-panes --json`'s `is_focused`), so
  `isPaneFocused` answers a real boolean rather than always `unknown`. `read` uses `dump-screen` to
  stdout (the viewport; `--full` plus a client-side tail for a `lines` request, Zellij having no
  trailing-N primitive); env is non-native on `new-pane`/`new-tab`, so every open rides the same
  `envFallback` prefix-or-warn compensation wezterm uses.

Decisions (`worktree-provision` — reuse a free worktree instead of always creating one, issue #79):

- **`provision` is `prune`'s twin, and shares its selection predicate** — DECIDED: the reuse-candidate set
  is *exactly* the disposable set. `pruneWorktrees` REMOVES every worktree `isWorktreeRemovable` clears;
  `provisionWorktree` RECYCLES one, and its **default availability gate IS `isWorktreeRemovable`** — the
  same `linked && !prunable && merged && !dirty && !workspace` composite prune deletes on. Structured
  identically (`provisionWorktree(exec, primaryRoot, opts)` raw + `WorktreeApi.provision` bound, mirroring
  `pruneWorktrees`/`prune`), so the two can never disagree about which worktrees are free — prune could
  have deleted precisely the checkout provision hands back. The primary checkout is filtered out
  (`.filter(entry => entry.linked)`) **before** the gate runs, matching prune's own absolute refusal, so
  even a host predicate that forgot the check can never return the primary.

- **availability is an INJECTED predicate — the boundary is held** — DECIDED: `worktree.ts`'s rule is *no
  host-specific concepts*, and "available" splits at exactly that line. The clean/landed/on-disk/
  unoccupied part is generic git and stays here as the default `isWorktreeRemovable`. But "no **live agent
  session** is attached to this worktree" is HOST semantics — a cyberlegion ship/pane this module must
  never know — so it enters as `available?: (entry) => boolean`, a parameter, not a hardcoded rule. The
  host (cyberlegion) composes its own predicate on top (`e => isWorktreeRemovable(e) && noLivePane(e)`, or
  a looser one). No live-session/pane concept is hardcoded into `worktree.ts`; the seam is a plain
  `WorktreeEntry` predicate keyed on facts already in the entry.

- **occupancy: the DEFAULT excludes occupied, and it stays overridable** — DECIDED, Council-ratified. The
  default gate is `isWorktreeRemovable`, whose `!workspace` clause excludes a worktree a mux workspace
  holds — the safe default, and the exact mirror of prune. A host that wants to reuse an occupied-but-stale
  worktree passes its own predicate; because availability is a *replaceable* predicate rather than an
  always-ANDed rule, the host can genuinely LOOSEN the gate, not only narrow it. The alternative — dropping
  the workspace clause from the generic gate and leaving occupancy entirely to the injected predicate — was
  considered and rejected: it would make the default no longer mirror prune, and a caller who forgot the
  predicate could reuse an occupied worktree. The result **always carries the reused entry in full**
  (`reused: WorktreeEntry`), so its `workspace` (occupancy) and prior `branch` are reported to the caller,
  per the Council's requirement that the response include workspace info.

- **reuse-state: a reused worktree is reset to a PRISTINE tree on a fresh branch** — DECIDED,
  Council-ratified over the two softer alternatives. On reuse the checkout is `git switch -c <branch>
  <base>`, then `git reset --hard <base>`, then `git clean -fdx` — a fresh branch and a cold, deterministic
  tree. The safety is *inherited from the gate*: the `merged` clause proves the old branch's work has
  landed (repointing it destroys nothing the trunk lacks — the same fact prune leans on to delete the whole
  checkout, here spent on reusing it), and the `dirty === false` clause proves there is nothing uncommitted
  to clobber. Because the decision was ratified, the destructive `clean -fdx` is a **Council choice, not a
  silent default**.
  - **Alternatives surfaced and rejected:** *open as-is* (hand back on the existing merged branch) —
    rejected because the caller's new commits would land on an old, landed branch, almost always the wrong
    branch for new work; *fresh branch, warm tree* (skip `clean -fdx` to keep `node_modules`/`dist` warm as
    the payoff over a fresh `add`) — a real contender the Council declined in favor of a guaranteed-pristine
    tree, accepting that the reused checkout pays a reinstall.
  - **`base` resolution:** the caller's `create.base` when given, else the resolved default branch
    (`resolveDefaultBranchRef`, already in hand from the list — no new git plumbing), else `HEAD`. A caller
    that wants reuse and create to land on an identical start-point passes `base` explicitly; the fallback
    exists so a bare call is still deterministic.

- **`dryRun` was NOT added, unlike prune** — DECIDED, on scope. Prune's `dryRun` exists because prune is
  the CLI's *default* invocation and a bare run must be safe to preview; `provision` is an *action a caller
  asks for by name* and returns what it did (`action: 'reused' | 'created'`), so a preview mode has no
  bare-invocation to protect. Left as a clean follow-up if a CLI `worktree provision` verb ever wants one.
