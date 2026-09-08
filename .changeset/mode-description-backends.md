---
"cyber-mux": patch
---

`mode`'s own `--help` line said it reports "tmux / herdr / none", three backends behind the seven it
actually resolves. It now names them all, and says it reports the *drivable* backend — which is why a
recognized-but-undrivable mux (GNU screen) answers `none` here while `doctor` still names it.
