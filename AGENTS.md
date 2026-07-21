# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

`cyber-mux` is a standalone CLI for **cross-multiplexer pane control** — one contract
(`SessionAdapter`) over terminal multiplexers (tmux, herdr), with detection, pane identity, git
worktree, and turn-taking (nudge) helpers. It is the mux seam extracted from `cyberlegion`, focused
solely on driving panes across multiplexers.

- **scripts:** repository scripts are in `package.json` such as `test` and `verify`
- **toolchain:** node and pnpm are pinned in `mise.toml`; run `mise install` to get them

## Commit Discipline

- **Unit of work:** one complete, reviewed, coherent, independently revertable change
- **Auto-commit rule:** commit a unit of work automatically
- **Message format:** Conventional Commits, enforced on every commit by commitlint. Case and length
  rules are relaxed; type and structure are not
- **Staging:** stage only the files belonging to the unit of work. A pre-commit hook formats staged
  files with biome and re-stages them, so expect the commit to include those rewrites
- **Before push:** tests run automatically on pre-push; a red suite blocks the push
- **Releases:** user-facing changes to the published `cyber-mux` package need a changeset. The
  `website` app is excluded from versioning and never needs one

## Delegation

Before starting work, classify whether an independent, bounded part can be completed by a cheaper
agent. Proactively delegate mechanical edits and focused analysis to the fastest suitable agent;
do not wait for the user to request delegation. Keep judgment and final integration with the
primary agent.

Brief every subagent with the relevant context, why the task is delegated, its exact scope, what
completion looks like, and whether it may edit files. Subagents may start with an isolated context,
so do not assume they know the parent conversation.

| Task class                   | Capability      | Delegation guidance                                  |
| ---------------------------- | --------------- | ---------------------------------------------------- |
| Mechanical, repetitive work | Fast, low-cost  | Delegate by default                                  |
| Scoped research             | Balanced        | Delegate by default                                  |
| Complex multi-step work     | High reasoning  | Delegate on clear benefit                            |
| Judgment and architecture   | Highest capable | Keep primary unless independent review helps         |

Use the models and agent types available in the active client. These capability tiers are guidance,
not literal cross-provider model names.

In Codex, automatically spawn the project-scoped `fast_worker` agent for bounded mechanical edits
and focused repository analysis, even when parallelism is unnecessary. The primary agent reviews
and integrates its result.

### References

- `commit` / `commit-work` skills — staging, splitting, and message authoring
- `add-changeset` skill — adding a changeset for a published-package change
- `init-commit-discipline` skill — regenerate these rules and hooks

## Architecture

pnpm + turbo monorepo.

**Key directories:**

- `packages/cyber-mux/` — the TypeScript CLI; bundled to `dist/cli.mjs` by tsdown, exposed via `bin/cyber-mux.mjs`
- `apps/website/` — Astro + Starlight documentation site (deployed to GitHub Pages)

**CLI source (`packages/cyber-mux/src/`):**

- `session.ts` — the `SessionAdapter` contract + shared mux types (the seam)
- `session.tmux.ts` / `session.herdr.ts` — the two multiplexer adapters
- `mux-probe.ts` — multiplexer detection (env fast-path + process-ancestry walk) and `currentPane` self-identity
- `backend.ts` — `selectSessionAdapter` (probe → adapter)
- `worktree.ts` — the git-worktree adapter
- `nudge.ts` — send-and-verify-turn-taken helper
- `exec.ts` — the synchronous `Exec` command-runner seam every adapter takes
- `cli.ts` — commander entry; `output.ts` / `cli-options.ts` — shared output + option conventions

**Environment contract:** `CYBER_MUX` (override: `tmux|herdr|screen|none`) and `CYBER_MUX_PANE`
(pane id) form the fast-path; otherwise detection walks the process ancestry, falling back to
`$TMUX` / `$HERDR_ENV` hints.

## Test harness

**Vitest.** Tests are co-located next to source as `*.test.ts`. Adapters are tested with a mocked
`Exec`, so no real multiplexer is required.

## CI

`pull-request` and `release` delegate to reusable workflows shared across the org from
`cyberuni/.github`. Those `uses:` references are pinned to the `@v1` tag — never repoint them to
`@main`, which would make every shared-workflow change land here unreviewed. Breaking changes to the
shared workflows arrive as a new major tag to opt into.

## Validation After Changes

Match validation cost to the change:

- For source code, build or runtime configuration, dependency, or website changes, run:

```bash
pnpm verify   # turbo: build + typecheck + lint + test + biome ci
```

- For changes limited to repository guidance or agent configuration, such as `AGENTS.md`,
  `CLAUDE.md`, or `.codex/`, run `git diff --check` instead. Do not run `pnpm verify`; these files do
  not affect the build or test suite.

## Language

Write all content in en-US (American English spelling).
