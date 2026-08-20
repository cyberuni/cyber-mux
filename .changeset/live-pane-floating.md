---
'cyber-mux': minor
---

`LivePane` now reports whether a pane FLOATS, so a caller can tell a float from a tiled pane after
the open that made it — the read side of the `pane:float` placement.

- `LivePane.floating` is **required**, the only required field on the type beyond `id`/`mux`. Every
  backend can answer, so absence is not one of its states: an optional field would leave a caller
  guessing whether a missing value meant *not floating* or *cannot tell*.
- **tmux** reads `#{pane_floating_flag}` and **zellij** reads `is_floating`, each appended to the
  pane listing the adapter already asks for — no extra command on either.
- **herdr**, **wezterm**, **cmux** and **otty** answer `false` **by construction**: they have no
  floating-pane concept, so every pane they can report really is tiled. Deliberately not a named
  refusal — the *create* side has no truthful pane to hand back and refuses by name, while the
  *read* side has one, which is why this rides `LivePane` rather than a capability object.
- `cyber-mux list --format json` carries the new field per pane; the human table is unchanged.
