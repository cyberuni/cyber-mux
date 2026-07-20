---
"cyber-mux": patch
---

Place every tab of a multi-tab template in the workspace the apply opened. Previously only the first tab landed there — each later tab was created beside the pane the command was run from, because a `tab` placement with no anchor is resolved against the workspace the user is looking at. `SessionOpenOptions` gains `within`, the workspace a `tab` placement opens inside, honored by the herdr and WezTerm backends and ignored by tmux, which has no workspace tier.
