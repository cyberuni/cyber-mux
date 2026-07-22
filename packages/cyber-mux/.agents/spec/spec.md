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
      floor: "Clearance fires and CLEARS across six frozen library suites (detection, driving, lookup, placement, template/apply, template/capture), each re-opened by a relocation-with-conservation — the CLI-surface scenarios move to a new cli/X mirror node, the surface-independent contract stays. Ratified by the operator kickback mandate (complete the CLI surface, not just worktree). Four independent cold spec-judges verified coverage conservation scenario-by-scenario against the HEAD baseline: none lost, none narrowed. cli/lookup adds 4 NEW frozen scenarios for the previously-unspecified read/focus/close verbs, backfilled to observable behavior and confirmed accurate to src/cli.ts. No Conflict. Compatibility inert (package 0.0.0). This supersedes the split-worktree CR's approval, which the operator kicked back as incomplete (that ledger, seq 5)."
      blast: "large but spec-mostly — 6 new cli/X mirror nodes (+ a cli/template index), 6 trimmed library suites, cli/README.md + the root placement-map reframed from a narrow divergence-only exception to a consistent CLI-surface axis. The only source touched is 3 added verb-action tests; no product code changed."
      novelty: "high — generalizes the surface axis corpus-wide: cli/X-mirrors-mux/X becomes the standing pattern, presentation separated from contract for every capability, with worktree's genuine divergence just one instance."
      confidence: "high — 4 cold spec-judges at depth 1, each re-deriving its own oracle. detection+driving ALIGNED (byte-identical moves); lookup ALIGNED (coverage conserved + the 4 backfilled verbs verified accurate to source); template ALIGNED (apply 69->69, capture 33->35, the apply-atomicity and capture-refusal calls judged correct). placement returned architect FAIL on ONE misfiled scenario — the --at-omitted fallback pinned a default the adapter makes, not the CLI — remediated by relocating it to mux/placement re-altituded to the adapter contract (which otherwise had no coverage of its own fallback), re-verified 1:1. Mechanical: check:features 14/14, check-spec-state OK, every suite 1:1 with its map. Ratified by unional after the backlog follow-ups were addressed (mux/README.md rollup synced to the surface split, the corpus-wide `## Logic`→`## Control Flow` heading corrected, the detection Use Cases bullet completed)."
  impl:
    verdict: approve
    by: unional
    cause: dimension
    why:
      floor: "none. The reorg is spec relocation of already-verified behavior EXCEPT the 4 new read/focus/close frozen scenarios. close was already verified (resolution tests assert kill-pane); read (raw bytes to stdout, not the JSON envelope), read --lines (capture-pane -S -n), and focus (switch-client -> select-window -> select-pane, empty stdout) lacked a direct happy-path verification, so 3 tests were added. Every relocated scenario keeps its pre-existing passing verification."
      blast: "small — 3 added verification tests in src/cli.test.ts; no product-code change (read/focus/close already shipped)."
      novelty: "low-moderate — verifications for verbs that shipped without spec coverage."
      confidence: "high — the 3 new tests pass and each falsifies a wrong subject (a JSON-wrapped read, an ignored --lines, a no-op focus); the lookup cold spec-judge independently confirmed all 4 verb scenarios match src/cli.ts and the tmux/herdr adapters. Full suite green under pnpm verify. Ratified by unional."
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
