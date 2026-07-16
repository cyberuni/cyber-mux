@frozen
Feature: layout — named, reusable pane layouts
  A template names a pane pool once — geometry, a startup command, an environment per pane — and
  re-targets it at a directory supplied at apply time. Nothing about the target is ever in the
  template.

  # ── Resolving a template by name ──
  # Three sources, repo before user, resolved from the primary checkout so every worktree agrees.

  Scenario: --file skips resolution entirely
    Given a caller running cyber-mux layout show --file ./scratch/pool.json
    When the template is resolved
    Then the file at that path is the one read
    And neither the repo nor the user layouts directory is consulted

  Scenario: a repo template shadows a user template of the same name
    Given a repo layouts directory containing pool-4.json
    And a user layouts directory also containing pool-4.json
    When cyber-mux layout show pool-4 runs
    Then the repo template is the one shown
    And cyber-mux layout list reports the user pool-4 as shadowed

  Scenario: a user template resolves when the repo has none of that name
    Given a repo layouts directory with no scratch.json
    And a user layouts directory containing scratch.json
    When cyber-mux layout show scratch runs
    Then the user template is the one shown
    And cyber-mux layout list reports its source as user

  Scenario: the repo layouts directory resolves through the primary checkout, not the caller's cwd
    Given a caller inside a linked worktree whose branch predates pool-4.json
    And the primary checkout carries .cyber-mux/layouts/pool-4.json
    When cyber-mux layout show pool-4 runs
    Then the primary checkout's template is resolved
    # reading ./.cyber-mux relative to the caller's cwd reports not-found here — the worktree's own
    # checkout predates the file. Resolving through resolvePrimaryRoot gives one canonical answer.

  Scenario: a name that resolves nowhere lists the directories searched
    Given no pool-9.json in either the repo or the user layouts directory
    When cyber-mux layout show pool-9 runs
    Then it exits 1
    And the error names both directories it searched

  Scenario Outline: a name that is not a plain stem is refused before any file is read
    Given a caller running cyber-mux layout show "<name>"
    When the name is validated
    Then it exits 1
    And no file is read

    Examples:
      | name             |
      | ../../../etc/pwd |
      | pool/../../out   |
      | Pool-4           |
      | -pool            |
      | pool_4           |

  Scenario: a template whose name field disagrees with its filename stem fails validation
    Given a repo template pool-4.json whose name field is "pool-3"
    When cyber-mux layout validate pool-4 runs
    Then it exits 1
    And the error names both the filename stem and the name field
    # the redundancy is the point: a copied file that kept its old name fails loudly

  # ── The tree, and no cwd in it ──
  # The single rule the capability exists to enforce, plus the schema's other refusals.

  Scenario: a template that sets cwd fails validation naming --cwd and dir
    Given a template whose root.first pane node carries a cwd field
    When cyber-mux layout validate runs
    Then it exits 1
    And the error names the JSON path root.first.cwd
    And the error names --cwd as the apply-time option and dir as the subdirectory field
    # a hard error rather than an ignored key is what keeps a template reusable

  Scenario Outline: dir must be a relative subdirectory that cannot escape the target
    Given a pane node whose dir is "<dir>"
    When the template is validated
    Then it exits 1 naming that pane's JSON path

    Examples:
      | dir                     |
      | /etc                    |
      | ../sibling              |
      | packages/../../outside  |

  Scenario: a relative dir under the target is accepted
    Given a pane node whose dir is services/api/logs
    When the template is validated
    Then it exits 0

  Scenario Outline: a degenerate or out-of-range ratio is a mistake, not an intent
    Given a split node whose ratio is <ratio>
    When the template is validated
    Then it exits 1 naming that node's JSON path

    Examples:
      | ratio |
      | 0     |
      | 1     |
      | -0.5  |
      | 1.5   |

  Scenario: a duplicate label is a validation error because labels are manifest keys
    Given a template with two pane nodes both labeled worker
    When the template is validated
    Then it exits 1 naming the duplicated label

  Scenario Outline: exactly one of root and panes
    Given a template that declares <declares>
    When the template is validated
    Then it exits 1

    Examples:
      | declares               |
      | both root and panes    |
      | neither root nor panes |

  Scenario: every validation error is reported at once, not first-only
    Given a template carrying a cwd field, a duplicate label, and a ratio of 0
    When cyber-mux layout validate runs
    Then all three errors are reported, one per line
    And each names its own JSON path

  # ── Flat-N sugar ──
  # cyber-mux owns the desugaring, so one template means one geometry on every backend.

  Scenario: even-horizontal splits at 1/n then 1/(n-1) so every pane ends the same width
    Given a flat template with 3 panes and arrange even-horizontal
    When it is desugared
    Then the outer node is a right split at ratio 1/3
    And its second child is a right split at ratio 1/2
    And all three panes end equal width
    # splitting evenly at 0.5 each time would yield 1/2, 1/4, 1/4 — a comb, not an even row

  Scenario: even-vertical is the same comb, down
    Given a flat template with 3 panes and arrange even-vertical
    When it is desugared
    Then every split node's direction is down
    And the split ratios are 1/3 then 1/2

  Scenario: tiled balances columns and rows
    Given a flat template with 4 panes and arrange tiled
    When it is desugared
    Then the outer node is a right split at ratio 0.5
    And each half is a down split at ratio 0.5
    And the result is a 2x2 grid

  Scenario: arrange omitted defaults to tiled
    Given a flat template with 4 panes and no arrange
    When it is desugared
    Then the tree is the one arrange tiled produces for 4 panes

  Scenario: n = 1 is legal and produces a single pane with no split
    Given a flat template with 1 pane
    When it is desugared
    Then the tree is that pane alone
    And it carries no split node

  Scenario: the desugared tree is identical on every backend
    Given a flat template with 4 panes and arrange tiled
    When it is applied on tmux and applied on herdr
    Then both backends receive the same splits, in the same order, with the same directions and ratios
    And tmux's own select-layout is never invoked
    # select-layout tiled implements tmux's grid algorithm, which herdr has no equivalent of —
    # using it would give the same template a different geometry per backend

  Scenario: show --desugar prints exactly the tree apply will build
    Given a flat template pool-4
    When cyber-mux layout show pool-4 --desugar runs
    Then the printed tree is the one the walk splits from

  # ── The walk ──
  # Open blank, build geometry depth-first against named panes, launch last.

  Scenario: the region is opened blank and its pane becomes the tree's root
    Given a template whose first pane carries the command claude
    When it is applied
    Then open is called with no launch
    And the pane open returns is the tree's root region rather than a pane to close

  Scenario: geometry is built before any command is submitted
    Given a template with 3 panes each carrying a command
    When it is applied
    Then every split is issued before the first submit
    # splitting a pane already running an interactive agent lands the split mid-render, and
    # computes the ratio against a pane whose child is reflowing

  Scenario: each split names the pane it splits rather than relying on the backend's default
    Given a template whose tree splits a pane created two steps earlier
    When it is applied
    Then that split passes from carrying that pane's id
    And no split relies on the backend's own current-pane default
    # the defaults disagree: herdr's --current falls back to the UI-focused pane, tmux always
    # splits the session's active pane — both track the user, not the caller

  Scenario: commands are submitted last, in template order
    Given a template whose panes carry commands in the order planner, worker-a, worker-b
    When it is applied
    Then submit is called for those panes in that order, after the geometry is built

  Scenario: a pane with no command opens a blank shell
    Given a pane node carrying no command
    When it is applied
    Then the pane is created
    And no submit is issued for it

  Scenario: dir is joined onto the apply-time cwd
    Given a pane node whose dir is services/api/logs
    And an apply whose --cwd is the target root
    When it is applied
    Then that pane opens in the target root joined with services/api/logs

  Scenario: a dir absent from this worktree fails naming the pane and the resolved path
    Given a pane node labeled watcher whose dir does not exist under the target
    When it is applied
    Then it exits 1
    And the error names watcher and the resolved path
    # a branch that predates a directory is a real case

  # ── Ratio and env: degrade, never reject ──
  # The schema is backend-agnostic, so a template's validity cannot depend on the live multiplexer.

  Scenario Outline: the ratio sign convention converts in opposite directions per backend
    Given a split node with ratio 0.333 applied through the <backend> adapter
    When the split is issued
    Then the backend receives <flag>

    Examples:
      | backend | flag          |
      | herdr   | --ratio 0.333 |
      | tmux    | -l 67%        |

    # template ratio is the fraction kept by `first`, the ORIGINAL pane. herdr's --ratio sizes the
    # original, so it passes through unconverted; tmux's -l sizes the NEW pane, so it takes
    # 1 - ratio. Applying the inversion to both backends, or to neither, fails one of these rows.

  Scenario: ratio omitted splits the region evenly
    Given a split node carrying no ratio
    When it is applied
    Then the region is split evenly between first and second

  Scenario Outline: env is set natively on both backends, at the pane's birth
    Given a pane node with env ROLE=worker applied through the <backend> adapter
    When the pane is created
    Then the backend receives <flag>

    Examples:
      | backend | flag              |
      | herdr   | --env ROLE=worker |
      | tmux    | -e ROLE=worker    |

  Scenario: a pane with env and no command is valid and yields a blank shell with the env set
    Given a pane node with env ROLE=worker and no command
    When it is applied
    Then the pane is created with ROLE set in its environment
    And no submit is issued for it
    # a coherent warm pane for something to attach to later

  Scenario: a backend that cannot size a split warns once and takes its own default
    Given a backend with no ratio primitive
    And a template whose splits carry ratios
    When it is applied
    Then every pane the template names is still created
    And exactly one warning is written to stderr
    And stdout stays machine-readable
    # a wrong-looking split is not worth failing an otherwise-correct pool over

  # ── Resolution precedes side effects; apply does not roll back ──

  Scenario: a layout name that resolves nowhere leaves no worktree behind
    Given cyber-mux worktree add --branch feat-x --layout pool-9
    And pool-9 resolves in neither layouts directory
    When the command runs
    Then it exits 1
    And no worktree is created

  Scenario: an invalid template leaves no worktree behind
    Given cyber-mux worktree add --branch feat-x --layout bad-pool
    And bad-pool sets a cwd
    When the command runs
    Then it exits 1 with the validation error
    And no worktree is created

  Scenario: open --layout with an unresolvable name opens nothing
    Given cyber-mux open --layout pool-9
    And pool-9 resolves in neither layouts directory
    When the command runs
    Then it exits 1
    And no region is opened
    # resolution and validation run before any side effect on open too, not only worktree add

  Scenario: a throw mid-walk reports what was built and kills nothing
    Given a 4-pane template whose third split fails
    When it is applied
    Then the panes created before the failure are still open
    And the manifest reports those panes
    And it exits 1
    And no pane is killed
    # a kill is not obviously safer than a half-built layout the caller can see and finish

  # ── --layout, the exact sibling of --launch ──

  Scenario: --layout and --launch are mutually exclusive
    Given a caller running cyber-mux open --layout pool-4 --launch claude
    When the command runs
    Then it exits 1 rejecting the pair

  Scenario: --at defaults to workspace when --layout is given
    Given a caller running cyber-mux open --layout pool-4 with no --at
    When the command runs
    Then the region opens at the workspace placement
    # a fresh space is empty by construction

  Scenario: --label defaults to the template name
    Given a caller running cyber-mux open --layout pool-4 with no --label
    When the command runs
    Then the opened region is labeled pool-4

  Scenario: worktree add --layout applies the template against the worktree root
    Given a caller running cyber-mux worktree add --branch feat-x --layout agent-pool-3
    When the command runs
    Then the worktree's workspace is opened with no launch
    And the walk's cwd is the worktree root
    And the manifest is reported alongside the worktree's root and branch

  # ── The manifest is the handoff ──

  Scenario: --format json reports every pane apply created
    Given a caller running cyber-mux open --layout agent-pool-3 --format json
    When the command runs
    Then stdout carries the layout name, the injected cwd, the workspace, and one entry per pane
    And each entry carries its label, pane id, dir, and command
    # the complete answer to "which panes exist and what are they for" — a dispatcher built on it
    # needs no new cyber-mux surface

  Scenario: the manifest's workspace is null on tmux
    Given a caller running cyber-mux open --layout pool-4 --format json with $TMUX set
    When the command runs
    Then the manifest's workspace field is null
    # matching how reportOpenedWorktree already reports it

  # ── Managing templates needs no multiplexer ──

  Scenario Outline: list, show and validate answer with no multiplexer at all
    Given a caller with neither $TMUX nor $HERDR_ENV set
    When cyber-mux layout <verb> runs
    Then it answers without resolving a session backend

    Examples:
      | verb          |
      | list          |
      | show pool-4   |
      | validate pool-4 |

  Scenario: validate exits 0 on a valid template
    Given a well-formed template pool-4
    When cyber-mux layout validate pool-4 runs
    Then it exits 0
    And stderr is empty

  Scenario: applying with no multiplexer fails through the existing adapter path
    Given a caller with neither $TMUX nor $HERDR_ENV set
    When cyber-mux open --layout pool-4 runs
    Then it throws naming tmux/herdr as the required backend
