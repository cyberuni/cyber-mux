---
todos:
  - content: "Confirm otty CLI surface: pane id, send-keys, capture, split, focus"
    status: completed
  - content: "Add otty to detection scenarios (detection.feature)"
    status: completed
  - content: "Implement mux.otty.ts adapter"
    status: completed
  - content: "Wire otty into backend.ts selector"
    status: completed
  - content: "Add mux.otty.test.ts with mocked Exec"
    status: completed
---

# otty adapter

**Source:** https://otty.sh/

otty is a native terminal-centric workspace with integrated multiplexing (windows, tabs, splits,
panes) and first-class support for AI coding agents. Its CLI (`otty`) exposes pane control via
`otty pane <subcommand>`.

## NEXT

Ready for spec gate. Build-to-learn complete — all tests pass.

## Initial research

1. **Pane identity:** `OTTY_PANE_ID` — the unique pane identifier. `OTTY_SOCKET` is the IPC path.
2. **CLI commands:**
   - `otty panes --json` — list all panes as JSON
   - `otty pane show --pane <id>` — show specific pane info
   - `otty pane split --right|--left|--top|--bottom` — create split
   - `otty pane send-keys --pane <id> -- <text> key:Enter` — send keys
   - `otty pane capture --pane <id> --lines <n>` — read terminal content
   - `otty pane focus --pane <id>` — focus pane
   - `otty pane close --pane <id>` — close pane
   - `otty pane zoom --pane <id>` — zoom pane
   - `otty pane resize --pane <id>` — resize pane
3. **Tab/window ops:**
   - `otty open <path> --title <name>` — open in new tab/window
   - `otty tab new --command <cmd> --title <name>` — new tab
4. **Platform:** macOS/Windows desktop app. CLI is installed via Settings > Shell > Install CLI.
5. **No worktree concept:** like tmux/wezterm/zellij/cmux, binding falls back to plain git + open.

## Scope

- `mux.otty.ts` adapter implementing `MuxAdapter`
- Detection via `$OTTY_PANE_ID` (analogous to `$WEZTERM_PANE`)
- Detection hint: `$OTTY_SOCKET` (analogous to `$HERDR_ENV`)
- Probed from docs only — otty is GUI-only, not installed in sandbox
