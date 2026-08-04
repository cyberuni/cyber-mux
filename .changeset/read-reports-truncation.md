---
'cyber-mux': minor
---

`read` reports whether the capture dropped older rows

`MuxAdapter.read` (and the bound `MuxSession.read`) now answers with `{ text, truncated? }` instead
of a bare string, so a caller matching against a snapshot can tell a short pane from a capture that
hit its bound. Pass `MuxReadOptions.truncation` to have the backend determine it; leave it off and
`truncated` is **absent** — never `false`, because a `false` that means "I did not check" is
indistinguishable from "you have everything" (the conflation herdr itself shipped a fix for in 0.8.0,
herdrdev/herdr#1717).

Real on every backend, by one rule: ask for one row more than the captured window and compare row
counts (`isReadTruncated`). tmux takes `-S -(N+1)`, WezTerm `--start-line -(N+1)`, Zellij compares
against the full dump its `lines` read already holds (no extra query at all), and herdr probes
`--source recent`, since its CLI prints the read's text alone and never surfaces the `truncated`
field its socket API computes.

Opt-in because it costs one extra backend query and `read` is the hottest verb on this seam —
`pollForOutput` runs it once per poll tick. Omitted, the argv is byte-identical to the read that has
always been issued.

CLI: `cyber-mux read --omitted-rows` — named for the backend's elision rather than "truncation",
which AXI #3 already spends on this CLI's own body truncation (the one `--full` escapes). The answer
is on stdout in every format: a trailing `omitted-rows` field after the capture in the default and
`agent` formats, and `{pane, text, omittedRows}` under `--format json`. The capture itself is
byte-identical either way.

Callers reading text from `read` now take `.text` (`nudge` and `waitForOutput` already do
internally).
