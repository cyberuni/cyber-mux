---
status: implemented
project-path: packages/cyber-mux
name: cyber-mux
approval:
  spec:
    verdict: approve
    by: unional
    cause: dimension
    why:
      floor: "none — behavior-neutral binding pass (CR 83-adopt-scenario-bridge-binding). Added an @id:<slug> tag above every Scenario/Scenario Outline across all 14 frozen suites (281 tags) so tests bind mechanically. Tag additions are additive and narrow nothing, so every frozen suite SELF-CLEARS (structural diff: 281 modified, 0 removed; every changed line a +@id: insertion) — no re-open, no Clearance. The behavioral contract is unchanged from the CLI-surface CR that implemented it (its full verdict lives in that CR's ledger shard + git history)."
      blast: "large but metadata-only — 281 @id: tags across 14 .feature suites + a design/ doctrine note (README + decisions ADR). No spec.md behavioral text changed; no product code."
      novelty: "low — adopts the external SDD scenario-bridge @id: convention (pointer, not restatement); the HOIST rule (a node wrapper must be the first spec: segment) is recorded in the decisions ADR."
      confidence: "high — check-suite clean over all 14 suites with tags present; slugs node-unique; 281/281 tagged, purely additive (parse OK, gherkin diff 0 removed). Self-asserted within the auto-spec leash (ledger seq 2)."
  impl:
    verdict: approve
    by: unional
    cause: dimension
    why:
      floor: "none — no product code and no test assertion changed. Rebound the tests to their scenarios by top-level describe('spec:cyber-mux/<node>') wrappers + @id: leaf titles (+ removal of dead duplicate fixtures left by block relocation). Behavior-neutral: expect() counts and sorted assertion multisets identical HEAD↔now across all 13 touched test files (the two file-level diffs are pure biome reflows)."
      blast: "large but binding-only — 13 test files rebound; 261/281 scenarios BOUND + PASS, 0 FAIL. The 20 unbound are genuine coverage gaps (no test at that node's surface) recorded as backlog follow-ups, not fabricated bindings."
      novelty: "low — mechanical binding, bridge-verified per node."
      confidence: "high — full pnpm verify green (811 + 8 dist tests, biome + typecheck clean); integration bridge 261/281 bound, 0 fail; a cold independent impl-judge APPROVED all four checks (semantic soundness on 45+ sampled bindings, gap legitimacy on all 20, behavior-neutrality, altitude). Ratified by unional."
produced-by:
  spec-producer: sdd:start-mission
  impl-producer: sdd:start-mission
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

**The CLI-surface axis.** A capability is specified along two axes: its **surface-independent
contract** (adapters, resolution, git facts, the library seams — *what the capability guarantees
however invoked*) and its **CLI surface** (the `cyber-mux <verb>` commands, their flags, exit codes,
stdout/stderr split, human-table/text rendering, and the AXI error contract — *how the command line
invokes and presents it*). The contract lives in the capability node ([`mux/`](./mux/README.md),
[`template/`](./template/README.md)); the CLI surface lives in a mirror node under
[`cli/`](./cli/README.md), one `cli/X` per library node `mux/X` (or `template/X`). Separating
**presentation from contract** is the principle — the CLI's flag-parsing, usage errors, output
shape, and rendering have no library equivalent and earn their own home, so a change to how a verb
renders never touches the contract and vice-versa.

A *genuine capability divergence* (worktree's CLI verb takes only the default availability gate while
the library seam takes an injected predicate, cyberuni/cyberplace#360) is **one** reason for the
split but not the only one; clean presentation-vs-contract separation stands on its own. `cli/` is
**not** a layered dumping ground: a `cli/X` node exists **only** as the counterpart to a real library
node, and every scenario it holds must *need the CLI surface* to state (a flag, an exit code, a
rendered marker, an error payload) — a surface-independent guarantee stays in the capability node.

| Node | Owns |
|---|---|
| [`mux/`](./mux/README.md) | the pane abstraction, as five units — [`detection/`](./mux/detection/README.md) (which backend, and what am I inside), [`placement/`](./mux/placement/README.md) (where a pane opens and what `open` reports), [`driving/`](./mux/driving/README.md) (a pane's turn), [`lookup/`](./mux/lookup/README.md) (addressing, focus, listing, the error surface), [`worktree/`](./mux/worktree/README.md) (the library git-worktree seam and its binding) |
| [`template/`](./template/README.md) | named, reusable workspace templates, as two units — [`apply/`](./template/apply/README.md) (resolve a template and walk it into a live pool against a target cwd) and [`capture/`](./template/capture/README.md) (the inverse: read a live workspace and write a template back out) |
| [`cli/`](./cli/README.md) | **the CLI surface** (not a capability) — one mirror node per library node per the CLI-surface axis above, holding that capability's `cyber-mux <verb>` presentation & invocation: [`cli/detection/`](./cli/detection/README.md) (doctor, mode), [`cli/placement/`](./cli/placement/README.md) (open + the `--env`/`--at` flag surface), [`cli/driving/`](./cli/driving/README.md) (send, submit), [`cli/lookup/`](./cli/lookup/README.md) (read, focus, close, list, exists + the shared AXI error contract), [`cli/worktree/`](./cli/worktree/README.md) (the worktree verbs incl. `provision`), [`cli/template/`](./cli/template/README.md) (apply-side & capture-side verbs) — each the counterpart to its library node under [`mux/`](./mux/README.md) or [`template/`](./template/README.md) |
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
| a capability's CLI presentation (a verb, flag, exit code, rendered marker, or error payload) | its mirror node under [`cli/`](./cli/README.md), paired to the capability node; the surface-independent contract stays in the capability node |

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
- **A `cli/X` node holds only what needs the CLI surface; the contract stays in the capability.** A
  scenario lives in `cli/X` when stating it requires a verb, a flag, an exit code, a rendered marker,
  or an error payload; a surface-independent guarantee (an adapter's behavior, a resolution rule, a
  git fact, a library seam) stays in the capability node `mux/X` / `template/X`. Never duplicate a
  contract across both. The AXI error contract (structured error on stdout, per-failure codes,
  exit-code taxonomy, no raw-diagnostic leak) is CLI presentation shared by every verb: it lives in
  [`cli/lookup/`](./cli/lookup/README.md) and the other `cli/` nodes cross-reference it rather than
  restating it.
