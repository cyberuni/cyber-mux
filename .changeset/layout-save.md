---
"cyber-mux": minor
---

Add `cyber-mux template save <name>` — capture the live pane region around a pane into a named template, so a pool built by hand once can be named rather than transcribed. This closes the schema's one real authoring cost: a 4+ pane grid needs nested `split` nodes nobody wants to type.

It captures the region around the calling pane by default, or `--from <pane>`'s; writes to the repo's templates directory (`--to user` for your own), refusing to overwrite without `--force`; and prints the written path alone on stdout, so `$(cyber-mux template save pool-4)` composes. Absolute paths never reach the template — a pane under the captured root becomes a relative `dir`, and one outside it loses its directory with a warning.

**A capture recovers geometry, labels and dirs — never commands**, and that limit is structural rather than a gap: no multiplexer reports the command a pane was launched with, because cyber-mux types commands with `submit` rather than passing them to the split. So a saved template is a draft, and it says so in its own `description`. Fill the commands in before applying it.

This adds an optional `describeRegion?` member to the `SessionAdapter` seam — "report this region's geometry", answered as one rectangle per pane, with the split tree derived from those rectangles rather than from any backend's own encoding. Both tmux and herdr implement it; a backend that cannot describe its region refuses `save` rather than degrading.
