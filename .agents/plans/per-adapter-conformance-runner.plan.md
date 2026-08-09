---
cr-ref: per-adapter-conformance-runner
status: active
project: packages/cyber-mux
todos:
  - content: "Scaffold spec/conformance node — README + conformance.feature"
    status: completed
  - content: "Spec gate — judge suite + spec, freeze on approve"
    status: completed
  - content: "Build scripts/test-adapter.ts — discovery, probe, run, report"
    status: completed
  - content: "Wire test:adapter npm script; unit tests for the runner"
    status: completed
  - content: "Impl gate — verification per frozen scenario"
    status: completed
  - content: "Changeset (none — nothing published changes), commit, PR"
    status: completed
---

# CR — per-adapter conformance runner

A manual, maintainer-run CLI that verifies **one adapter at a time** against the real multiplexer,
because CI cannot install every multiplexer. No source issue; requested directly.

## Why

`pnpm test:integration` runs **every** `*.integration.test.ts` in one shot, and each suite
self-skips when its multiplexer is absent (`describe.skipIf(!hasTmux())`). Two consequences:

- **No per-adapter selection.** On a machine with tmux only, verifying herdr is impossible.
- **A skip and a pass render identically.** Green tells you nothing about what actually ran.

Worse, `wezterm` and `zellij` ship adapters with **no real-boundary suite at all** — only mocked
unit tests. Any runner that reports those green would be asserting coverage that does not exist.

## Decisions (settled with the requester)

| Question | Answer |
|---|---|
| Scope | Runner now; the injected shared conformance suite is a **follow-up CR** |
| Home | Repo script, **not shipped** — `packages/cyber-mux/scripts/`, its own npm script |
| Growth | **Derive from the filesystem** — no hand-maintained adapter table |
| Installed adapter, no suite | **Named gap, exit non-zero** — never renders as a pass |

## Design

- **Adapter discovery** — `src/mux.<name>.ts` (excluding tests). A new adapter is picked up with no
  edit; `cmux` / `otty` will appear the day their adapter lands.
- **Suite discovery** — `src/*.<name>.integration.test.ts`. herdr has two (`mux.`, `cli.`).
- **Presence probe** — the binary named by the adapter, looked up on `PATH`. Zero registry, so it
  extends to future adapters for free. The suite's own internal `skipIf` stays the second gate.
- **Outcomes** — `SKIP` (not installed, exit 0) · `GAP` (installed, no suite — exit 1) ·
  `PASS`/`FAIL` (installed, suite ran).
- **Bare form lists** every adapter with its status and exits 0; `--all` runs every installed
  adapter. Flags alone suffice — no interactive mode.
- **Exit codes** follow AXI's set: `0` success, `1` error/gap, `2` usage.

## Out of scope

- The shared injected conformance suite (the follow-up CR).
- Writing wezterm/zellij integration suites — this CR **reports** those gaps, it does not fill them.
- Root `spec.md` naming only "tmux, herdr, wezterm" while `zellij` ships — pre-existing spec drift,
  recorded as a follow-up.

## What landed

Both gates passed; nothing is left to resume.

- **`packages/cyber-mux/.agents/spec/conformance/`** — a new behavioral node, its 23-scenario suite
  `@frozen` at the spec gate. Registered in the root `spec.md` placement map (Capability map row,
  routing row, and a tie-break for the maintainer-only node kind).
- **`packages/cyber-mux/scripts/test-adapter.ts`** — the runner, plus `test-adapter.test.ts` binding
  all 23 scenarios. Exposed as `pnpm --filter=cyber-mux test:adapter`.
- **Config**: `vitest.config.ts` and `tsconfig.json` includes widened to `scripts/`;
  `.agents/sdd/scenario-bridge.toml` lost its `src` positional, which had made this node's scenarios
  structurally unbindable.
- **No changeset** — `scripts/` is absent from `package.json` `files`, so nothing published changed.

Two design points worth remembering, both forced by a judge round:

- **Run outcomes vs projected outcomes.** The listing form runs nothing, so it reports only
  `skip`/`gap`/`runnable` — never `pass`/`fail`/`no-coverage`, which are findings *of* a run.
- **`no-coverage` is the whole point.** A suite whose every test self-skips makes vitest exit 0
  reporting success; the runner reads the executed count instead and fails.

Follow-ups are recorded in this CR's ledger shard (wezterm/zellij have no real-boundary suite; the
shared injected conformance suite; root `spec.md`'s tmux/herdr/wezterm prose drift vs shipped zellij;
`--all` unit-verified only).
