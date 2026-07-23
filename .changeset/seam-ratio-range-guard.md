---
"cyber-mux": patch
---

Validate `MuxOpenOptions.ratio` at the seam: a sizing adapter (`tmux`, `herdr`, `wezterm`) now rejects
a ratio outside `0 < ratio < 1` with a named error instead of rendering it into a silently broken split
(above 1 produced a negative length; 0 or 1 gave a whole-region split). The check lives with the size
render (`assertRatioInRange`), so a backend that cannot size a split (`zellij`, which drops the ratio)
is unaffected, and `template`'s schema still refuses a degenerate ratio earlier per node. The range was
already documented as a contract precondition; it is now enforced. Resolves #18.
