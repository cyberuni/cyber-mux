---
'cyber-mux': patch
---

`template save` now explains the command limit in terms of **portability** rather than availability,
and its help text changes accordingly.

The old wording — "no multiplexer can report the command a pane was launched with" — was true as
literally phrased and misleading in effect. Probed against live binaries: herdr 0.7.4's `pane
process-info` returns full argv for a pane's whole foreground tree, and `/proc` reaches the same from
a pid on any backend, so "there is nothing to be had here" was false.

The real reason a capture writes no `command` is that what a backend reports is the **resolved**
command line, not the one that was typed: `nr web dev` comes back as
`node /run/user/1000/fnm_multishells/4223_1784479278417/bin/nr web dev`, a path carrying a uid, a pid
and a timestamp that is dead on the next machine. A template is meant to be checked in and run
elsewhere, and applying one **submits** whatever `command` says — so a wrong one fails by executing
something. Absent beats wrong.

Behavior is unchanged: a capture still records no `command` on any pane. `template save --help` now
also names the two `template edit` calls that fill them in.
