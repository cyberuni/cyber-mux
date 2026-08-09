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
      floor: "none — CR per-adapter-conformance-runner adds a NEW node (conformance/) with a newly frozen suite. No existing frozen scenario was narrowed, rewritten, or deleted, so no Clearance arises. The root spec.md edit is placement-map BODY only (Capability map row, routing row, tie-break) — spec.md is never frozen — and no other node's lifecycle field was touched."
      blast: "medium — one new top-level spec node + its 23-scenario suite, plus the root placement-map registration. No product code, no shipped surface change; the artifact it specifies is an unshipped maintainer script."
      novelty: "medium — introduces a new node KIND to this corpus: a maintainer-only, unshipped, but behavioral tool that deliberately takes no cli/ mirror. Given a declared home (routing-table row + tie-break) rather than left as an undeclared exception."
      confidence: "high — check-suite clean (1:1 scenario-map binding over 23 scenarios); check:features parses all 17 suites; a cold spec-judge on a fresh context returned ALIGNED with oracle/builder/architect all PASS after two grading rounds. The load-bearing no-coverage assumption is spike-measured (a fully-skipped suite reports success:true and exits 0), not assumed. Self-asserted within the auto-spec leash."
  impl:
    verdict: approve
    by: agent
    cause: dimension
    why:
      floor: "none — no frozen scenario narrowed, rewritten, or deleted; the .feature was untouched by the implementation (confirmed by the cold impl-judge via git status). No shipped surface changed: scripts/ is absent from package.json files, so the runner does not enter the published package."
      blast: "medium — one unshipped maintainer script plus its 23-scenario verification, three config includes widened (vitest, tsconfig, scenario-bridge), one package script added, and the test script's redundant `src` positional dropped."
      novelty: "medium — the corpus's first maintainer-only node; the run-vs-projected outcome split (the listing reports skip/gap/runnable and never claims a run outcome it would have to run to know) is the design's one non-obvious idea."
      confidence: "high — a cold impl-judge re-derived all 23 frozen scenarios' oracles independently and approved 23/23 with no blocker; pnpm verify green 8/8 (1014 src + 10 dist tests, biome ci + typecheck clean). The load-bearing no-coverage behavior is verified end-to-end against a real, deliberately-broken multiplexer — tmux on PATH but non-functional reports no-coverage and exits 1 where vitest alone exits 0 reporting success."
produced-by:
  spec-producer: sdd:start-mission
  impl-producer: sdd:start-mission
---

# cyber-mux — the CLI: cross-multiplexer pane control

> Root project spec — the **descriptive** top index for the `cyber-mux` npm package
> (`packages/cyber-mux`). Behaviors live in the capability folders below.

`cyber-mux`: one contract (`SessionAdapter`) over terminal multiplexers (tmux, herdr, wezterm, zellij, cmux,
otty) — detection, pane identity, placement, git worktree, and turn-taking (nudge) helpers — decoupled
from legion (no store/identity/doorbell). Env namespace is `CYBER_MUX` / `CYBER_MUX_PANE`.

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
| [`agent/`](./agent/README.md) | the herdr agent-lifecycle capability — the `AgentLifecycle` wait binding on the `cyber-mux/agent` subpath, and its refusal on every backend without the primitive |
| [`cli/`](./cli/README.md) | **the CLI surface** (not a capability) — one mirror node per library node per the CLI-surface axis above, holding that capability's `cyber-mux <verb>` presentation & invocation: [`cli/detection/`](./cli/detection/README.md) (doctor, mode), [`cli/placement/`](./cli/placement/README.md) (open + the `--env`/`--at` flag surface), [`cli/driving/`](./cli/driving/README.md) (send, submit), [`cli/lookup/`](./cli/lookup/README.md) (read, focus, close, list, exists + the shared AXI error contract), [`cli/worktree/`](./cli/worktree/README.md) (the worktree verbs incl. `provision`), [`cli/template/`](./cli/template/README.md) (apply-side & capture-side verbs), [`cli/agent/`](./cli/agent/README.md) (agent status + wait) — each the counterpart to its library node under [`mux/`](./mux/README.md), [`template/`](./template/README.md), or [`agent/`](./agent/README.md) |
| [`conformance/`](./conformance/README.md) | **a maintainer tool, not a capability of the shipped CLI** — the per-adapter real-boundary verification runner (`scripts/test-adapter.ts`), run by hand on a machine that has a given multiplexer, because CI cannot install them all. Behavioral but unshipped, so it takes no `cli/` mirror node |
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
| a **maintainer-only tool** with a testable surface, run by hand and excluded from the published package | its own top-level folder, `spec-type: behavioral`, suite colocated — and **no `cli/` mirror**, since it has no `cyber-mux <verb>` counterpart to present |

**Tie-breaks.**

- **The output contract is a root file, not a capability folder.** `axi.md` is one document
  describing a convention every command follows, so it owns no capability and gets no folder. It
  keeps `spec-type: reference` and stays verified through the consuming capability's suite, since a
  reference node carries no suite of its own.
- **A maintainer tool gets a top-level folder, but is not a capability of the CLI.** Capability-first
  names top-level folders for what the CLI *does*, and a hand-run verification tool
  ([`conformance/`](./conformance/README.md)) does nothing the CLI does — it is not in the published
  package and a consumer never invokes it. It still earns a top-level folder rather than a home
  inside a capability, because it is *about* every adapter at once and belongs to no single one;
  filing it under [`mux/`](./mux/README.md) would smear a testing concern into the pane abstraction.
  The marker that it is not a shipped capability is that it takes **no `cli/` mirror node** — the one
  structural difference from every capability folder above.
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
