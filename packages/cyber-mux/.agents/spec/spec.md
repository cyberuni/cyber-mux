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
      floor: "Clearance fires and CLEARS (does not stop). classify-edit-class.mts reports NARROWING — 4 provision Givens modified, 0 added, 0 removed — so mux/worktree/worktree.feature genuinely re-opens; this is not an additive self-clear. The re-open is ratified by the mission mandate (doctrine Scanner strategy candidate 109cb2 seq 5 + the operator brief chartering the frozen-Given re-altitude), which is the async re-open flag, and Clearance is pre-authorized in that CR. Clearance run explicitly all the same: no acceptance is weakened — every When/Then is byte-identical pre-edit, only the Given surface descriptor changed from a nonexistent `cyber-mux worktree provision` CLI verb to the shipped provisionWorktree / WorktreeApi.provision seam. Compatibility inert (package 0.0.0). No Conflict — the ADR settles provision as library-only, so the CLI narration was a one-sided factual error."
      blast: "low — spec-only, one file: 4 Given clauses re-altituded plus one band comment in worktree.feature. No source change (the shipped seam is the subject, not the target); provision scenarios 5-6 opened on a predicate and were already surface-neutral; mux/worktree/README.md carried no CLI-provision claim and needed no edit."
      novelty: "low — no new behavior. The change corrects which surface the already-implemented provision behavior is attributed to; the behavioral contract (reuse / reset-pristine / create / default-gate / injected-predicate / primary-checkout) is unchanged."
      confidence: "high — cold spec-judge at depth 1 re-deriving its own oracle returned PASS on all three lenses (oracle: the re-altituded Givens name a surface that genuinely ships, confirmed against cli.ts / worktree.ts / the worktree-provision ADR; builder: concrete and buildable against the real seam; architect: right altitude, the ADR's own deferral language confirms fix A over fix B). Round 1 caught a producer under-declaration (governances_loaded omitted the oracle-spec/builder-spec bars) — refiled and passed. Round 2 caught and corrected an edit-class mishandling (a stale-mistake self-clear framing) and forced the re-open + explicit Clearance path recorded here; a non-blocking Given-uniformity nit was fixed. Mechanical checks green: check:features parses all 7 features; classify-edit-class confirms Given-only modification. Self-asserted within the auto-spec leash; lands provisionally in the async review queue: ratify or kick back."
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "none at the impl gate. This CR proposes no source change; the provisionWorktree / WorktreeApi.provision seam is already shipped and was impl-gate-verified under the original worktree-provision CR. Because every re-altituded scenario's When/Then acceptance is byte-identical to that already-verified contract, impl-sync is unchanged."
      blast: "small — no source change. The behavior under verification is the already-shipped provisionWorktree seam in src/worktree.ts; only the spec's surface descriptor changed."
      novelty: "low — verification only, over an already-green suite."
      confidence: "high — the frozen provision scenarios' acceptance is verified by 8 passing provision tests in src/worktree.test.ts (reuse-and-reset-pristine, explicit base, create-when-none, never-reuse-unmerged-under-default-gate, skip-predicate-excluded, never-reuse-primary-checkout); `vitest run src -t provision` → 8 passed. No dedicated cold impl-judge dispatched for a spec-only re-altitude whose subject is an already-verified implementation and whose acceptance lines did not change (the #63 precedent); self-asserted within the auto-spec leash."
produced-by:
  spec-producer: sdd:start-mission
---

# cyber-mux — the CLI: cross-multiplexer pane control

> Root project spec — the **descriptive** top index for the `cyber-mux` npm package
> (`packages/cyber-mux`). Behaviors live in the capability folders below.

`cyber-mux`: one contract (`SessionAdapter`) over terminal multiplexers (tmux, herdr, wezterm) — detection,
pane identity, placement, git worktree, and turn-taking (nudge) helpers — decoupled from legion
(no store/identity/doorbell). Env namespace is `CYBER_MUX` / `CYBER_MUX_PANE`.

## Capability map

The placement map — the declared organization. `cyber-mux` is organized **capability-first**:
top-level folders name what the CLI *does*. A new concept routes to the folder whose capability it
serves; rules go to [`design/`](./design/README.md), and a concept enacted across capabilities is
declared in `concept:` frontmatter rather than given a folder of its own.

| Node | Owns |
|---|---|
| [`mux/`](./mux/README.md) | the pane abstraction, as five units — [`detection/`](./mux/detection/README.md) (which backend, and what am I inside), [`placement/`](./mux/placement/README.md) (where a pane opens and what `open` reports), [`driving/`](./mux/driving/README.md) (a pane's turn), [`lookup/`](./mux/lookup/README.md) (addressing, focus, listing, the error surface), [`worktree/`](./mux/worktree/README.md) (the git-worktree surface and its binding) |
| [`template/`](./template/README.md) | named, reusable workspace templates, as two units — [`apply/`](./template/apply/README.md) (resolve a template and walk it into a live pool against a target cwd) and [`capture/`](./template/capture/README.md) (the inverse: read a live workspace and write a template back out) |
| [`axi.md`](./axi.md) | the Agent Experience Interface output contract every CLI command follows |
| [`glossary.md`](./glossary.md) | the ubiquitous language — every load-bearing term defined once |
| [`design/`](./design/README.md) | the rules & model, and the decisions log (append-only, descriptive, ungated) |
| `ledger/` | the provenance — durable audit records; data, outside the node taxonomy |

### Routing table

Where a concept of a given kind goes, plus the tie-break rows for the overlaps the strategy alone
does not settle.

| Concept kind | Home |
|---|---|
| a thing the CLI does, with a testable surface | its own capability folder, `spec-type: behavioral`, suite colocated |
| a cross-cutting rule or model no single capability owns | [`design/`](./design/README.md), descriptive |
| a project-scope decision and its why | [`design/decisions/`](./design/decisions/README.md), append-only |
| a load-bearing term | [`glossary.md`](./glossary.md) — defined once there, referenced everywhere else |
| a shipped artifact with no testable surface of its own, spanning every command | a root file beside this spec, `spec-type: reference` |
| a sub-grouping inside a capability | a `concept:` tag, never a third folder level |

**Tie-breaks.**

- **The output contract is a root file, not a capability folder.** `axi.md` is one document
  describing a convention every command follows, so it owns no capability and gets no folder. It
  keeps `spec-type: reference` and stays verified through the consuming capability's suite, since a
  reference node carries no suite of its own.
- **Backend adapters are not capabilities.** A per-multiplexer adapter (tmux, herdr, wezterm, and
  any future one) is an implementation of the pane abstraction, not a thing the CLI does. It routes
  to [`mux/`](./mux/README.md), never to a folder of its own — one adapter per folder would smear
  the one pane capability across as many folders as there are backends.
- **Worktree behavior routes by what it is about.** The git-facts half is plain repository work and
  lives with the capability that surfaces it; the binding half — what opens, and where — is pane
  placement, so it belongs to [`mux/`](./mux/README.md).
