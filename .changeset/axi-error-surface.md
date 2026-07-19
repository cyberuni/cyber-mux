---
"cyber-mux": minor
---

The CLI's error surface now follows [AXI](https://github.com/kunchenguid/axi) on every command, not
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
