---
'cyber-mux': patch
---

`probeMultiplexer` now reports the pane for an otty session discovered through the process-ancestry
route. `paneFor` carried a hand-written list of the muxes with a per-pane env var and `otty` was
missing from it, so an ancestry-discovered otty session answered "no pane" while `$OTTY_PANE_ID` was
set and readable — `currentPane` self-identity silently came back empty. The `$CYBER_MUX` fast-path
was unaffected.

The guard is now a `PANE_ENV` lookup rather than a second list, and `PaneMux` is derived from `Mux`
by subtracting the two muxes that genuinely carry no pane (`screen`, `none`) instead of re-listing
the ones that do — so a new backend cannot be added without either giving it a pane var or excluding
it on purpose. `screen` and `none` still report no pane.
