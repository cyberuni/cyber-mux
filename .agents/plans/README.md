# plans — SDD mission plan briefs

Each `<cr-ref>.plan.md` here is the durable handoff for one SDD mission (`sdd:start-mission` /
`pause-mission` / `resume-mission` / `discover-plans`). This file is the **local contract** for
what a *new* brief's frontmatter carries in this repo — it does not apply retroactively; existing
briefs are historical records and are not rewritten to match it.

## Required frontmatter keys

A newly scaffolded brief carries all four, alongside the `todos` list the shared skills already
require:

| Key | Value | Why |
|---|---|---|
| `cr` | the CR ref (matches the filename stem, e.g. `61-plan-brief-keys`) | lets a brief be identified when read out of context, not just by its path |
| `source` | the originating URL or ref (a GitHub issue/PR link, `Council ruling (owner mail …)`) | traces the brief back to why the mission exists |
| `project` | the target project/package slug (e.g. `cyber-mux`, `cyber-mux/mux`) | lets a multi-project scan (or a future cross-repo dispatcher) route the brief without opening it |
| `status` | the mission's dispatch/completion state — see enum below | what `discover-plans` and `pause-mission --approve` read and write |

Without these, `discover-plans` still lists the brief (its shape check only requires a frontmatter
block), but a consumer scanning *by* CR, source, or project sees nothing to match on — and a brief
with no `status` key silently reads as `active` (`discover-plans`'s unset default), indistinguishable
from a genuinely fresh, undispatched mission even when the brief's own `## NEXT` says the work
already landed.

## The `status` vocabulary — pinned

One word per state, used consistently:

| Value | Meaning |
|---|---|
| `active` (or the key absent) | in flight — the default `discover-plans` assumes |
| `approved` | cleared for headless dispatch (`pause-mission --approve`; a human review act only) |
| `implemented` | the mission's work has landed — the **only** finished-state word. Matches the
  same word `spec.md`'s own lifecycle (`draft \| approved \| implemented \| deprecated`) already
  uses for "landed," so one word means "done" everywhere in the corpus. Older briefs also spell
  this `done`; that spelling is retired going forward, not corrected in place. |

## Minimal new-brief template

```markdown
---
cr: <cr-ref>
source: <github-issue-or-pr-url | Council ruling (...) | other durable ref>
project: cyber-mux
status: active
todos:
  - content: <short summary, < 120 chars>
    status: pending
---

## NEXT

<the next concrete action>
```

See `sdd:start-mission` / `sdd:pause-mission` for the rest of the brief-authoring procedure (todo
statuses, the `## NEXT` anchor shape, the safe-to-publish floor for what a brief may reference).
This file only pins the four keys and the `status` vocabulary above it; it does not replace those
skills' procedures.
