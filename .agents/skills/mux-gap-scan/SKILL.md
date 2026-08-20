---
name: mux-gap-scan
description: Use this skill when checking supported multiplexers for new releases, finding seam gaps, surveying multiplexers cyber-mux does not yet drive, and filing gap issues.
metadata:
  internal: true
---

# Multiplexer Gap Scan

Apply when asked to check the latest versions of the supported multiplexers, find what the seam is
missing, survey multiplexers cyber-mux does not yet drive, and file issues — for cyber-mux only.

This skill has **two axes**. Run both unless the request names one:

- **Depth** — new capabilities in the backends already driven (steps 1–8).
- **Breadth** — multiplexers not driven at all that now deserve an adapter (step 9).

## Drivable backends

Derive this list from the filesystem — `ls packages/cyber-mux/src/mux.*.ts` — rather than trusting
the table below, which is a convenience and will rot as backends land. Each adapter maps to one
upstream release source:

| Backend | Adapter source | Upstream releases |
| --- | --- | --- |
| tmux | `packages/cyber-mux/src/mux.tmux.ts` | `gh release list --repo tmux/tmux` |
| wezterm | `packages/cyber-mux/src/mux.wezterm.ts` | `gh release list --repo wezterm/wezterm` |
| zellij | `packages/cyber-mux/src/mux.zellij.ts` | `gh release list --repo zellij-org/zellij` |
| herdr | `packages/cyber-mux/src/mux.herdr.ts` | `gh release list --repo herdrdev/herdr`; else `herdr --version` |
| cmux | `packages/cyber-mux/src/mux.cmux.ts` | `gh release list --repo manaflow-ai/cmux`; docs at cmux.com/docs/api |
| otty | `packages/cyber-mux/src/mux.otty.ts` | docs at docs.otty.sh/reference/cli |

Do **not** scan `screen` — recognized and honored as an override so the value is reported truthfully,
then rejected by name, because it has no stable per-pane identity for driver-created panes (the
`45-screen-adapter` ADR).

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

## Breadth: multiplexers not yet driven

A backend can also be missing entirely. Depth alone never finds one, because a project with no
adapter has no baseline to beat.

9. **Read the verdicts already recorded, before probing anything.** Past sweeps left their findings
   in the ADR log — `packages/cyber-mux/.agents/spec/design/decisions/README.md`, searched for
   `backend-survey`. This is the breadth twin of step 5's dedup search, and it is what stops a sweep
   re-deriving a `no` someone already paid for. A recorded verdict is re-probed only when its own
   recheck trigger has fired:

   - **`undrivable`** — durable. Do not re-probe absent a rewrite of the project's control surface.
   - **`blocked-upstream`** — re-probe when the named missing feature may have landed; the verdict
     records what to look for, so check that, not the whole CLI.
   - **`viable`** — already has an issue. Confirm the issue, do not re-file.

10. **Sweep for candidate multiplexers above 500 stars.** The threshold is a *discovery filter*, not a
   verdict — it is the level at which a project is likely to still exist next year and to have
   documented its CLI. Query GitHub directly rather than recalling star counts, which go stale:

   ```bash
   gh api "search/repositories?q=terminal+multiplexer+stars:%3E500&sort=stars&per_page=15" \
     -q '.items[]|"\(.stargazers_count)\t\(.full_name)\t\(.language)\t\(.description)"'
   ```

   Run it for more than one phrasing — `terminal multiplexer`, `tmux alternative`, `terminal
   workspace panes` — since projects self-describe inconsistently and single-query results are
   incomplete. Drop anything that is not a pane host: editor plugins, themes, remote-control
   front-ends, and terminal emulators with no multiplexing.

11. **Gate each candidate on per-pane CLI drivability, in this order.** Stars decide what to look at;
    these decide what is possible. Read the project's own CLI reference — not its README — and stop
    at the first gate it fails:

    - **Stable per-pane identity, addressable from outside.** A relative selector alone
      (`focused`, `main`, `next`) is not identity. This is the gate `screen` fails architecturally,
      and the one zellij only passed at 0.44.
    - **The birth command emits the new pane's id** — `open()` must return an `OpenedPane` with a
      real id. Every current adapter gets it from the create command itself.
    - **Pane enumeration** — `listPanes` is required, and a listing is also the recovery path when a
      create is silent (the snapshot-before/diff-after shape in `mux.zellij.ts`).

    A candidate failing only the last two is **blocked on additive upstream CLI features**; one
    failing the first is **architecturally undrivable**, like `screen`. Say which — they are very
    different asks, and the second is not worth an issue against this repo.

12. **File a prospective-backend issue per viable candidate**, same confirmation rule as step 6.
    State the star count and date, quote the CLI reference verbatim for each gate it clears or
    fails, and name whether it is blocked upstream or ready to adapt. Label `enhancement`, and add
    `help wanted` where a live binary is needed that this machine cannot run. Footer:
    `*Filed by mux-gap-scan (breadth sweep).*`

13. **Record a verdict for EVERY candidate gated — including the ones you file nothing for.** This
    is the step that makes the sweep cumulative instead of repeated. A candidate that fails gate 1
    gets no issue, so without this its assessment is lost the moment the run ends and the next sweep
    pays for it again.

    Append one section to the ADR log
    (`packages/cyber-mux/.agents/spec/design/decisions/README.md`), which is append-only — add a
    section, never edit an existing one. Match the log's house shape:

    ```markdown
    Decisions (`backend-survey-YYYY-MM` — feasibility verdicts for multiplexers not yet driven):

    - **<project> — VERDICT: viable | blocked-upstream | undrivable | not-a-multiplexer.**
      <stars> stars, probed <date> against <the CLI reference URL, not the README>. Gate 1
      (per-pane identity): <cleared, quoting the selector syntax | failed, quoting what it offers
      instead>. Gate 2 (id at birth): … Gate 3 (enumeration): … <For blocked-upstream: the RECHECK
      TRIGGER — the exact feature whose arrival would change this.> <For viable: the issue URL.>
    ```

    Record the **date and the version or commit probed**, not just the verdict. A verdict without
    them cannot be trusted later, because the thing it describes moves. This is the same
    deliver-tense discipline the adapter headers use for `verified against <version>`.

    Verdicts are descriptive, not gates: recording `undrivable` closes nothing and forbids nothing
    if the project changes. It records what was true, when, and what would have to change.

## Anti-patterns

- Filing an issue for a capability the seam already exposes, or one already tracked — always run the dedup search in step 5.
- Scanning `screen`, or trusting the backend table over `ls packages/cyber-mux/src/mux.*.ts`.
- Treating a wezterm nightly/dated pre-release as the baseline-beating "latest".
- Filing without user confirmation.
- Treating a star count as a feasibility verdict, or recalling one instead of querying it.
- Judging a candidate's drivability from its README rather than its CLI reference.
- Gating a candidate and recording nothing because it failed — a `no` is the verdict most worth
  keeping, since it is the one no issue will preserve.
- Re-probing a candidate whose recorded verdict has no fired recheck trigger.
- Editing an existing ADR section instead of appending a new one.

## References

- create-issue skill — duplicate search and issue authoring.
- Seam contract: `packages/cyber-mux/src/mux.ts`.
- Reference gap issue shape: https://github.com/cyberuni/cyber-mux/issues/97
- Why per-pane identity is the gate: the `45-screen-adapter` ADR in
  `packages/cyber-mux/.agents/spec/design/decisions/README.md`.
