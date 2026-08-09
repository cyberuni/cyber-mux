---
cr-ref: adapter-real-boundary-coverage
status: active
project: packages/cyber-mux
todos:
  - content: "wezterm: real-boundary suite + CI install — PR #108"
    status: completed
  - content: "zellij: probe whether it can be driven headlessly at all"
    status: in_progress
  - content: "zellij: decide the MuxTarget session-qualifier seam before writing the suite"
    status: pending
  - content: "zellij: real-boundary suite + CI install"
    status: pending
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
| zellij | 39 | none |
| cmux | 25 | none |
| otty | 25 | none |

## NEXT — resume here

**The next action.** Probe whether zellij can be driven with no attached client, before writing
anything:

```bash
curl -fsSL https://github.com/zellij-org/zellij/releases/download/v0.44.3/zellij-x86_64-unknown-linux-musl.tar.gz | tar -xz -C /tmp
/tmp/zellij --version                                  # verified working: 0.44.3
/tmp/zellij attach --create-background cm-probe        # does a detached session start?
/tmp/zellij --session cm-probe action dump-screen /tmp/out   # does an action reach it with no client?
```

That last line is the whole question. tmux answers it with `-L`, and wezterm answers it with
`XDG_RUNTIME_DIR` + `--prefer-mux`; whether zellij answers it at all is **unprobed** — do not assume
it does. If actions need an attached client, a suite is only possible under a PTY harness, and that
changes the shape enough to re-decide the scope.

**Blocking decision — resolve, don't rediscover.** The zellij adapter has a known seam limitation
recorded in `packages/cyber-mux/.agents/spec/design/decisions/`: `MuxTarget` carries only an opaque
pane id and **no session qualifier**, so `open({at:'workspace'})` collapses to a tab in the ambient
session and no adapter command ever names a session. Two options, and the suite's shape depends on
which:

- **Pin today's behavior.** Write the suite against the ambient-session limitation as specified.
  Cheap; the suite then documents a constraint rather than pressuring it.
- **Lift the seam first.** Add a session qualifier to `MuxTarget` — a real contract change, so a
  spec-gated CR of its own, and the suite follows it.

Recommend probing first regardless: if zellij cannot be driven headlessly, the decision is moot for
now.

**cmux and otty are blocked, not deferred by choice.** Both are macOS GUI applications; this
workstation is WSL/Linux and CI is Linux, so neither can be driven or even installed here. Writing
their suites blind would produce files that self-skip everywhere and report green by absence —
precisely the failure `per-adapter-conformance-runner` exists to make impossible. They want a macOS
machine with the apps installed. Note the same constraint is why both adapters were doc-probed
rather than driven when they landed (`48-cmux-adapter.plan.md`, `otty-adapter.plan.md`).

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
  the PID the suite owns.
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
