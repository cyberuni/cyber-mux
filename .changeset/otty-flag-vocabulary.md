---
'cyber-mux': patch
---

Fix two otty argv shapes that otty's CLI does not accept, and refuse pane-tier `rename` on otty.

`otty open` always opens a new window and documents only `--command` and `--title`; the adapter was
passing a `--new-window` that belongs to the different `otty view`/`otty edit` family, so every
`open({ at: 'workspace' })` died at otty's argument parser. It now issues a bare `otty open` and
names the new window at birth with the documented `--title` instead of renaming a tab afterward.

`otty pane split` takes `--direction <right|left|up|down>`, not a bare directional flag. The adapter
was passing `--right` / `--bottom` — and `bottom` is not a direction otty names at all — so every
`pane:right` and `pane:down` split was broken too. It now passes `--direction right` / `--direction
down`.

otty scopes `rename` to windows and tabs, so `rename(…, 'pane', …)` now throws a named error rather
than issuing a `otty pane rename` that otty rejects and this adapter discarded, and a `label` on a
`--at pane:*` open degrades to a stderr warning — the same trade the WezTerm adapter makes for the
same missing primitive.

Read off otty's published CLI reference, NOT verified against a live binary — otty is GUI-only and
absent from the machine this was written on.
