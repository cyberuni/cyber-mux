---
name: mux-gap-scan
description: Use this skill when checking supported multiplexers for new releases, finding seam gaps, and filing gap issues.
metadata:
  internal: true
---

# Multiplexer Gap Scan

Apply when asked to check the latest versions of the supported multiplexers, find what the seam is
missing, and file issues — for cyber-mux only.

## Drivable backends

Scan these four; each maps to one adapter and one upstream release source:

| Backend | Adapter source | Upstream releases |
| --- | --- | --- |
| tmux | `packages/cyber-mux/src/mux.tmux.ts` | `gh release list --repo tmux/tmux` |
| wezterm | `packages/cyber-mux/src/mux.wezterm.ts` | `gh release list --repo wezterm/wezterm` |
| zellij | `packages/cyber-mux/src/mux.zellij.ts` | `gh release list --repo zellij-org/zellij` |
| herdr | `packages/cyber-mux/src/mux.herdr.ts` | `gh release list --repo herdrdev/herdr`; else `herdr --version` |

Do **not** scan `screen` (recognized, not drivable — no stable per-pane identity) or `cmux` (a
proposed backend, tracked in an open issue, not yet an adapter).

## Workflow

1. **Read the baseline version per backend.** The version each adapter is verified against lives in
   code comments — `grep -nE 'verified against|Requires|≥|[0-9]+\.[0-9]+\.[0-9]+' <adapter source>` —
   and in `apps/website/src/content/docs/multiplexers.md`. Record the highest verified version per
   backend as its baseline.

2. **Resolve the latest upstream release per backend** from the release source above. Prefer the
   latest **stable** tag (skip pre-releases/nightlies for wezterm; take the newest dated stable). For
   herdr, if the GitHub repo is unreachable, fall back to the locally installed `herdr --version`.

3. **Skip backends where latest ≤ baseline** — no gap to file. Report them as up to date.

4. **For each backend where latest > baseline, read the changelog between the two versions**
   (`gh api repos/<owner>/<repo>/releases`, or the repo's `CHANGELOG.md`). Extract every new or
   changed **pane-control** capability: new CLI verbs, new flags, newly addressable surfaces,
   per-pane state feeds, or behavior changes to a capability the seam already normalizes.

5. **Map each candidate against the seam** (`packages/cyber-mux/src/mux.ts` — the `MuxAdapter`
   contract and its capability interfaces). A candidate is a **gap** only when all hold:
   - the seam exposes no method for it;
   - it is not already covered by an open or closed issue (`gh issue list --state all --search "<keyword>"`);
   - it is a capability cyber-mux would plausibly adopt, not a backend-internal detail.

   Classify each gap by normalization altitude, mirroring issue #97:
   - **real-everywhere** — every backend can realize it (native or by polling an existing read); belongs on the seam as a shared primitive.
   - **backend-specific** — only one backend can know it (e.g. a derived agent state); belongs on a capability interface that other adapters refuse by name.

6. **Confirm the gap list with the user before filing** — issue creation is outward-facing. Present
   the classified list; file only what they approve, or all of it if they said to proceed.

7. **File one issue per approved gap** via the **create-issue** skill (it dedupes before filing).
   Match the repo's issue shape from #97: a `## Proposed` section (the seam signature + how each
   backend realizes it), and a normalization-altitude note stating real-everywhere vs
   backend-specific-refuse. Label `enhancement`. End the body with an italic
   `*Filed by mux-gap-scan against <backend> <latest>.*` footer.

8. **Report a summary table**: backend, baseline → latest, gaps found, issues filed (with URLs),
   gaps skipped (already tracked or declined).

## Anti-patterns

- Filing an issue for a capability the seam already exposes, or one already tracked — always run the dedup search in step 5.
- Scanning `screen` or `cmux`.
- Treating a wezterm nightly/dated pre-release as the baseline-beating "latest".
- Filing without user confirmation.

## References

- create-issue skill — duplicate search and issue authoring.
- Seam contract: `packages/cyber-mux/src/mux.ts`.
- Reference gap issue shape: https://github.com/cyberuni/cyber-mux/issues/97
