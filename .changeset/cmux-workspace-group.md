---
'cyber-mux': patch
---

Group cmux workspaces through its real `workspace-group` family instead of dropping the caller's
`workspaceGroup` silently.

`group()` on the cmux adapter was a no-op, justified in the header by "cmux has a real workspace tier
that already groups every surface in it, so there is nothing for this to add". That reasoning is sound
for Pane → Surface and does not reach the tier the flag targets: cmux ships a first-class
`workspace-group` family that groups multiple top-level **workspaces** into a named, collapsible
sidebar section. A caller passing `workspaceGroup` on a cmux `{ at: 'workspace' }` open got nothing
grouped and no error saying so.

It now routes to `workspace-group create` then `workspace-group add`. cmux mints its own group ids, so
the seam's opaque caller-chosen id cannot *be* the group id — it rides `--idempotency-key` (and
`--name`, so the sidebar section carries it too), which makes a repeat call find the existing group
rather than mint a second one. `add` is idempotent, so re-grouping needs no membership pre-check. Only
the `workspace` route groups: a `tab` or `pane:*` open lands in the workspace the caller is already in,
and grouping that would group a space the caller never opened.

**Behavior change worth knowing:** cmux's `workspace-group create` always mints a brand-new *anchor*
workspace, so the first grouping call for a given id adds a visible workspace to the sidebar — a
deviation from the seam's "`group` opens nothing", accepted because the alternative was the silent drop
above and cmux offers no membership-only create. It does not steal focus, and later calls for the same
id open nothing.

No seam member changed — `group()` / `workspaceGroup` was already the right shape; only the adapter was
wrong. Read off cmux's own Swift source (`manaflow-ai/cmux` at `71eb616d`), **not** verified against a
live binary: cmux is macOS-GUI-only, and issue #128 tracks the missing real-boundary suite.
