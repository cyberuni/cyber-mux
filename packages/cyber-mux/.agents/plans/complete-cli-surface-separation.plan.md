---
cr: complete-cli-surface-separation
project: cyber-mux
status: implemented
source: operator kickback of split-worktree-cli-api-surfaces — complete the full CLI surface under cli/
todos:
  - content: "Revise placement-map framing to the CLI-surface axis (consistent, not divergence-only)"
    status: done
  - content: "Separate cli/detection (doctor, mode) from mux/detection"
    status: done
  - content: "Separate cli/placement (open + --env/--at flag surface) from mux/placement"
    status: done
  - content: "Separate cli/lookup (read, focus, close, list, exists + AXI error contract); fill read/close/focus gaps"
    status: done
  - content: "Separate cli/driving (send, submit) from mux/driving"
    status: done
  - content: "Separate cli/template/{apply,capture} from template/{apply,capture}"
    status: done
  - content: "Spec gate over the whole reorg (cold judge, coverage conservation per node); freeze; impl gate for filled verbs"
    status: done
  - content: "pnpm verify, changeset if new verb behavior ships, commit, report"
    status: done
---

## CR

Complete the CLI-surface separation across the whole CLI (operator kickback of the worktree-only
split): one `cli/X` mirror node per library node, holding that capability's CLI presentation &
invocation; the surface-independent contract stays in the capability node. Fill the currently-
unspecified verbs (read, close, focus-action).

Classification is the exploration map (command→node, per-scenario S/C/M). Structure:
- `cli/detection/` ← mux/detection (doctor, mode) — ~3 S scenarios
- `cli/placement/` ← mux/placement (open; the `--env`/`--at` flag surface) — ~14
- `cli/lookup/` ← mux/lookup (read, focus, close, list, exists + the shared AXI error contract) — ~18 + fill read/close/focus
- `cli/driving/` ← mux/driving (send, submit) — ~4
- `cli/template/apply/` + `cli/template/capture/` ← template/{apply,capture} — ~16 + ~13

Rule: a scenario goes to cli/X iff stating it needs the CLI surface (a verb, flag, exit code, rendered
marker, error payload); a surface-independent guarantee stays in the capability node. Mixed scenarios
split. AXI error contract lives in cli/lookup, cross-referenced by the others. Coverage conserved per
node (no dropped/narrowed acceptance).

## NEXT

Fan out per-capability migrations (independent files), integrate, run the spec gate over the whole
reorg with a cold judge checking coverage conservation per node, then the impl gate for the newly
filled read/close/focus verbs (they already exist in cli.ts — backfill to observable behavior).
