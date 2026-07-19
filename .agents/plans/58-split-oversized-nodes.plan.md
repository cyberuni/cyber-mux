---
cr: 58-split-oversized-nodes
project: cyber-mux
source: https://github.com/cyberuni/cyber-mux/issues/58
status: in-progress
todos:
  - content: "Run the formation pass; route breadth-vs-depth per node"
    status: completed
  - content: "Record the routing decision on the CR as the split contract"
    status: completed
  - content: "Reconcile the stale backend list in the root spec intro"
    status: completed
  - content: "Split the pane node into detection, placement, driving, lookup, worktree"
    status: pending
  - content: "Split the template node into apply and capture"
    status: pending
  - content: "Rewrite both parent nodes as descriptive capability indexes"
    status: pending
  - content: "Update the root spec capability map for the new unit nodes"
    status: pending
  - content: "Verify: scenario titles identical pre/post, all suites bind, structure clean"
    status: pending
---

## NEXT

Formation routed both nodes to breadth. The split boundaries are recorded on
the CR and are the contract for this work.

Pane node → detection (9), placement (60), driving (18), lookup (36),
worktree (23). Template node → apply (69), capture (33). Both partitions are
exhaustive and sum to the current totals exactly.

THE BAR, and it is mechanical: scenarios relocate VERBATIM. That is what makes
the split non-narrowing and therefore legal against a frozen suite. The
pre-split scenario title sets are hashed and held; post-split the union per
capability must match them exactly — 146 and 102, nothing reworded, merged, or
dropped. A rewrite during the move is a narrowing and needs a ratified re-open
instead, which this CR does not have.

Deliberately out of scope: down-leveling the two permutation-heavy groups
inside placement (thirteen outlines over four plain scenarios, and eight over
zero). That is depth, not breadth, and belongs to the scenario-to-test bridge.

## CR

Execute the formation split. One PR for the whole thing, both capabilities.
