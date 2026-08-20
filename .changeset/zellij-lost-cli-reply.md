---
"cyber-mux": patch
---

Stop a lost or misdelivered zellij CLI reply from becoming a wrong answer

Zellij 0.44.3 can deliver a `zellij action` reply to the wrong command. Under CPU contention a
command exits 0 having printed nothing, and the payload it should have received arrives on the
stdout of the command issued after it. Reproduced by alternating `new-tab` and `list-panes --json`
forty times on a loaded two-core box: twice in forty, the `new-tab` printed an empty string and the
`list-panes` that followed it printed `27`. Two hundred back-to-back `list-panes --json` calls with
no mutating verb between them lost nothing, so it is the mutating verbs that open the window.

Two of the adapter's answers were wrong in the face of that. An empty reply to `list-panes --json`
was read as an empty session — but a live zellij session always has at least one pane, and reading
zero made every id the adapter resolves fail at once. And the id `new-pane`/`new-tab` printed was
taken on trust, so a stale one could name a pane that had been standing all along and hand the
caller somebody else's pane.

The listing is now re-asked when a read does not come back as a pane array, so `[]` means zellij
answered with no panes rather than that zellij did not answer. And an `open()` reads the listing
before the command as well as after: a reported id is believed only where it names a pane that was
not already there, which closes the phantom guard that `new-pane --direction` needs — the split
prints a plausible id and exits 0 having created nothing when the attached client sits on a plugin
pane. Where the id cannot be believed, a single pane that appeared over the open answers instead, so
an open that genuinely happened is no longer failed for a reply zellij dropped.

An `open()` also no longer resolves to a PLUGIN pane. Zellij loads plugin panes on its own schedule,
so a tab opened by `new-tab` can be carrying one in the same listing as its own initial pane, and
that record can sort first. Caught at the real boundary: an `open()` at `tab` returned `plugin_15`,
an id that exists — so nothing downstream refused it — and the `rename()` after it renamed a pane the
caller never opened. Both `new-tab` and `new-pane` create a terminal pane, so that is what an open
now resolves to.
