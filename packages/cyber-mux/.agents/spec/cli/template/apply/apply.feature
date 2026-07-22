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

  @id:template-apply-read-verbs-no-mux
  Scenario Outline: list, show and validate answer with no multiplexer at all
    Given a caller with neither $TMUX nor $HERDR_ENV set
    When cyber-mux template <verb> runs
    Then it answers without resolving a session backend

    Examples:
      | verb          |
      | list          |
      | show pool-4   |
      | validate pool-4 |

  @id:template-apply-file-skips-resolution
  Scenario: --file skips resolution entirely
    Given a caller running cyber-mux template show --file ./scratch/pool.json
    When the template is resolved
    Then the file at that path is the one read
    And neither the repo nor the user templates directory is consulted

  @id:template-apply-show-desugar-tree
  Scenario: show --desugar prints exactly the tree apply will build
    Given a flat template pool-4
    When cyber-mux template show pool-4 --desugar runs
    Then the printed tree is the one the walk splits from

  @id:template-apply-validate-exit-0
  Scenario: validate exits 0 on a valid template
    Given a well-formed template pool-4
    When cyber-mux template validate pool-4 runs
    Then it exits 0
    And stderr is empty

  # ── Applying is --template, the exact sibling of --launch ──
  # There is no `template apply` verb: apply is reached only through open --template and
  # worktree add --template. Both flags answer "what runs in the space you are opening", so they are
  # mutually exclusive and --at defaults to workspace (a fresh space is empty by construction).

  @id:template-apply-template-launch-exclusive
  Scenario: --template and --launch are mutually exclusive
    Given a caller running cyber-mux open --template pool-4 --launch claude
    When the command runs
    Then it exits 2 rejecting the pair, a usage error — two flags that cannot both be given is malformed input

  @id:template-apply-at-defaults-workspace
  Scenario: --at defaults to workspace when --template is given
    Given a caller running cyber-mux open --template pool-4 with no --at
    When the command runs
    Then the region opens at the workspace placement
    # a fresh space is empty by construction

  @id:template-apply-tabs-defaults-workspace
  Scenario: a tabs template still defaults --at to workspace
    Given a caller running cyber-mux open --template with a tabs template and no --at
    When the command runs
    Then the workspace placement is the one used
    # a fresh space is empty by construction, and a workspace is what a set of tabs needs to live in

  @id:template-apply-label-defaults-name
  Scenario: --label defaults to the template name
    Given a caller running cyber-mux open --template pool-4 with no --label
    When the command runs
    Then the opened region is labeled pool-4

  # ── The manifest is the handoff (--format json) ──
  # --format json reports every pane apply created plus the workspace and per-pane tab it landed in.
  # The workspace field carries the real answer where the backend has a workspace tier and is null
  # where it does not; tab is the same argument one level down.

  @id:template-apply-json-reports-panes
  Scenario: --format json reports every pane apply created
    Given a caller running cyber-mux open --template agent-pool-3 --format json
    When the command runs
    Then stdout carries the template name, the injected cwd, the workspace, and one entry per pane
    And each entry carries its label, pane id, dir, and command
    # the complete answer to "which panes exist and what are they for" — a dispatcher built on it
    # needs no new cyber-mux surface

  @id:template-apply-manifest-workspace-value
  Scenario: the manifest carries the workspace the region opened in
    Given a caller running cyber-mux open --template pool-4 --format json with $HERDR_ENV set and no $TMUX
    When the command runs
    Then the manifest's workspace field carries the workspace the region opened in
    # The manifest is framed as the complete machine-readable answer to "which panes exist and what
    # are they for" — a consumer grouping panes by workspace needs something to group on. open
    # surfaces the workspace it landed in, so the manifest reports it rather than a flat null.

  @id:template-apply-manifest-workspace-null-tmux
  Scenario: the manifest's workspace is null on tmux
    Given a caller running cyber-mux open --template pool-4 --format json with $TMUX set
    When the command runs
    Then the manifest's workspace field is null
    # matching how reportOpenedWorktree already reports it

  @id:template-apply-manifest-tab-per-pane
  Scenario: the manifest reports which tab each pane landed in
    Given a tabs template of 2 tabs applied with --format json
    When the manifest is reported
    Then every pane carries the tab it landed in
    And the pane list stays one flat list of every pane apply created
    # the manifest is still the whole handoff — a consumer grouping panes by tab needs something to
    # group on, exactly as it needs workspace to group by space

  @id:template-apply-manifest-tab-null-single
  Scenario: a pane from a single-tab template reports no tab
    Given a template declaring root applied with --format json
    When the manifest is reported
    Then each pane's tab is null
    # absent rather than false: there is no tab structure to report, and inventing one would claim the
    # template said something it did not

  @id:template-apply-manifest-workspace-null-tabs-grouped
  Scenario: the manifest's workspace is still null on tmux even when tabs are grouped
    Given a tabs template applied on tmux
    When the manifest is reported
    Then the manifest's workspace is null
    # the grouping tag is cyber-mux's own bookkeeping, not a workspace tier. Reporting it as workspace
    # would claim a tier tmux does not have — the same absent-rather-than-false convention that makes
    # the field null for a single-tab apply on tmux today.
