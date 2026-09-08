---
'cyber-mux': minor
---

Close the two focus gaps on the `MuxAdapter` seam (#152): `isPaneFocused` can now say "cannot
determine" on every backend, and `opensWithoutStealingFocus` is replaced by the three-valued
`focusOnOpen`.

**`isPaneFocused` reaches its own `undefined`.** The member already returned `boolean | undefined`,
but six of the seven adapters could not actually produce the `undefined` for the case it exists
for — an unanswerable query came back as a confident `false`, which a caller cannot tell from a real
negative.

- **WezTerm gains a real probe.** It used to answer a blanket `undefined` on the claim that the
  backend has no focus primitive. It has one: `cli list-clients --format json` carries
  `focused_pane_id`, measured on `20240203-110809-5046fc22` with a GUI client attached to a headless
  mux server, moving with `cli activate-pane` in both directions. It deliberately does **not** read
  `cli list --format json`'s `is_active`, which is per-tab — measured, three rows reported it `true`
  at once across two tabs and two windows.
- **Zellij stops believing `is_focused`.** That flag is true on more than one record at a time (a
  floating plugin pane and the tiled pane beneath it), so the probe could report `true` for a pane
  the client was not on. It now reads `list-clients`, the same authority the adapter's focus restore
  already used.
- **tmux and rmux** presence-check every `-F` field before comparing any: a short line left the
  active flags `undefined`, and `undefined === '1'` is `false`.
- **cmux and otty** presence-check the focus field, not just the row. Both row shapes are
  source/docs reads, so an absent field is the likeliest way they are wrong.

**`focusOnOpen` replaces `opensWithoutStealingFocus`.** BREAKING for anyone reading that member.
The boolean could not express a backend that moves focus and puts it back, so it called that "no
theft" — which is how Zellij came to declare the same value as tmux while doing something visibly
different. The new member is `'preserved' | 'restored' | 'stolen'`:

| backend | value | why |
| --- | --- | --- |
| tmux, rmux | `'preserved'` | `-d` on every route, and `-t` targets the split directly |
| herdr | `'preserved'` | `--no-focus` on every route, and `pane split --pane` names the anchor |
| Zellij | `'restored'` | its `from` path focuses the anchor, opens, and focuses back |
| WezTerm, cmux, otty | `'restored'` | **new** — every open now reads the focused pane first and restores it |

No backend declares `'stolen'` today, which is #152's acceptance criterion: an open on any backend
either leaves focus alone or deterministically restores it. The restore is spelled once
(`restoringFocus`, exported from the package root alongside the `FocusOnOpen` type), reads before
anything moves, runs in a `finally` so a throwing open cannot leave the caller's view relocated, and
is skipped rather than guessed when nothing reports being focused.

cmux's `--focus false` (#167) and otty's `pane split --no-focus` (#172) are deliberately still not
passed: both are unverified without a Mac, and the restore is correct whether or not those documented
defaults are what ships. Everything stated about cmux and otty here remains a source/docs read —
neither can be driven on Linux CI (#128).
