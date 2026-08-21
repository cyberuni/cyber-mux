# Design: the cyber-* icon system

**Status:** accepted — `cyber-mux` implements it in `apps/website/`.
**Scope:** the visual mark for the four packages of the ADLC stack — `cyber-mux`, `cyber-truss`,
`cyberlegion`, `cyberfleet`. This document is the family template; each repo carries its own copy of
the two asset files.
**Prior art:** `repobuddy` ships one hand-drawn SVG wired into Starlight as both `favicon` and
`logo`. This system keeps that shape and adds a family rule on top of it.

## 1. Problem

The four packages are one system — an Agentic Development Life Cycle stack — shipped as four
separate repos, four npm packages, and four docs sites. Nothing visual says so. A reader with all
four docs sites open sees four identical blank favicons.

Two failure modes to avoid, and they pull against each other:

- **One identical mark everywhere** makes the family obvious and the packages indistinguishable.
  Four tabs, one icon, no way to tell `cyberlegion`'s docs from `cyberfleet`'s.
- **Four unrelated marks** make the packages distinguishable and hide that they are one system.

## 2. Verdict up front

| Decision | Answer |
| --- | --- |
| Structure | a **shared frame** plus a **per-package glyph**, on one 128×128 grid |
| Frame | two opposed corner brackets — a command reticle. Byte-identical in all four packages |
| Glyph | fills the centered 64×64 slot, and draws the thing the package actually does |
| Color | monochrome. The SVG flips its own fill under `prefers-color-scheme` |
| Files per repo | one self-theming favicon + a light/dark header pair — three files, one drawing (§6) |
| Rejected | a hexagon or other generic "tech" container; per-package brand colors |

The frame is the constant claim — *this is under one command*. The glyph is the variable — *this is
the part that drives panes / holds the lattice / relays peers / sails the fleet*.

## 3. The grid

`viewBox="0 0 128 128"`, inherited from `repobuddy` so the two families render at the same weight.

| Region | Bounds | Rule |
| --- | --- | --- |
| Canvas | `0..128` | |
| Frame bleed | `12..116` | the reticle's outer stroke edge |
| Glyph slot | `32..96` | 64×64, centered. Nothing else may enter it |
| Clearance | ≥ 5 units | the smallest gap between any glyph bleed and any frame stroke |

Glyphs may bleed a few units past the slot for round stroke caps, but never closer than 5 units to a
bracket. That clearance is what keeps the mark legible at 16×16.

## 4. The frame

Two brackets, top-left and bottom-right. Not four — an asymmetric pair reads as a reticle locking
on, and it costs two strokes instead of four, which is what survives a favicon.

```svg
<path class="s" d="M17 47V17h30"/>
<path class="s" d="M111 81v30H81"/>
```

Stroke `10`, `linecap="round"`, `linejoin="round"`. Copy these two paths verbatim; they are the
family, and a repo that redraws them by eye breaks it.

## 5. The glyphs

Each glyph names its package literally. No metaphors that need a caption.

### cyber-mux — panes

A pane split: one full-height pane beside a stacked pair. This is the thing the CLI drives.

```svg
<rect class="f" x="32" y="32" width="28" height="64" rx="5"/>
<rect class="f" x="68" y="32" width="28" height="28" rx="5"/>
<rect class="f" x="68" y="68" width="28" height="28" rx="5"/>
```

### cyber-truss — the lattice

A Warren truss: two chords braced by a triangulated web. `cyber-truss` calls its own concept
*the lattice*, so the mark draws one.

```svg
<path class="s" d="M34 88h60"/>
<path class="s" d="M34 88 49 48 64 88 79 48 94 88"/>
<path class="s" d="M49 48h30"/>
```

### cyberlegion — the peer triad

Three nodes, every pair linked. `cyberlegion` is pure mechanism: sessions reaching each other over
the filesystem, with no server in the middle — so the mark has no hub, only peers.

