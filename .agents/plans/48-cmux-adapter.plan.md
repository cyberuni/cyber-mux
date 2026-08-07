---
todos:
  - content: "Confirm cmux CLI surface and platform support"
    status: completed
  - content: "Add cmux to detection scenarios (detection.feature)"
    status: completed
  - content: "Implement mux.cmux.ts adapter"
    status: completed
  - content: "Wire cmux into backend.ts selector"
    status: completed
  - content: "Add mux.cmux.test.ts with mocked Exec"
    status: completed
---

# 48 — cmux adapter

**Source:** [GitHub issue #48](https://github.com/cyberuni/cyber-mux/issues/48)

cmux is a terminal built for coding agents — sidebar tabs, split panes, libghostty rendering, a CLI
and Unix socket API. Its verb set maps nearly to `SessionAdapter`: create workspace, split pane,
send input, read screen.

## NEXT

Ready to land. Create changeset and commit.

## Questions from the issue

1. **Platform:** macOS only today; Linux/Windows/Android in development. Not a blocker for the
   adapter (mocked `Exec` tests), but a deliberate call.
2. **CLI vs socket:** CLI fits `Exec` with no new machinery. Prefer CLI unless something is only
   reachable over the socket.
3. **Pane identity:** need a stable id for `SessionTarget`/`LivePane`, and an env variable for
   `currentPane`.
4. **Scope:** screenshots and in-app browser are out of scope — cyber-mux drives panes only.
5. **Type widening:** `LivePane.mux` union widens to include `'cmux'`.
