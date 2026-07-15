---
"cyber-mux": patch
---

Fix `list` on the herdr backend to report every live pane, including one with no agent/harness running in it. Previously such panes (a plain tab, an extra split, or a blank pane from `open` with no `--launch`) were silently dropped, contradicting `list`'s own "enumerate every live pane" contract.
