---
cr-ref: adapter-real-boundary-coverage
status: active
project: packages/cyber-mux
todos:
  - content: "wezterm: real-boundary suite + CI install — PR #108"
    status: completed
  - content: "zellij: probe whether it can be driven headlessly at all"
    status: completed
  - content: "zellij: decide the MuxTarget session-qualifier seam before writing the suite"
    status: completed
  - content: "zellij: fix the two field-name bugs the probe found (pane_cwd absent, pane_command is terminal_command)"
    status: completed
  - content: "zellij: real-boundary suite + CI install"
    status: completed
  - content: "cmux: real-boundary suite — blocked, needs macOS with the app installed"
    status: pending
  - content: "otty: real-boundary suite — blocked, needs macOS with the app installed"
    status: pending
---

# Adapter real-boundary coverage

Closing the gap the conformance runner (`per-adapter-conformance-runner`, PR #107) exists to
report: four of six adapters shipped with **mocked unit tests only**. Every one of those asserts
that the adapter builds the command string it intended; none checks that the multiplexer accepts it.

| adapter | unit tests | real-boundary suite |
|---|---|---|
| tmux | 70 | pre-existing |
| herdr | 106 | pre-existing |
| wezterm | 41 | **landed — PR #108** |
| zellij | 39 | **landed — 10 tests, this branch** |
| cmux | 25 | none |
| otty | 25 | none |

## NEXT — resume here

**The probe is done and both open questions are answered** (2026-08-09, zellij 0.44.3 musl on
WSL/Linux). Do not re-run it; the findings are below under "zellij probe".

**Answer: zellij IS drivable headlessly**, with exactly one exception — `new-pane --direction`
(see the findings). A clientless harness covers every verb except tiled splits; covering those
too costs one `script`-allocated PTY client, which is cheap enough to be worth it.

**Decision, resolved: pin today's ambient-session behavior.** No `MuxTarget` change. The probe
settled it: isolation is fully available through the **injected `Exec`** — `--session <name>` plus a
private `XDG_RUNTIME_DIR` — which is the working method's own rule (isolation comes from the Exec,
never from the adapter). So the suite needs no session qualifier on `MuxTarget` to be isolated, and
lifting that seam stays a separate spec-gated CR that this suite neither blocks nor pressures.

**zellij is DONE on this branch** — field-name fix (with changeset), a 10-test
`mux.zellij.integration.test.ts`, and the `live-backends` CI install, all committed. The suite was
run three times locally against the real 0.44.3 binary (10 passed, ~7s, stable, no leftover sessions
or temp dirs) and confirmed to *skip* cleanly with zellij off `PATH`. `pnpm verify` is green (1045).

**The next action — the only one left that is not machine-blocked.** Push this branch and read the
`live-backends` job log to confirm the zellij suite actually EXECUTED on the runner rather than
self-skipping. A green check is not the evidence; the 10 test names in the log are. This is the check
that bit twice during PR #107.

After that, this mission is blocked on hardware, not on work — see cmux/otty below.

**cmux and otty are blocked, not deferred by choice.** Both are macOS GUI applications; this
workstation is WSL/Linux and CI is Linux, so neither can be driven or even installed here. Writing
their suites blind would produce files that self-skip everywhere and report green by absence —
precisely the failure `per-adapter-conformance-runner` exists to make impossible. They want a macOS
machine with the apps installed. Note the same constraint is why both adapters were doc-probed
rather than driven when they landed (`48-cmux-adapter.plan.md`, `otty-adapter.plan.md`).

## zellij probe — the answers, do not re-derive

Setup that works: `zellij attach --create-background <name>` starts a session with no client, and
`zellij --session <name> action …` reaches it. Isolation is `XDG_RUNTIME_DIR` (live sockets live at
`$XDG_RUNTIME_DIR/zellij/contract_version_1/<name>`) — also set `XDG_CACHE_HOME`, because the
*resurrection* list bleeds through the cache dir and a fresh runtime dir still lists dead sessions.

- **Every action must name `--pane-id`.** With no client there is no focused pane, so the
  focus-relative default silently targets nothing — `dump-screen` with no `-p` returns empty and
  exit 0. The adapter already spells `--pane-id` on every verb, so this costs it nothing; it is the
  suite's harness that must never rely on focus. Verified working headlessly: `new-pane` (plain,
  `--name`, `--cwd`, `--floating`), `new-tab`, `write-chars -p`, `send-keys -p`, `dump-screen -p`,
  `focus-pane-id`, `close-pane -p`, `list-panes --json`.