```svg
<path class="s" d="M40 84 64 38 88 84Z"/>
<circle class="f" cx="40" cy="84" r="10"/>
<circle class="f" cx="64" cy="38" r="10"/>
<circle class="f" cx="88" cy="84" r="10"/>
```

Override the link stroke to `8` on that first path so the nodes stay dominant.

### cyberfleet — the formation

Three sails in echelon, one leading. `cyberfleet` carries ships, missions, and the Council view;
the mark carries the formation, not a single hull.

```svg
<path class="f" d="M64 30 78 58H50Z"/>
<path class="f" d="M42 62 55 88H29Z"/>
<path class="f" d="M86 62 99 88H73Z"/>
```

## 6. Color and theme

Monochrome. One drawing, but **two theming mechanisms**, because the two places the mark lands
answer to different signals.

### The favicon self-themes

Browser chrome follows the operating system, so the favicon carries its own style block and needs no
pair. The style lives inside the SVG, which keeps the file correct anywhere it is embedded — a
readme, a GitHub org avatar — without a wrapper supplying a palette:

```svg
<style>.f{fill:#000}.s{fill:none;stroke:#000;stroke-width:10;stroke-linecap:round;stroke-linejoin:round}@media (prefers-color-scheme:dark){.f{fill:#fff}.s{stroke:#fff}}</style>
```

`.f` is filled geometry, `.s` is stroked. Every glyph in §5 uses one or both.

### The header logo ships as a pair

Starlight switches themes on `data-theme`, and this site defaults to **dark regardless of the OS**.
A single self-theming file therefore fails in a way that is easy to miss: a visitor whose OS is set
to light, reading the dark site, gets a near-black mark on a near-black header. `prefers-color-scheme`
never learns what `data-theme` decided.

So the header takes two files and lets Starlight pick, with the ink hardcoded to the theme's own
title color rather than pure black and white:

| File | Ink | Serves |
| --- | --- | --- |
| `src/assets/logo-light.svg` | `#10111a` | `data-theme="light"` |
| `src/assets/logo-dark.svg` | `#f7f8f8` | `data-theme="dark"` (the default) |

**Any repo pairing a self-theming SVG with a `data-theme` site inherits this bug.** Check it by
loading the site in its non-default theme with the OS set the other way.

### No accent color

Not per package, not at all. A brand color would compete with the glyph for the "which package is
this" job, and it is the half that dies first at favicon size.

## 7. Wiring a repo

Three files, one drawing. Starlight's `logo` takes a path under `src/` it can process and `favicon`
takes one under `public/`; neither can read the other's location, so the favicon is a separate file
even where the artwork is identical.

```js
favicon: "/img/logo.svg",
logo: {
  light: "./src/assets/logo-light.svg",
  dark: "./src/assets/logo-dark.svg",
  alt: "<package name>",
},
```

### The header crop

The favicon uses the full `0 0 128 128`. The header pair crops to `10 10 108 108`.

The outer margin is padding a favicon needs to survive a tab strip. In the header the mark is sized
to a fixed height, so that same margin only shrinks the artwork inside its box. Cropping to the
mark's real bleed edge lets it fill the slot.

### The header gap

Starlight spaces the logo from the title with `--sl-nav-gap` — the content padding variable, sized
for the distance between nav *regions*, not between a mark and the words beside it. At header scale
it reads as two unrelated elements. In `global.css`:

```css
.site-title {
	gap: 0.5rem;
}
```

## 8. Adopting this in the other three repos

1. Copy `apps/website/public/img/logo.svg` from `cyber-mux` — the self-theming favicon.
2. Swap the glyph block for the package's glyph from §5, leaving the two frame paths untouched.
3. Make the header pair from the same glyph: `logo-light.svg` and `logo-dark.svg`, cropped to
   `10 10 108 108`, ink hardcoded per §6. Match the ink to the site's own title colors if they
   differ from cyber-mux's.
4. Add the `favicon` / `logo` config and the `.site-title` gap from §7.

This document lives in `cyber-mux` because that is where the system was first built. It describes
four repos, so it belongs in `cyberuni/.github` once there is a home for cross-repo design there.
