---
cr: 19-env-flag
source: https://github.com/cyberuni/cyber-mux/issues/19
project: cyber-mux/mux
status: in-progress
todos:
  - content: "explore: grill spec + suite for --env on open/worktree add/worktree open"
    status: completed
  - content: "decide where envPrefix lives — layout-session owns it, both routes now need it"
    status: completed
  - content: "amend mux.feature block 5 preamble (prose-only, not a scenario narrowing)"
    status: completed
  - content: "add CLI --env scenarios; bind the prefix fallback + no-command warning"
    status: completed
  - content: "spec gate: freeze touched .feature, ledger gate line, status write"
    status: completed
  - content: "deliver: --env on three verbs, envHonored reported, verification per scenario"
    status: in_progress
  - content: "rebase onto main, impl gate, changeset (published package, user-facing)"
    status: pending
  - content: "handoff: PR with Closes #19, drain follow-ups"
    status: pending
---

# CR 19 — `--env` on every verb that opens a pane

Issue #19 filed this as "herdr's worktree verbs drop env silently". The real gap is wider:
**there is no `--env` flag anywhere in the CLI**. The seam and both adapters carry `env`
natively at every tier; a layout template's pane is the only thing that can set it. That is
why `--env` reads as welded to `--layout`.

## Scope (decided with requester — do not relitigate)

- `--env KEY=VALUE` (repeatable) on `open`, `worktree add`, `worktree open` — one flag, one meaning.
- **Drop policy** on herdr's bind route: prefix `env K=V` onto `--launch` when a command exists,
  warn on stderr when it does not. Reuses the existing fallback rather than inventing a second
  policy. **Not** refuse — identical flags succeeding on tmux and failing on herdr is the backend
  leak the seam exists to prevent.
- Requester chose to **bind the prefix fallback** (it is live but unfrozen, and `--env` makes it
  load-bearing) and to **amend block 5's preamble** honestly.

## Established this session (do not re-probe)

- Live herdr 0.7.4: `worktree create` takes `[workspace, cwd, branch, base, path, label, focus,
  json]` and rejects `--env` ("unknown option: --env"); `worktree open` likewise. Only `pane split`,
  `workspace create`, `tab create` take `--env KEY=VALUE`. Comments at `session.herdr.ts:440`/`:460`
  are accurate.
- Upstream request filed asking for env on herdr's worktree verbs. If accepted the fallback becomes
  dead code — note it, but **do not design around an unmerged request**.
- The drop bites **one cell**: on herdr only `--at workspace` binds and loses env. `--at pane`/`--at
  tab` falls back to `git worktree add` + `open()`, where env is native and lands.
- `mux.feature` and `layout.feature` are `@frozen` **at Feature level** — every scenario frozen by
  inheritance, no scenario-level tags.

## Freeze findings (shape the touch set)

- `mux.feature:261` "herdr's worktree verbs cannot set env at birth, and drop it rather than
  failing" pins only `Then no env flag reaches herdr's worktree command`. The prefix rides in via
  `submit` (herdr `pane run`), **not** the worktree command — so the Then stays literally true and
  the prefix is **additive; freeze self-clears**. Its title goes half-stale; retitling would be a
  narrowing needing a ratified re-open. Prefer adding sibling scenarios and leaving 261 alone.
- `mux.feature:142-146` block 5 preamble asserts the seam is reached "not through a CLI flag".
  `--env` falsifies it. **Prose, not scenario content** — a comment edit yields zero
  added/modified/removed scenarios, so it is not a narrowing and needs no re-open. Verify
  structurally at the gate (`classify-edit-class.mts`), do not assert.
- The env-prefix fallback is **unfrozen implementation**: `layout-session.ts:173` (`envPrefix`),
  `:161` (`shellQuote`), `:681-693` (the `needsEnvPrefix` branch + warning). `cli.test.ts:1075`
  tests it but its title is implementation-voiced, so it **binds to nothing**.

## Open architecture question (for explore)

`envPrefix` lives in `layout-session.ts`, but `worktree add --env --launch` with **no** `--layout`
needs the same prefix outside the layout tier. Either lift it to a shared module or route the
worktree verbs through the one engine both converge on. CR 14's lesson is directly on point: a
behavior bound on ONE route and silently false on the other is this project's recurring defect.

## Ownership boundary

`mux/mux.feature` owns what env **means** at the seam; `layout/layout.feature` owns what a
**template** does with it (`layout.feature:389-396` states this). CLI-surface scenarios are a third
altitude — placement is an explore decision.

## NEXT

**Spec gate PASSED** (status: approved, both features frozen, ledger seq:2). Seven judge rounds;
final round oracle+builder PASS, one architect blocker fixed. Now in **deliver**.

Build to keep against the frozen suite:
1. Lift `envPrefix`/`shellQuote` out of `layout-session.ts` into a shared module (seam-adjacent),
   with the fallback RULE (honored ? prefix : warn) as ONE function both the CLI worktree route and
   the layout walk call. This is the structural fix — do NOT wire compensation per route.
2. `--env KEY=VALUE` (repeatable, collector) on `open`, `worktree add`, `worktree open` via a shared
   `ENV_OPTION` in `cli-options.ts` (like `AT_OPTION`/`LABEL_OPTION`). Reject malformed before any
   side effect. `.conflicts('layout')` on the two verbs that carry `--layout`. `--env` implies
   `--at workspace` on `worktree add`.
3. `openExistingWorktree` takes an `env` param today it lacks; thread it through.
4. `reportOpenedWorktree` warns on `envHonored: false` (the asymmetry with `degraded`).
5. One verification per frozen scenario (16 new + the modified bare-add).
6. Rebase onto main, impl gate, changeset (published package, user-facing).
