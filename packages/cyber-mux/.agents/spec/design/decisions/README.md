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
  no custom code. Requester chose this shape. AXI's content-first principle (#8) says a bare group
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
