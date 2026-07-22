@frozen
Feature: mux lookup — resolving a pane, the focus probe, and the listing content
  How a pane locator resolves to one pane, whether a pane is focused, and what a listing carries so a
  name resolves from it. The CLI rendering of these outcomes — exit codes, the structured error every
  verb fails with, and --format — is the surface in ../../cli/lookup/lookup.feature; this suite owns
  the surface-independent resolution, focus-probe, and listing-content contract.

  # ── Reporting whether a pane is currently focused (on screen for an attached client) ──

  @id:lookup-tmux-focused-attached-client
  Scenario: tmux reports a pane focused when an attached client is currently viewing it
    Given a tmux pane that is the active pane of the current window in a session with an attached client
    When the backend is asked whether that pane is focused
    Then it reports focused

  @id:lookup-tmux-not-focused-conditions
  Scenario Outline: tmux reports a pane not focused when <condition>
    Given a tmux pane where <condition>
    When the backend is asked whether that pane is focused
    Then it reports not-focused

    Examples:
      | condition                               |
      | it is not the active pane of its window |
      | its window is not the current window    |
      | its session has no attached client      |

  @id:lookup-herdr-focused
  Scenario: herdr reports a pane focused when its pane record is focused
    Given a herdr pane whose pane record reports it is currently being viewed by a client
    When the backend is asked whether that pane is focused
    Then it reports focused

  @id:lookup-herdr-not-focused
  Scenario: herdr reports a pane not focused when its pane record is not focused
    Given a herdr pane whose pane record reports no client is currently viewing it
    When the backend is asked whether that pane is focused
    Then it reports not-focused

  @id:lookup-focus-unknown-not-boolean
  Scenario Outline: a focus query that cannot be answered is unknown, not a boolean
    Given <condition>
    When it is asked whether a pane is focused
    Then it answers unknown rather than a boolean, so callers fail open instead of treating the pane as absent

    Examples:
      | condition                                    |
      | a backend with no primitive to report focus  |
      | a pane the backend can no longer resolve     |
      | a focus query that errors                    |

  @id:lookup-wezterm-focus-always-unknown
  Scenario: wezterm always reports unknown — it has no focus primitive at all, not just a per-query gap
    Given a wezterm pane, any pane
    When the backend is asked whether that pane is focused
    Then it reports unknown
    # `wezterm cli list --format json`'s documented fields carry no active/focused indicator for a
    # pane, tab, or window — unlike tmux/herdr, where unknown is a per-query FALLBACK, this is the
    # WHOLE backend's answer, every time, by the same honest convention.

  # ── The live pane listing carries the labels a name resolves from ──
  # A label is a human name, not a key. The listing reports every live pane with the label a name
  # resolves from — and the label it reports is the one a person set, never a backend's default.

  @id:lookup-listing-enumerates-all-panes
  Scenario: the live pane listing enumerates every live pane, including one running no agent/harness
    Given a backend with a mix of panes, some running an agent/harness and some running none
    When the live panes are listed
    Then every live pane is reported, whether or not it is running an agent/harness

  @id:lookup-listing-carries-label
  Scenario Outline: the live pane listing carries each pane's label, so a name resolves from it
    Given a <backend> pane a person has labeled
    When the live panes are listed
    Then the listing carries that pane's label beside its id

    Examples:
      | backend |
      | tmux    |
      | herdr   |

  # tmux has no unset title — it defaults pane_title to the hostname, so an untouched pane reports a
  # name nobody chose. Exporting that would label EVERY pane in the session identically, and the
  # hostname would then resolve to every one of them: ambiguity manufactured out of nothing.
  @id:lookup-tmux-unnamed-no-label
  Scenario: a tmux pane nobody named carries no label, so the hostname addresses no pane
    Given a tmux pane whose title has never been set
    When the live panes are listed
    Then that pane reports no label
    And the hostname resolves to no pane, rather than colliding with every pane in the session

  # The contrast that shows the tmux rule is a workaround, not the shape of the thing: herdr has the
  # honest primitive, so an unnamed pane needs no rule to be read as unnamed.
  @id:lookup-herdr-unnamed-no-label
  Scenario: a herdr pane nobody named carries no label, with no comparison needed to tell
    Given a herdr pane that has never been renamed
    When the live panes are listed
    Then that pane reports no label, because herdr omits the name outright until one is set

  @id:lookup-wezterm-never-labeled
  Scenario: a wezterm pane never carries a label, because nothing can ever set one
    Given a wezterm pane, any pane
    When the live panes are listed
    Then that pane reports no label
    # Not a filtering rule like tmux's hostname guard — there is no primitive at all to title a pane
    # on this backend (see rename), so `title` is always the ambient running-program name, never
    # something a human or cyber-mux chose. Reporting it as a label would manufacture the exact
    # collision (every shell pane named the same thing) the hostname guard exists to prevent, with no
    # way for an author to ever override it here.

  # ── Resolving a pane locator — a name or an id, and the ambiguity decision ──
  # Neither backend requires a label unique, herdr labels every new workspace's root tab 1, and a
  # label reaches a live pane because a person set it by hand — so duplicates arrive by default.
  # Refusing them at authoring time was only ever a guess about what the author meant; at LOOKUP time
  # the ambiguity is a fact, the candidates are known, and the caller is present to resolve it.

  @id:lookup-verb-resolves-by-name
  Scenario Outline: every pane verb addresses a pane by name as readily as by id
    Given three live panes, labeled worker, sidebar and logs
    When a caller runs <verb> naming worker rather than the pane's id
    Then the verb acts on the pane labeled worker, exactly as if that pane's id had been passed
    And neither of the other two panes is acted on

    Examples:
      | verb                         |
      | cyber-mux read               |
      | cyber-mux submit             |
      | cyber-mux exists             |
      | cyber-mux focus              |
      | cyber-mux close              |
      | cyber-mux send text          |
      | cyber-mux send keys          |
      | cyber-mux template save --from |

  @id:lookup-wezterm-name-never-resolves
  Scenario: a name never resolves a wezterm pane — only an id can
    Given a live wezterm pane and a caller naming some word as if it were a label
    When a caller runs any pane verb naming that word
    Then it fails as a pane that could not be resolved, the same as any name matching no live pane
    # Not a gap in the resolution ladder — a direct consequence of wezterm never carrying a label at
    # all (see the live-pane-listing scenario above): with no pane ever reporting one, a name can
    # never match, so every pane verb on wezterm is reachable by id alone.

  # An ambiguous name is handled identically by every pane verb: it acts on none of the matching panes,
  # none guessing which was meant. The PAYLOAD of that failure — reported on stdout under ambiguous-pane
  # at exit 2 — is the CLI surface in ../../cli/lookup.
  @id:lookup-ambiguous-name-fails-all-verbs
  Scenario Outline: an ambiguous name fails the same way on every pane verb, acting on none
    Given three live panes all labeled worker
    When a caller runs <verb> naming worker
    Then the verb fails, having acted on none of the three panes
    And every pane verb refuses an ambiguous name identically, none guessing which pane was meant

    Examples:
      | verb                         |
      | cyber-mux read               |
      | cyber-mux submit             |
      | cyber-mux exists             |
      | cyber-mux focus              |
      | cyber-mux close              |
      | cyber-mux send text          |
      | cyber-mux send keys          |
      | cyber-mux template save --from |

  # An id outranks a name, so every caller that works today keeps working: an id can never be made
  # to mean something else by a person renaming an unrelated pane. Ambiguity is a fuzzy-tier
  # condition only — the same ladder git, Docker and tmux resolve their own targets by.
  @id:lookup-id-outranks-label-collision
  Scenario: an id addresses the pane whose id it is, even when another pane is labeled with that id
    Given a live pane whose id is a string, and a different live pane labeled with that same string
    When a caller names that string
    Then the pane whose id it is, is the one addressed
    And no ambiguity is reported, because the two matches are not peers

  # The counter-case a syntax rule cannot survive: %9 is id-SHAPED, but no pane carries it as an id
  # and one carries it as a label. A resolver that sniffs the shape calls this a missing pane; a
  # resolver that asks the live list finds the label. Docker sniffs (`sg-` → an id) and it is the
  # cheaper rule — refused here because encoding a backend's id format in the CLI is the backend leak
  # this seam exists to prevent, and a new backend would owe a new syntax rule.
  @id:lookup-id-matched-not-by-shape
  Scenario: an id is recognized by matching a live pane, never by the shape of the string
    Given a live pane labeled %9, and no live pane whose id is %9
    When a caller names %9
    Then it resolves to the pane labeled %9
    And it is neither reported as a pane that does not exist, nor refused for looking like an id

  @id:lookup-name-matches-one-resolves
  Scenario: a name matching exactly one live pane resolves to it and the command proceeds
    Given three live panes, exactly one of them labeled worker
    When a caller names worker
    Then it resolves to that pane, and the command proceeds against it
    And neither of the other two panes is acted on

  # Zero matches is the not-found path, distinct from two-or-more. The exit-1 rendering of a
  # pane-not-found is the CLI surface in ../../cli/lookup (the error-surface outline).
  @id:lookup-name-matches-none-not-found
  Scenario: a name matching no live pane is not found, rather than ambiguous
    Given no live pane labeled worker, and no live pane whose id is worker
    When a caller names worker
    Then it fails as a pane that could not be resolved, not as an ambiguity

  @id:lookup-name-matches-many-fails
  Scenario: a name matching two or more live panes fails rather than guessing which was meant
    Given three live panes all labeled worker
    When a caller names worker
    Then the command fails, having acted on none of them
    And the matching entries are yielded — each with its id, label and working directory — so the caller can choose between them
    # The three fields are the ones that discriminate: a report listing `worker, worker` helps nobody,
    # and each candidate's id is directly usable as the retry. The RENDERING of those entries as a
    # structured error on stdout is the CLI surface in ../../cli/lookup.

  @id:lookup-label-with-spaces-resolves
  Scenario: a label containing spaces resolves to its pane
    Given a tmux pane labeled my worker
    When a caller names my worker
    Then it resolves to that pane, the whole label including its space taken as one locator
    And no part of the label is treated as a separate token
    # The rendering half — that the list table lists the label and working directory whole, never
    # corrupting the column beside them — is the CLI surface in ../../cli/lookup.
