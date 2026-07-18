---
cr: "42-worktree-failed-backend-text"
source: "github#42"
project: cyber-mux
status: implemented
todos:
  - content: "Explore: traced the leak to session.tmux.ts/session.herdr.ts's withReason (embeds exec.lastError) reaching stdout via reportWorktreeFailure's err.message fallback"
    status: completed
  - content: "Draft mux/: additive scenario pinning the worktree catch-all against the general leak scenario; README prose"
    status: completed
  - content: "Draft axi/: closed the worktree-failed residual in 'what ships today'"
    status: completed
  - content: "Implement: WorktreeGitError in worktree.ts (5 sites) distinguishes cyber-mux's own worktree text from backend-originated text in reportWorktreeFailure"
    status: completed
  - content: "Test + verify: new cli.test.ts case, pnpm verify 7/7 green (602 tests); independent review agent confirmed no leak paths missed, no regressions"
    status: completed
  - content: "Handoff: changeset added, PR opened (Closes #42)"
    status: completed
---

# CR: worktree-failed catch-all still forwards raw backend text (#6 residual)

Source: github#42 — https://github.com/cyberuni/cyber-mux/issues/42 (follow-up filed from #40/PR #41)

## What was wrong

`reportWorktreeFailure` (`cli.ts`) forwarded any non-`CliError` caught into a `worktree-failed`
error using `err.message` verbatim. Most of the time that message is this CLI's own worktree text
(worktree.ts's refusals), which is safe and frozen tests assert on it. But the same catch-all also
sits downstream of `session.tmux.ts`/`session.herdr.ts` opening or binding the worktree's pane —
those throw via `withReason(exec, ...)`, which appends `exec.lastError`, the backend's raw stderr,
verbatim, alongside the backend's own name ("tmux ... failed", "herdr worktree create failed"). That
combination reached stdout untranslated — AXI #6's "never leak a dependency's name or text", the one
path #36's error-surface pass didn't reach.

## Fix

- `worktree.ts`: new `WorktreeGitError extends Error`, thrown at its 5 own refusal/failure sites
  instead of plain `Error`.
- `cli.ts` `reportWorktreeFailure`: `CliError` passes through as before; `WorktreeGitError` forwards
  its message verbatim (unchanged behavior — the frozen worktree refusal text stays exactly as
  tested); anything else (backend-originated) writes its raw message to **stderr** as a diagnostic
  and reports a generic, coded `worktree-failed` on stdout with no backend name or text.
- Fail-safe by construction: an unmarked future throw anywhere reachable from the worktree verbs is
  redacted by default, not leaked — no blocklist to keep in sync with new backend throw sites.

## Spec/suite

Additive only — `mux.feature` gained one scenario ("the worktree catch-all never forwards the
multiplexer's raw diagnostic either") beside the existing general "an error never leaks the
multiplexer's own output" scenario, which the worktree path was the one gap in. Self-clears; the
frozen file needed no re-open. `mux/README.md` and `axi/README.md` prose updated to describe the fix
and close the "what still trails the contract" residual axi/ had recorded.

## NEXT — landed

**Both gates self-asserted by agent** (small, single-package, additive-only change; package is
`0.0.0`, nothing shipped, so Compatibility does not fire; no Clearance narrowing — the new scenario is
additive and the worktree.ts refusal messages are unchanged; no Conflict). Verification: mechanical
(`check:features` both `.feature` files parse; `pnpm verify` 7/7 turbo tasks, 602 tests) plus an
independent review pass (a fresh general-purpose agent, blind to this plan, traced every
`reportWorktreeFailure` call site — worktree add/open/list/remove — and every reachable throw
(`resolvePrimaryRoot`, `session.tmux.ts`/`session.herdr.ts` binding calls, `removeWorktreeSafely`) and
confirmed no raw backend text remains reachable and no existing frozen-text assertion broke).
Changeset added (`patch` — a bug fix to error content, not a new capability). PR opened, `Closes #42`.

**Working method / provenance:** ledger shard
`packages/cyber-mux/.agents/spec/ledger/42-worktree-failed-backend-text.bc5290.jsonl`. SDD default
squad (no plugin registry).
