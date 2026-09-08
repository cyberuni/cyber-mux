---
'cyber-mux': minor
---

otty can now size a split, and names a new tab at birth.

`otty pane split` documents a `--size` flag, so the otty adapter declares `canSizeSplits: true` and
renders `MuxOpenOptions.ratio` onto it. `--size` is the **new** pane's share, while `ratio` is the
fraction kept by the **original**, so the value is inverted — the same inversion the cmux and WezTerm
adapters already make, and the opposite of herdr's pass-through `--ratio`. otty's unit is a whole
percent over a documented **10–90** range: `ratio: 0.7` becomes `--size 30`, and a ratio that lands
outside the range (`0.95`, a 5% new pane) is clamped into it with a warning on stderr rather than
sent as a size otty rejects, which would fail the split outright.

The previous `canSizeSplits: false` did not merely undercount otty — it gave a reason that was wrong,
implying otty has no sizing verb. The verb it does have that cyber-mux still cannot use is
`pane resize`, which counts cells; `resizePane` stays refused on otty for exactly that reason, and
the adapter now says which is which.

`otty tab new` documents `--title`, so `open({ at: 'tab', label })` names the tab in the creating
call instead of following up with a `rename` — one round trip fewer, and no window in which the tab
carries otty's default name. Same fix the workspace tier already got with `otty open --title`.

Read off otty's published CLI reference, **not verified against a live binary** — otty is a macOS-only
GUI app with no public source, so the coverage is mocked-`Exec` argv assertions.
