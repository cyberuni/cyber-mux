---
todos:
  - content: "Fix stale send/submit docs in commands.md and mux-seam.md"
    status: completed
  - content: "Document --env flag on open/worktree add/worktree open"
    status: completed
  - content: "Add layout concept page + CLI reference (layout list/show/validate/save)"
    status: completed
  - content: "Add AXI / output-contract reference page"
    status: completed
  - content: "Add worktree concept page (binding vs git-facts split, degrade rules)"
    status: completed
  - content: "Fix mux-seam.md contract table (missing rename/group/canSizeSplits/describe*)"
    status: completed
  - content: "Fix workspace placement description (visible Window, not detached session)"
    status: completed
  - content: "Update sidebar (astro.config.mjs) with new pages"
    status: completed
  - content: "Update introduction.md / index.mdx to mention worktree + layout"
    status: completed
  - content: "Remove stale 'provisional' banner in commands.md"
    status: completed
---

## NEXT
Done. website build/typecheck/lint + cyber-mux test suite (602) all green via
`turbo run build typecheck lint test --filter=website --filter=cyber-mux`. The
repo-wide `pnpm verify` still fails on a pre-existing, unrelated biome-format
issue in the untracked `.github/setup-state.json` (present before this CR
started) — not touched here.

## CR
website-doc-sync — align apps/website/src/content/docs/** with the current
packages/cyber-mux/.agents/spec/** (status: implemented) and actual CLI source
(no prior spec exists for `website` itself; this CR is prose/reference-only,
tracked per resolve-tracking, targeting the cyber-mux project's docs).

Drift found (Explore agent pass):
- send/submit docs describe a removed verb shape (commands.md, mux-seam.md)
- --env flag undocumented everywhere
- layout command group + concept fully undocumented (no page at all)
- AXI output contract (exit codes, --format, help[N] blocks) has no page
- worktree stdout-vs-stderr degrade note is stale (now stdout structured payload)
- mux-seam.md contract table missing rename/group/canSizeSplits/describeRegion/describeWorkspace
- workspace placement wrongly described as "separate/detached session" (spec says visible Window)
- commands.md banner still says "provisional" though spec status is implemented
- introduction.md/index.mdx omit worktree + layout capabilities entirely
- sidebar (astro.config.mjs) has no nav entries for layout/worktree/AXI
