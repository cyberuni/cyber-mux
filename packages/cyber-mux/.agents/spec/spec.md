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
      floor: "No floor fires. Edit class verified structurally, not assumed: 50 insertions, ZERO modified or removed lines across mux.feature and mux/README.md — additive-only, so the file-level @frozen self-clears and no re-open was needed. Clearance does not fire: the untouched worktree-list provenance scenarios pin WHOSE facts these are, the new band pins HOW they render — orthogonal aspects, confirmed non-conflicting by two independent cold judges. Compatibility does not fire: package is 0.0.0, nothing shipped. No Conflict."
      blast: "small and spec-only — three added scenarios plus one section comment in mux.feature, one Use Cases bullet and one summary-table row in mux/README.md. This CR proposes no source change; the already-shipped rendering code is its subject, not its target."
      novelty: "low for the ~ half (axi/'s #10 already owes $HOME collapsed to ~ on the home view, making this consistency across surfaces rather than a new idea); moderate for the generalization pinned — a one-bit fact earns a marker on the column it is about rather than a column of its own, and a marker is human-surface only."
      confidence: "high — two cold spec-judge rounds at depth 1, each re-deriving its own oracle. Round 1 failed the builder lens on three underdetermination defects (a Then whose sibling-prefix subject the Given never constructed; the marker glyphs living only in the never-frozen README; the human-vs-structured boundary pinned at the --format json flag rather than the surface, which the corpus's own owed TOON default would have hollowed out). Round 2 independently verified all three fixes real, passed builder, and caught a regression the producer introduced by taking round 1's optional band-placement nit — cleared with an additive section comment. Mechanical checks green (check:features parses both files; the judge's check-spec-state and check-suite reported OK). Self-asserted within the auto-spec leash; lands provisionally in the async review queue: ratify or kick back."
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "none at the impl gate. This is a BACKFILL and is recorded as one rather than dressed as build-to-contract: the three rendering commits landed on the branch before any spec covered them. The scenarios were written to observable behavior and then checked against it — none names a helper, module, or call shape."
      blast: "small — no source change in this CR. The behavior verified is the already-landed rendering work: cli.ts's worktree-list column set and output.ts's tildify helper."
      novelty: "low — verification only, over an already-green suite."
      confidence: "high — every frozen scenario has a real verification in the shipped suite, checked one by one rather than in aggregate. Scenario 1 (marker not column): the cli.test.ts case asserting the primary renders marked, a linked worktree does not, and no LINKED header remains, plus the vanished-checkout case. Scenario 2 (~ shortening, boundary-matched): the cli.test.ts home-rooted case plus output.test.ts's five-case boundary set including the sibling-prefix near-miss and the root-home edge. Scenario 3 (no marker in a structured payload): both JSON cases, asserting the booleans survive, the path is absolute, and the branch field carries no marker text. 179 tests green across the two touched files; pnpm verify 7/7 turbo tasks green. No dedicated cold impl-judge for a spec-only CR whose subject is an already-verified implementation; self-asserted within the auto-spec leash."
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
