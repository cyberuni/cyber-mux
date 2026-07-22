@frozen
Feature: mux worktree — git worktree helpers and the workspace binding
  Plain git worktree add/list/remove, and the binding a backend contributes when a worktree is opened
  in a workspace.

  # ── git worktree helpers — the checkout itself, plain git, no legion/unit-registry concepts ──

  Scenario: worktree add defaults the path to a sibling of the primary checkout
    Given a caller running cyber-mux worktree add --branch <branch> with no --path
    When add runs
    Then the worktree is checked out at <parent>/<repo>.worktrees/<branch>, never nested inside the primary checkout

  Scenario: worktree add honors an explicit --path
    Given a caller running cyber-mux worktree add --branch <branch> --path <path>
    When add runs
    Then the worktree is checked out at <path>

  Scenario: worktree remove refuses the primary checkout, even with --force
    Given a caller running cyber-mux worktree remove against the primary checkout's own path
    When remove runs
    Then it refuses and removes nothing, regardless of --force

  Scenario: worktree remove tolerates a worktree already gone from disk
    Given a caller running cyber-mux worktree remove against a path with nothing checked out there
    When remove runs
    Then it succeeds without error and runs no git removal command

  Scenario: worktree remove refuses uncommitted changes unless --force
    Given a caller running cyber-mux worktree remove against a worktree with uncommitted changes and no --force
    When remove runs
    Then it refuses, naming --force as the way to discard them

  Scenario: worktree remove --force discards uncommitted changes without the dirty check
    Given a caller running cyber-mux worktree remove --force against a worktree with uncommitted changes
    When remove runs
    Then it removes the worktree without checking whether it is dirty

  # ── provision — reuse a free worktree instead of always creating one, the twin of prune ──
  # prune REMOVES every disposable worktree; provision RECYCLES one, through the SAME default gate
  # (isWorktreeRemovable), so the two can never disagree about which worktrees are free. Availability
  # is an injected predicate: the clean/landed/on-disk/unoccupied part is generic git and is the
  # default here, but "no live agent session is attached" is a host concept this seam never knows.

  Scenario: provision reuses a free worktree, resetting it to a pristine tree on a fresh branch
    Given a caller running cyber-mux worktree provision with a pool holding a merged, clean, unoccupied worktree
    When provision runs
    Then it reuses that worktree rather than creating a new checkout
    And it resets it to a fresh branch at base, then reset --hard, then clean -fdx — a pristine tree
    And it reports the action as reused, with the recycled worktree's prior branch and workspace

  Scenario: provision branches a reused worktree from an explicit base
    Given a caller running cyber-mux worktree provision --base <base> with a free worktree to reuse
    When provision runs
    Then the reused worktree's fresh branch starts at <base> rather than the resolved default branch

  Scenario: provision creates a fresh worktree when none is available
    Given a caller running cyber-mux worktree provision with a pool holding no available worktree
    When provision runs
    Then it creates a fresh checkout with plain git and recycles nothing
    And it reports the action as created, with no recycled worktree

  Scenario: provision never reuses an unmerged worktree under the default gate
    Given a caller running cyber-mux worktree provision with a pool whose only free-looking worktrees are unmerged
    When provision runs with the default availability gate
    Then it treats none of them as reusable and creates a fresh checkout instead

  Scenario: provision never hands back a worktree the availability predicate excludes
    Given a host availability predicate that excludes the first candidate because a live session is bound to it
    When provision runs
    Then it skips that worktree and reuses the next free one, never the excluded one

  Scenario: provision never reuses the primary checkout
    Given an availability predicate that would clear every worktree, including the primary checkout
    When provision runs
    Then the primary checkout is filtered out before the gate and is never handed back

  # ── worktree/workspace binding — only the backend that binds can group ──
  # A backend either binds a worktree to a workspace as a first-class record, or has no such concept.
  # That binding is what a multiplexer's UI groups a repo's checkouts by, and it is the ONLY thing a
  # backend contributes here: every other worktree fact is git's, on every backend.

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

  Scenario: worktree add --launch defaults the placement to workspace
    Given a caller running cyber-mux worktree add --branch <branch> --launch <command> with no --at
    When add runs
    Then the worktree opens in a workspace — a launch wants its own space, not a pane crowding the caller's
    And workspace is the only placement a backend can bind a worktree to

  Scenario: worktree add --env defaults the placement to workspace, for --launch's reason
    Given a caller running cyber-mux worktree add --branch <branch> --env ROLE=worker with no --at and no --launch
    When add runs
    Then the worktree opens in a workspace carrying ROLE=worker
    # Beside --launch's rule rather than in the --env block, because it IS --launch's rule: asking for
    # something IN a pane is asking for the pane, and a reader comparing the two flags finds both here.
    # Without it, `worktree add --env` would stay the pure git operation above, open nothing, and drop
    # the env with nothing to carry it — reintroducing the silent drop this capability exists to remove.

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

  Scenario: a backend that binds nothing falls back without reporting a lost grouping
    Given a caller running cyber-mux worktree add --branch <branch> --at pane:right with $TMUX set
    When add runs
    Then it reports no workspace, and does not claim the placement cost anything
    And no grouping was ever on offer — there is nothing to report about a feature the backend lacks

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

  Scenario: --label omitted leaves each backend its own default
    Given a caller running cyber-mux with no --label
    When the command opens the space
    Then no name is passed, and the backend's own default label stands
    # worktree add always passes --path to hold the sibling convention across backends, and herdr
    # labels a workspace by the checkout path's basename when given one — using the branch only when
    # it picks the location itself. So branch `feat/deep/name` defaults to a workspace named `name`.
    And a worktree's default label is the checkout path's basename on a backend that derives one from the path

  Scenario: worktree open groups a worktree that plain git created earlier
    Given a worktree checked out by a bare cyber-mux worktree add, open in no workspace
    When a caller runs cyber-mux worktree open against its path on a backend that binds
    Then the existing checkout opens in a workspace bound to it, and no new checkout is created
    And add-now-group-later is a first-class story rather than a dead end

  Scenario: worktree list reads every worktree fact from git, whatever the backend
    Given a backend that also enumerates worktrees and reports a branch of its own
    When a caller runs cyber-mux worktree list
    Then every reported path, branch, linked, and prunable value is git's answer, not the backend's
    And two backends can never report a different branch for the same worktree

  Scenario: worktree list reports which workspace each worktree is open in
    Given a repo whose worktrees are open in workspaces on a backend that binds
    When a caller runs cyber-mux worktree list
    Then each worktree is reported with the workspace bound to it, and those open in none report no workspace
    And the primary checkout is listed alongside the linked worktrees

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

  Scenario: a one-bit worktree fact is marked, never given its own column
    Given a repo whose worktrees include the primary checkout and one whose directory is gone from disk
    When a caller runs cyber-mux worktree list and reads the human table
    Then the primary checkout's branch is marked (*), and the gone checkout's path is marked (gone)
    And a linked worktree's branch carries no marker, the mark being what tells the one row from the rest
    And neither fact spends a column of its own, which would cost every row width to distinguish one

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

  Scenario: a table marker never reaches a structured payload
    Given any worktree whose row the human table marks or shortens
    When a caller runs cyber-mux worktree list asking for structured output in any format
    Then every fact a marker was derived from is still its own field, carrying git's own value
    And each path is absolute, because a consumer of the payload has to be able to act on it
    And no marker the table added appears anywhere in the payload — a marker shows a fact, and is never the fact

  # ── Is the worktree still NEEDED, not merely free ──
  # The workspace binding answers only whether something is currently HOLDING a worktree. A free
  # worktree is either finished or merely idle, and the listing could not tell them apart. Two more
  # git facts close that: whether the branch's work has landed, and whether the checkout is clean.
  # They compose with the binding into one COMPOSITE the table compresses to a single marker —
  # earning its place by the same rule a one-bit fact does, because the reader's question is one
  # question. The composite is a rendering, never a field: baking it into the payload would freeze
  # ONE policy into the wire format, and a consumer with a different one composes it from the raw
  # facts instead.

  Scenario: worktree list answers whether a worktree is still needed, not only whether it is occupied
    Given a repo with a worktree whose branch is merged into the default branch, whose checkout is clean, and which nothing is open in
    When a caller runs cyber-mux worktree list and reads the human table
    Then that worktree's branch is marked (removable), meaning its work landed and nothing holds it
    And a worktree failing any one of those three carries no marker, the three being one question
    And the primary checkout is never marked, so the mark and (*) can never appear on one branch

  Scenario: the disposability composite is the table's compression, never a field of its own
    Given any worktree the human table marks (removable)
    When a caller runs cyber-mux worktree list asking for structured output in any format
    Then the payload carries merged and dirty as raw fields, exactly as it carries linked and prunable
    And no composite field appears, a consumer composing its own policy from the raw facts instead

  Scenario: the default branch merged is measured against is resolved, never assumed
    Given a repo whose default branch is not named main
    When a caller runs cyber-mux worktree list
    Then merged is measured against the branch the repo actually treats as its default
    # The remote-tracking ref first, because "merged" means landed upstream in the workflow this
    # serves; the primary checkout's own branch when there is no remote to ask, which is the trunk
    # for a local-only repo and costs no extra read.
    And a repo with no resolvable default branch reports no merged verdict rather than a guessed one

  Scenario: a disposability signal git cannot determine is absent, never false
    Given worktrees including one on a detached HEAD and one whose checkout is gone from disk
    When a caller runs cyber-mux worktree list
    Then every worktree is still listed, the missing signal costing a field rather than the listing
    And the undeterminable signal is absent from the payload rather than reported as a negative
    And no such row is marked (removable), because undeterminable must never render as safe to delete

  Scenario: the listing reports disposability and never acts on it
    Given a worktree the human table marks (removable)
    When a caller runs cyber-mux worktree remove against it
    Then the removal applies exactly the gates it always did, consulting no disposability signal
    And nothing about the listing deletes or prunes a worktree of its own accord

  # ── worktree removal ordering — gates before release, release before git ──

  Scenario: worktree remove refuses uncommitted changes BEFORE releasing the workspace
    Given a worktree with uncommitted changes, open in a workspace on a backend that binds
    When a caller runs cyber-mux worktree remove without --force
    Then it refuses, naming --force as the way to discard them
    And the workspace is still open — a refused removal has no side effect

  Scenario: worktree remove releases the workspace before git removes the checkout
    Given a worktree open in a workspace on a backend that binds
    When a caller runs cyber-mux worktree remove and every gate passes
    Then the workspace is closed first, and only then does git remove the checkout
    And no workspace is left pointing at a directory that no longer exists

  Scenario: worktree remove releases the workspace of a checkout already gone from disk
    Given a path with nothing checked out there, still open in a workspace on a backend that binds
    When a caller runs cyber-mux worktree remove against it
    Then the workspace is closed, and no git removal command runs
    And the orphan this prevents — a workspace bound to a checkout that is gone — cannot persist

  Scenario: worktree removal is never delegated to the backend
    Given a backend with a worktree-removal primitive of its own
    When a caller runs cyber-mux worktree remove on it
    Then removal is cyber-mux's own gates plus git, and the backend is asked only to release its binding
    # The backend's own removal addresses a workspace, not a path, so it cannot even reach an unbound
    # worktree — delegating would make a destructive operation's safety depend on whether a workspace
    # happened to be open.
    And the gates behave identically whether or not a workspace is open on the worktree
