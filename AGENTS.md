# AGENTS.md

`cyber-mux` is a standalone CLI for **cross-multiplexer pane control** — one contract
(`SessionAdapter`) over terminal multiplexers (tmux, herdr), with detection, pane identity, git
worktree, and turn-taking (nudge) helpers. It is the mux seam extracted from `cyberlegion`, focused
solely on driving panes across multiplexers.

- **scripts:** repository scripts are in `package.json` such as `test` and `verify`
- **toolchain:** node and pnpm are pinned in `mise.toml`; run `mise install` to get them

## Commit Discipline

- **Unit of work:** one complete, reviewed, coherent, independently revertable change
- **Auto-commit rule:** commit a unit of work automatically

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

## Validation After Changes

Always run before committing:

```bash
pnpm verify   # turbo: build + typecheck + lint + test + biome ci
```

## Language

Write all content in en-US (American English spelling).
