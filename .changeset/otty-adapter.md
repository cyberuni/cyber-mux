---
"cyber-mux": minor
---

Add otty backend adapter

otty is a native terminal-centric workspace app with integrated multiplexing, built for AI coding agents. This adds detection and a full `MuxAdapter` implementation using otty's CLI.

- Detection via `$OTTY_PANE_ID` env variable
- Supports workspace (window), tab, and pane:right/pane:down placements
- Send-keys supports text and key tokens in one atomic call
- No split sizing support (`canSizeSplits: false`)
- No `--env` flag support (env compensation via command prefix)
- No geometry/regions support (otty CLI doesn't report positions)
- macOS/Windows desktop app
