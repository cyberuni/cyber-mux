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

  Scenario: two panes may share a label, because a label is a name rather than a key
    Given a template with two pane nodes both labeled worker
    When the template is validated
    Then it is valid
    # neither backend requires a unique name — tmux titles three panes worker without complaint and
    # herdr's pane rename takes no uniqueness constraint — and the manifest's unique handle is the
    # pane id, never the label. A pool of workers all named worker is a legitimate thing to mean.
    # Ambiguity belongs to whoever LOOKS a pane up, where the candidates are known and a caller can
    # choose, rather than to the author, where refusing it is only a guess about intent.

  Scenario Outline: exactly one of root, panes and tabs
    Given a template that declares <declares>
    When the template is validated
    Then it exits 1

    Examples:
      | declares                    |
      | both root and panes         |
      | both root and tabs          |
      | both panes and tabs         |
      | none of root, panes or tabs |

  Scenario: every validation error is reported at once, not first-only
    Given a template carrying a cwd field, an absolute dir, and a ratio of 0
    When cyber-mux layout validate runs
    Then all three errors are reported, one per line
    And each names its own JSON path

  # ── Tabs: a workspace is tabs of panes, not one pane tree ──
  # root and panes each describe ONE tab's worth of structure. tabs is the two-level form: a
  # workspace of N tabs, each carrying its own pane tree in the very same shape.

  Scenario: a tab carries its own tree, in the same shape a single-tab template uses
    Given a template declaring tabs, the first with a root split and the second with a single pane
    When the template is validated
    Then it is valid
    And each tab's tree is the same node shape a top-level root accepts

  Scenario: a tab may use the flat sugar, desugared exactly as a single-tab template is
    Given a template whose tab declares panes of 3 and arrange even-horizontal
    When the template is desugared
    Then that tab's tree is the same right-comb the top-level flat form produces
    # sugar is a property of a pane pool, not of where the pool sits — one desugarer, one answer

  Scenario Outline: a tab declares exactly one of root and panes, the same as the template itself
    Given a template with a tab that declares <declares>
    When the template is validated
    Then it exits 1
    And the error names that tab's JSON path

    Examples:
      | declares               |
      | both root and panes    |
      | neither root nor panes |

  Scenario: an empty tabs array is refused, because a workspace of no tabs is not a workspace
    Given a template declaring tabs as an empty array
    When the template is validated
    Then it exits 1

  Scenario: two tabs may share a label, and so may panes in different tabs
    Given a template declaring two tabs both labeled editor, each carrying a pane labeled worker
    When the template is validated
    Then it is valid
    # nothing keys on either name. The manifest reports a pane's tab by INDEX, not by label, and a tab
    # is addressed by its own id at the seam — herdr labels EVERY new workspace's root tab 1, so a
    # backend that manufactures duplicates by default cannot be one a uniqueness rule describes.

  Scenario: a tab may leave its label to the backend
    Given a template declaring two tabs, neither carrying a label
    When the template is validated
    Then it is valid
    # matching --label omitted everywhere else: the backend's own default stands

  Scenario: a tab cannot carry a cwd any more than a pane can
    Given a template whose tab carries a cwd field
    When the template is validated
    Then it exits 1 naming --cwd and dir
    # the rule the whole capability exists to enforce does not weaken because a level was added

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

  # ── The walk, across tabs ──
  # The single-tab walk is unchanged and is the inner loop. A tabs template wraps it: open the
  # workspace, open each further tab in it, and build each tab's tree against its own root pane.

  Scenario: the first tab opens the workspace and every later tab opens inside it
    Given a tabs template of 3 tabs applied on a backend with a real workspace tier
    When the walk runs
    Then the first tab opens at the workspace placement
    And the second and third each open at the tab placement
    And no tab opens as a split of another tab's pane

  Scenario: each tab's tree is built against that tab's own root pane
    Given a tabs template whose second tab is a split of two panes
    When the walk runs
    Then the second tab's split names the second tab's root pane as the pane it splits
    # the same rule the single-tab walk already holds: a split names its pane rather than trusting the
    # backend's default, which tracks the user rather than the caller

  Scenario: geometry is built across every tab before any command is submitted
    Given a tabs template of 2 tabs, each carrying a pane with a command
    When the walk runs
    Then every tab and every split is opened before the first submit
    And the commands are submitted in template order, tab by tab
    # the single-tab reason scales: a split lands mid-render if it targets a pane already running an
    # interactive agent, and a tab is opened blank for the same reason a region is

  Scenario: a tabs template still defaults --at to workspace
    Given a caller running cyber-mux open --layout with a tabs template and no --at
    When the command runs
    Then the workspace placement is the one used
    # a fresh space is empty by construction, and a workspace is what a set of tabs needs to live in

  Scenario: apply never steals focus, and a tabs template cannot ask it to
    Given a tabs template of 3 tabs
    When the walk runs
    Then the caller's focus is where it was before the apply
    And the template has no field naming a tab to focus
    # unchanged from every spawn path: a caller who wants to land somewhere calls focus with a pane id
    # from the manifest

  Scenario: worktree add --layout builds a tabs template into the worktree's own workspace
    Given a caller running cyber-mux worktree add --layout with a tabs template
    When the command runs
    Then the first tab is built into the workspace the worktree opened
    And every later tab opens as a tab in it

  Scenario: a tabs template groups the same way whichever verb opened the workspace
    Given a caller running cyber-mux worktree add --layout with a tabs template on tmux
    When the command runs
    Then every tab carries the same workspace group, the first one included
    And the workspace captures back with every tab it was built with
    # the route that opened the region cannot change what the template means. Grouping only the tabs
    # the walk itself opened would leave the workspace's own first tab out, and a group missing a tab
    # is worse than no group: capture would confidently round-trip a 3-tab workspace as 2.
    # worktree add --layout already forces the workspace placement, so a set of tabs has a workspace
    # to live in and needs no second one. The route differs from open --layout in one way only: the
    # region already exists, so the first tab builds into it rather than opening it.

  Scenario: a throw part-way through a tabs walk reports the tabs already built and kills nothing
    Given a tabs template of 3 tabs whose second tab fails to open
    When the walk runs
    Then the panes already built are reported in the manifest
    And it exits 1 without killing anything
    # apply does not roll back, and adding a level does not buy an atomicity the node never offered

  # ── Carrying the workspace where the backend has no workspace tier ──
  # A workspace of N tabs maps directly onto a backend that has a workspace tier. On one that does
  # not, the grouping has to be carried some other way — and it is carried TWICE, for two different
  # readers, because one carrier cannot serve both.

  Scenario: on a backend with no workspace tier, a tab is labeled with its workspace and its own name
    Given a tabs template named pool whose tab is labeled editor
    When it is applied on tmux with the workspace labeled pool
    Then the window is named "pool - editor"
    # tmux collapses workspace and tab onto the same Window, so a template's tabs would otherwise be an
    # unlabeled pile — the prefix is what keeps them recognizable as a group in the status bar

  Scenario: on a backend with a real workspace tier, a tab carries its own label unprefixed
    Given a tabs template named pool whose tab is labeled editor
    When it is applied on herdr
    Then the tab is labeled "editor"
    And the workspace is labeled "pool"
    # herdr's UI already groups by the real workspace label, so a prefix would be redundant noise —
    # the concept maps onto what the backend actually has

  Scenario: the workspace label is never shortened, so two workspaces never collide by shortening
    Given a tabs template applied with a long workspace label
    When a tab is labeled on a backend with no workspace tier
    Then the workspace label appears in the tab label in full
    # the prefix is the label the caller already chose, so the caller controls its length; shortening
    # would invent a collision question that not shortening does not have

  Scenario: a tab's label is never parsed back to recover its workspace
    Given a workspace labeled "acme - beta" whose tab is labeled main
    When the workspace's tabs are enumerated
    Then the workspace is identified by its grouping tag rather than by splitting the tab label
    # "acme - beta - main" is ambiguous under every split rule — it reads as workspace "acme" with tab
    # "beta - main" just as well as workspace "acme - beta" with tab "main". The label is for a human
    # to read; the tag is what a machine reads.

  Scenario: herdr's root tab is named after birth, because it is the one tab that cannot be named at birth
    Given a tabs template whose first tab is labeled editor
    When it is applied on herdr
    Then the workspace is created and its root tab is renamed to editor
    And every later tab is named at birth
    # herdr labels a new workspace's root tab 1 with no flag to change it; tab create --label names
    # every subsequent tab at birth. This is the whole of the constraint the mux node's tab-naming
    # non-goal was generalizing from.

  # ── Ratio and env: degrade, never reject ──
  # The schema is backend-agnostic, so a template's validity cannot depend on the live multiplexer.
  #
  # What `ratio` and `env` MEAN at the seam — the sign convention each backend converts in, the flag
  # each renders, and the tier env reaches — belongs to the pane abstraction and is specified there
  # (`mux/mux.feature`, "Split options"). This node owns only what a TEMPLATE does with them: that
  # the desugared tree carries them, and that a backend which cannot size a split degrades rather
  # than rejecting an otherwise-valid pool.
  #
  # The two degrades are NOT symmetric, though the block's title pairs them. `ratio`'s policy is this
  # node's outright — this node is its only caller. `env`'s prefix-or-warn rule is the seam's, stated
  # once in `mux/mux.feature` because env has two callers (this node and `--env`) and a rule with two
  # callers is not one caller's to invent. What this node owns for env is the SCOPING: that only the
  # root pane can need it, and that the warning fires once rather than per pane.

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

  Scenario: a root pane whose env the region open could not carry has it prefixed onto its command
    Given a region opened by a route that could not carry the root pane's env
    And a template whose panes each carry a command, the root's among them
    When the template is applied
    Then the root pane's command is prefixed with that env
    And no other pane's command is prefixed
    # The scoping this node owns — the prefix-or-warn RULE is the seam's (`mux/mux.feature`), because
    # env has two callers and a rule with two callers is not one caller's to invent. What is this
    # node's is WHERE it applies: only the ROOT pane can need it, since every other pane is born by a
    # split and splits carry env natively on both backends, so prefixing another would double-apply
    # what the split already set. The template needs more than one pane to say that at all.

  Scenario: a root pane whose env could not be carried, with no command to prefix, warns once
    Given a region opened by a route that could not carry the root pane's env
    And a template of several panes across several tabs, whose root pane carries no command
    When the template is applied
    Then every pane the template names is still created
    And exactly one warning naming that pane's variables is written to stderr
    And stdout stays machine-readable
    # The other half of the scoping: HOW OFTEN. Once, not once per pane — the root pane is the only
    # one that could have lost env, so a second warning would be noise about panes that never had a
    # problem. Stated over a multi-pane, multi-tab template because a single-pane one cannot tell
    # "once" from "once per pane", exactly as the ratio degrade above needs plural splits to mean
    # anything. An otherwise-correct pool is not worth failing over a variable one route could not
    # carry.

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

  Scenario: the manifest carries the workspace the region opened in
    Given a caller running cyber-mux open --layout pool-4 --format json with $HERDR_ENV set and no $TMUX
    When the command runs
    Then the manifest's workspace field carries the workspace the region opened in
    # The manifest is framed as the complete machine-readable answer to "which panes exist and what
    # are they for" — a consumer grouping panes by workspace needs something to group on. open
    # surfaces the workspace it landed in, so the manifest reports it rather than a flat null.

  Scenario: the manifest's workspace is null on tmux
    Given a caller running cyber-mux open --layout pool-4 --format json with $TMUX set
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

  # ── Capturing a live region: which region, and what tree ──
  # save is the inverse of apply. The seam reports one rectangle per pane; cyber-mux derives the tree.

  Scenario: save captures the region around the calling pane, not the one the user is looking at
    Given a caller in a pane whose region the caller is not focused on
    When cyber-mux layout save pool-3 runs with no --from
    Then the captured region is the caller's own
    # the same reason every split names its pane: both backends' defaults track the user rather than
    # the caller, and they only coincide while a human is typing

  Scenario: --from captures the region around a named pane
    Given a caller running cyber-mux layout save pool-3 --from a pane in another region
    When the command runs
    Then the captured region is that pane's

  Scenario: the geometry seam reports one rectangle per pane, not a backend's own tree
    Given a region on any backend
    When the geometry seam reports it
    Then every pane in the region is reported with its rectangle
    And no backend's native split-tree encoding is parsed to obtain the tree
    # tmux encodes its tree in a bespoke string it does not promise to keep; herdr's splits[] is flat,
    # with parent links only inside an undocumented id convention. A rectangle is the one fact both
    # report exactly, and a region built by splitting is always guillotine-cuttable from rectangles.

  Scenario: a captured ratio is the one the split was made with, not the one the pane sizes imply
    Given a region split at ratio 0.7 on a backend that draws a divider between panes
    When the region is captured
    Then the captured split's ratio is 0.7
    # the divider cell belongs to the region and to neither pane, so the backend reports 34 and 15 of
    # a 50-row region. first/(first+second) reads 0.69; the complement, 1 - second/total, puts the
    # divider where the backend's own sizing flag puts it and reads the 0.7 the split was made with.

  Scenario: re-applying a captured template reproduces the region it was captured from
    Given a region of 4 panes built by splitting
    When it is captured and the captured template is applied to a fresh region of the same size
    Then every pane of the rebuilt region matches the size of its counterpart in the original
    # the property the whole derivation exists to hold — a capture that does not round-trip is a
    # confident lie about the user's screen

  Scenario: an n-ary row captures as the right-comb the flat sugar desugars to
    Given a region of 3 equal panes side by side
    When it is captured
    Then the captured tree is the one arrange even-horizontal desugars to for 3 panes
    # three panes side by side is ONE node with three children in a backend's own tree; the schema is
    # binary, so the capture must comb it — and must comb it the way the desugarer does, or a pool
    # would not survive the round trip. Capture and the flat sugar meet at the same canonical form.

  Scenario: an ambiguous grid captures columns-first, matching tiled rather than its transpose
    Given a region of 4 panes in a 2x2 grid
    When it is captured
    Then the captured tree is the one arrange tiled desugars to for 4 panes
    # a 2x2 is genuinely ambiguous: cutting vertically or horizontally first describes the same
    # screen and neither is more true. The tie is broken to match tiled, so a captured grid comes
    # back as the template that built it.

  # ── The capture is a draft ──
  # It recovers geometry, never commands — and the file has to say so itself.

  Scenario Outline: no pane in a captured template carries a command, on either backend
    Given a region on the <backend> adapter whose panes are running commands
    When it is captured
    Then no pane node in the written template carries a command

    Examples:
      | backend |
      | tmux    |
      | herdr   |

    # no multiplexer reports the command a pane was launched with: the walk types commands with
    # submit rather than passing them to the split, so tmux's pane_start_command is empty for every
    # pane cyber-mux creates and pane_current_command reports the shell or interpreter instead

  Scenario: a captured template records in its own description that it is geometry only
    Given a caller running cyber-mux layout save pool-3 with no --description
    When the command runs
    Then the written template's description says the capture is geometry only
    And it says a command must be added to each pane
    # layout list shows a capture beside finished templates, so a note that only reached the terminal
    # that ran save would be gone by the time anyone read the file

  Scenario: --description replaces the draft note
    Given a caller running cyber-mux layout save pool-3 --description "the review pool"
    When the command runs
    Then the written template's description is "the review pool"

  # ── The capture subtracts the target back out ──
  # Apply's injection, run backwards: apply joins cwd + dir, so capture divides it out.

  Scenario: a pane under the captured root becomes a relative dir
    Given a region whose root pane runs in the target and another pane runs in the target's services/api
    When it is captured
    Then that pane node's dir is services/api
    And no pane node carries a cwd
    And no absolute path appears anywhere in the written template
    # the rule the whole capability exists to enforce, holding in the writing direction too

  Scenario: a pane outside the captured root loses its dir and says so
    Given a region one of whose panes runs outside the captured root
    When it is captured
    Then that pane node carries no dir
    And a warning naming that pane's directory is written to stderr
    And the template is still written
    # dir must stay under the apply-time target, so emitting ../elsewhere would fail the very
    # validator this capture has to satisfy — there is nowhere to put this pane's location

  Scenario: a captured template passes validate
    Given a template captured from a live region
    When cyber-mux layout validate runs on it
    Then it exits 0
    # the round trip that matters: a capture that its own validator rejects is not a template

  Scenario: a label two panes share is captured onto both, because a human chose it
    Given a region where two panes are both labeled worker
    When it is captured
    Then both pane nodes carry the label worker
    And no warning about the label is written
    # this is what capture is FOR. A pane's label got there because someone renamed the pane by hand,
    # so dropping it discards the exact fact the capture exists to preserve — and reports "no label"
    # where there is one, against the absent-rather-than-false rule everything else here follows. The
    # live model has no uniqueness rule and neither does the schema: a pool of three panes all named
    # worker is a thing a person may legitimately mean.

  Scenario: a label the author set is captured, and a backend's default pane title is not
    Given a tmux region where one pane's title was set to reviewer and every other pane carries tmux's default title
    When it is captured
    Then the reviewer pane node carries the label reviewer
    And no other pane node carries a label
    # tmux has no unset title — it defaults every pane's to the hostname, so capturing the title
    # verbatim would hang the host's name on every pane of every capture. A title equal to the host
    # is the default; one that differs is a label someone chose. The trade is deliberate: a pane
    # labeled exactly its own hostname loses its label, which costs one hand-edit and is rare.

  # ── Capturing a whole workspace ──
  # save's subject is a region and stays one. --workspace widens it to every tab of the workspace the
  # caller's region sits in, and is the exact inverse of the tabs walk.

  Scenario: save --workspace captures every tab of the caller's workspace
    Given a caller in a workspace of 3 tabs
    When cyber-mux layout save pool --workspace runs
    Then the written template declares tabs
    And it carries one tab per tab of the workspace, each with that tab's own tree

  Scenario: save without --workspace captures only the caller's own region
    Given a caller in a workspace of 3 tabs
    When cyber-mux layout save pool runs
    Then the written template declares root rather than tabs
    And it carries only the caller's own region
    # the default subject is unchanged — widening it silently would rewrite what save has always meant

  Scenario: a bare save in a multi-tab workspace says what it left out
    Given a caller in a workspace of 3 tabs
    When cyber-mux layout save pool runs with no --workspace
    Then the path is printed on stdout
    And stderr notes that the workspace holds more tabs than were captured
    # the capture is honest about its own scope rather than letting a caller believe a 3-tab workspace
    # round-trips from a 1-tab template

  Scenario: a captured tab keeps the label its tab carries
    Given a workspace whose tabs are labeled editor and logs
    When it is captured with --workspace
    Then the captured tabs are labeled editor and logs

  Scenario: a captured tab's label is the tab's own name, never the composed one
    Given a workspace labeled pool on tmux whose tab displays as "pool - editor"
    When it is captured with --workspace
    Then the captured tab is labeled editor
    And re-applying the capture displays "pool - editor" again rather than compounding the prefix
    # the tab's own name is read from where the walk stored it, not split back out of the display name
    # — the separator is ambiguous, so parsing would be unsound, and taking the display name verbatim
    # would re-prefix it on every round trip. Capture is the inverse of apply or it is a lie about the
    # user's screen.

  Scenario: re-applying a captured workspace reproduces the tabs it was captured from
    Given a workspace of 2 tabs, each of 2 panes built by splitting
    When it is captured with --workspace and the captured template is applied to a fresh workspace
    Then the rebuilt workspace has the same tabs
    And every pane matches the size of its counterpart in the original
    # the round-trip property the derivation exists to hold, now at the tab level as well as the pane
    # level — a capture that does not round-trip is a confident lie about the user's screen

  Scenario: a captured workspace is still a draft carrying no command
    Given a workspace of 2 tabs whose panes were launched with commands
    When it is captured with --workspace
    Then no pane in any tab carries a command
    And the template records in its own description that it is geometry only
    # unchanged and for the unchanged reason: no multiplexer reports the command a pane was launched
    # with, and adding a level does not add that fact

  Scenario: on a backend with no workspace tier, an untagged region captures as a single-tab workspace
    Given a caller in a tmux window carrying no grouping tag
    When cyber-mux layout save pool --workspace runs
    Then the captured template carries exactly one tab
    # a window nobody grouped is a workspace of one — the honest answer, and the reason the tag is read
    # rather than the label parsed

  Scenario: a backend that cannot enumerate a workspace's tabs refuses save --workspace cleanly
    Given a backend that cannot report its workspace's tabs
    When cyber-mux layout save pool --workspace runs
    Then it exits 1 naming the backend
    And no file is written
    # the same refusal shape as a backend that cannot report a region's geometry — an absent optional
    # seam member is a refusal, never a guess

  # ── save writes a file ──

  Scenario: save writes to the repo layouts directory and prints the path
    Given a caller running cyber-mux layout save pool-3
    When the command runs
    Then the template is written under the primary checkout's .cyber-mux/layouts as pool-3.json
    And stdout carries that path and nothing else
    # the path alone, so $(cyber-mux layout save pool-3) composes

  Scenario: --to user writes to the user layouts directory instead
    Given a caller running cyber-mux layout save pool-3 --to user
    When the command runs
    Then the template is written under the user layouts directory
    And nothing is written to the repo layouts directory

  Scenario: save refuses to overwrite an existing template, and reads no region finding out
    Given a repo layouts directory already containing pool-3.json
    When cyber-mux layout save pool-3 runs
    Then it exits 1
    And the error names --force
    And the existing template is unchanged
    And no region is read
    # a capture is hand-edited afterwards — the commands are added by hand — so overwriting one
    # silently would throw that work away. Checked before the capture, so the refusal is free.

  Scenario: --force overwrites an existing template
    Given a repo layouts directory already containing pool-3.json
    When cyber-mux layout save pool-3 --force runs
    Then it exits 0
    And pool-3.json is replaced by the captured template

  # ── save's refusals ──

  Scenario: save validates the name before touching the filesystem or the multiplexer
    Given a caller running cyber-mux layout save "../escape"
    When the command runs
    Then it exits 1
    And no file is written
    And no region is read
    # a name is a lookup key that must also be a filename, exactly as it is for show and validate

  Scenario: save with no pane to capture around refuses rather than guessing
    Given a caller in no pane at all
    And no --from
    When cyber-mux layout save pool-3 runs
    Then it exits 1 naming --from
    And no template is written
    # falling back to the backend's own default would capture whichever region the user happens to be
    # looking at and name it after the caller's intent — a wrong answer is worse than no answer here

  Scenario: a backend that cannot report its region's geometry refuses save cleanly
    Given a backend with no region-geometry primitive
    When cyber-mux layout save pool-3 runs
    Then it exits 1 naming that backend
    And no template is written
    # geometry reporting is an optional capability, exactly as the worktree binding already is —
    # a backend that cannot answer cannot be captured, and there is nothing to degrade to

  Scenario: a region no sequence of splits could have produced is refused
    Given a region whose panes no straight cut separates without crossing one
    When it is captured
    Then it exits 1
    And no template is written
    # both backends build regions only BY splitting, so this cannot come off a real screen. Reaching
    # it means the geometry is not what we think it is, and a tree that misplaces the user's panes is
    # worse than a refusal.
