@frozen
Feature: cyber-mux worktree — the CLI worktree surface
  The `cyber-mux worktree <verb>` commands — add, provision, open, list, remove, prune — how they
  invoke the worktree seam, default their flags, group a checkout in a workspace where the backend
  binds, and render git's facts into the human table. The surface-independent library contract those
  verbs call lives in ../../mux/worktree/worktree.feature; this suite owns invocation and presentation.

  # ── git worktree helpers — the checkout itself, plain git, no legion/unit-registry concepts ──

  @id:worktree-add-default-path
  Scenario: worktree add defaults the path to the next free library slot beside the primary checkout
    Given a caller running cyber-mux worktree add --branch <branch> with no --path
    When add runs
    Then the worktree is checked out at <parent>/<repo>.worktrees/<repo>-<n>, never nested inside the primary checkout
    And <n> is the lowest slot no worktree of the repo holds and nothing occupies on disk
    # The slot path is the library's (cyber-agentkit/worktrees slotPath), so its prune and
    # reuse recognize the checkout as their own. The older <repo>.worktrees/<branch> naming is left to
    # age out, not adopted (agent-harness#73 item 4).

  @id:worktree-add-explicit-path
  Scenario: worktree add honors an explicit --path
    Given a caller running cyber-mux worktree add --branch <branch> --path <path>
    When add runs
    Then the worktree is checked out at <path>

  @id:worktree-remove-refuses-primary
  Scenario: worktree remove refuses the primary checkout, even with --force
    Given a caller running cyber-mux worktree remove against the primary checkout's own path
    When remove runs
    Then it refuses and removes nothing, regardless of --force

  @id:worktree-remove-tolerates-gone
  Scenario: worktree remove tolerates a worktree already gone from disk
    Given a caller running cyber-mux worktree remove against a path with nothing checked out there
    When remove runs
    Then it succeeds without error and runs no git removal command

  @id:worktree-remove-refuses-dirty
  Scenario: worktree remove refuses uncommitted changes unless --force
    Given a caller running cyber-mux worktree remove against a worktree with uncommitted changes and no --force
    When remove runs
    Then it refuses, naming --force as the way to discard them

  @id:worktree-remove-force-discards-dirty
  Scenario: worktree remove --force discards uncommitted changes without the dirty check
    Given a caller running cyber-mux worktree remove --force against a worktree with uncommitted changes
    When remove runs
    Then it removes the worktree without checking whether it is dirty

  @id:worktree-remove-respects-lease-and-session
  Scenario: worktree remove never removes a leased worktree or one a live agent session works in
    Given a caller running cyber-mux worktree remove, with or without --force, against a worktree the library has leased or a live agent session works in
    When remove runs
    Then it refuses and removes nothing, naming why
    And a workspace bound to that worktree stays open
    # The removal is the library's removeWorktree; --force waives only the dirty check, never a lease
    # or a live session. The caller named the worktree, so its branch need not have landed and it
    # need not sit at a slot path.

  # ── worktree provision — reuse an idle worktree, else create, through the library's acquire ──
  # The verb wires cyber-agentkit/worktrees acquire with its default gates: it reuses one of the
  # library's own slot worktrees that is unleased, idle, clean, and landed, else creates one at the
  # next free slot. A one-shot verb has no later moment to release, so it gives the lease straight
  # back. The CLI cannot inject a predicate or choose a path; a host needing either calls acquire.

  @id:worktree-provision-reuses-free
  Scenario: worktree provision reuses an idle worktree in the pool and reports the reclaim
    Given a caller running cyber-mux worktree provision --branch <branch> with an unleased, idle, clean, landed slot worktree in the pool
    When provision runs
    Then it reuses that worktree rather than creating a new checkout
    And the structured payload reports the action as reused, the worktree {root, branch}, and the recycled worktree's root and prior branch
    And the worktree is handed back unleased
    And it exits 0

  @id:worktree-provision-creates-fresh
  Scenario: worktree provision creates a fresh checkout when the pool holds no reusable worktree
    Given a caller running cyber-mux worktree provision --branch <branch> with no reusable worktree in the pool
    When provision runs
    Then it creates a fresh checkout at the next free slot <parent>/<repo>.worktrees/<repo>-<n>
    And the structured payload reports the action as created, the worktree {root, branch}, and no recycled entry
    And the worktree is handed back unleased
    And it exits 0

  @id:worktree-provision-base
  Scenario: worktree provision --base starts the provisioned branch at the given ref
    Given a caller running cyber-mux worktree provision --branch <branch> --base <base>
    When provision runs
    Then the provisioned worktree's branch starts at <base> rather than the resolved default branch

  @id:worktree-provision-no-predicate-injection
  Scenario: the worktree provision verb offers no predicate injection and no path choice
    Given a caller inspecting the flags cyber-mux worktree provision accepts
    When the caller reads the full flag set
    Then the flags are --branch, --base, and --format, and none of them injects an availability predicate or a path
    And a host that must add its own availability check, or hold the lease, calls the library's acquire directly

  # ── worktree/workspace binding — only the backend that binds can group ──
  # A backend either binds a worktree to a workspace as a first-class record, or has no such concept.
  # That binding is what a multiplexer's UI groups a repo's checkouts by, and it is the ONLY thing a
  # backend contributes here: every other worktree fact is git's, on every backend.

  @id:worktree-add-bare-opens-nothing
  Scenario: a bare worktree add opens nothing, so there is nothing to group
    Given a caller running cyber-mux worktree add --branch <branch> with none of --at, --launch or --env
    When add runs outside any multiplexer
    Then it creates the checkout with plain git and opens no pane, tab, or workspace
    And it reports no pane and no workspace
    And it resolves no backend — with nothing opened, a multiplexer has no part in the answer
    # "Bare" is the absence of every flag that asks for something openable — --env joined that list
    # when it gained the power to ask. The rule is unchanged: an add that asks for nothing openable
    # opens nothing, and it is the ONLY route that works outside a multiplexer at all, since every
    # other one resolves a backend and fails without one.

  @id:worktree-add-launch-defaults-workspace
  Scenario: worktree add --launch defaults the placement to workspace
    Given a caller running cyber-mux worktree add --branch <branch> --launch <command> with no --at
    When add runs
    Then the worktree opens in a workspace — a launch wants its own space, not a pane crowding the caller's
    And workspace is the only placement a backend can bind a worktree to

  @id:worktree-add-env-defaults-workspace
  Scenario: worktree add --env defaults the placement to workspace, for --launch's reason
    Given a caller running cyber-mux worktree add --branch <branch> --env ROLE=worker with no --at and no --launch
    When add runs
    Then the worktree opens in a workspace carrying ROLE=worker
    # Beside --launch's rule rather than in the --env block, because it IS --launch's rule: asking for
    # something IN a pane is asking for the pane, and a reader comparing the two flags finds both here.
    # Without it, `worktree add --env` would stay the pure git operation above, open nothing, and drop
    # the env with nothing to carry it — reintroducing the silent drop this capability exists to remove.

  @id:worktree-add-at-workspace-grouping
  Scenario Outline: worktree add --at workspace groups the worktree where the backend binds
    Given a caller running cyber-mux worktree add --branch <branch> --at workspace with <env>
    When add runs
    Then the worktree opens through the <adapter> adapter and is reported as <grouping>

    Examples:
      | branch     | env                         | adapter | grouping                                      |
      | my-feature | $HERDR_ENV set and no $TMUX | herdr   | bound to a workspace — one call creates both  |
      | my-feature | $TMUX set                   | tmux    | ungrouped — tmux binds nothing, plain git plus a plain open |
      | my-feature | $WEZTERM_PANE set           | wezterm | ungrouped — wezterm has no worktree concept in its CLI at all, plain git plus a plain open |
      | my-feature | $ZELLIJ set                 | zellij  | ungrouped — zellij has no worktree subcommand in its CLI at all, plain git plus a plain open |

  @id:worktree-add-placement-fallback
  Scenario Outline: a placement the binding cannot serve falls back rather than failing
    Given a caller running cyber-mux worktree add --branch <branch> --at <placement> on a backend that binds
    When add runs
    Then the checkout is created with plain git and opened at <placement>
    # A worktree open in a split pane is a complete, useful outcome — just not a grouped one.
    # Refusing would make identical flags succeed on tmux and fail on herdr, which is the backend
    # leak this seam exists to prevent.
    And it succeeds, reporting no workspace rather than refusing
    And the caller is told the placement is what cost the grouping

    Examples:
      | branch     | placement  |
      | my-feature | pane:right |
      | my-feature | pane:down  |
      | my-feature | tab        |

  @id:worktree-add-nonbinding-no-note
  Scenario: a backend that binds nothing falls back without reporting a lost grouping
    Given a caller running cyber-mux worktree add --branch <branch> --at pane:right with $TMUX set
    When add runs
    Then it reports no workspace, and does not claim the placement cost anything
    And no grouping was ever on offer — there is nothing to report about a feature the backend lacks

  @id:worktree-add-lost-grouping-note
  Scenario: the lost-grouping note is a help entry on stdout, not a line on stderr
    Given a caller running cyber-mux worktree add --branch my-feature --at pane:right on a backend that binds
    When add runs and the chosen placement costs the workspace grouping
    Then the worktree report on stdout carries a help entry
    And the help entry names --at workspace as the flag that would have grouped what was opened
    And stderr is empty
    And it exits 0
    # This is how "the caller is told the placement cost the grouping" (above) is realized. Per axi/'s
    # #9 a next move belongs on STDOUT in the payload, not stderr the agent does not read — so the note
    # rides in the worktree report's own help[N]: block ({ message, command }), naming the flag that
    # would have grouped it. The exit stays 0: the worktree opened, just ungrouped. Only emitted when a
    # grouping was actually lost, per #9's omit-when-self-contained rule.

  @id:worktree-label-names-space
  Scenario Outline: --label names whatever --at opened, on every backend
    Given a caller running cyber-mux with --at <placement> --label <name>
    When the command opens the space
    Then <name> is the label of the <herdr tier> on herdr, and the <tmux tier> on tmux
    And a backend that takes the label at birth passes it in the opening call, and one that does not names the space immediately after

    Examples:
      | name    | placement  | herdr tier      | tmux tier   |
      | my-unit | workspace  | workspace label | window name |
      | my-unit | tab        | tab label       | window name |
      | my-unit | pane:right | pane label      | pane title  |

  @id:worktree-label-omitted-default
  Scenario: --label omitted leaves each backend its own default
    Given a caller running cyber-mux with no --label
    When the command opens the space
    Then no name is passed, and the backend's own default label stands
    # worktree add always passes --path to hold the sibling convention across backends, and herdr
    # labels a workspace by the checkout path's basename when given one — using the branch only when
    # it picks the location itself. So branch `feat/deep/name` defaults to a workspace named `name`.
    And a worktree's default label is the checkout path's basename on a backend that derives one from the path

  @id:worktree-open-groups-existing
  Scenario: worktree open groups a worktree that plain git created earlier
    Given a worktree checked out by a bare cyber-mux worktree add, open in no workspace
    When a caller runs cyber-mux worktree open against its path on a backend that binds
    Then the existing checkout opens in a workspace bound to it, and no new checkout is created
    And add-now-group-later is a first-class story rather than a dead end

  @id:worktree-list-reports-workspace
  Scenario: worktree list reports which workspace each worktree is open in
    Given a repo whose worktrees are open in workspaces on a backend that binds
    When a caller runs cyber-mux worktree list
    Then each worktree is reported with the workspace bound to it, and those open in none report no workspace
    And the primary checkout is listed alongside the linked worktrees

  @id:worktree-list-answers-outside-mux
  Scenario: worktree list and remove answer outside a multiplexer
    Given a caller running cyber-mux worktree list or worktree remove with no multiplexer to be inside of
    When the command runs
    Then it answers from git rather than failing — a multiplexer can only add a binding to the answer

  # ── The worktree listing renders git's facts; it never restates them ──
  # A fact worth ONE BIT does not earn a column: a column costs its full width on EVERY row to carry
  # a value only one row differs on. The bit becomes a marker on the column naming the thing the fact
  # is about — the branch for which checkout is primary, the path for the one that vanished — and the
  # marker is HUMAN-surface only: every structured payload keeps the field it was derived from,
  # because that is the surface an agent acts on. The boundary is the SURFACE, not any one --format
  # value, so a later structured default cannot satisfy these scenarios while breaking the rule.

  @id:worktree-list-marks-one-bit-facts
  Scenario: a one-bit worktree fact is marked, never given its own column
    Given a repo whose worktrees include the primary checkout and one whose directory is gone from disk
    When a caller runs cyber-mux worktree list and reads the human table
    Then the primary checkout's branch is marked (*), and the gone checkout's path is marked (gone)
    And a linked worktree's branch carries no marker, the mark being what tells the one row from the rest
    And neither fact spends a column of its own, which would cost every row width to distinguish one

  @id:worktree-list-marks-removable
  Scenario: worktree list answers whether a worktree is still needed, not only whether it is occupied
    Given a repo with a slot worktree whose branch is merged into the default branch, whose checkout is clean, and which nothing is open in
    When a caller runs cyber-mux worktree list and reads the human table
    Then that worktree's branch is marked (removable), meaning its work landed and nothing holds it
    And a worktree failing any one of those carries no marker, the marker being exactly worktree prune's dry-run candidate set
    And the primary checkout is never marked, so the mark and (*) can never appear on one branch

  @id:worktree-list-no-composite-field
  Scenario: the disposability composite is the table's compression, never a field of its own
    Given any worktree the human table marks (removable)
    When a caller runs cyber-mux worktree list asking for structured output in any format
    Then the payload carries merged and dirty as raw fields, exactly as it carries linked and prunable
    And no composite field appears, a consumer composing its own policy from the raw facts instead

  @id:worktree-list-undeterminable-not-removable
  Scenario: an undeterminable disposability signal is never marked (removable) in the human table
    Given a repo whose worktrees include one on a detached HEAD and one whose checkout is gone from disk, and one merged, clean, unoccupied worktree
    When a caller runs cyber-mux worktree list and reads the human table
    Then neither the detached-HEAD nor the gone row's branch is marked (removable) — a signal git could not determine must never render as safe to delete
    And the fully determined merged, clean, unoccupied row still IS marked (removable), so the suppression is the missing signal's alone and not a blanket off
    # The marker demands the POSITIVE facts (merged === true, dirty === false, unoccupied), never the
    # absence of negatives: a predicate written as `merged !== false` would mark a detached HEAD, the
    # exact over-report this guards. The library half — that the signal is absent, not false, and that
    # isWorktreeRemovable never clears such a worktree — lives at the seam in ../../mux/worktree; this
    # is its CLI-rendering consequence, the marker the table must withhold.

  @id:worktree-list-home-shortened
  Scenario: a home-rooted worktree path is shortened to ~ in the human table
    Given worktrees checked out under the caller's home directory
    And one worktree checked out in a sibling directory whose name merely extends the home directory's own name
    When a caller runs cyber-mux worktree list and reads the human table
    Then each path under the home directory renders with that prefix collapsed to ~
    # The prefix is matched at a path BOUNDARY, not as a string prefix: a sibling directory whose
    # name merely starts with the home directory's name is a different location entirely, and
    # rewriting it would report a path the caller cannot cd to. axi/'s #10 owes the same $HOME → ~
    # shortening on the home view, so the two surfaces stay consistent once that one is built.
    And the sibling path is left whole, being a different location rather than one inside home

  @id:worktree-list-marker-not-in-payload
  Scenario: a table marker never reaches a structured payload
    Given any worktree whose row the human table marks or shortens
    When a caller runs cyber-mux worktree list asking for structured output in any format
    Then every fact a marker was derived from is still its own field, carrying git's own value
    And each path is absolute, because a consumer of the payload has to be able to act on it
    And no marker the table added appears anywhere in the payload — a marker shows a fact, and is never the fact

  # ── worktree prune — bulk remove of every (removable) candidate, the gate list marks with ──
  # The candidate set is EXACTLY what `worktree list` marks (removable), so prune and list can never
  # disagree about which worktrees are free. The library's pruneWorktrees decides, over the worktrees no
  # workspace holds. The bare form PREVIEWS — the destructive default must be side-effect-free, so a
  # caller can see what would go — and --force applies it.

  @id:worktree-prune-preview
  Scenario: worktree prune bare previews the removable candidates and removes nothing
    Given a repo with worktrees the same gate worktree list marks (removable)
    When a caller runs cyber-mux worktree prune with no --force
    Then it lists the candidates it would remove and removes nothing
    And the report carries a help entry naming --force as the way to actually remove them
    And it exits 0

  @id:worktree-prune-force-removes
  Scenario: worktree prune --force removes every removable candidate in one call
    Given a repo with worktrees the same gate worktree list marks (removable), and one that fails the gate
    When a caller runs cyber-mux worktree prune --force
    Then it removes exactly the candidates list marks (removable) — the free set — in one call
    And the worktree that fails the gate is skipped, reported with the reason it was kept
    And it exits 0

  @id:worktree-prune-skips-foreign
  Scenario: worktree prune leaves a worktree that is not one of the library's slots
    Given a repo with a merged, clean worktree checked out at a path that is not a library slot, such as <parent>/<repo>.worktrees/<branch>
    When a caller runs cyber-mux worktree prune --force
    Then that worktree is skipped and reported with the reason it was kept
    And it is never marked (removable) by worktree list
