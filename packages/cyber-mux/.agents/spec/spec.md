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
      floor: "Clearance fires and CLEARS. classify-edit-class reports mux/worktree/worktree.feature MIXED (5 added / 4 modified / 28 removed) — a genuine re-open, ratified by the mission mandate (operator-directed full CLI/API surface split; cyberuni/cyberplace#360). The 28 removed scenarios are RELOCATED to the new cli/worktree/worktree.feature, not deleted: the cold spec-judge verified coverage conservation scenario-by-scenario, every baseline When/Then surviving in exactly one suite (the one dropped CLI-marker-suppression assertion was caught and restored additively before approval). cli/worktree/worktree.feature is a brand-new @frozen suite. No Conflict (no shared-When contradiction). Compatibility inert (package 0.0.0; the new `worktree provision` verb's source + changeset land in the deliver step, status is approved not yet implemented)."
      blast: "medium — a structural split across 5 spec files plus a new surface node (cli/), and a placement-map change adding the surface-axis exception. No source change in this gate."
      novelty: "high — first use of the surface-axis exception to capability-first: a public surface that genuinely diverges from its capability (a CLI verb takes only the default gate; the library seam takes an injectable predicate) earns its own node, the shared contract staying in the capability. A structural precedent, so it lands provisionally for async ratification."
      confidence: "high — cold spec-judge at depth 1, re-deriving its own oracle, returned ALIGNED with oracle/builder/architect all PASS after one remediation round. The architect smear-vs-divergence question PASSED on evidence (zero duplicate assertions across the 42-scenario union; the injectable predicate is a callable a CLI flag cannot express; cli/ holds exactly one node, admission tied to genuine divergence). Two blocking findings were caught and closed additively (a dropped undeterminable-signal marker-suppression assertion, restored as a paired guard+positive CLI scenario; an unbacked prune Use Case, backed with a bare/--force scenario pair). Two earlier rounds were governance pre-flight rejections (producer under-declared the oracle/builder then architect bars) — refiled and passed. Mechanical checks green: check:features 8/8, check-suite OK, check-spec-state OK, cli scenario map 1:1 (31/31). Self-asserted within the auto-spec leash; lands provisionally in the async review queue: ratify or kick back."
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "none at the impl gate. The only new implementation is the `worktree provision` CLI verb (worktreeProvisionCommand in cli.ts), wired over the already-shipped provisionWorktree seam with the DEFAULT gate and no predicate injection — the surface divergence. The relocated CLI scenarios and re-scoped seam scenarios changed spec TEXT only; their behavior and their pre-existing verifications are unchanged, so impl-sync holds for them by the full suite staying green."
      blast: "small — one new CLI verb delegating straight to the seam; no existing behavior touched. src/cli.ts gains worktreeProvisionCommand + its registration; src/cli.test.ts gains 5 verification tests."
      novelty: "moderate — a new shipped CLI verb (`cyber-mux worktree provision`), additive."
      confidence: "high — cold impl-judge at depth 1, re-deriving each oracle independently, returned IMPLEMENTATION_PASS with all 5 frozen provision-verb scenarios carrying a real, falsifiable, passing verification (reuse-and-report-reclaim, create-at-sibling, --base, --path, no-predicate-injection). It confirmed the default-gate/no-injection divergence at SOURCE level (provisionWorktree called with no `available` key → falls through to isWorktreeRemovable), and a clean structural read (CLI-altitude delegation, no seam logic duplicated, no absorption). Full suite 808/808 green post-relocation; typecheck clean. Self-asserted within the auto-spec leash."
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

**Surface-axis exception.** One capability can ship through **divergent public surfaces** — the CLI
and the library API — that expose *different* things (a CLI verb can only use the default gate; a
library seam takes an injected one). When they diverge, a single capability node cannot carry the
per-(capability × surface) contract, so the surface that diverges earns a **surface node** under
[`cli/`](./cli/README.md), the counterpart to its capability node. This is a *sanctioned exception*
to capability-first, not a second organizing axis: it is invoked only where a surface genuinely
diverges (cyberuni/cyberplace#360), and the surface-independent contract stays in the capability
node.

| Node | Owns |
|---|---|
| [`mux/`](./mux/README.md) | the pane abstraction, as five units — [`detection/`](./mux/detection/README.md) (which backend, and what am I inside), [`placement/`](./mux/placement/README.md) (where a pane opens and what `open` reports), [`driving/`](./mux/driving/README.md) (a pane's turn), [`lookup/`](./mux/lookup/README.md) (addressing, focus, listing, the error surface), [`worktree/`](./mux/worktree/README.md) (the library git-worktree seam and its binding) |
| [`template/`](./template/README.md) | named, reusable workspace templates, as two units — [`apply/`](./template/apply/README.md) (resolve a template and walk it into a live pool against a target cwd) and [`capture/`](./template/capture/README.md) (the inverse: read a live workspace and write a template back out) |
| [`cli/`](./cli/README.md) | **surface node** (not a capability) — where a public surface diverges from the capability it draws from, per the surface-axis exception above. Today: [`cli/worktree/`](./cli/worktree/README.md), the `cyber-mux worktree <verb>` surface (verbs, flag defaults, table rendering, and the `provision` verb's default-gate-only invocation), counterpart to the library seam in [`mux/worktree/`](./mux/worktree/README.md) |
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
| a public surface that DIVERGES from its capability's contract | a surface node under [`cli/`](./cli/README.md), paired to the capability node — only when the surfaces genuinely differ |

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
- **A surface node holds only what diverges; the shared contract stays in the capability.** The
  worktree seam's surface-independent guarantees (git owns the facts, removal is never delegated,
  the injectable availability predicate) stay in [`mux/worktree/`](./mux/worktree/README.md); only
  the CLI-specific invocation and presentation (the verbs, flag defaults, the human table, and the
  `provision` verb's default-gate-only behavior) live in [`cli/worktree/`](./cli/worktree/README.md).
  A behavior belongs in a surface node only when asserting it needs that surface — never to duplicate
  a contract the capability node already owns.
