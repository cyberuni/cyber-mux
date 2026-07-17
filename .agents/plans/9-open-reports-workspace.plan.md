---
todos:
  - content: Draft mux + layout scenarios and README use cases for open's workspace report
    status: completed
  - content: Spec gate — judge suite/spec, freeze if approved
    status: completed
  - content: Widen SessionAdapter.open to return the workspace the pane landed in
    status: completed
  - content: herdr parses workspace_id on all three routes; tmux reports absent
    status: completed
  - content: openLayout passes the workspace through instead of hardcoding null
    status: completed
  - content: Update tests (tmux/herdr unit + integration, layout-session, cli)
    status: completed
  - content: Impl gate — verify every frozen scenario against live tmux + herdr, pnpm verify
    status: completed
  - content: Changeset + commit + handoff
    status: completed
---

# open reports the workspace a pane landed in

CR (#9): `open --layout --format json` emits a manifest whose `workspace` is always `null`, even on
a backend with a real workspace tier that did open one. Cause: `SessionAdapter.open` returns only a
pane id, so nothing downstream has a workspace to report. Fix: widen what `open` returns.

## Contract

- `open` returns the workspace the pane **landed in** — absent when the backend has no workspace
  tier, following the seam's existing absent-rather-than-false convention (`isPaneFocused`,
  `worktree?`).
- herdr answers on **every** placement, from output it already parses — no extra call:
  - `workspace create` → `result.root_pane.workspace_id` (also `result.workspace.workspace_id`)
  - `tab create` → `result.root_pane.workspace_id` (the workspace the tab was created in)
  - `pane split` → `result.pane.workspace_id` (the workspace the split landed in — the caller's)
- tmux has no workspace tier (`workspace` and `tab` both collapse to a Window), so it always
  reports absent. The frozen scenario "the manifest's workspace is null on tmux" stays true.
- `openLayout` passes it through instead of hardcoding `null`.

## One concept, two relations — settled with the requester

There is **one** workspace concept (the backend's workspace tier). Two different questions are asked
about it, by two **separate outputs**:

- **occupancy** — which workspace a pane/region *lives in*. Every herdr route answers it. This is
  what the layout manifest wants, and what `open` now returns.
- **binding** — whether a worktree is *grouped* to a workspace as a first-class record. Only the
  worktree capability produces it; it stays the worktree report's `workspace` field, untouched.

They are not competing for one field: the worktree report and the layout manifest are distinct
outputs. So no rename, no second manifest field.

## Not in scope

- `worktree add --layout` needs **no** change: it hardcodes the `workspace` placement, so it always
  routes through the binding capability, where the bound workspace already *is* the occupied one.
  There is no degraded-placement case on that route.
- Multi-tab layouts — a template models panes and splits only, with no tab concept. Filed as #14.

## Probe facts (herdr 0.7.4, tmux 3.6b, live)

- The binding is a `worktree` sub-record **inside** the workspace record; `workspace create --cwd
  <checkout>` produces a workspace **without** it. So binding is not inferable from occupancy.
- herdr's `worktree list` reports an `open_workspace_id` for an *unbound* checkout, matching by path
  after the fact — confirming the existing spec note that the list view is misleading and the
  workspace record is the truth. No spec change needed; it is accurate as written.

## NEXT

Landed as PR #15; both gates self-asserted within leash, awaiting ratification. Nothing left to do
here — on merge this plan is retired by the doctrine loop.
