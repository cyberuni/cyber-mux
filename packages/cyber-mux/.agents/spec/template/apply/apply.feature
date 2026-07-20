@frozen
Feature: template apply — resolve a template and build the panes it describes
  A template names a pane pool once — geometry, a startup command, an environment per pane — and
  re-targets it at a directory supplied at apply time. Nothing about the target is ever in the
  template. This unit owns the read direction: resolving a template by name, validating it,
  desugaring the flat form, and walking the tree into live panes and tabs.

  # ── Resolving a template by name ──
  # Three sources, repo before user, resolved from the primary checkout so every worktree agrees.

  Scenario: --file skips resolution entirely
    Given a caller running cyber-mux template show --file ./scratch/pool.json
    When the template is resolved
    Then the file at that path is the one read
    And neither the repo nor the user templates directory is consulted

  Scenario: a repo template shadows a user template of the same name
    Given a repo templates directory containing pool-4.json
    And a user templates directory also containing pool-4.json
    When cyber-mux template show pool-4 runs
    Then the repo template is the one shown
    And cyber-mux template list reports the user pool-4 as shadowed

  Scenario: a user template resolves when the repo has none of that name
    Given a repo templates directory with no scratch.json
    And a user templates directory containing scratch.json
    When cyber-mux template show scratch runs
    Then the user template is the one shown
    And cyber-mux template list reports its source as user

  Scenario: the repo templates directory resolves through the primary checkout, not the caller's cwd
    Given a caller inside a linked worktree whose branch predates pool-4.json
    And the primary checkout carries .cyber-mux/templates/pool-4.json
    When cyber-mux template show pool-4 runs
    Then the primary checkout's template is resolved
    # reading ./.cyber-mux relative to the caller's cwd reports not-found here — the worktree's own
    # checkout predates the file. Resolving through resolvePrimaryRoot gives one canonical answer.

  Scenario: a name that resolves nowhere lists the directories searched
    Given no pool-9.json in either the repo or the user templates directory
    When cyber-mux template show pool-9 runs
    Then it exits 1
    And the error names both directories it searched

  Scenario Outline: a name that is not a plain stem is refused before any file is read
    Given a caller running cyber-mux template show "<name>"
    When the name is validated
    Then it exits 2, a usage error — the argument is malformed and the fix is a different name
    And no file is read
    # 2, not 1: nothing was attempted and nothing failed. The name is bad input, the same family as a
    # missing required parameter, which axi/'s #6 puts at 2. save's identical name check agrees.

    Examples:
      | name             |
      | ../../../etc/pwd |
      | pool/../../out   |
      | Pool-4           |
      | -pool            |
      | pool_4           |

  # Exit 1 below is deliberate and stays: a template's CONTENT being invalid is not a usage error.
  # The invocation was well-formed — the fix is to the file, not to a different argument — so it is
  # not the malformed-argument family axi/'s #6 puts at 2. `validate` is a predicate reporting invalid
  # (an answer, the grep/test shape `exists` also takes), and a mutating verb like `apply` or
  # `worktree add --template` refusing a bad template is a genuine operation failure. Both are 1; only a
  # malformed NAME or a missing required parameter (above, and in save's refusals) is the usage-error 2.
  Scenario: a template whose name field disagrees with its filename stem fails validation
    Given a repo template pool-4.json whose name field is "pool-3"
    When cyber-mux template validate pool-4 runs
    Then it exits 1
    And the error names both the filename stem and the name field
    # the redundancy is the point: a copied file that kept its old name fails loudly

  # ── The tree, and no cwd in it ──
  # The single rule the capability exists to enforce, plus the schema's other refusals.

  Scenario: a template that sets cwd fails validation naming --cwd and dir
    Given a template whose root.first pane node carries a cwd field
    When cyber-mux template validate runs
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
    When cyber-mux template validate runs
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
    And tmux's own select-template is never invoked
    # select-template tiled implements tmux's grid algorithm, which herdr has no equivalent of —
    # using it would give the same template a different geometry per backend

  Scenario: show --desugar prints exactly the tree apply will build
    Given a flat template pool-4
    When cyber-mux template show pool-4 --desugar runs
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
    Given a caller running cyber-mux open --template with a tabs template and no --at
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

  Scenario: worktree add --template builds a tabs template into the worktree's own workspace
    Given a caller running cyber-mux worktree add --template with a tabs template
    When the command runs
    Then the first tab is built into the workspace the worktree opened
    And every later tab opens as a tab in it

  Scenario: a tabs template groups the same way whichever verb opened the workspace
    Given a caller running cyber-mux worktree add --template with a tabs template on tmux
    When the command runs
    Then every tab carries the same workspace group, the first one included
    And the workspace captures back with every tab it was built with
    # the route that opened the region cannot change what the template means. Grouping only the tabs
    # the walk itself opened would leave the workspace's own first tab out, and a group missing a tab
    # is worse than no group: capture would confidently round-trip a 3-tab workspace as 2.
    # worktree add --template already forces the workspace placement, so a set of tabs has a workspace
    # to live in and needs no second one. The route differs from open --template in one way only: the
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

  Scenario: a template name that resolves nowhere leaves no worktree behind
    Given cyber-mux worktree add --branch feat-x --template pool-9
    And pool-9 resolves in neither templates directory
    When the command runs
    Then it exits 1
    And no worktree is created

  Scenario: an invalid template leaves no worktree behind
    Given cyber-mux worktree add --branch feat-x --template bad-pool
    And bad-pool sets a cwd
    When the command runs
    Then it exits 1 with the validation error
    And no worktree is created

  Scenario: open --template with an unresolvable name opens nothing
    Given cyber-mux open --template pool-9
    And pool-9 resolves in neither templates directory
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
    # a kill is not obviously safer than a half-built template the caller can see and finish

  # ── --template, the exact sibling of --launch ──

  Scenario: --template and --launch are mutually exclusive
    Given a caller running cyber-mux open --template pool-4 --launch claude
    When the command runs
    Then it exits 2 rejecting the pair, a usage error — two flags that cannot both be given is malformed input

  Scenario: --at defaults to workspace when --template is given
    Given a caller running cyber-mux open --template pool-4 with no --at
    When the command runs
    Then the region opens at the workspace placement
    # a fresh space is empty by construction

  Scenario: --label defaults to the template name
    Given a caller running cyber-mux open --template pool-4 with no --label
    When the command runs
    Then the opened region is labeled pool-4

  Scenario: worktree add --template applies the template against the worktree root
    Given a caller running cyber-mux worktree add --branch feat-x --template agent-pool-3
    When the command runs
    Then the worktree's workspace is opened with no launch
    And the walk's cwd is the worktree root
    And the manifest is reported alongside the worktree's root and branch

  # ── The manifest is the handoff ──

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

  # ── Managing templates needs no multiplexer ──

  Scenario Outline: list, show and validate answer with no multiplexer at all
    Given a caller with neither $TMUX nor $HERDR_ENV set
    When cyber-mux template <verb> runs
    Then it answers without resolving a session backend

    Examples:
      | verb          |
      | list          |
      | show pool-4   |
      | validate pool-4 |

  Scenario: validate exits 0 on a valid template
    Given a well-formed template pool-4
    When cyber-mux template validate pool-4 runs
    Then it exits 0
    And stderr is empty

  Scenario: applying with no multiplexer fails through the existing adapter path
    Given a caller with neither $TMUX nor $HERDR_ENV set
    When cyber-mux open --template pool-4 runs
    Then it throws naming tmux/herdr as the required backend
