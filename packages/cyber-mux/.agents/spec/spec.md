---
status: implemented
project-path: packages/cyber-mux
name: cyber-mux
approval:
  spec:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "No floor fires. Structural edit class: mux.feature ADDITIVE only (one new scenario, zero modified/removed) — self-clears, no re-open. Compatibility does not fire: package is 0.0.0, nothing shipped. No Conflict: the new scenario sits beside, and is consistent with, the existing general 'an error never leaks the multiplexer's own output' scenario it closes the one gap in."
      blast: "small — one internal cli.ts helper (reportWorktreeFailure) and one new exported class (WorktreeGitError, worktree.ts). No adapter, seam, or CLI-flag surface change; no other command's error path is touched. axi/ (reference, prose-only) and mux/README.md (prose) updated to reflect the fix; no .feature change there."
      novelty: "low — a bug fix inside an already-frozen general contract (the mux.feature scenario the fix satisfies already existed and named the intended behavior; the worktree path was simply the one command group not yet honoring it)."
      confidence: "medium-high — mechanical checks green (check:features: both .feature files parse) and manual structural diff read (gherkin-cli not invoked; the diff was visually confirmed as pure addition, zero removed/modified lines). No dedicated cold sdd-spec-judge round was dispatched for a change this small and additive-only; self-asserted within the auto-spec leash. Lands provisionally in the async review queue: ratify or kick back."
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "none at the impl gate. The frozen mux.feature was built against, not fitted to: the new additive scenario was settled at the spec gate and the impl gate built to it, adding no scenario and narrowing none."
      blast: "small — worktree.ts (WorktreeGitError class, 5 throw sites re-typed, message text unchanged) and cli.ts (reportWorktreeFailure's branching). One new cli.test.ts case."
      novelty: "low — mechanical: type-tag the known-safe throw sites, translate everything else the same way every other verb's backend failure already was."
      confidence: "high — pnpm verify 7/7 turbo tasks green, 602 tests (was 601; +1 new case), biome ci clean, both .feature files parse. A fresh, independent general-purpose agent (blind to this plan) traced every reportWorktreeFailure call site (worktree add/open/list/remove) and every reachable throw (resolvePrimaryRoot, session.tmux.ts/session.herdr.ts binding calls, removeWorktreeSafely) and confirmed: no raw backend text remains reachable on stdout, no existing frozen worktree-refusal text assertion broke, and the WorktreeGitError tagging approach is fail-safe by construction (an unmarked future throw is redacted by default, not leaked) rather than a blocklist that would need updating at every new backend throw site. No dedicated cold sdd-impl-judge dispatched for a change this small; self-asserted within the auto-spec leash. Lands provisionally in the async review queue: ratify or kick back."
produced-by:
  spec-producer: sdd:start-mission
---

# cyber-mux — the CLI: cross-multiplexer pane control

> Root project spec — the **descriptive** top index for the `cyber-mux` npm package
> (`packages/cyber-mux`). Behaviors live in the capability folders below.

`cyber-mux`: one contract (`SessionAdapter`) over terminal multiplexers (tmux, herdr) — detection,
pane identity, placement, git worktree, and turn-taking (nudge) helpers — decoupled from legion
(no store/identity/doorbell). Env namespace is `CYBER_MUX` / `CYBER_MUX_PANE`.

## Capabilities

| Node | Concern |
|---|---|
| [`mux/`](./mux/README.md) | the pane abstraction — backend selection, placement, multiplexer detection, focus reporting |
| [`template/`](./template/README.md) | named, reusable workspace templates — the arrangement, environment and launch commands a workspace is rebuilt from, plus resolution, the schema, and the walk that builds a pool against a target cwd |
| [`axi/`](./axi/README.md) | the Agent Experience Interface output contract every CLI command follows |
| [`design/`](./design/README.md) | cross-cutting rules/models and the decisions log (append-only, descriptive, ungated) |
