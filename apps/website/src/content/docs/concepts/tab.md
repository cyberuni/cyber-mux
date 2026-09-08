---
title: Tab
description: The tier every multiplexer has between a workspace and a pane — herdr, WezTerm, Zellij, and otty call it a tab, tmux and rmux call it a window, cmux calls it a surface.
---

A **tab** is the middle tier: it holds one or more [panes](/cyber-mux/concepts/pane/) and lives
inside a [workspace](/cyber-mux/concepts/workspace/) where the backend has one. Unlike the workspace
tier, which only some backends have, **every multiplexer has a tab tier** — so cyber-mux can always
report which tab a pane landed in, and never has to report it absent.

## "tab" on herdr and Zellij, "window" on tmux, "surface" on cmux

The tier is universal; the name is not. [herdr](/cyber-mux/multiplexers/), WezTerm, Zellij, and otty
call it a **tab**; tmux and rmux call it a **window** — a tmux window *is* its tab (cyber-mux reads
its id as `#{window_id}`); cmux calls it a **surface**, the terminal unit inside one of its panes. cyber-mux uses the neutral word "tab" for all of them, so the same command means the
same thing whichever multiplexer you are inside.

Because tmux and rmux have nothing above their window, that window doubles as both tiers at once: with no
workspace level to sit under, `workspace` and `tab` placements **both collapse to a new window**.
That is why [`open --at workspace`](/cyber-mux/cli/open/) and `open --at tab` behave identically on
tmux and differently on herdr/WezTerm. Zellij's two placements also collapse to the same outcome — a
new tab — but for the opposite reason: it *has* a session tier above the tab, cyber-mux just has no
session-crossing pane target to reach it with; see [Workspace](/cyber-mux/concepts/workspace/).

## As a placement

`tab` is one of the four placements [`open`](/cyber-mux/cli/open/) accepts, and the **default** when
`--at` is omitted. It adds a new tab inside the caller's current space rather than opening a separate
one the way [`workspace`](/cyber-mux/concepts/workspace/) does.

| Placement   | herdr / WezTerm | tmux / rmux  | Zellij       | cmux            | otty         |
| ----------- | --------------- | ------------ | ------------ | --------------- | ------------ |
| `tab`       | a new tab       | a new window | a new tab    | a new surface   | a new tab    |
| `workspace` | a new workspace | a new window | a new tab    | a new workspace | a new window |

Every `open`, whatever its placement, reports the `tab` its new pane landed in — a new tab reports
itself, a created workspace reports its **root tab**, and a `pane:*` split reports the tab of the
pane it split. That tab id is addressable, which is what makes naming it portable across backends.

## Naming a tab

Open a tab with a name by passing [`--label`](/cyber-mux/cli/open/) — on tmux that becomes the window
name, on herdr/WezTerm/Zellij the tab's name (see `open`'s label table). Where a backend has no
workspace tier, a tab's *display* name may be a composed `<workspace> - <tab>`, but its **own** name
is stored and reported separately, never split back out of the composed string.

## Where tab shows up

- [`open --at tab`](/cyber-mux/cli/open/) — open a new tab (the default placement); a new window on
  tmux.
- [`focus`](/cyber-mux/cli/focus/) — beams the attached client to a pane *across* workspace and tab.
- [`template save --workspace`](/cyber-mux/cli/template/) — captures one region per live tab of the
  workspace.
- [Multiplexers](/cyber-mux/multiplexers/) — how each backend names and nests the tier.
