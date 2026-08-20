---
'cyber-mux': patch
---

Refuse a `pane:float` open on **cmux** and **otty** instead of silently substituting a right split.

Both adapters declared they cannot float (no `canFloatPanes`) but never enforced it: `open()`
resolved placement as down-or-right, so `at: 'pane:float'` fell through to a tiled split and was
reported as success — a pane with a real id and none of the property the caller asked for. They now
throw `FloatingPanesUnsupportedError` naming the backend, before any command is issued, the same as
wezterm and herdr.

The CLI was already correct (it checks `canFloatPanes` and refuses before reaching an adapter); the
hole was on the library surface, where a caller holding an adapter calls `open()` directly.
