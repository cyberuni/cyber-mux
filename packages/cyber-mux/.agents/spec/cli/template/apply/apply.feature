@frozen
Feature: cyber-mux template apply — the CLI apply surface
  How the cyber-mux command line reaches apply: the read verbs (list, show, validate), the
  --template flag that is --launch's sibling and its flag defaults, and the shape of the manifest
  --format json hands back. The surface-independent engine those verbs drive — resolving a template,
  validating it, desugaring the flat form, and walking the tree into live panes and tabs — lives in
  ../../../template/apply/apply.feature; this suite owns invocation and presentation. The exit-code
  contract every verb honors (0 ok, 1 operation failed, 2 usage error) is AXI's, pinned once for the
  whole CLI in ../../lookup/lookup.feature and applied here, not restated.

  # ── The read verbs — list, show, validate ──
  # list, show and validate take a file as their subject, so they answer with no multiplexer present.

  Scenario Outline: list, show and validate answer with no multiplexer at all
    Given a caller with neither $TMUX nor $HERDR_ENV set
    When cyber-mux template <verb> runs
    Then it answers without resolving a session backend

    Examples:
      | verb          |
      | list          |
      | show pool-4   |
      | validate pool-4 |

  Scenario: --file skips resolution entirely
    Given a caller running cyber-mux template show --file ./scratch/pool.json
    When the template is resolved
    Then the file at that path is the one read
    And neither the repo nor the user templates directory is consulted

  Scenario: show --desugar prints exactly the tree apply will build
    Given a flat template pool-4
    When cyber-mux template show pool-4 --desugar runs
    Then the printed tree is the one the walk splits from

  Scenario: validate exits 0 on a valid template
    Given a well-formed template pool-4
    When cyber-mux template validate pool-4 runs
    Then it exits 0
    And stderr is empty

  # ── Applying is --template, the exact sibling of --launch ──
  # There is no `template apply` verb: apply is reached only through open --template and
  # worktree add --template. Both flags answer "what runs in the space you are opening", so they are
  # mutually exclusive and --at defaults to workspace (a fresh space is empty by construction).

  Scenario: --template and --launch are mutually exclusive
    Given a caller running cyber-mux open --template pool-4 --launch claude
    When the command runs
    Then it exits 2 rejecting the pair, a usage error — two flags that cannot both be given is malformed input

  Scenario: --at defaults to workspace when --template is given
    Given a caller running cyber-mux open --template pool-4 with no --at
    When the command runs
    Then the region opens at the workspace placement
    # a fresh space is empty by construction

  Scenario: a tabs template still defaults --at to workspace
    Given a caller running cyber-mux open --template with a tabs template and no --at
    When the command runs
    Then the workspace placement is the one used
    # a fresh space is empty by construction, and a workspace is what a set of tabs needs to live in

  Scenario: --label defaults to the template name
    Given a caller running cyber-mux open --template pool-4 with no --label
    When the command runs
    Then the opened region is labeled pool-4

  # ── The manifest is the handoff (--format json) ──
  # --format json reports every pane apply created plus the workspace and per-pane tab it landed in.
  # The workspace field carries the real answer where the backend has a workspace tier and is null
  # where it does not; tab is the same argument one level down.

  Scenario: --format json reports every pane apply created
    Given a caller running cyber-mux open --template agent-pool-3 --format json
    When the command runs
    Then stdout carries the template name, the injected cwd, the workspace, and one entry per pane
    And each entry carries its label, pane id, dir, and command
    # the complete answer to "which panes exist and what are they for" — a dispatcher built on it
    # needs no new cyber-mux surface

  Scenario: the manifest carries the workspace the region opened in
    Given a caller running cyber-mux open --template pool-4 --format json with $HERDR_ENV set and no $TMUX
    When the command runs
    Then the manifest's workspace field carries the workspace the region opened in
    # The manifest is framed as the complete machine-readable answer to "which panes exist and what
    # are they for" — a consumer grouping panes by workspace needs something to group on. open
    # surfaces the workspace it landed in, so the manifest reports it rather than a flat null.

  Scenario: the manifest's workspace is null on tmux
    Given a caller running cyber-mux open --template pool-4 --format json with $TMUX set
    When the command runs
    Then the manifest's workspace field is null
    # matching how reportOpenedWorktree already reports it

  Scenario: the manifest reports which tab each pane landed in
    Given a tabs template of 2 tabs applied with --format json
    When the manifest is reported
    Then every pane carries the tab it landed in
    And the pane list stays one flat list of every pane apply created
    # the manifest is still the whole handoff — a consumer grouping panes by tab needs something to
    # group on, exactly as it needs workspace to group by space

  Scenario: a pane from a single-tab template reports no tab
    Given a template declaring root applied with --format json
    When the manifest is reported
    Then each pane's tab is null
    # absent rather than false: there is no tab structure to report, and inventing one would claim the
    # template said something it did not

  Scenario: the manifest's workspace is still null on tmux even when tabs are grouped
    Given a tabs template applied on tmux
    When the manifest is reported
    Then the manifest's workspace is null
    # the grouping tag is cyber-mux's own bookkeeping, not a workspace tier. Reporting it as workspace
    # would claim a tier tmux does not have — the same absent-rather-than-false convention that makes
    # the field null for a single-tab apply on tmux today.
