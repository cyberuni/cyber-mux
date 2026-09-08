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

- **the restore reads `list-clients`, not `list-panes --json`'s `is_focused`** — DECIDED, after the
  first draft got it wrong. `is_focused` looked like the obvious field and is not: the zellij
  integration suite already records, from the real boundary, that a live session marks `is_focused:
  true` on MORE THAN ONE record at once — a floating plugin pane and the tiled pane beneath it — so
  it answers "focused within its layer", not "where the client is". Scanning for the first such
  record could restore focus onto a PLUGIN pane the user was never on, which is a focus move the
  restore INVENTED, strictly worse than the theft it exists to undo. `zellij action list-clients`
  names the client's pane directly, in the `terminal_N` form `focus-pane-id` takes — proven by the
  suite's own parked-client precondition, which polls that column until it equals a known pane id.
  Caught by reading the suite's live notes rather than by a failing test, because no row asserted
  where focus ENDED; two now do.

- **CI is the zellij evidence, and a local green run is not** — DECIDED. With the pin at 0.45.0 the
  zellij suite runs all 13 rows in CI, and two new rows there assert the client does not move — one
  per mechanism (`--no-focus`, and the `from` restore). That is what backs zellij's `true`. It is
  stated that way in the adapter rather than as a flat "verified", because the same suite run on a
  machine with no zellij skips every row and still reports green (#125): the claim is about where it
  ran, not that it passed.

Decisions (`135-pane-resize` — the resize seam member, issue #135):

- **pane resize is an ABSOLUTE ratio, and it lives on `RegionInspector`** — DECIDED (issue #135).
  The issue laid out three placements and leaned toward a `canResizePanes` declaration plus a
  required member that refuses, by analogy with `canSizeSplits` and `canFloatPanes`. Deciding it
  against the capability matrix instead — reading the four relative primitives rather than the
  issue's summary of them — landed somewhere else, because **the verb's shape decides its home**.
  Probed:
  - tmux `resize-pane -t <id> -x/-y <n>` — absolute, in CELLS (3.7c, live). `-x <pct>` is a
    percentage of the **window**, not of the pane's split region, so it is wrong at any nesting
    depth and is not used.
  - rmux `resize-pane -t <id> -x/-y <n>` — the same, and probed as its own claim rather than
    inherited from the sibling adapter (0.10.0, live, isolated socket). Every case matched tmux 3.7c
    number for number: `-x 120` in a 200-column window left 120 + 79 + a divider column, `-y` did the
    same on a stacked split, a nested resize left the outer divider alone, and `-x 60%` was 60% of the
    WINDOW — the reading that makes cells rather than percent the right rendering here too.
  - herdr `pane resize --pane <id> --direction <l|r|u|d> --amount <float>` — a **delta on the
    enclosing split's ratio** (0.8.2, live). `--direction` names where the DIVIDER moves, not which
    pane grows: `right`/`down` raise the ratio and `left`/`up` lower it, whichever side the `--pane`
    sits on. It resolves against the nearest ancestor split on the direction's own axis. None of
    that is in `--help`, which lists the four values and says nothing about what they move.
  - otty `pane resize --right N --down N` — relative, in CELLS (docs only, no binary here).
  - zellij `action resize [right|left|up|down|+|-]` — relative, **no amount argument at all** and no
    stated step size (docs only, no binary here).

  A RELATIVE seam verb is therefore unspellable: its `amount` would be a ratio on herdr, cells on
  otty, and nothing zellij could honor in any units. An ABSOLUTE ratio means one thing everywhere —
  but no backend takes one, so every adapter must first know what the pane's split region measures.
  That is `describeRegion`'s fact and nothing else's, so the write shares the reads' all-or-nothing
  precondition exactly, and `canResizePanes` would only be a second spelling of `regions !==
  undefined` that can drift from it.
  **This retires the issue's own objection to the `RegionInspector` placement** — that it would deny
  zellij and otty a capability they have. It does not: they have a *relative nudge*, which is a
  different verb, and neither can answer this one. The implementor set is exactly the set that ships
  `regions` — tmux, rmux and herdr — and the refusal is the absence of `regions`, surfaced by name
  through `PaneResizeUnsupportedError`. rmux arrived (#139) after this was decided and needed no
  amendment to it, which is the property a derived capability was chosen for: it answered the member
  because it already reported rects.
  **Unverified, and stated as such:** the otty and zellij readings are from published CLI docs; this
  machine has neither binary. Nothing in either adapter changed — both simply continue to omit
  `regions` — so no untested command shape was written on the strength of those docs.

Decisions (`128-cmux-otty-isolation` — can either GUI app give a suite a throwaway instance, issue #128):

- **The isolation question #128 puts first is answered: cmux YES but only from a source-built tagged
  app, otty NO.** Read 2026-09-06 from published references only. **Nothing here was probed.** This
  machine is WSL2 Linux (`Linux zeta 6.18.33.2-microsoft-standard-WSL2`) and `command -v cmux otty`
  finds neither, which is not an accident of this box: cmux is *"a lightweight, native macOS terminal
  built on Ghostty"* with *"Requirements: macOS 14.0 or later"* (cmux.com/docs/getting-started), and
  otty ships macOS only — its install page lists *"Windows — Status: In development"* and *"Linux —
  Status: In development"* against *"macOS — Requirements: macOS 14 (Sonoma) or later"*
  (docs.otty.sh/getting-started/installation). Sources and their versions: cmux.com/docs/api and
  cmux.com/docs/getting-started (undated, no version stamp; latest release tag `v0.64.22`), plus
  `manaflow-ai/cmux` at `7d78b6e` (2026-09-07) for `docs/cli-contract.md`,
  `skills/cmux-workspace/references/commands.md`, `skills/cmux-dev-workflow/references/tagged-builds.md`
  and `scripts/launch-tagged-automation.sh`; docs.otty.sh `/reference/cli`, `/workflows/cli-usage`,
  `/reference/configuration` and `/getting-started/installation` (undated, no version stamp — the
  newest version the text names is *"Otty 1.3.0 and earlier"*).

- **cmux, gate 1 (a flag or env var that targets a SEPARATE instance): CLEARED, and further than the
  public docs suggest.** The public CLI options table lists `--socket PATH` — *"Custom socket path"* —
  over sockets that are per BUILD, not per instance: *"Release `/tmp/cmux.sock`"*, *"Debug
  `/tmp/cmux-debug.sock`"*, *"Tagged debug build `/tmp/cmux-debug-<tag>.sock`"*, *"Override with the
  `CMUX_SOCKET_PATH` environment variable"* (cmux.com/docs/api). Read alone that is a *client-side*
  override — it picks among instances that already run and cannot create one. The repo settles the
  server side: `scripts/launch-tagged-automation.sh` launches an app with
  `CMUX_SOCKET_MODE=${MODE} CMUX_SOCKET_PATH=${SOCK} CMUXD_UNIX_PATH=${DSOCK}
  CMUX_DISABLE_SESSION_RESTORE=1 … open -g "$APP"`, having first unset the ambient
  `CMUX_SOCKET_PATH`/`CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID`/… of the calling terminal. So the app DOES
  honor `CMUX_SOCKET_PATH` at launch, session restore can be suppressed so the instance comes up empty,
  and `open -g` opens it in the background rather than in front of the operator. `tagged-builds.md` is
  explicit about what that buys: *"Tagged builds isolate app name, bundle ID, debug socket, and
  DerivedData path so multiple agents and the user's normal app do not collide."*
  **The catch, and it is the whole catch:** that script resolves `$HOME/Library/Developer/Xcode/
  DerivedData/cmux-<tag>/Build/Products/Debug/cmux DEV <tag>.app` and exits with *"error: tagged app
  not found"* otherwise. The isolated instance is a DEV BUILD — macOS plus Xcode plus a clone of the
  app's source, built with `./scripts/reload.sh --tag <tag> --launch`. Whether the shipped `.dmg`
  release can be launched a second time under a custom `CMUX_SOCKET_PATH` (its bundle ID is fixed, and
  macOS single-instance semantics are what the tagged build's distinct `com.cmuxterm.app.debug.<tag>`
  id exists to sidestep) is NOT answered anywhere read, and must be probed before anyone relies on it.

- **cmux, gate 2 (create and tear down a workspace): CLEARED on paper.** `cmux new-workspace` —
  *"Create a new workspace."* — and `cmux close-workspace --workspace <id>` — *"Close a workspace."* —
  are a matched pair, and `new-workspace` takes `--name`, `--cwd`, `--command` and `--layout`
  (`commands.md`), which is everything a fixture needs. Against the operator's LIVE app this is still
  not isolation: the workspace appears in their sidebar, and whether `new-workspace` also focuses it
  is undocumented (`select-workspace` exists as a separate verb, which hints not, and a hint is not a
  fact). Against a tagged instance it is isolation, and the instance is the throwaway anyway.

- **cmux, gate 3 (what the suite skips ON): a probe exists, but the obvious one is ambiguous.**
  `cmux ping` is *"Check if cmux is running and responsive."* (cmux.com/docs/api) / *"Check socket
  connectivity."* (`docs/cli-contract.md`). Its exit code when no app is running is documented
  nowhere; the CLI contract only guarantees `--help`/`--version` *"without connecting to the cmux
  socket"*. Worse for a test runner, a failing `ping` does not mean "not installed": the default
  access mode is *"cmux processes only — Only processes spawned inside cmux terminals can connect"*,
  and a `vitest` process is not one of those, so a suite run from an ordinary shell is refused even
  with the app up unless the operator sets `CMUX_SOCKET_MODE=allowAll` (*"Environment override only"*)
  or the tagged launcher's `CMUX_SOCKET_MODE=automation` — a fourth mode that appears in
  `launch-tagged-automation.sh` and in NO public docs table. `cmux capabilities` — *"List available
  socket methods and current access mode"* — is the read that separates "not reachable" from "not
  permitted", and a suite that skips on `ping` alone will silently report the second as the first.
  There is also a socket password (`--password <value>`, `CMUX_SOCKET_PASSWORD`) in
  `docs/cli-contract.md` that the public docs never mention; whether it is required in any mode is
  unanswered.

- **cmux, gate 4 (anything headless): FAILS.** The CLI is a client of a Swift/AppKit GUI app; nothing
  in either docs set or the repo offers a `wezterm-mux-server` equivalent. The nearest things are not
  it: `cmux local-tmux` drives *a real tmux server* (already cyber-mux's own backend, not cmux), and
  `cmux vm …` drives cloud machines through the app. A human, or at least a logged-in macOS GUI
  session, must have cmux on screen.

- **otty, gate 1: FAILS.** `--socket <path>` exists — *"Override the runtime control socket path"*,
  default `auto` (docs.otty.sh/reference/cli) — but it is documented only as a client-side override,
  and nothing published says an app can be launched bound to a chosen socket. otty is closed source,
  so unlike cmux there is no launcher script to settle the server side. The configuration reference
  has no socket key at all, and no instance, profile, or tag concept anywhere. `--config-file <path>`
  overrides the config file, which is not the same lever.
- **otty, gate 2: FAILS, and the create verb is actively hostile to a test.** `otty open` is the only
  create-a-container verb, and *"Starts the app if it isn't already running"* (`/workflows/cli-usage`)
  — a suite that calls it on a machine where otty is closed POPS A GUI WINDOW on the operator's
  screen. `otty <no subcommand>` is worse: *"Running `otty` with no subcommand (or starting with
  `-e`) launches the GUI"*. Windows and tabs can be closed again (`window`/`tab` carry `close`), but
  they are windows of the operator's one app.
- **otty, gate 3: NO probe is documented.** There is no `ping`, and no reachability verb. `otty
  --version` answers without the app (the CLI *"ships inside the app"* but runs standalone), so it
  proves installation, not reachability — exactly the distinction the skip needs. The documented exit
  codes are about other things: `4` *"No pane/tab matched selector"*, and on `watch:` `4`/`6`/`9`.
  What a UI verb such as `otty panes --json` does when the app is not running is undocumented, bounded
  only by `--timeout <ms>` (default `3000`, *"IPC timeout when talking to the running app"*). The
  probe has to be discovered on a Mac with otty; it cannot be read off the reference.
- **otty, gate 4: FAILS twice over.** Not merely GUI-only, but gated on two settings a test cannot
  set for itself: the drive-a-pane commands are *"off by default: turn on Settings → Advanced → IPC
  Allow Send Keys first"*, and *"they're also refused on a pane that's in an SSH or `sudo` session
  unless you additionally enable IPC Allow Sensitive Sessions"* (`/workflows/cli-usage`). The
  configuration reference confirms both as config keys defaulting to `false` (`ipc-allow-send-keys`,
  `ipc-allow-sensitive-sessions`). `otty config set … --transient` (*"running app only, don't
  persist"*) could flip the first without editing the operator's file, but that is a suite reaching
  into the live app's settings to permit itself, and it is untested speculation until someone runs it.

- **NO suite files were written, for either adapter — DECIDED.** #117's and #132's histories point
  the same way: a suite authored against a reference and never executed asserts what we believe the
  CLI does, which is the exact defect a real-boundary suite exists to close. Every `expect` in
  `mux.cmux.integration.test.ts` would have been written blind against a macOS-only GUI app that
  cannot be installed here. `scripts/test-adapter.ts` makes the cost concrete rather than merely
  stylistic: an always-skipping suite executes zero tests, and the runner classes that as
  `no-coverage`, which sits in `BAD` alongside `gap`. So the file would trade one honest bad outcome
  for a different bad outcome, while adding unverified assertions. `gap` remains the truthful report
  until someone on a Mac can run something.

- **#128 SHOULD BE SPLIT per adapter — RECOMMENDED.** The issue itself flagged the split as
  conditional on the isolation answers differing, and they differ in kind, not degree. cmux is
  *unblocked but expensive*: a real isolated instance exists, the reachability probe exists, the
  create/tear-down pair exists, and the remaining work is one operator on macOS with Xcode building a
  tagged app and running the commands to find out what they actually print. otty is *blocked on facts
  nobody has*: no isolated instance, no reachability probe, a create verb that launches the GUI, and
  two GUI-only permission toggles in front of the verbs a suite would drive. Their next steps do not
  overlap and their preconditions are different machines' worth of setup. The otty half should also
  record what it is really waiting on — a documented "is the app running" read, and a way to bind an
  instance to a socket — because both are questions for the vendor rather than work this repo can
  finish alone.

Decisions (`backend-survey-2026-09` — feasibility verdicts for multiplexers not yet driven):

- **`directvt/vtm` — VERDICT: undrivable.** 3,357 stars, probed 2026-09-07 against `doc/settings.md`
  (the event-sources table) and `doc/command-line-options.md` at commit `e84626e`, not the README.
  Gate 1 (per-pane identity) **FAILED**: the scripting API is exclusively relative traversal
  (`vtm.desktop.FocusNextWindow(n)`) or spawn-by-menu-template-name (`vtm.taskbar.Set({id='Term'})`,
  `vtm.desktop.Run({id=...})`). Neither yields a handle onto an existing live pane from outside, so
  there is nothing to address. Gates 2 and 3 not reached. Durable, in screen's own way: this is the
  shape of the control surface, not a missing flag.

- **`aaronjanse/3mux` — VERDICT: undrivable.** 1,912 stars, probed 2026-09-07 against `main.go` and
  `serve.go` at commit `f088961` — no `docs/` folder exists, so source was the only reference.
  Gate 1 **FAILED**: the CLI is `new <name>` / `attach <name>` / `kill <name>`, all session-level, and
  the sockets carry fds, resize, detach and kill — never a pane id. No addressing of any kind, not
  even relative. Durable.

- **`prompt-toolkit/pymux` — VERDICT: undrivable.** 1,547 stars, probed 2026-09-07 against
  `pymux/commands/commands.py` at commit `163eeb3`; no prose reference exists. Gate 1 **FAILED**, and
  instructively: an internal stable `pane_id` *does* exist, but is never accepted as a CLI target.
  `select-pane` / `select-window` take only `':.+'` / `':.-'` (next/prev) or a renumbering index, and
  `split-window` has no `-t` at all. Internal identity that the CLI will not accept is not identity
  for this seam's purposes.

- **`deadpixi/mtm` — VERDICT: undrivable.** 1,204 stars, probed 2026-09-07 against the `mtm.1` man
  page at commit `b346b86`, cross-checked by grepping `mtm.c` for IPC primitives (none found).
  Gate 1 **FAILED**: there is no external control channel at all — commands are in-band keychords into
  the TUI's own input, addressed by direction and focus. Durable.

- **`martanne/abduco` — VERDICT: not-a-multiplexer.** 985 stars, probed 2026-09-07 against the
  `abduco.1` man page. One session is one pty running one command; there is no split, pane, or window
  concept to address. The man page itself names `dvtm` as the tool expected to provide multiplexing on
  top of it. Durable.

- **`rse/stmux` — VERDICT: not-a-multiplexer (for this seam).** 547 stars, first seen in this sweep,
  probed 2026-09-07 against `src/stmux.md` at commit `290cfa79`, cross-checked against
  `src/stmux-7-help.ts`. Gate 1 **FAILED**: it is a launch-time static grid (`stmux -- [ A .. B ]`)
  navigated by in-TUI keystrokes (`CTRL+a 1-9`, arrows) with no external command surface — and more
  fundamentally, no facility to create a pane after launch, which `open()` requires.

- **`Yazelix/nova` — VERDICT: already driven.** Probed 2026-09-07: its multiplexing component
  (`Yazelix/nova-zellij`) is a source fork of vanilla zellij carrying the same `zellij-client` /
  `server` / `utils` crates and an unchanged CLI (`DumpScreen --pane-id <ID>`, same MANPAGE.md); the
  stated deltas are Kitty-graphics rendering only. cyber-mux drives zellij, so this needs no adapter.

- **`cosmos72/twin` — VERDICT: undrivable as an `Exec` backend, with the reason recorded because it is
  NOT the usual one.** 1,100 stars, probed 2026-09-07 against `docs/libtw.txt`, `docs/twin.1` and the
  sample clients (`lsobj.c`, `restackW.c`) at HEAD of `main`. All three gates are conceptually
  satisfied — stable object handles (`tobj`), `Tw_CreateWindow` returns an id at birth, and
  `TWS_screen_ChildrenW_List` enumerates — but every one of them is a **compiled-C library API
  (`libtw`)**, not an invocable CLI or protocol string. `SessionAdapter` takes an `Exec` that runs
  commands; there is no command to run. **RECHECK TRIGGER:** twin shipping a CLI or socket protocol
  front-end over `libtw`. Recorded as undrivable-under-the-current-contract rather than
  architecturally undrivable, because the identity is genuinely there.

- **`coder/boo` — VERDICT: not a pane host.** 779 stars, new since the 2026-08-26 refresh, probed
  2026-09-07 against `src/help.zig` at commit `39245a70`. All three gates pass **at session
  granularity**: `boo attach <name>` with unique-prefix matching, `boo new -d` printing the session
  name on stdout, `boo ls --json` enumerating. Recorded as a NO anyway, and this is the judgment worth
  keeping: boo has no CLI-drivable intra-session splitting — each concurrent shell is its own
  top-level session, so an adapter would refuse every `pane:*` placement and implement only
  `workspace`. That is abduco's shape with a better listing, not a multiplexer this seam can drive.
  **RECHECK TRIGGER:** a split verb that creates a second addressable surface inside one session.

- **`austinjones/tab-rs` — VERDICT: not a pane host, and cold.** 685 stars, new since 2026-08-26 but
  last pushed **2023-03-11**; probed 2026-09-07 against the clap `App` definition in `tab/src/cli.rs`
  at commit `76e6a75`. Same shape as boo: stable caller-chosen `TAB-NAME` identity and `--list`
  enumeration, but named tabs with no splits, so `pane:*` is unimplementable. Additionally, no
  headless/detached creation flag was found — `tab <name>` attaches interactively — so even the
  workspace tier is unevidenced for scripted use. Two independent reasons not to adapt it.

- **`iAmCorey/kooky` — VERDICT: viable.** 644 stars, probed 2026-09-07 against the parse-table
  generator `renderCLIHelp()` in `Sources/KookyHookKit/CLIFrontend.swift` at current `main` — kooky
  publishes no reference doc or man page, so the contract is source-derived and unversioned.
  Gate 1 **CLEARED**: `focus --tab <session-uuid>` / `close --tab <uuid>`, with non-UUID input
  rejected. Gate 2 **CLEARED**: `open` returns the created tab's UUID synchronously. Gate 3
  **CLEARED**: `list [--json]` enumerates windows -> workspaces -> tabs with ids.
  Its addressable unit is a tab, not a split — the same mapping `mux.cmux.ts` already makes for a cmux
  surface. Open question carried into the issue: whether kooky has any split verb, since without one
  the adapter answers `tab`/`workspace` and refuses every `pane:*`.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/158

- **`am-will/limux` — VERDICT: viable.** 549 stars, new since the 2026-08-26 refresh, probed
  2026-09-07 against `rust/limux-cli/src/main.rs` (`print_help()` and the command handlers) at commit
  `7e31649`. Gate 1 **CLEARED**: `new-pane [--pane <id|ref>] [--surface <id|ref>]` with a global
  `--id-format refs|both|uuids`. Gate 2 **CLEARED**: the response carries `pane_id` / `pane_ref`.
  Gate 3 **CLEARED**: `list-panes [--workspace <id|ref>]`. A GTK4/Ghostty-embedded desktop app, so
  driving it needs the app process running — the cmux/otty situation, not a gate failure.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/157

- **Two `backend-survey-2026-08b` entries were STALE and are corrected here** (this log is
  append-only, so the correction is recorded rather than edited in place). `Gaurav-Gosain/tuios` was
  left as "ungated, still" with the next step "read `docs/protocol.md`" — that work has since been
  done and filed as **#145**. `muxy-app/muxy` was recorded as ungated and is filed as **#146**. Both
  were re-confirmed 2026-09-07: tuios's `docs/protocol.md` (910 lines, commit `6c5cc805`) clears all
  three gates (`list-windows` returns real `window_id`s matched by exact id/prefix/name/title;
  `new-window` answers `{"type":"window_created","window_id":"9a3c..."}`; `list-windows` enumerates),
  and muxy ships an external CLI over a unix socket with `--pane <id>` addressing, `split-right` /
  `split-down` printing the new pane id, and `muxy list-panes`. Neither was re-filed.

- **Discovery refreshed 2026-09-07** across `terminal multiplexer`, `tmux alternative`, and
  `terminal workspace panes`, all `stars:>500`, queried live. New above the line since 2026-08-26:
  `coder/boo` (779), `austinjones/tab-rs` (685), `am-will/limux` (549), `rse/stmux` (547) — all four
  gated above. Surfaced and DROPPED as not pane hosts: `seebi/tmux-colors-solarized` (a theme),
  `mrjones2014/smart-splits.nvim` (a Neovim plugin), `decolua/9remote` (a phone remote-control
  front-end), `eneskirca/nodeterm` (a tmux-BACKED front-end, so tmux is the multiplexer and cyber-mux
  already drives it).
  **The ungated backlog from the two 2026-08 sweeps is now empty** — every candidate either carries a
  verdict above or was filed as an issue. `monotykamary/openmux` keeps its `blocked-upstream` verdict
  unchanged: its recheck trigger (`pane split` printing the new pane's id, OR any pane-enumeration
  command) has not fired, so it was not re-probed.

Decisions (`144-otty-size-title` — otty's documented `pane split --size` and `tab new --title`,
issue #144):

- **`canSizeSplits` on otty flips to `true`, and the issue's own reasoning for keeping it `false` is
  WRONG.** #144 argued the declaration should stay `false` with a better comment, on the reading that
  `--size 30` is a **cell count** like the sibling verb `otty pane resize --right 10 --down 5`, and
  that converting a `ratio` to cells needs a region extent otty cannot report — the same argument
  `resizePane` already records. The reference does not say that. Read 2026-09-07 from
  docs.otty.sh/reference/cli: **`--size` = the NEW pane's share, 10–90**, on the example
  `otty pane split --direction right --command "htop" --size 30`. A *share* is exactly the unit the
  seam's `ratio` is in, and needs no extent to be expressed in — which is why this one is
  implementable while `resizePane` stays refused. Both halves of #144's third item still land: the
  old comment gave a reason that was wrong; it was just wrong in the other direction.

- **The conversion is `1 - ratio`, scaled to whole percent** — the inversion `mux.cmux.ts`
  (`--size`, a 0–1 fraction) and `mux.wezterm.ts` (`--percent`, whole percent) both already document,
  and the opposite of herdr's `--ratio`, which sizes the ORIGINAL and passes through verbatim. otty's
  units are wezterm's, its direction is cmux's, and it is the first backend with a **range** as well:
  10–90. Boundary-tested at 0.9 → `--size 10` and 0.1 → `--size 90`.

- **Out-of-range ratios are CLAMPED with a stderr warning, not refused and not applied quietly** —
  DECIDED. The seam accepts any `0 < ratio < 1`; otty accepts only 10–90. `ratio: 0.95` therefore has
  no faithful rendering. Sending `--size 5` fails at otty's argument parser, turning a ratio the seam
  guarantees into a dead split; clamping silently is the silent-wrong-output this seam refuses. So the
  size is clamped INTO otty's range and the near miss is announced — the same degrade-loudly trade
  this file already makes for a `label` on a `pane:*` open. A caller who cannot accept the near miss
  sees the warning; one who can gets a pane.

- **`tab new --title` names the tab at birth** — DECIDED, no tension. Documented on the same page
  (`otty tab new --command "cargo watch" --title build`), so the follow-up `rename(…, 'tab', …)` is
  dropped: one round trip fewer, and no window in which the tab carries otty's default name. This is
  the tab-tier twin of what #160 did at the window tier with `otty open --title`.

- **Not verified against a live binary.** otty is a macOS-only GUI app absent from this machine, with
  no public source to cross-check, so every claim above is read off the published reference and
  nothing was probed. Coverage is mocked-`Exec` argv assertions in `mux.otty.test.ts`; #128 tracks the
  missing real-boundary suite for cmux/otty.

- **`--cwd` is documented on NEITHER `tab new` NOR `pane split`, and the adapter passes it on both** —
  observed, NOT acted on here. `tab new` documents `--command` and `--title`; `pane split` documents
  `--direction`, `--command`, `--size`; no page of the reference mentions `--cwd` at all. This is the
  same class as #156, but absence from a rendered SPA doc is not proof (the #132 lesson) and it is a
  different unit of work, so it is filed as **#163** rather than widening #144's PR. Corroborated by a
  second read that asked the question directly: the global flag list (`--format`, `--json`,
  `--no-headers`, `-q/--quiet`, `--socket`, `--config-file`, `--timeout`, `-y/--yes`, `--version`,
  `-h/--help`) carries no working-directory flag either, and `/workflows/cli-usage` handles directories
  through `otty open [path]`'s POSITIONAL argument — which the workspace tier already uses, and which
  is why that tier is unaffected.
Decisions (`worktree-landed-signals` — issue #151, squash-merge detection in worktree disposability):

- **Layer the landed signals, never replace the ancestry one** — DECIDED. `git branch --merged` is
  structurally blind to a squash merge: the squash commit on the target is a rewritten tip with no
  ancestry link back to the branch. Verified against real git in `worktree.integration.test.ts`, which
  builds a scratch repo that genuinely squash-merges and asserts `--merged` still omits the branch.
  cyber-mux itself merges with merge commits only, so its own history could never be the fixture.
  Three layers are ADDED in cost order — `upstream-gone` (`%(upstream:track)` is `[gone]`, one batched
  read, offline, correct for squash/rebase/merge alike), `squash-patch` (`commit-tree <branch>^{tree}
  -p <merge-base>` then `git cherry`, three calls per unresolved branch, offline), and `forge` (the
  forge's word on a merged PR, opt-in only). The ancestry answer keeps its meaning and its place at
  the front; nothing about merge-commit or fast-forward repos changes.
  - **Alternative rejected:** *replace `--merged` with the patch-id probe*. It answers the same
    question more expensively for the overwhelmingly common case, and it is a heuristic where
    ancestry is a proof — a strictly worse first layer.

- **Every layer after the first is POSITIVE-ONLY, so the composite is a monotone OR** — DECIDED. Only
  layer 1 may report a `false`; a later layer either says "landed" or declines to speak. Two layers
  therefore cannot contradict each other, and the only disagreement that can arise is between a
  landed signal and a GUARD — dirty, occupied, stale, primary — where the guard always wins
  (`isWorktreeRemovable` is unchanged). The consequence is deliberate: a squash that was
  conflict-resolved or hand-edited produces a different patch, does not match, and degrades to "not
  reusable" rather than to a false positive. Covered live by the hand-edited-squash and
  work-continued-after-landing scenarios.
  - **Alternative rejected:** *require two layers to agree before clearing a branch*. It sounds
    conservative and is not: `squash-patch` is the only layer that can corroborate `upstream-gone`,
    and it fails on exactly the conflict-resolved squashes `upstream-gone` exists to catch — so the
    rule would have deleted the layer's entire contribution while adding three git calls per branch.

- **The blast radius of a wrong positive is a CHECKOUT, never committed work** — RECORDED, because it
  is why layering is safe to do at all. Neither `removeWorktreeSafely` nor `provisionWorktree` deletes
  the branch ref: prune removes the checkout, provision repoints it to a fresh branch at `base`. The
  old branch still names its commits either way, asserted live in the provision scenario. The only
  thing a wrong answer can destroy is UNCOMMITTED work, which the `dirty` guard already refuses.

- **The listing reads the gone-upstream state, it never refreshes it** — DECIDED: no `git fetch
  --prune` is run on the caller's behalf. A listing is a report, and a report must not reach for the
  network, block on it, or move the repo's refs as a side effect. The signal is exactly as fresh as
  the caller's last fetch, which for a pool driver means fetching on its own schedule.

- **`mergedSignal` is reported, not kept private** — DECIDED. The layers do not carry equal authority
  — `ancestor` is git's proof, `squash-patch` a patch-id heuristic, `upstream-gone` the forge's word —
  so a caller auditing a reclaim needs to see which one spoke. It is a plain field on `WorktreeEntry`
  alongside `merged`, absent for a negative or undeterminable verdict.

- **The forge layer enters as an INJECTED probe, not a built-in** — DECIDED: `signals.forge` is a
  `(branch) => boolean | undefined` seam, asked only about branches the offline layers left
  unresolved, and every one of its failure modes (no `gh`, no auth, no network, no origin, a
  local-only branch) collapses to `undefined` rather than `false`. `ghForgeMergedProbe` ships as an
  opt-in implementation and resolves `--repo` from the `origin` remote rather than from the process
  cwd, because `Exec` runs commands without one. Not wired into any CLI verb by this change — the
  `cyber-mux worktree` flag that would expose it is a separate unit of work.

- **The squash probe carries its OWN git identity** — DECIDED, after the live-backends job caught what
  a developer machine structurally cannot. `git commit-tree` refuses with `fatal: empty ident name`
  when neither the environment nor git's config names an author, which is the state of any machine
  that has never configured git — a CI runner, a fresh container. Left to the ambient identity the
  whole `squash-patch` layer goes silently dark there and every squash-merged worktree reads unlanded
  again, i.e. exactly the bug this work exists to fix, reappearing only off the author's laptop. The
  probe therefore passes `-c user.name` / `-c user.email` inline; the object is a throwaway that
  should not carry the caller's name in any case. The integration suite now drives the library through
  an `Exec` with every ambient identity STRIPPED, so the layer can never again pass for a reason that
  lives in the developer's global gitconfig rather than in the code.

Decisions (`132-cmux-broken-members` — six `MuxAdapter` members that could not work on cmux, issue #132):

- **The six were re-derived against cmux's source, not accepted from the issue.** Read 2026-09-08 from
  `manaflow-ai/cmux` at `71eb616d6f3fb4dcc707b206e08752c297917e02` (2026-09-08, `main`) — the CLI
  dispatch and per-command parsers in `CLI/cmux.swift`, the CLI's own verb inventory in
  `CLI/CMUXCLI+CommandSuggestions.swift`, the socket payload builders under
  `Packages/macOS/CmuxControlSocket/` and `Sources/`, and `docs/cli-contract.md`. **Nothing was run
  against a binary** — cmux is macOS-GUI-only and this machine is WSL2 Linux, so no claim here reaches
  the bar `mux.tmux.ts`/`mux.herdr.ts` meet; #128 still tracks the missing real-boundary suite. The
  issue's own read was at `525352e`; every defect below was re-confirmed at the newer commit rather
  than carried over.

- **Confirmed and fixed.** `new-pane` takes only `--type --direction --url --profile --placement
  --focus --workspace --window` and validates no unknown flag (`cmux.swift:7263`), so the `--cwd` and
  `--size` the adapter sent were accepted and ignored — `canSizeSplits: true` was a false claim, and
  the split opened in the wrong directory. `new-workspace` hardcodes `honorJSONOutput: false`
  (`:7155`, gated at `:10491`), so `--json new-workspace` prints `OK workspace:N` and the workspace
  route threw on every call; the namespaced `workspace create` (`:11166`) honors `--json`.
  `list-panes` (`pane.list`) answers `{"panes":[…]}` while the adapter required a top-level array of
  panes holding surface OBJECTS, so `listCmuxSurfaces` returned `[]` for every real response and took
  `listPanes`, `paneExists` and `isPaneFocused` down with it; `list-panels` (`surface.list`) is the
  surface-tier verb, keyed `ref`/`title`/`focused`/`pane_ref`/`selected_in_pane`
  (`ControlCommandCoordinator+Surface.swift:150`). `rename-surface`/`rename-pane` exist nowhere —
  cmux's only rename verbs are `rename-tab`, `rename-window`, `rename-workspace` — and there is no
  pane rename at any layer, so both seam tiers land on `rename-tab --surface … --title …`.

- **One defect was overstated, and is recorded as measured rather than as filed.** The issue says
  `teardown()` "hard-errors" on every call. It does not: `close-surface` falls back to
  `$CMUX_WORKSPACE_ID` when given no `--workspace`/`--window` (`cmux.swift:7351`) and only refuses
  when that is unset too (`:7373`). The real failures are narrower — a library caller with no cmux env
  gets the refusal, and a surface outside the caller's own workspace resolves against the WRONG
  workspace. `teardown` now names the workspace whenever the adapter is bound to one.

- **The issue's "minor" whitespace claim is wrong for this adapter's argv, and a different `send`
  hazard is real.** `send` joins its remaining positionals with single spaces (`cmux.swift:7674`), so
  runs of whitespace survive as long as the text is ONE argv element — which is exactly how
  `sendText`/`submit` pass it. What does bite is `unescapeSendText` (`:20173`): `send` interprets
  `\n`/`\r` as Enter and `\t` as Tab in the text it is given, so a literal backslash-n in a caller's
  string presses Enter. That is a turn-taking hazard, it is NOT one of the six, and it is left for its
  own change rather than folded into this one.

- **A defect in the `workspace-group` route landed by #162 fell out of this read and is fixed here.**
  `workspace.create` reports `{window_*, workspace_*, surface_*}` and **no `pane_ref`**
  (`TerminalController+WorkspaceCreate.swift:156-198`), so a workspace open's `OpenedPane.tab` is a
  SURFACE ref, not the pane ref the fixture assumed. `paneToWorkspace` sent only `pane_id`, and cmux's
  handle registry is keyed by the ref STRING rather than by kind (`uuidAny` →
  `handles.uuid(forRef:)`), so a surface handle resolved to a UUID naming no pane and the routing fell
  back to the CALLER's workspace — grouping the wrong space, silently. The lookup now verifies each
  attempt against its own rows and tries the surface spelling when the pane one does not hold the
  target.

- **Held for a Mac, deliberately.** `identify`-backed `isPaneFocused`, any `capabilities` pre-flight,
  and adopting `workspace create --env` all replace WORKING behavior on source-only evidence, so they
  stay out. One more found in this pass and not acted on: `new-pane`/`new-surface`/`workspace create`
  all take `--focus <true|false>` and apply it with `defaultValue: false`, which contradicts the
  `opensWithoutStealingFocus: false` this adapter declares and the "cmux's CLI offers no way to
  suppress the focus move" the website says. Flipping that flips real behavior for every caller, so it
  wants its own issue and a live check, not a docs edit.

Decisions (`tuios-regating-2026-09` — #145 re-measured against source, and parked):

- **`Gaurav-Gosain/tuios` — VERDICT: blocked-upstream. No RELEASE clears the gates; `main` does.**
  Re-probed 2026-09-08 against two trees: the `v0.7.0` release tarball
  (`archive/refs/tags/v0.7.0.tar.gz` — the exact artifact Homebrew's stable formula builds) and
  `main` at commit `6c5cc80` (2026-09-07). Note the owner spelling: **`Gaurav-Gosain`**, not
  `Gaurav-Gosani` as #145 and its dispatch brief both wrote — the misspelled path 404s.
  This entry CORRECTS #145's verdict, which gated `main`'s docs while the world can only install
  `v0.7.0`. Recorded rather than edited in place; this log is append-only.

  **The release/protocol gap.** Newest release `v0.7.0` published **2026-03-28**;
  `docs/protocol.md` was first added **2026-07-18**, four months later. Every file implementing the
  verb protocol #145 gates on — `internal/session/verb_protocol.go`, `verb_handlers.go`,
  `verb_layout.go`, `verb_hints.go`, `verb_mailbox.go`, `daemon_command.go`, `session_ops.go` —
  exists only on `main`. At `v0.7.0`, `internal/session/` holds the attach transport
  (`daemon.go`, `codec.go`, `protocol.go`) and no dispatcher, and `internal/server/` is three files
  (`ssh.go`, `session_picker.go`, `server_test.go`).

  **Gated against `v0.7.0`, which is what a user gets.** Its CLI is 30 cobra subcommands, of which
  the machine-drivable part is `list-windows`, `get-window`, `session-info`, `send-keys`,
  `run-command <TapeCommand>`, `new`, `attach`, `kill-session`. Absent: `new-window`,
  `split-window`, `capture-pane`, `send-text`, `wait-for`, `verbRegistry`.
  Gate 1 (per-pane identity) **CLEARED**: `list-windows --json` reports window ids, and a spawned
  window carries `TUIOS_WINDOW_ID` (`internal/terminal/window.go:343`).
  Gate 2 (id at birth) **FAILED**: `run-command NewWindow` is fire-and-forget — it prints
  `Command sent (request ID: %s)` (`cmd/tuios/remote_commands.go:322`), a *request* id, not a
  window id. #145's gate-2 quote (`{"type":"window_created","window_id":"9a3c..."}`) is `main`-only.
  Gate 3 (enumeration) **CLEARED**: `list-windows --json`.

  **The blocker is below the gates, which is why this is not a degrade.** `v0.7.0` has **no read
  primitive at all** — no `capture-pane`, no `screenshot`, and the window payloads in
  `internal/session/protocol.go` carry `id`, `title`, `pty_id` and geometry, nothing textual.
  `MuxAdapter.read` is a REQUIRED member and `waitForOutput` is required and built on it via
  `pollForOutput`, so on stable both are unimplementable. There is no adapter to write, faithful or
  otherwise. The snapshot-before/diff-after recovery that rescues a silent create (`mux.zellij.ts`)
  does not reach this: it recovers an id, not a screen.

  **#145's headline limitation is exactly backwards.** It concluded "placement is not
  caller-controlled … `pane:right` and `pane:down` have nothing to drive", and the dispatch brief
  instructed the pod to refuse both by name. That is TRUE of `v0.7.0` — whose only split is
  `run-command Split horizontal|vertical`, acting on the FOCUSED window with no target — and FALSE
  of `main`, where `split-window` (`internal/session/verb_protocol.go:377-392`) takes a target
  `window` AND a required `direction` (`horizontal`/`vertical`). The error's source is
  methodological and worth naming: `docs/protocol.md` self-describes as "deliberately partial", and
  it is — `verbRegistry` (`verb_protocol.go:176`) holds **50** verbs against the doc's 35, and
  `split-window` is among the 15 it omits. Gating on a doc that says it is incomplete produced a
  confident refusal of a capability the backend has.

  **Other `main`-only corrections held for the re-file**, so they are not rediscovered: there is no
  `rename-window` verb (renaming rides `set-window`'s `name` param, `:429`); `wait-for` registers a
  sixth condition, `agent-message`, documented nowhere; self-identity is `TUIOS_ENV=1` plus
  `TUIOS_WINDOW_ID`/`TUIOS_PANE_ID`/`TUIOS_SESSION`/`TUIOS_SOCKET`
  (`internal/session/session.go:1600-1636`); and the socket path has no flag or env override —
  `$XDG_RUNTIME_DIR/tuios/tuios.sock`, else `/tmp/tuios-<uid>/tuios.sock`
  (`internal/session/manager_unix.go:12-29`), which constrains how a probe isolates scratch sessions
  from a user's own.

  **Why parked rather than shipped against `main`.** The `mux.zellij.ts` precedent looks like a
  licence to declare a floor and move on, and it is not: zellij's 0.45.0 floor is a RELEASED version
  a caller can install. A tuios floor would be an unreleased commit on a third party's default
  branch — `brew install tuios` yields `v0.7.0`, on which every verb the adapter drives fails. An
  honest refusal beats a backend that only works for whoever built it from source. `live-backends`
  compounds it: that job pins released binaries deliberately ("a herdr release should never silently
  change what this suite runs against"), so a tuios row would pin a third-party SHA and add a Go
  toolchain plus a module fetch to a BLOCKING job.

  **RECHECK TRIGGER:** tuios cuts a release containing `internal/session/verb_protocol.go`. Re-gate
  against that release — not against `main` — and re-file. Nothing else about the candidate needs
  re-establishing: `main`'s verb surface clears all three gates, and the corrections above carry
  forward.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/145

Decisions (`163-otty-cwd` — the `--cwd` the otty adapter passes on `tab new` and `pane split`,
issue #163):

- **`--cwd` on `pane split` is REAL, and #163's premise is wrong about it.** #163 (and the
  `144-otty-size-title` entry above, which first observed it) concluded that "no page of the reference
  mentions `--cwd` at all" made the flag a #156-class fabrication on both routes. The reference is not
  the whole corpus. otty's own **`/agents/orchestration`**, under *"Doing it yourself — the skill is a
  wrapper around commands you can run by hand"*, gives verbatim:
  `otty pane split --direction right --cwd "$PWD" --no-focus --json`. First-party, hand-runnable, in
  exactly the shape this adapter sends. So the split route KEEPS `--cwd`.

- **The measurement that settles what the reference is worth here.** All 141 URLs in
  `docs.otty.sh/sitemap.xml` were fetched and grepped on 2026-09-08 (VitePress SSRs its content, so
  the raw HTML carries the prose — no SPA truncation, verified by reading each page's real footer).
  `--cwd` occurs on **exactly one** of the 141 pages, and `--no-focus` on exactly the same one. Both
  are absent from `/reference/cli`, which the orchestration page nevertheless calls the place with
  "every flag and exit code". And the reference's `window / tab / pane` section is the least detailed
  on the page — prose plus four example lines, with **no flag table at all**, unlike `open`,
  `view`/`edit`, `font list`, `export`, `watch`. It enumerates nothing about this command family, so
  its silence is worth nothing about this command family. That is the #132 lesson landing a third
  time (after cmux's 27-of-162 docs page and tuios's self-described-partial protocol doc), and the
  first time it has overturned a claim in THIS log rather than in an issue.

- **`tab new` gets no such rescue, and the fix is chosen to be correct under BOTH readings.** Nothing
  on any of the 141 pages puts a working directory on `tab new` — its only documented flags are
  `--command` and `--title` — and no third-party source, changelog entry, or published source exists
  to settle it (otty is closed-source; `github.com/otty-shell/otty` is a DIFFERENT project and is not
  evidence). The flag is therefore neither evidenced nor disproven, and the two readings have very
  unequal costs: if `--cwd` exists, sending it and sending a `cd` both work; if it does not, sending
  it fails **every** `--at tab` open at otty's argument parser while a `cd` still works. So the tab
  route drops the flag and carries the directory as a `cd` on the command line — the shape
  `mux.cmux.ts` landed for the same wall in #132, with the env prefix INSIDE the `&&` for the same
  reason (`env K=V cd '/x' && cmd` sets the variables on `cd`). Accepted cost: a shell-level cd lands
  in the tab's shell history and means nothing in a non-shell pane.
  **RECHECK TRIGGER:** anyone with a Mac running `otty tab new --help`. If `--cwd` is there, the tab
  route should go back to the native flag; nothing else in this entry changes.

- **The degenerate case the brief predicted does not arise.** A `cd` needs no command to ride, unlike
  the env prefix — so a tab opened with a `cwd` and no `launch` still lands in the right directory,
  with the `cd` sent alone. `mux.cmux.ts` already does this (its stderr warning is for **env**, which
  genuinely has nowhere to go without a command, not for cwd). No new warning was added.

- **`pane split --no-focus` is real too, and is deliberately NOT acted on here.** The same
  orchestration line demonstrates it, and `opensWithoutStealingFocus: false` on otty gives "no
  suppress-focus flag is documented on `pane split`, `tab new`, or `open`" as half its reason — which
  is now measurably false for `pane split`. The declaration itself does not move: it is one
  adapter-wide bit, `tab new` and `open` still have nothing, and `from` is honored by focusing the
  target first. Passing `--no-focus` is a behavior change on a different seam member (#133 set that
  declaration), so the comment is corrected in place and the capability is left for its own unit of
  work.

- **Not verified against a live binary.** otty is a macOS/Windows GUI app absent from this Linux
  machine, so every claim here is read off otty's published docs and nothing was probed. Coverage is
  mocked-`Exec` argv assertions in `mux.otty.test.ts`; #128 tracks the missing real-boundary suite.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/163

Decisions (`142-pane-zoom` — the zoom seam member, issue #142):

- **The issue's open question is settled the other way round: wezterm HAS zoom and cmux has none.**
  #142 named wezterm and cmux as the two unknowns and said the answer decides the member's shape —
  "capability-interface-shaped only if wezterm and cmux turn out to have nothing". Both readings in
  the issue were wrong, and the correction is a measurement rather than a preference:
  - wezterm: the issue said *"`wezterm cli` has no documented zoom verb; zoom is a GUI key action"*.
    It has one. `wezterm cli --help` on 20240203-110809-5046fc22 — the version `pull-request.yml`
    pins — lists `zoom-pane   Zoom, unzoom, or toggle zoom state`, and `zoom-pane --help` gives
    `--pane-id`, `--zoom`, `--unzoom`, `--toggle`. Driven against a real headless
    `wezterm-mux-server`, it is the BEST-shaped zoom on the seam: per-pane, truly absolute
    (repeating `--zoom` changes nothing), it TRANSFERS the zoom when a sibling holds it, and
    `--unzoom` on a pane that is not zoomed leaves the zoomed sibling alone. `cli list --format
    json` carries `is_zoomed` per row.
  - cmux: no pane-zoom verb at any programmable layer. Read from `manaflow-ai/cmux` at HEAD
    `ae18c88`, not from a binary (macOS-only, per `128-cmux-otty-isolation`): the only `zoom` verbs
    in `CLI/` are `canvas zoom` (viewport magnification) and `browser zoom` (web page zoom); the
    control socket's pane methods are exactly nine (`pane.break` `pane.create` `pane.focus`
    `pane.join` `pane.last` `pane.list` `pane.resize` `pane.surfaces` `pane.swap`); the capability
    exists only as the GUI keybinding `ShortcutAction.toggleSplitZoom` (⌘⇧↩). Upstream issue #351
    asked for the CLI verb and was closed on the keybinding alone; PR #353 would add it and is
    unmerged; issue #2100 is open.

  So the member is REQUIRED on `MuxAdapter` with a `canZoomPanes` declaration and a refusal by name
  (`PaneZoomUnsupportedError`, `zoom.ts`) — `canFloatPanes`'s exact shape, with a different pair of
  refusers than the issue predicted.

- **ABSOLUTE, not a toggle, and no toggle beside it** — DECIDED, following `resizePane`. A blind
  toggle cannot be used correctly by an agent: it can ask for "big" and get "small". A caller that
  wants the toggle spells `setPaneZoom(e, t, !isPaneZoomed(e, t))`, which is one line and is honest
  about the read it depends on; a seam toggle would be a second spelling every adapter has to carry.

- **The no-op is CONTRACT, not optimization: every adapter reads before it writes** — DECIDED, and
  this is the decision a mocked test would never have forced. Two backends spell zoom at the TAB
  tier rather than the pane tier, so an unguarded absolute write acts on a pane the caller never
  named. Measured live on herdr 0.9.0: with p2 zoomed, `herdr pane zoom p3 --off` unzoomed **p2**
  and moved focus to p3. `setPaneZoom(p3, false)` asks for nothing — p3 was never zoomed — and
  would have silently unzoomed a sibling. tmux/rmux have the same trap from the other side: `-Z` on
  a window already zoomed on a different pane merely unzooms it, so a naive "toggle when the flag
  differs" leaves NOTHING zoomed instead of transferring.

- **Per-backend renderings, each probed rather than inferred from a sibling:**
  - tmux 3.7c / rmux 0.10.0 — `resize-pane -Z`, a TOGGLE, preceded by `select-pane -t <id>` when
    zooming. The `select-pane` is not redundant: measured on both, `-Z -t %2` while `%1` is zoomed
    leaves every pane at `z=0` with `%1` still active, because the zoom follows the ACTIVE pane.
    `select-pane` unzooms the window and moves the active pane in one step. Read is
    `#{window_zoomed_flag} AND #{pane_active}` — the flag is per WINDOW and reads `1` on all three
    panes of a zoomed window — taken off `list-panes -a` rather than `display-message -p -t <pane>`,
    which answers a dead pane with a blank line and exit 0.
  - herdr 0.8.0 / 0.9.0 — `pane zoom <id> --on|--off`, natively ABSOLUTE and idempotent
    (`{"changed":false}` on a repeat). Read is `pane layout --pane <id>` → `zoomed AND
    focused_pane_id === id`. The 0.8.0 CI pin was settled from that binary's own bundled schema
    (`herdr api schema --json`, protocol 19: `pane.zoom` with `PaneZoomParams { mode, pane_id }`,
    and `PaneLayoutSnapshot` REQUIRING `zoomed: boolean` + `focused_pane_id: string`) because a
    0.8.0 client answers a 0.9.0 server with `protocol_mismatch` and herdr has no throwaway-server
    mode to run an old one beside it.
  - zellij 0.45.0 — `action toggle-fullscreen -p <id>`, a toggle, preceded by `action focus-pane-id
    <id>` when zooming, for tmux's reason (measured: toggling a different pane while one is
    fullscreen just leaves fullscreen). **That focus call is deliberately UNCHECKED**, and finding
    out why is the second thing only a live binary could teach: `focus-pane-id` exits **2** when the
    pane is ALREADY focused ("Pane Terminal(0) is already focused") — a success for this purpose —
    and exits 2 with the same shape when the pane does not exist. The exit code cannot tell them
    apart, so gating on it threw on the commonest case; the `toggle-fullscreen` that follows is what
    reports a real failure. Read is `is_fullscreen`, genuinely per-pane, free in the listing.
  - wezterm 20240203 — `cli zoom-pane --pane-id <id> --zoom|--unzoom`. Read is `is_zoomed`, free in
    the listing. Nothing to compose; the guard is kept only because the seam's no-op is uniform.
  - otty — REFUSED, and NOT for cmux's reason. `otty pane zoom` exists; the docs name it once
    ("Panes additionally have `split`…, `zoom`, `resize`, …") with no flag list, no example, and no
    read-back field, while spelling out the flags of `split` and `resize` in that same sentence.
    Both halves of an absolute set are missing — the write vocabulary and the read that guards it —
    and guessing a flag would ship the same silent-success failure cmux's `resize-pane -Z` shim
    already is (`-Z` is not in that verb's `boolFlags`, an unknown short flag lands in `positional`,
    and the dispatch has no final `else`, so it resolves the pane, does nothing, and exits 0).
    **`163-otty-cwd`'s lesson was applied rather than ignored:** that entry, landed on `main` while
    this one was being written, showed the reference is not the whole corpus — `/agents/orchestration`
    demonstrates `--cwd` and `--no-focus` on `pane split`, which `/reference/cli` omits. That page was
    therefore checked for this member too and mentions zoom nowhere; the `otty pane …` commands it
    runs by hand are `list`, `split`, `run`, `exec`, `capture`, `wait`, `close`. `/workflows/cli-usage`,
    `/user-interface/window-tab-split`, `/user-interface/command-palette`, `/changelog` and `llms.txt`
    carry nothing either. The refusal rests on a corpus search, not on the reference alone.
    **RECHECK TRIGGER:** `otty pane zoom --help` on a machine with otty (#128). An absolute on/off
    makes this a two-line implementation; a bare toggle keeps the refusal until `otty panes --json`
    is shown to carry a zoom field.

- **`isPaneZoomed` answers `undefined` on cmux and otty, never `false`** — DECIDED, and this is
  where it diverges from `LivePane.floating`. A backend with no floating-pane concept truthfully has
  only tiled panes, so `false` is a real answer there. A backend with no zoom CLI is not a backend
  with no zoom: cmux binds pane zoom to ⌘⇧↩, so `false` would be a confident lie about a pane the
  user zoomed by hand. `isPaneFocused`'s wezterm shape.

- **`LivePane` does NOT gain a `zoomed` column, against the issue's proposal** — DECIDED, on a
  measurement the issue did not have. It asked for the flag on `LivePane` "the same way `floating`
  was added in #112 and for the same reason". The reason does not carry: `floating` rides `LivePane`
  because every backend answers it inside the listing the adapter ALREADY makes, so it is free.
  Zoom is free on tmux, rmux, zellij and wezterm — and not on herdr, whose `pane list` carries no
  zoom key on any record (verified live on 0.9.0) and whose only read is `pane layout --pane <id>`,
  one call PER TAB. Putting it on `LivePane` would make `listPanes` — the bulk cull `reconcile`
  runs — cost one exec per tab on that backend for a fact most callers never read. `isPaneFocused`
  is the precedent and the exact parallel: the other view-state fact, reported by three backends'
  listings and still a targeted probe rather than a column.

- **Zooming MOVES FOCUS, and that is declared rather than compensated** — DECIDED. Measured on all
  four toggling backends plus wezterm: tmux/rmux's `-Z` makes the target active, zellij's
  `toggle-fullscreen` focuses it, wezterm's `--zoom` makes it active, herdr's `--on` answers
  `focus_changed: true`. Undoing it would be a SECOND visible focus move, not the absence of one —
  `opensWithoutStealingFocus`'s reasoning exactly. Unzooming moves nothing.

- **No CLI command, deliberately** — DECIDED, following `resizePane`, which is a seam member with no
  `cyber-mux` subcommand either (`derivePaneResize` is exported and unwired). The member and its
  refusal are the unit of work; a `zoom` verb is a separate change with its own option and output
  conventions to settle.

- **Live coverage on all five capable backends**, which is where this member had to be settled: the
  tmux, rmux, herdr, zellij and wezterm real-boundary suites each gained zoom rows, and every one
  asserts a real screen fact (the pane's actual width, or which sibling survived) rather than an
  argv. The transfer row was checked against its own failure — deleting tmux's `select-pane` turns
  it red while every mocked row stays green, which is the whole argument for where this was tested.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/142

Decisions (`173-extract-cd-fallback` — the cwd `cd`-fallback lives with the env prefix):

- **The `cd` fallback moves into `env-fallback.ts` as `launchFallback`, and the two compensations
  become ONE function** — DECIDED, not two functions side by side. A route that lost both env and cwd
  must compose them in one order (`cd '/x' && env K=V cmd`, the env INSIDE the `&&`), so any shape
  that lets a caller apply them separately leaves the ordering at the call site, which is exactly
  where the second copy got written. `launchFallback(env, launch, cwd)` returns the finished command
  line; the caller submits it and, on `kind: 'dropped'`, writes its own backend-named warning. The
  warning text stays per-adapter because it names that backend's missing flags; nothing else does.

- **`kind: 'dropped'` now carries a `command`** — DECIDED, and it is the reason the union was kept
  rather than flattened. Dropped means ENV was lost for want of a command to ride; the `cd` needs no
  command, so the directory survives and must still be submitted. Both prior copies got this right by
  hand (`if (cwd) adapter.submit(…)` before the early `return`); the extracted shape makes it
  structural instead of remembered. A flat `{ command, droppedEnv }` was rejected: a caller could
  submit the command and never read `droppedEnv`, silently swallowing the warning — the failure mode
  this whole module exists to prevent.

- **An empty `cwd` is treated as none.** `MuxOpenOptions.cwd` is a REQUIRED string, so a caller with
  no directory to name passes `''`. Both copies tested it with a truthiness check; the extraction
  keeps that rather than `cwd === undefined`, which would emit `cd ''`.

- **No other adapter silently drops `cwd`** — the issue's "while you are there" check, run over every
  creating route in all seven adapters and answered from the SOURCE, not from a docs page. tmux
  (`new-pane`/`new-window`/`split-window` `-c`), rmux (`new-window`/`split-window` `-c`), herdr
  (`workspace create`/`tab create`/`pane split --cwd`), zellij (`new-tab`/`new-pane --cwd`), wezterm
  (`cli spawn`/`spawn --new-window`/`split-pane --cwd`), cmux's `workspace`/`new-surface` and otty's
  `open` positional and `pane split --cwd` all pass it natively; cmux `new-pane` and otty `tab new`
  are the two fallback routes and are now the two callers of `launchFallback`. There is no third
  route to wire, and no route that accepts a cwd and discards it. This is the answer as of this
  commit — a NEW adapter, or a new route on an existing one, has to answer it again.

- **Pure refactor, proven by mutation rather than asserted.** Behavior is unchanged and no changeset
  was added. Three mutations of the extracted function were each run and each went red: env moved
  OUTSIDE the `&&` (5 failures — the new unit row plus both adapters' argv rows), the `cd` withheld on
  the dropped-env path (2), and the shell-quote removed (10). Nothing was driven live: cmux and otty
  have no binary on any CI runner (#128), which is why both call sites are pinned by mocked-`Exec`
  argv assertions and why those assertions are what the mutations had to break.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/173

Decisions (`153-remote-async` — does driving a pane on a REMOTE machine force the seam async, issue
#153):

- **The issue's premise is half wrong, and which half matters.** #153 states *"Every adapter method is
  synchronous today. Remote transport forces async."* Both clauses were measured and both need
  correcting. `waitForOutput` has been `Promise<MuxWaitResult>` since it landed, and every consumer
  already awaits it, so the seam is not uniformly sync — it is sync **except where time is the
  subject**. And transport does not force async at all: a blocking `ssh host -- <cmd>` is an
  `execFileSync` like any other, so `Exec`'s signature already fits it. **DRIVEN, not argued** — a
  throwaway `sshd` on loopback plus a throwaway `tmux -L` server, and `tmuxMuxAdapter.listPanes`
  called with an `Exec` whose body is `execFileSync('ssh', [...opts, host, '--', ...argv])`: a real
  `LivePane` came back off a real remote tmux, with **zero adapter changes**. What forces async is the
  ACCEPTANCE CRITERION, not the wire.

- **Async is REQUIRED — by concurrency, and by nothing else.** DECIDED. #153's own acceptance says
  *"An unreachable machine reports unavailable without blocking operations on other machines."* No
  `Exec` shape can satisfy that, because a synchronous child process freezes the whole runtime.
  Measured against a blackholed address (`10.255.255.1`), with `execFileSync`'s own `timeout: 20_000`
  set: **21,893 ms wall and 0 event-loop ticks** from a 100 ms interval that should have fired ~219
  times. One unreachable machine is not "one slow call" — it is every other machine stopped too, and a
  `SIGTERM` kill is the only exit. `nodeExec` sets no `timeout` at all today, so the real blocking is
  unbounded. That single measurement is the whole decision; the transport arguments below only say
  what a sync route would ALSO cost if the criterion were dropped.

- **A sync `ssh` route is real, and ships two silent corruptions. NOT RECOMMENDED even for one
  machine.** Both were driven, and both are the failure mode this repo keeps paying for — a wrong
  answer, not an error:
  - **argv is re-parsed by the remote shell.** `ssh` joins its command words with spaces and the far
    side runs them through a login shell, so `execFileSync`'s array safety is gone. The tmux adapter's
    own `listPanes` format begins `#{pane_id}`, and `#` opens a comment at word start: the remote
    shell ate the format, tmux answered `command list-panes: -F expects an argument` and exited 1,
    `Exec` mapped that to `null`, and **`listPanes` returned `[]`** — a machine full of panes reported
    as empty. Per-argument shell quoting at the transport fixes it (measured: quoted, the same call
    returns the record).
  - **the far side inherits no locale, and tmux's output depends on one.** A non-interactive `ssh`
    command session exports neither `LANG` nor `LC_ALL` (measured: both empty). Under `LANG=C` or an
    empty environment, tmux renders the TAB in a `-F` format as `_`; under `C.UTF-8` it emits the tab.
    Isolated with `env -i` vs `env -i LANG=C.UTF-8` against the SAME binary, so it is the locale and
    not the version. `listPanes` splits on `\t`, so over `ssh` it parsed **one** pane whose `id` was
    the entire line — `%0_zsh_/home/unional_zeta_zeta_` — and every later call on that id failed
    against a pane that never existed. Nothing threw.
  So a remote `Exec` is not "the same signature with a different body": it is a transport that must
  quote every argument and normalize the far side's environment. Neither is `Exec`'s job today, and
  neither is visible to a mocked test.

- **Connection reuse is a real cost but not a deciding one.** Measured on LOOPBACK, where network
  latency is zero: local `execFileSync` **1.9 ms/call**, a fresh `ssh` connection **184.4 ms/call**
  (~97×), and `ControlMaster`/`ControlPersist` multiplexing **7.5 ms/call** (~4×). The seam is chatty
  by design — `setPaneZoom` reads before it writes, `focus` walks workspace and tab — and
  `pollForOutput` reads every `DEFAULT_WAIT_POLL_MS` (150 ms), so an unmultiplexed remote wait polls
  at the transport's cadence rather than its own. Reuse is a transport concern that a sync route could
  also carry; it argues for a connection-owning transport object, not for async.

- **What herdr actually offers today: a machine REGISTRY, and no remote control path.** DRIVEN on the
  installed **herdr 0.9.0** with its server running, not read off the issue:
  - `herdr machine {list,add,rename,remove,enable,disable}` — "Manage saved SSH machines". `machine
    add --label <L> <SSH_TARGET>` "prepare[s] the remote Herdr server and save[s] an SSH machine".
    `herdr machine list --json` answers `[]` here, so nothing below was probed against a real peer.
  - **The socket API has no machine concept at all.** `herdr api schema --json` (protocol 22, 275 KB,
    ~100 methods from `agent.*` to `worktree.*`) contains **zero** occurrences of `machine`, `ssh`,
    `host`, or `profile` — the only `remote` hits are plugin-update fields. Every method is scoped to
    the local socket.
  - **`--remote` is attach-only.** `herdr --remote <target> pane list` answers `error: --remote can
    only be used with the default launch command`, exit 2. It attaches the TUI through SSH; it does
    not carry a control subcommand.
  - `--session <name>` DOES compose with control verbs, and selects a different **unix** socket
    (`~/.config/herdr/sessions/<name>/herdr.sock`), failing loudly and structurally when nothing is
    there (`{"error":{"code":"server_not_running", ...}}`, exit 1). A unix socket is local by
    construction, so this is a second-server axis, not a remote one.
  - **Therefore the issue's inference does not hold.** #153 reads herdr's machine support as *"the
    multiplexer can already span hosts while cyber-mux cannot"*. The herdr **app** spans hosts; its
    **control API** does not. The only route to a remote herdr pane today is `ssh host -- herdr pane
    …` — the generic transport route, with herdr's registry buying cyber-mux nothing it would not have
    to build anyway.

- **When async does land: a hard breaking change with a major. NOT a dual surface, NOT a generic.**
  DECIDED in shape only; **this CR changes no signature.**
  - *Dual sync/async surface* — rejected. Seven adapters × ~25 members written twice, and the sync
    half can never serve a remote target, so the type system would carry a permanent lie about which
    calls are addressable.
  - *Generic over the return type* (`MuxAdapter<'sync' | 'async'>`) — rejected. The color leaks into
    every shared helper above the adapters (`wait-output`, `zoom`, `resize`, `nudge`, `template-*`),
    each of which would need the same conditional return, and every reader pays for it forever.
  - *Hard break* — chosen. The edit is mechanical and codemod-shaped (`async` + `await`), which is
    exactly what the other two are not. Blast radius, counted: **151 `exec(` call sites across 9
    non-test source files** (herdr 31, tmux 26, rmux 26, zellij 17, worktree 14, cmux 13, wezterm 12,
    otty 11, mux-probe 1), **31 test files** driving a fake `Exec`, and three published entry points
    (`.`, `/worktree`, `/template`) whose barrels re-export 16 modules.
  - **Named downstream, not hypothetical:** `cyberlegion` imports `cyber-mux` and `cyber-mux/worktree`
    and calls into them from **19 sites across 8 non-test files** — `session.ts` 7, `identity.ts` 3,
    `runtime/inject-inbox.ts` 2, `console/doorbell.ts` 2, `cli.ts` 2, `paths.ts`, `mux-select.ts`,
    `decommission.ts`. All but one sit inside a plain SYNCHRONOUS exported function: `spawn` (six of
    them), `resolveSelfId`, `claimPresence`, `resolveProjectLocalRoot`, `decommission`; only
    `nudgeUnit` is already `async`. The await colors each of those and then their callers
    transitively, so the downstream cost is an identity/session-layer rewrite, not nineteen `await`s.

- **Ordering, and what concurrent adapter work should do RIGHT NOW: stay sync.** DECIDED, and it is
  the opposite of what #153 proposed ("landing async-tolerant signatures up front"). A codemod over a
  uniformly sync seam is one pass; a seam where some members were written "async-tolerant" ahead of
  time is neither sync nor async and cannot be codemodded at all. The sequence is: (1) the async major
  as its OWN CR touching signatures and nothing else, (2) remote target addressing, (3) per-machine
  capability reporting. Nothing in (2) or (3) is startable before (1), which is why #153's first work
  item is the gate it says it is.

- **Nothing is implemented here, deliberately.** No `Exec`, `MuxAdapter`, or adapter signature is
  touched by this entry; three pods were editing adapters while it was written, and an async rewrite
  landing under them destroys their work for no delivered capability.

- **RECHECK TRIGGERS** — any one of these reopens the decision:
  - **herdr's socket API grows a machine-scoped address.** The check is mechanical: `herdr api schema
    --json | grep -ci machine` is **0** at protocol 22. A non-zero answer, or `herdr --remote <host>
    pane list` no longer refusing with `--remote can only be used with the default launch command`,
    means the remote target becomes herdr's own and cyber-mux may need addressing without transport.
  - **#153's multi-machine acceptance is relaxed to one machine at a time.** The concurrency argument
    is the only one that forces async; drop it and the quoted, locale-normalized `ssh` route becomes
    viable, at the two silent-corruption costs measured above.
  - **A cancelable synchronous child process appears in Node.** It has not and will not; recorded so
    the argument is falsifiable rather than rhetorical.

- **Found while probing, out of this CR's scope: `listPanes` is locale-sensitive on tmux and rmux.**
  Under `LANG=C` or an empty environment, tmux emits `_` where the adapter's `-F` format asked for a
  TAB, so the tab split yields one bogus record instead of N real ones — reproduced locally with `env
  -i`, no SSH involved. Reachable today by any caller launched without a locale (a systemd unit, a
  cron job), not only by a future remote one. Recorded here rather than fixed, because a parse change
  is a code change and this CR is a decision.
  ISSUE: https://github.com/cyberuni/cyber-mux/issues/153

Decisions (`177-locale-safe-tmux-output` — what makes tmux mangle its own `-F` output, and how the
adapter stops it, issue #177):

- **The corruption is a whole BYTE CLASS, not a separator.** MEASURED on tmux 3.7c, one binary, one
  isolated `-L` socket, only the environment differing. For a client tmux does not consider UTF-8,
  every byte outside printable ASCII (0x20–0x7e) comes back as a literal `_`: 0x01, 0x07, 0x08, TAB,
  LF, 0x0b, 0x0c, CR, ESC, 0x1d, 0x1e, 0x1f, 0x7f, and every non-ASCII byte (U+00A0 and U+2022 both
  tested) — all `_`; `|` and `:` pass through untouched. So #177's TAB is one instance and NO control
  character is a usable separator. It also means the corruption is not confined to the parse:
  `#{pane_title}`, `#{pane_current_path}` and `#{session_name}` lose their non-ASCII content in every
  format, space-separated ones included, which is what makes a re-picked separator a half fix.

- **DECIDED: `-u` on every tmux invocation, through one helper.** `runTmux` in `mux.tmux.ts` is the
  single choke point; all 26 call sites go through it. tmux(1) documents `-u` as exactly this: *"Write
  UTF-8 output to the terminal even if the first environment variable of LC_ALL, LC_CTYPE, or LANG
  that is set does not contain \"UTF-8\" or \"UTF8\"."* Applied uniformly rather than to the `-F` calls
  only — the class above is wider than the parse, and a flag carried by some call sites and not others
  is a flag the next call site forgets. Verified live: `send-keys -l` round-trips `café•` identically
  with and without it, and `capture-pane -p` was never sanitized, so uniformity costs nothing.

- **REJECTED: pinning a locale on the child environment.** It was the other candidate and it is worse
  on two measured counts. `LC_ALL=C` does **not** fix it — still `_` — because tmux's test is a
  substring match for "UTF-8"/"UTF8", not "is this a valid locale", so a pin has to name a UTF-8
  locale the host actually has, and `C.UTF-8` is a glibc spelling macOS does not ship. It would also
  need `Exec` widened to carry an environment, which the seam does not do. The argument that a pin
  would leak into panes the adapter creates was **checked and is FALSE** — measured: a pane created by
  a `LANG=C.UTF-8` client has no `LANG`, because the pane inherits the SERVER's environment, not the
  client's. Recorded because it is the intuitive objection and it does not hold.

- **rmux is NOT affected — this corrects the #153 entry above.** That entry recorded the finding as
  "locale-sensitive on tmux and rmux", inferred from rmux reimplementing tmux's `#{…}` vocabulary
  under the same names. Measured on a live rmux 0.10.0 under `env -i`, the same format returns a real
  TAB, and a multi-line format returns real newlines where tmux returns `_`. `mux.rmux.ts` is
  therefore left alone. rmux accepts `-u` (it is in its usage string) but has nothing to fix, and
  adding a no-op flag to a second adapter would suggest a shared defect that measurement says is not
  there.

- **`$TMUX` in the caller's environment suppresses the bug entirely, and that bounds its blast
  radius.** MEASURED, and it is not in the issue: with no locale at all but `$TMUX` set, `list-panes
  -a -F '#{pane_id}<TAB>#{window_id}'` still returns a real tab — a command client inside a session
  takes the containing client's UTF-8 state instead of reading the environment. So a caller running
  **inside a pane was never affected**; what was affected is a caller with neither a locale nor
  `$TMUX`, which is the systemd unit / cron job / container entrypoint / non-interactive ssh case
  reaching this adapter through the `CYBER_MUX=tmux` override or process ancestry. The issue's
  severity is right and its reachability list is right; this is the missing precondition.

- **Why `live-backends` never went red, and what the regression test had to do about it.** The job
  inherits the runner's environment, which carries a `LANG`, and the existing tmux integration block
  sets `$TMUX` on purpose so target-less commands resolve — either one alone is enough to hide this.
  So `mux.tmux.integration.test.ts` gained a SECOND real-tmux block whose child environment is built
  from nothing but `PATH` and `HOME`, on its own socket and its own server. Its first row asserts that
  environment rather than describing it, so a fixture that quietly regrew a `LANG` fails loudly
  instead of turning the block into a test of nothing. The rows that are about `listPanes` create
  their panes with a separator-free `-F '#{pane_id}'` call rather than through `open`, so that
  reverting the fix turns each row red on ITS OWN claim instead of on `open`'s parse. Reverting `-u`
  was run: all three rows go red, and the listing row fails with the issue's exact shape
  (`%0_zsh_/tmp/…`).

- **The mocked unit fakes assert the flag rather than spelling it into every expected argv.** Each
  fake `Exec` that serves tmux checks `args[0] === '-u'` and strips it before recording, so the flag
  is pinned on EVERY recorded call — not only on the rows that assert a full argv — and the ~240
  existing rows stay about the command they are about. This is the one place a mocked test is load
  bearing here, and it is load bearing for argv shape only; the behavior it protects is proven at the
  real boundary above.

- **Untested, and stated as such:** only tmux 3.7c and rmux 0.10.0 were driven. `-u` is long-standing
  in tmux and takes no argument, so an older tmux is expected to accept it, but that expectation was
  not measured against an older binary.

ISSUE: https://github.com/cyberuni/cyber-mux/issues/177
