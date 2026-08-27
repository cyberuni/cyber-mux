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

Decisions (`83-adopt-scenario-bridge-binding` — adopt the SDD scenario-bridge `@id:` binding convention corpus-wide, issue #83):

- **every suite adopts the `@id:` binding convention, corpus-wide, this CR** — DECIDED: all 14 frozen
  suites (281 scenarios) get an `@id:<slug>` on every `Scenario`/`Scenario Outline`, and their proving
  tests bind to it. Before this, the impl-gate scenario-bridge (`verify-scenarios`) reported UNBOUND for
  every scenario, so each impl-judge pass paid the full by-hand re-derivation the bridge exists to remove.
  The issue proposed doing it per-node-as-touched; the requester chose the full sweep. **No behavior
  change:** adding an `@id:` tag is additive and narrows nothing, so it self-clears the freeze; retitling
  tests changes no assertion. The convention itself is external (the `verify-scenarios` skill) and is
  pointed to, not restated — the local standing rule lives in [`../README.md`](../README.md).

- **mechanism is `@id:<slug>` tags, not verbatim-name binding** — DECIDED over the fallback. The bridge
  keys a scenario by its `@id:<slug>` tag if present, else its verbatim name. Tags were chosen: they
  survive a later scenario rename, give the test an ergonomic short leaf title (the scenario names here
  are long sentences), and are the bridge's primary convention. Cost: it edits the frozen `.feature`
  files (a tag line per scenario) — accepted because the edit is additive.

- **THE HOIST rule — a node wrapper must be the FIRST `spec:` segment** — DECIDED, learned at the
  exemplar (`cli/worktree`). The bridge takes the first `spec:` segment in the ` > `-joined describe chain
  and stops. The tests had one coarse top wrapper per file (`describe('spec:cyber-mux/mux')` /
  `.../template`), so a *nested* leaf-node wrapper (`spec:cyber-mux/cli/worktree`) is shadowed and stays
  unbound. The fix is to **hoist** each leaf node to a **top-level** `describe('spec:cyber-mux/<node>')`
  (its own `logs`/`beforeEach`), the shape the pre-existing top-level `spec:cyber-mux/template` block
  already used. A single test file that proved several nodes is split into several top-level node
  wrappers.

- **coverage gaps are recorded, never fabricated** — DECIDED. Some `cli/X` scenarios have no direct
  CLI-surface test — only a library-seam test at the paired `mux/X` node proves the behavior (e.g. 7 of
  `cli/worktree`'s 31: remove-dirty/gone, placement-fallback, label). This CR **binds what exists** and
  records each true gap as a `backlog` follow-up (a `cli/X` scenario wanting a direct CLI test); it does
  **not** author the missing tests (out of the issue's binding scope) and does **not** invent a binding.
  The impl-judge hand-derives those few — the pre-existing state — so the CR is a strict net improvement,
  not a regression.

Decisions (`18-seam-ratio-range` — should the seam validate `MuxOpenOptions.ratio`, or is the range the caller's, issue #18):

- **the SEAM validates `0 < ratio < 1`, and the range is a precondition rather than a caller
  convention** — DECIDED, resolving a fork the split-options fold-back (CR 10) left deliberately open.
  The prior state was a recorded boundary: adapters rendered whatever number they were handed, the
  `0 < ratio < 1` bar lived only in `template/`'s schema, and a caller reaching an adapter directly —
  the only way to set a ratio today, no CLI flag exposes it — got no check. That renders a *silently
  broken* split for an out-of-range value: above 1 the sizing math goes negative (`tmux -l -50%`,
  `wezterm --percent -50`), and 0 or 1 hands one side the whole region and the other nothing. Neither
  adapter refused either. The issue framed it as a genuine fork — validate at the seam, or keep the
  range the caller's with the schema its only home — and called both defensible. **Chosen: validate at
  the seam**, on the corpus's own dominant principle. This seam prefers a loud refusal to a silent
  wrong answer everywhere else it has faced the choice (screen's honest rejection over a half-faithful
  adapter, wezterm's pane-rename throw over a silent no-op, `absent` over a false `none`); an
  out-of-range ratio rendered into a negative length is precisely that silent-wrong output, and the
  one place the seam was still paying the cost it refuses elsewhere. The `MuxOpenOptions.ratio`
  contract already *documented* `0 < ratio < 1`; leaving it unenforced made the contract a claim no
  code stood behind — the same shape as the `screen` value that was named-but-unbacked (`45`), here
  producing garbage rather than a lie.

- **range validity is the seam's; degrade policy stays the caller's — the env decision draws exactly
  this line** — DECIDED, and it is why this does not contradict the recorded reason the ratio DEGRADE
  policy lives with `template`. The env grill (`placement.feature`, `--env` block) kept ratio's degrade
  policy with the caller *because template is its only caller*, and moved env's *meaning* to the seam
  *because env has two*. Those are two different questions about ratio: **degrade policy** — what to do
  when a backend cannot size a split *at all* — is genuinely a caller choice (warn once, take the even
  default), unchanged here; **range validity** — whether 5, 0, or −1 is a legal ratio — is a universal
  property of what a ratio IS, true on every backend, the seam's own vocabulary. By the env decision's
  own logic the universal invariant belongs at the seam, so a second caller (the corpus already
  anticipates "another such caller") cannot quietly reach an adapter with a malformed value. The two
  are fully compatible: this CR moves only the invariant, and touches no degrade path.

- **the guard lives WITH the size render, so a backend that renders no ratio checks none** — DECIDED.
  `assertRatioInRange` (`ratio.ts`, a shared module in the `env-fallback.ts` mold — one cross-adapter
  rule in one place so it cannot be wired on one adapter and forgotten on another) is called by each
  sizing backend's size helper (`toTmuxSize`, `toWeztermSize`, herdr's new `toHerdrRatio`). It throws
  before the split command is built, so no broken split is ever issued. A backend that cannot size a
  split (`zellij`) renders no ratio and so never reaches the guard — a dropped value is never checked,
  valid or not, which is the same even-default degrade its callers already take. This keeps the
  adapters honest renderers (the check is a precondition at the render's mouth, not scattered logic)
  while closing the footgun.

- **`template`'s schema is KEPT as the earlier, per-node layer — two layers, different jobs** —
  DECIDED, not collapsed into the seam guard. The schema refuses a degenerate ratio at
  `template validate` time, per node, with a path-qualified message (`root.first.ratio: must be a
  number strictly between 0 and 1 — got …`) — a better authoring signal than a bare seam throw, and it
  catches the whole template before any pane opens. The seam guard is the backstop for a *direct*
  caller that has no schema in front of it. Defense in depth is idiomatic here (env's meaning at the
  seam plus its flag surface at the CLI; occupancy vs binding as separate reports), so the overlap is
  deliberate, not a duplication to remove.

- **decided rather than mailed, and recorded for the owner's ratification at the PR** — DECIDED. The
  issue called the fork 50/50, which would ordinarily be the owner's call. It is not a coin-flip once
  the seam's loud-over-quiet principle is weighed against a concrete silent-corruption failure, so the
  decision was made on that principle and recorded here — in the append-only, descriptive log that is
  the owner's ratification point at review — rather than deferred. If the owner prefers the thin-seam
  boundary, the change is a small, cleanly revertable guard plus one additive scenario, and this entry
  is the full rationale to revert against.

Decisions (`99-floating-panes` — the `pane:float` placement):

- **a PLACEMENT (`pane:float`), not a `floating?: boolean` on the open contract** — DECIDED. The issue
  offered both. A placement is the shape the options already have: `MuxPlacement`'s members are
  mutually exclusive, and floating is too — a pane either takes a share of the region, opens its own
  space, or sits above one. A boolean is orthogonal by construction, so it would owe an answer to
  `{ at: 'workspace', floating: true }`, a combination no caller asked for and no backend realizes;
  either the seam invents a meaning or every adapter grows a guard against a state the type permits.
  The placement also reaches the CLI for free — `--at pane:float`, one more member of a choice list
  that is already the flag's whole contract — where a boolean would need a second flag whose validity
  depends on the first.

- **real on tmux/zellij, REFUSED by name on wezterm/herdr — the #97 altitude split** — DECIDED, and it
  is what distinguishes this from `waitForOutput`. A wait on raw terminal text is realizable on every
  backend, because every backend can already `read`; a floating pane is a primitive two backends have
  (tmux 3.7's `new-pane`, zellij's `new-pane --floating`) and two simply do not. There is nothing to
  emulate it *with*: the nearest substitute is a tiled split, which resizes the region's other panes —
  the one property `pane:float` exists to avoid — so a caller would be handed a pane whose id satisfies
  them and whose behavior does not. Same emulate-or-refuse rule `agentLifecycle` follows.

- **a `canFloatPanes` declaration BESIDE the refusal, not instead of it** — DECIDED. The declaration
  mirrors `canSizeSplits` in shape and inverts it in meaning: a `no` there means *degrade* (the
  backend's own even split, one warning), a `no` here means *refuse*. It exists so a caller — and the
  CLI — can ask before opening, and `open` re-checks as its own contract, the same belt-and-braces
  `agent wait` runs against `agentLifecycle`. Two mechanisms, because the pre-flight answer and the
  enforcement are needed at different altitudes: the CLI must refuse before touching a backend so a
  refused float opens nothing, and a direct library caller that skips the question must still be
  refused.

- **the refusal is `FloatingPanesUnsupportedError` on the `.` barrel, not a subpath** —
  DECIDED. `CaptureUnsupportedError` and `AgentLifecycleUnsupportedError` ride the subpaths whose verbs
  they refuse (`template`, `agent`); the verb refused here is `open`, which is on the surface everybody
  gets, so a consumer must be able to catch it from there. It lives in its own `floating.ts` rather
  than in `mux.ts` because `mux.ts` is the contract and carries no runtime value — putting a class
  there would make every consumer of the types import a value too.

- **`--at pane:float` stays in the CLI choice list on every backend** — DECIDED, over gating the list
  on the detected backend. Gating would make `--help` say different things in different panes, and
  would render a genuine capability limit as a *usage* error (exit 2) when it is an *operation* failure
  (exit 1) — the invocation is well-formed and the value is legal. So the value always parses and the
  backend refuses it, naming itself and naming the backends that can.

- **`ratio` is dropped on a float, even on tmux, which can size a split** — DECIDED. A float takes no
  share of the region, so there is no original pane whose fraction a ratio could be; `new-pane` sizes
  in absolute columns and lines instead. Letting `ratio` mean "cells" on this one placement would give
  one option two unit systems. A sized float, if it is ever wanted, is a separate option.

- **tmux's floating-pane support is DECLARED, never version-probed** — DECIDED. `new-pane` is 3.7's,
  and the adapter version-probes nothing else; a probe would cost an exec on every resolution to
  pre-empt a failure tmux already reports precisely (`unknown command`, surfaced by the adapter naming
  the command that failed). Silent-wrong-pane is the failure mode worth engineering against, and an
  absent `new-pane` has nothing it could be mistaken for. Related: `new-pane -T` (a title at birth)
  lands in 3.8, one release after the pane, so the label rides the post-birth `select-pane -T` rename
  every other pane placement already takes — one spelling, and one that works on 3.7.

- **the tmux and zellij argv are probed from the projects' own CHANGES/docs, not a live binary** —
  RECORDED as a known limit, in the same disclaimer `mux.wezterm.ts` and `mux.zellij.ts` already carry:
  tmux 3.7 is not installed in this sandbox (3.6b is) and zellij is not installed at all. The tests
  assert the argv each adapter emits against a mocked `Exec`, which is exactly the part a live binary
  would confirm. Worth one confirmation each on a live 3.7 and a live 0.44.1.

Decisions (`117-float-refusal-vs-degrade` — should a float-less backend refuse or degrade, issue #117):

- **the refusal STANDS: a float-less backend refuses, it does not substitute** — DECIDED, on a
  challenge worth recording because the challenge was reasonable. `cyber-mux` exists to spawn agents,
  so a raised objection was that refusing an open means *the agent is never created*, and a worse
  layout beats no agent at all. The premise does not survive contact with what the refusal actually
  does: it is **pre-flight and side-effect-free** — no command is issued, nothing is half-opened — and
  it throws a named, catchable `FloatingPanesUnsupportedError` carrying the backend. `canFloatPanes`
  is the pre-flight query that exists for exactly this, so "float if possible, else a tab" is two lines
  in the CALLER. The real question is therefore not *refuse vs. spawn* but *who owns the fallback
  policy*, and the answer is the caller: it is the only layer that knows whether co-visibility was the
  point or a nicety. A spawner that needs a guaranteed pane should ask for `tab` outright.

- **a tab would be a more truthful degrade than a split, if a degrade is ever added** — RECORDED, and
  it sharpens why the cmux/otty defect was the worst available substitution rather than merely a wrong
  one. A float's defining property, per `MuxPlacement`'s own contract, is that it **displaces nothing
  and no existing pane is resized**. A `tab` preserves that property and loses only co-visibility. A
  tiled split violates *precisely* the property the float was asked for — it resizes the region's other
  panes. So the two adapters were not just substituting; they were substituting the one placement that
  contradicts the request. This holds whether or not a degrade path is ever offered.

- **`LivePane.floating` (issue #112) changes the calculus, and is the condition under which this may be
  revisited** — RECORDED. The original refusal reasoning rested on a silent substitution being
  **irrecoverable**: a caller handed a tiled pane had no way to discover it. That is no longer true —
  the read side now reports whether a pane floats on every backend, so a degrade is detectable after
  the fact. This does not by itself justify degrading, because detectable still requires a caller who
  knows to look, but it removes the strongest argument against ever doing so. Anyone reopening this
  should start here.

- **any future degrade must be an OPT-IN declared by the caller, never an adapter decision** —
  DECIDED as the shape, so the question does not get relitigated from scratch. The invariant worth
  protecting is not "never degrade"; it is **a caller always knows what it got**. An explicit
  tolerance (`open({ at: 'pane:float', fallback: 'tab' })`, or a CLI `--degrade`) preserves that; an
  adapter silently choosing does not. This is the same layering the seam already uses where a degrade
  IS truthful — `ratio` degrades to the backend's even default with a warning, and `canSizeSplits`
  declares it — versus `canFloatPanes`, whose absence means refuse. That contrast, stated at
  `MuxAdapter.canFloatPanes`, is the whole reason the two declarations exist rather than one, and it
  survives this challenge intact.

- **the `99-floating-panes` open item is now discharged** — RECORDED, since this log is append-only and
  that entry closed asking for "one confirmation each on a live 3.7 and a live 0.44.1". Both are done:
  issue #113 pinned the tmux float CREATE path against a live 3.7c and made CI build 3.7c from source
  so the float rows execute rather than skip, and the zellij adapter now runs against a live 0.44.3 in
  the same job. The argv that was probed from CHANGES/docs has been confirmed against real binaries.

Decisions (`backend-survey-2026-08` — feasibility verdicts for multiplexers not yet driven):

- **`monotykamary/openmux` — VERDICT: blocked-upstream.** 88 stars, pushed 2026-06-16, Bun/TypeScript,
  MIT. Probed 2026-08-20 against `docs/guides/cli.md`, not the README. Note the star count: this is
  BELOW the 500-star discovery filter the breadth sweep uses, and it was surfaced by a name search
  rather than by the sweep. Gated anyway — the filter decides what to *look* at, so a candidate
  arriving by another route is still gated on its merits.
  Gate 1 (per-pane identity) **CLEARED**, and it is the one that matters: `--pane <selector>` accepts
  `focused` (default), `main`, `stack:<n>`, `pane:<id>`, `pty:<id>`, and a raw `pane-123` treated as
  `pane:<id>`. Real ids, not only relative selectors — so this is NOT screen's problem.
  Gate 2 (id at birth) **FAILED**: `pane split --direction vertical/horizontal` documents no output,
  so an `open()` has nothing to return as `OpenedPane.id`.
  Gate 3 (enumeration) **FAILED**: there is no pane list command. `session list` enumerates sessions
  only. So `listPanes` cannot be implemented, and the snapshot-before/diff-after recovery that would
  otherwise rescue gate 2 has nothing to snapshot.
  It has the rest: `pane send --pane <sel> --text` (with C-style escapes), `pane capture --pane <sel>
  --lines N --format ansi`, `session create/attach`, over a control socket to a running UI.
  **RECHECK TRIGGER:** `pane split` printing the created pane's id, OR any pane-enumeration command.
  Either one alone probably suffices — an enumeration makes the diff-after recovery available. Both
  are additive CLI surface on identity that already exists, not a redesign.

- **`milind-soni/OpenMausBot` — VERDICT: not-a-multiplexer.** 1,315 stars, pushed 2026-08-20,
  TypeScript/Electron. Recorded because the name recurs in searches near `openmux` and will be asked
  about again. It is a desktop chat app presenting AI agents (Claude, Codex, Grok) as contacts, with a
  local harness server on `127.0.0.1:8799`; agents are processes, not panes, and there is no CLI for
  creating or addressing a terminal pane. Nothing for `MuxAdapter` to drive. Durable — this would need
  the project to become a different kind of program.

- **Candidates identified but NOT yet gated**, recorded so the next sweep starts here rather than
  re-querying: `Helvesec/rmux` (2.6k, Rust — self-describes as built to be driven from code, with a
  typed SDK, and native on Windows, which no current backend is; the most interesting of these by
  some distance), `Gaurav-Gosain/tuios` (3.5k, Go), `directvt/vtm` (3.4k, C++), `aaronjanse/3mux`
  (1.9k, Go), `prompt-toolkit/pymux` (1.5k, Python), `deadpixi/mtm` (1.2k, C), `Yazelix/nova` (1.1k,
  Rust), `cosmos72/twin` (1.1k, C), `martanne/abduco` (978, C), `iAmCorey/kooky` (615, Swift — an
  agent-workflow terminal, the same niche cmux and otty occupy). Star counts queried 2026-08-20.
  These carry NO verdict: they were surveyed for existence, never gated on the three drivability
  criteria. Do not cite this list as evidence any of them can or cannot be driven.

Decisions (`backend-survey-2026-08b` — feasibility verdicts for multiplexers not yet driven):

- **`Helvesec/rmux` — VERDICT: viable.** 2,598 stars, probed 2026-08-26 against a **live binary**,
  rmux 0.10.0 installed via `cargo install rmux --locked` — not against the docs, which were
  inconclusive on gates 2 and 3 because rmux.io/docs/cli documents the typed SDK rather than the
  CLI's print behavior. Installing it was what settled this, and it is the first candidate in either
  sweep that could be probed rather than read.
  Gate 1 (per-pane identity) **CLEARED**: tmux-shaped stable ids — `list-panes -F '#{pane_id}'`
  returns `%0`, and `send-keys -t %1` followed by `capture-pane -p -t %1` round-trips a value, so a
  pane is addressable by id from outside. Real identity, not a relative selector.
  Gate 2 (id at birth) **CLEARED**: `split-window -d -t probe -P -F '#{pane_id}'` prints `%1` —
  tmux's own `-P -F` print-format.
  Gate 3 (enumeration) **CLEARED**: `list-panes -t probe -F '#{pane_id}'` lists `%0`/`%1`, with
  arbitrary `-F` formats, so the snapshot-before/diff-after recovery is available too.
  Also held, probed the same session: `-c`/`-e` for cwd and env at birth (`split-window -c /etc -e
  CM_PROBE=yes` → `%2 /etc`); the `@cm_ws` user-option mechanism INCLUDING the server-side filter
  (`list-windows -f '#{==:#{@cm_ws},grp1}'` → `@0`), which is `TMUX_WORKSPACE_GROUP_OPTION`'s exact
  design working unmodified; and `#{window_layout}` returning tmux's nested layout string, so
  `RegionInspector` is realizable. `rmux list-commands` reports ~90 tmux-named commands.
  One gap: **no floating panes** — `new-pane` (tmux 3.7's) answers `unknown command`, so rmux would
  declare `canFloatPanes: false` and refuse `pane:float` by name.
  Runs natively on Linux, macOS, and **Windows**, which no current backend does.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/136

- **`Gaurav-Gosain/tuios` — VERDICT: ungated, still.** 3,558 stars, looked at 2026-08-26 against the
  README only. It has a documented JSON verb protocol for driving its daemon (`docs/protocol.md`)
  plus `tuios tape exec` for replaying scripted workflows against a running session, so it is NOT a
  keybinding-only TUI and the protocol is where the gates would be decided. The README does not
  establish per-pane id addressing either way. Recorded as ungated rather than blocked-upstream
  because nothing was probed: reading `docs/protocol.md` is the unstarted work, not a recheck
  trigger. **NEXT STEP:** read `docs/protocol.md` and gate it there.

- **Discovery refreshed 2026-08-26** across `terminal multiplexer`, `tmux alternative`, and
  `terminal workspace panes`. New above the 500-star line since `backend-survey-2026-08`:
  `muxy-app/muxy` (2,218, Swift — a libghostty macOS terminal), ungated. Surfaced and DROPPED as not
  pane hosts: `eneskirca/nodeterm` (1,330 — a tmux-BACKED front-end, so tmux is the multiplexer and
  cyber-mux already drives it), `decolua/9remote` (534 — a phone remote-control front-end), and
  `mrjones2014/smart-splits.nvim` (1,715 — a Neovim plugin).
  Still carrying NO verdict, unchanged from `backend-survey-2026-08`: `directvt/vtm`,
  `aaronjanse/3mux`, `prompt-toolkit/pymux`, `deadpixi/mtm`, `Yazelix/nova`, `cosmos72/twin`,
  `martanne/abduco`, `iAmCorey/kooky`, plus `muxy-app/muxy` above. Do not cite this list as evidence
  any of them can or cannot be driven.

Decisions (`136-rmux-adapter` — the seventh backend, and whether it shares the tmux adapter's code, issue #136):

- **COPY `mux.tmux.ts`, do not share it** — DECIDED, and this was the CR's open question. rmux
  reimplements ~90 commands under tmux's own names, flags, target syntax and `#{…}` format
  vocabulary, so a shared implementation parameterized by binary name was genuinely available and is
  what a first reading suggests. Rejected for three reasons that compounded. **(1) The seam's own
  argument.** rmux is a separate project that TRACKS tmux, not a tmux version; every future
  divergence would land as a conditional inside the tmux adapter, which is the argument this seam
  already makes against emulation. **(2) The comments are verification claims.** This repo's rule is
  that "verified against X" means someone ran it against X — so the tmux adapter's comments name
  3.7c and the rmux adapter's name 0.10.0, and a shared file could not honestly carry both. That is
  not a stylistic cost; a merged comment would have to either drop both binaries' provenance or
  assert one binary's behavior for the other. **(3) They already diverge, in more than one member.**
  `canFloatPanes` was the known one, and its 15-line justification on the tmux side is entirely about
  tmux 3.7's `new-pane` — text with no meaning on a backend that has no such command. Probing turned
  up a SECOND divergence the issue did not know about (below). Two on day one is not "a near-duplicate
  that may drift"; it is already drift. **Accepted cost, stated plainly:** ~570 duplicated lines, and
  a bug fixed in one adapter's shared-looking helpers (`parsePaneLocation`, `paneLabel`,
  `splitOpenReport`) will not reach the other. Mitigated only by each file naming the other in its
  header, which is weaker than a compiler. Revisit if a third tmux-language backend appears — at
  three, the arithmetic changes.

- **rmux and tmux disagree about what a target-less `split-window` splits** — the divergence the
  probe found and the issue did not predict, recorded because it is the concrete evidence behind the
  decision above. Probed on rmux 0.10.0: a target-less `split-window` run INSIDE pane `%1` (window
  `@0`) put its new pane in `@0` beside `%1`, while the session's active pane was `%2` in a different
  window — so rmux resolves the CALLING pane from `$RMUX_PANE`/`$TMUX_PANE`. tmux does the opposite,
  and `mux.tmux.ts` says so from its own 3.7c probe: it splits the ACTIVE pane and ignores
  `$TMUX_PANE` outright. rmux's behavior is the friendlier one and the adapter deliberately does NOT
  lean on it — `from` names which pane to split, which is not always the caller's, so `-t` is passed
  on both backends. Had these shared one implementation, this would already be conditional #2.

- **Detection is SOLVED, not deferred to the override** — DECIDED: `$RMUX` is the fast-positive hint
  and `$RMUX_PANE` the self-identity key, with `rmux-daemon` in the ancestry walk. The issue left
  this open ("no `$TMUX`-equivalent env var was confirmed") and allowed shipping override-only; that
  fallback was not needed. Probed by dumping a live pane's own environment on 0.10.0:
  `RMUX=<socket>,<pid>,<session>` (tmux's exact triple), `RMUX_PANE=%1`, `TERM_PROGRAM=rmux`, and a
  `ps -o ppid=,comm=` walk from inside a pane climbing `sh → zsh → rmux-daemon`.
  **The trap, and the load-bearing half of this decision:** an rmux pane ALSO sets `$TMUX` and
  `$TMUX_PANE`, to the same values, for tmux compatibility — and puts a PATH shim literally named
  `tmux` in front of them. So `$TMUX` is evidence of "some tmux-language multiplexer", never of tmux
  itself, and both `currentPane` and the ancestry fallback ask rmux BEFORE tmux. Getting that order
  wrong resolves every rmux session to the tmux adapter, and the shim is what would make the
  misdetection invisible rather than loud. The reverse mistake is unreachable: tmux does not set
  `$RMUX`.

- **`canFloatPanes` is OMITTED, not declared `false`** — DECIDED, following wezterm/cmux/otty rather
  than the issue's wording. `new-pane` is absent from rmux's command table (`unknown command:
  new-pane`, and it is not in `list-commands`), so `open({ at: 'pane:float' })` calls
  `refuseFloatingPane('rmux')` BEFORE building any argv — no exec is spent on a refusal, and a float
  can never degrade into a `split-window`. The read side answers `floating: false` by construction and
  the `listPanes` format asks for no floating variable at all: rmux expands the unknown
  `#{pane_floating_flag}` to the empty string, so requesting it would produce a column that reads as
  `false` by accident rather than by construction.

- **`rmux wait-pane` is deliberately NOT used** — DECIDED: `waitForOutput` runs the shared
  `capture-pane` poll every polling backend uses. rmux ships `wait-pane` among its non-tmux
  extensions, so a native wait was available. Declined because the seam's `waitForOutput` matches
  text the CALLER supplies, the shared poll already answers it identically on every backend, and a
  second implementation would be an rmux-only path to keep honest for no behavior a caller can
  observe. Recorded so the option is not rediscovered as an oversight. (herdr's native wait is the
  contrast that justifies the rule rather than breaking it: herdr's wait is a different envelope with
  its own error shapes, which the poll genuinely cannot reproduce.)

- **What the live probe did NOT cover** — stated because the honesty bar requires it. Everything above
  was run against rmux **0.10.0 on Linux**, on an isolated `-L` socket. Nothing was driven on
  **Windows or macOS**, which is the strategic reason this backend was wanted, so "the first native
  Windows backend" is a claim about rmux's portability and NOT about a cyber-mux run anyone has
  observed there. No other rmux version was exercised, and the adapter takes no version reading. The
  `focus` success path — `switch-client` → `select-window` → `select-pane` with a client attached —
  was probed by hand against a pty client but is NOT pinned by `mux.rmux.integration.test.ts`, which
  runs detached on purpose; the suite pins only its unresolvable-pane refusal.

Decisions (`otty-agent-lifecycle` — whether otty can implement `AgentLifecycle`):

- **otty `watch:<agent>` — VERDICT: gate 1 fails, `AgentLifecycle` stays ABSENT on otty.** Read
  2026-08-26 against docs.otty.sh only (`/reference/cli`, `/terminal-features/progress-state`,
  `/workflows/cli-usage`, `/agents/supported-agents`, `/agents/parallel-tasks`, `/vt/osc/osc-26`,
  `/reference/applescript`, `/terminal-features/term-value`). **Nothing here was probed** — otty is a
  GUI-only app and is not installed on the machine this was decided on, so every statement below is a
  docs claim, not a measurement.
  The real signature is `otty watch:<agent> <id>`, not the bare `otty watch:<agent>` that issue #134
  quoted — and the dropped positional is exactly what decides the gate. `<id>` is the **agent session
  id**, not a pane id: *"otty watch:claude <session-id> … The session ID is the one from Agent
  History"* (CLI Usage), *"blocks until that Claude session is idle"* (Progress State). Its whole flag
  table is `--interval-ms` (5000), `--timeout-secs` (0), `--unknown-timeout-secs` (60), `-v`; there is
  no pane selector on it, and none among the global flags either — while every pane-scoped verb
  (`pane show`/`send-keys`/`capture`) documents `--pane <id|index>`. So `waitForState(exec, target,
  opts)`, which is handed a pane id, has nothing to hand `watch:`.
  **No documented CLI route from a pane id to an agent session id.** otty binds the two in the other
  direction and internally: a hook reports `otty state:<agent> state=… agent-pid=… session-id=…`, and
  *"Otty matches an event to a pane by process tree: the reported `agent-pid` has to be a descendant
  of some pane's shell"* (Supported Agents). No command prints that mapping back out; `otty panes
  --json` has **no documented schema at all** in the docs, let alone a session or agent field. A
  lookalike built on `read()` polling remains refused for #94's reason, so the honest answer is
  absence, and `deriveAgentWait`'s existing refusal on otty stays correct.
- **`<agent>` is part of the verb, which is a second gate the issue did not name.** `watch:` is
  spelled per agent kind (`watch:claude` / `watch:codex` / `watch:opencode`), so even a `--pane`
  selector would leave the adapter needing the agent KIND running in that pane — another fact no
  documented CLI read reports.
- **Question 2, answered though moot: otty waits on `idle` and nothing else.** *"Blocks until the
  named code-agent session … reaches the `idle` state"*; exit `0` on idle (or if the session has
  since closed), `4` if it never reported a usable state, `6` if the agent has no integration
  installed, `9` on timeout. So an implementation would have to refuse any `until` that is not exactly
  `['idle']`, **by name**; `timeoutMs` would round to `--timeout-secs`' second granularity; and exits
  `4`/`6` are neither a reached state nor a timeout, so each would need its own named error.
  The state vocabulary otty's hooks report is `processing | idle | awaiting`.
- **A docs inconsistency the next reader should not trip on.** `/reference/cli` documents the report
  as `otty state:<agent> key=value …` with `state=processing|idle|awaiting`, while `/vt/osc/osc-26`
  documents `otty agent:set --code-agent claude --session "$SID" --status running|awaiting-approval|
  finished`. Two spellings and two vocabularies for the same report inside one docs set; which one
  ships is unresolved from the docs.
- **`LivePane.agentStatus` on otty: unanswerable, stays `undefined`.** otty plainly HOLDS per-pane
  agent state — it badges tabs with it — but no documented CLI read exposes it: no such field in
  `otty panes --json` (undocumented schema), `otty state:` is the write side, and the AppleScript
  per-tab properties are `contents`/`history`/`busy`/`process` with no agent state (and are macOS-only,
  outside the `Exec` seam regardless).
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/134
Decisions (`opensWithoutStealingFocus` — issue #133, the focus-on-open declaration):

- **rmux had tmux's hole too, and it was verified rather than inherited** — DECIDED, after #136
  landed the seventh backend mid-flight. rmux reimplements tmux's command language, so the resemblance
  invites assuming its answer; it was probed instead, on an isolated socket against a live 0.10.0. The
  result matched tmux exactly: `new-window` already carried `-d`, a bare `split-window` left the NEW
  pane active, `-d` left focus on the original, and `-P -F` reported the id either way. So `-d` was
  added to `split-window` and rmux declares `true`. It has no `new-pane` at all, so there is no third
  route — `pane:float` is refused before any command is issued. Four real-boundary rows pin it.

- **the issue's premise was wrong about tmux and herdr, and the fix is bigger than zellij** —
  DECIDED. #133 states that "every backend but zellij opens without stealing the user's focus". That
  holds only for the TAB/WORKSPACE routes. Measured against live binaries: on tmux 3.7c a bare
  `split-window` in a session focused on `%0` left `%1` active, and a bare `new-pane` did the same for
  a float — the adapter passed `-d` on `new-window` only, so every `pane:*` open moved the user. herdr
  was the opposite surprise: `pane split` carried no `--no-focus`, but 0.8.2 leaves focus on the pane
  it split either way, so its gap was declarative rather than behavioral. So `-d` was added to tmux's
  `split-window` and `new-pane`, and `--no-focus` to herdr's `pane split`. A declaration that says
  "every route" has to mean it; discovering three unflagged routes is the reason the declaration is
  worth having rather than an argument against it.

- **REQUIRED on the seam, unlike `canSizeSplits`/`canFloatPanes`** — DECIDED, and it is the one place
  the three differ. Those two are optional because absence has a truthful reading: there is no `-l` to
  pass, no float verb to call, so `undefined` and `false` say the same thing. Here they do not. A new
  adapter that simply never considered focus would read `undefined`, indistinguishable from one that
  considered it and found no primitive — a caller cannot tell an unanswered question from a negative
  answer. The seam takes the adapter author's debt over the caller's ambiguity, the trade `rename`
  already makes.

- **an END-STATE property, not "focus never moves"** — DECIDED. `true` means an open leaves focus
  where it found it. It deliberately does NOT mean no focus move occurs at any instant, because zellij
  cannot offer that on the one route that has to CHOOSE a split target: `new-pane` has no split-target
  flag, so `from` is honored by focusing that pane first, and that move is real. Defining the
  invariant on the end state is what lets zellij answer `true` by undoing the move instead of
  pretending it does not happen. The adapter comment says the round trip is visible.

- **zellij's floor moves to 0.45.0; no fallback path, no version probe** — DECIDED. `--no-focus`
  landed in 0.45.0 (confirmed by bisecting the source: `grep -c no_focus zellij-utils/src/cli.rs`
  returns 0 at both `v0.44.0` and `v0.43.1`). Four reasons compound against a conditional
  declaration: the seam member is static, with no runtime probe behind it, so a conditional value has
  nowhere to live and `true`-then-degrade would lie in exactly the way the declaration exists to
  prevent; version-probing would be a new behavior for a file that reads no version anywhere, costing
  an exec per open; a fallback would be a second code path nothing here can exercise, since there is
  no zellij on this machine and the integration suite skips its rows without one (#125); and the 0.44
  failure is LOUD and creates nothing — zellij parses in clap's strict mode (no `ignore_errors`,
  `allow_hyphen_values`, `allow_external_subcommands`, or `trailing_var_arg` anywhere in
  `zellij-utils/src/cli.rs` at v0.45.0), so an unknown `--no-focus` is a parse error and a nonzero
  exit. Same precedent tmux's unconditional `new-pane` declaration set.

- **`--no-focus` is NOT passed on zellij's `from` path, and `focus-last-pane` is not used at all** —
  DECIDED, against #133's proposal, which assumed `--no-focus` only suppresses the new pane's
  activation. It does more than that: per `zellij-server/src/route.rs`'s `new_pane_routing` at
  v0.45.0, a `--no-focus` open resolves its anchor as `--tab-id` if given, else the pane named by
  `$ZELLIJ_PANE_ID` — the pane the command was ISSUED from, which the flag's own help text states —
  and only failing both, the client's current pane. The focused pane is never consulted. So focusing
  `from` and then passing `--no-focus` would split the pane cyber-mux is running in, print a plausible
  id for it, and exit 0: the silent wrong-pane failure this adapter exists to refuse. The `from` path
  therefore omits the flag and restores focus afterward instead.
  `focus-last-pane` (also 0.45.0) was rejected as the restore primitive for two independent reasons:
  it operates on the ACTIVE TAB only (v0.45.0 `screen.rs` dispatches it under
  `active_tab_and_connected_client_id!`) while `from` may live in another tab, and it reads a focus
  history one entry deep while the sequence here makes two moves — so even within one tab it would
  land on `from` rather than on the caller. `focus-pane-id` with an explicit id has neither limit and
  is already driven against a live 0.44.3.
  Impersonating the issuing pane (`ZELLIJ_PANE_ID=<from> zellij action new-pane --no-focus`) would buy
  both properties at once and was rejected as unavailable: `Exec` takes a command and args and no env,
  by construction. Widening the seam every adapter shares to reach one backend's undocumented internal
  is not worth one avoided focus move.

- **wezterm/cmux/otty declare `false` rather than emulating** — DECIDED. None documents a
  suppress-focus flag on any creating verb; cmux and otty additionally focus the split target first,
  so an open moves the user twice. Re-focusing the caller afterward is available in principle to cmux
  and otty (both report `is_focused`) and NOT to wezterm, which has no focus-query primitive at all.
  It is not implemented for any of the three: all are alpha adapters written from documentation with
  no live binary, and an unverifiable three-command restore dance is worse than an honest `false`. The
  declaration describes what the adapter does, not what its backend might permit.

- **CI's `ZELLIJ_VERSION` pin moves with the declared floor, or the floor is a fiction** — DECIDED,
  after the live-backends job answered it: `pull-request.yml` pinned `v0.44.3`, and every one of the
  ten zellij integration rows died at once on the unknown `--no-focus`. That failure signature —
  ALL of them, not a partial set — is what separates it from the known #115 flake. The pin is now
  `v0.45.0`, with the reason written beside it: a workflow that pins below the adapter's floor does
  not test an older floor, it just fails the whole suite. The floor also had to move in three prose
  places that each restated it (`multiplexers.md`, `getting-started/introduction.md`,
  `concepts/detection.md`) — a version restated in four files is a version that drifts.

- **verification is split, and the split is stated in each file** — DECIDED. tmux's half is driven
  against a live 3.7c (5 rows in `mux.tmux.integration.test.ts`, including the one that replaced the
  now-obsolete "a target-less split right after a float fails loudly" row — `-d` removes the
  activation that made it fail). herdr's half was measured by hand against a live 0.8.2 and is NOT in
  the integration suite: asserting it needs the suite to focus a workspace, which would make
  `test:integration` steal the user's focus — unacceptable in a block whose own name promises
  "always safe". zellij's half is UNVERIFIED against a running binary and says so in the adapter
  header, the declaration comment, and the website page; it was read out of the v0.45.0 source tree,
  not off a live `--help`. rmux's half is driven against a live 0.10.0 (4 rows in
  `mux.rmux.integration.test.ts`, reading `#{pane_active}` rather than an attached client's focus,
  because that suite runs detached by construction).
