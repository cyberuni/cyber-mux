---
cr: 58-split-oversized-nodes
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/58
status: implemented
todos:
  - content: "Run the formation pass; route breadth-vs-depth per node"
    status: completed
  - content: "Record the routing decision on the CR as the split contract"
    status: completed
  - content: "Reconcile the stale backend list in the root spec intro"
    status: completed
  - content: "Split the pane node into detection, placement, driving, lookup, worktree"
    status: completed
  - content: "Split the template node into apply and capture"
    status: completed
  - content: "Rewrite both parent nodes as descriptive capability indexes"
    status: completed
  - content: "Update the root spec capability map for the new unit nodes"
    status: completed
  - content: "Verify: scenario titles identical pre/post, all suites bind, structure clean"
    status: completed
---

## NEXT

Split landed, both capabilities in one PR.

Pane node -> detection (9), placement (60), driving (18), lookup (36),
worktree (23). Template node -> apply (69), capture (33). Both parents are
now descriptive indexes owning no suite.

The verbatim bar held and was checked against the hashes taken before
anything moved: 146 and 102 titles in and out, and every step and example
line identical as a multiset (724 and 426 lines). Git recorded the template
suite move as a rename, which is its own evidence. All seven unit suites are
@frozen and bind to their own scenario maps; the suite check reports OK and
the structure audit reports no blocking findings.

Accepted residual, not an unfinished split: the apply unit remains above the
granularity threshold. The formation pass judged its pipeline coherent and
declined to cut it mid-flow. Recorded as a follow-up.

Also out of scope by decision: down-leveling the two permutation-heavy groups
inside placement. That is depth, and belongs to the scenario-to-test bridge.

## CR

Execute the formation split. One PR for the whole thing, both capabilities.
