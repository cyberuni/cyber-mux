---
'cyber-mux': minor
---

`read` reports whether the capture dropped older rows, and `--full` takes the rest

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
