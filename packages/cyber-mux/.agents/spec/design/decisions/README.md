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