- **`new-pane --direction` is the one verb that needs a client — and it fails SILENTLY.** It prints
  a plausible new pane id and exits 0 while creating nothing. It works only with a client attached
  *and focused on a terminal pane*; with a client focused on a plugin pane (the release-notes pane
  zellij focuses on first attach) it still fails, and `focus-pane-id` with no client does not rescue
  it. A PTY client is enough: `setsid script -qec "zellij attach <name>" /dev/null &`, then
  `focus-pane-id` a terminal pane before splitting. `script` is util-linux — present on the Ubuntu
  runners and WSL, no new dependency.
  - Consequence for the adapter, which is **good news**: `open({at:'pane:right'})` does not hand
    back a phantom. `openedForPane` looks the id up in `list-panes` and throws
    `zellij did not report a tab for the new pane …`. It fails loudly at exactly the right place.
- **Id forms confirmed, and `samePane` is load-bearing.** `new-pane` prints the prefixed
  `terminal_N`; `list-panes --json` reports `id` as a **bare integer**. The adapter's normalization
  is what makes those the same pane — the header flagged this as needing a live confirmation, and
  this is it. `new-tab` prints a bare tab id (`1`), as the adapter assumes.

### Two real adapter bugs the mocked tests cannot see

Both are `list-panes --json` field names that no fixture ever disagreed with, because the fixtures
were written from the same doc-probe as the code. Confirmed against 0.44.3's actual key set:

- **`pane_cwd` does not exist — there is no cwd field at all.** So `listPanes()`'s
  `if (p.pane_cwd) pane.cwd = …` is dead code and `LivePane.cwd` is *never* populated for zellij.
  The real keys are `id, tab_id, tab_name, tab_position, title, terminal_command, plugin_url,
  is_plugin, is_focused, is_floating, is_fullscreen, is_suppressed, is_selectable, is_held, exited,
  exit_status, index_in_pane_group, pane_x/y, pane_rows/columns, pane_content_*,
  cursor_coordinates_in_pane, default_bg, default_fg`.
- **`pane_command` is really `terminal_command`.** So `zellijLabel(p.title, p.pane_command)` always
  compares the title against `undefined` and the guard never fires — meaning an unnamed pane's
  ambient, command-derived title leaks out as an authored `label`. Observed live: a pane opened as
  `sh -c 'sleep 90'` reports `title === terminal_command === "sh -c sleep 90"` and today would be
  labeled with it. That is precisely the manufactured-name collision the guard exists to prevent,
  and it is the reason to fix this before the suite pins the behavior.

## Findings the commits will not show

- **wezterm is isolatable, contradicting an earlier audit.** That audit was right that the adapter
  spells no socket flag and wrong that no primitive exists: `wezterm cli --prefer-mux` targets a
  background `wezterm-mux-server` whose socket lives under `$XDG_RUNTIME_DIR`, so a throwaway
  runtime dir yields a private wezterm — a true `-L` equivalent supplied by the environment.
- **The socket path must be short.** `sun_path` is ~108 bytes and wezterm appends `wezterm/sock`.
  A long temp path makes the bind fail silently and every later command reports "failed to connect",
  which reads like a wezterm fault and is not.
- **wezterm's Ubuntu20.04 release build is dead on modern runners** — it links `libssl.so.1.1`,
  absent from 24.04, and fails at load with a message that looks nothing like a missing dependency.
  Use the Ubuntu22.04 tarball; it carries `wezterm`, `wezterm-gui` and `wezterm-mux-server`.
- **`pkill -f <server-name>` is unsafe as teardown.** It matches any command line merely mentioning
  the name — including the shell that launched the test run, which it killed mid-development. Kill
  the PID the suite owns. (Re-learned the hard way during the zellij probe, from this very note —
  a `pkill -f 'zellij.*cm-probe'` took the probe shell down with it. Delete a zellij session by name
  with `zellij delete-session --force <name>` instead; both suites kill their own PID/process group.)
- **Real-boundary cost is negligible**, which settles the "is this too slow for CI" question:
  installing wezterm took ~3s and its 7 tests ran in ~0.7s; the whole `live-backends` job is ~35s.
  Adding zellij should be the same order.
- **The probe already found a live behavior worth knowing:** `wezterm cli spawn` with neither
  `--pane-id` nor `$WEZTERM_PANE` fails outright, so the adapter's documented current-pane
  dependency is load-bearing rather than theoretical.

## Working method — do not relearn

- A real-boundary suite is `src/mux.<name>.integration.test.ts`, gated by `describe.skipIf(...)` on
  the binary's own presence, and opt-in via `pnpm cm test:integration` (never `pnpm test`).
- Isolation is supplied by the **injected `Exec`**, never by the adapter: the tmux suite injects
  `-L <socket>`, the wezterm suite injects `cli --prefer-mux` plus a private `XDG_RUNTIME_DIR`. The
  adapter spells no connection target, and that is deliberate.
- CI runs these in `pull-request.yml`'s `live-backends` job, which installs each multiplexer from a
  pinned release and is `continue-on-error`, so a new backend cannot block a PR on its first attempt.
- Verify a suite actually **ran** by reading the job log, never by a green check — a self-skipping
  suite reports green having executed nothing. This bit twice during PR #107.
