@frozen
Feature: cyber-mux open — the CLI placement surface
  The `cyber-mux open` verb's own flags — --at, --launch, and --env — how they are parsed, defaulted,
  validated, and refused, and how each hands its value to the library open contract. What that contract
  DOES with a placement, a launch command, or an env variable — the adapter behavior per backend — lives
  in ../../mux/placement/placement.feature; this suite owns the CLI flag surface alone.

  # ── --at — choosing where the pane opens ──
  # --at is the flag that selects the placement. Where each placement value LANDS on each backend — the
  # visible-space, native-tab, and split mappings — is the library's, in ../../mux/placement; this band
  # owns only that the flag is read, defaulted when omitted, and refused when out of set.

  Scenario: --at chooses where the new pane opens
    Given a caller running cyber-mux open --at pane:down
    When open runs
    Then the pane opens at that placement

  Scenario: --at accepts only pane:right, pane:down, tab, and workspace
    Given a caller running cyber-mux open
    When it passes an --at value outside pane:right|pane:down|tab|workspace
    Then the command is rejected before any pane opens
    # How a rejected flag is rendered and what it exits — the usage-error contract shared by every verb
    # — is cli/lookup's; see ../lookup/. This scenario owns only that an --at value outside the four is
    # refused before any pane opens, not the shape of the message it is refused with.

  # ── --launch — optional, carrying a command to the pane the verb opens ──
  # --launch is optional at the CLI, and when given it carries a command line into the open contract.
  # What the contract DOES with it — submit-and-run versus a blank pane — is the library's, in
  # ../../mux/placement/placement.feature; this band owns only the flag's optionality and its handoff.

  Scenario: open with no --launch still opens a pane — the flag is optional
    Given a caller running cyber-mux open with no --launch
    When open runs
    Then the verb opens a pane rather than treating the absent flag as an error

  Scenario: open --launch hands its command line to the pane the verb opens
    Given a caller running cyber-mux open --launch with a command line
    When open runs
    Then that command line is handed to the open contract as the launch command for the pane it opens

  # ── --env, the CLI surface for the seam's env option ──
  # env is the one split option with a CLI flag — `from` and `ratio` have none. It is on every verb
  # that OPENS a pane, because a variable a caller cannot set at birth is one they cannot set at all:
  # nothing else in the CLI reaches the pane before its shell starts. What the flag does to a pane
  # already open is not this block's business; there is no such verb. What env MEANS — native at the
  # birth of each tier, the fallback onto a command, and whether a route carried it — is the library
  # contract in ../../mux/placement/placement.feature; this block owns only the FLAG: how KEY=VALUE is
  # parsed, that it repeats, that it is refused alongside --template, and where it degrades.

  Scenario Outline: --env sets the variable in the pane the verb opens, on every route that carries env
    Given a caller running <verb> with --env ROLE=worker, on a route that carries env natively
    When it runs
    Then the pane the verb opens carries ROLE=worker

    Examples:
      | verb          |
      | open          |
      | worktree add  |
      | worktree open |

    # Exactly one pane is opened on each of these routes, so "which pane" needs no rule: it is the
    # one the verb opened. A template's per-pane env is template's business, and --template is refused
    # alongside --env for that reason.
    #
    # "On a route that carries env natively" is the load-bearing qualifier, NOT throat-clearing:
    # every route carries env EXCEPT herdr's worktree bind, and on that one this Then is false. The
    # two scenarios below own that exception — read them as this Outline's carve-out, not as
    # unrelated siblings. An unqualified claim here would be a property of the CLI that is silently
    # false on one backend's one route, which is this project's recurring defect rather than a
    # hypothetical one.

  Scenario Outline: --env on the one route that cannot carry it rides in on --launch
    Given a caller running <verb> --env ROLE=worker --launch a command, at workspace on herdr
    When it runs
    Then the pane the verb opens runs the command with ROLE=worker set

    Examples:
      | verb          |
      | worktree add  |
      | worktree open |

    # The bind route lost env at birth, so it is handed to the command instead. The variable lands;
    # the route it took to get there is the seam's business, not the caller's.
    #
    # BOTH worktree verbs, because both are exposed identically: herdr's worktree create and worktree
    # open each take no env parameter and each refuse the flag. Covering only one is how a compensation
    # gets wired on the verb that has a scenario and forgotten on the verb that does not.

  Scenario Outline: --env on the one route that cannot carry it, with no command to ride, warns
    Given a caller running <verb> --env ROLE=worker with no --launch, at workspace on herdr
    When it runs
    Then the pane the verb opens does not carry ROLE
    And a warning names ROLE as not having reached it

    Examples:
      | verb          |
      | worktree add  |
      | worktree open |

    # The honest half of the exception. herdr's worktree verbs take no env parameter and there is no
    # command to prefix, so the variable genuinely does not land — and the caller is TOLD, rather
    # than left to discover it. The alternative is refusing --env on herdr's worktree route, which
    # would make identical flags succeed on tmux and fail on herdr — the backend leak the seam
    # exists to prevent.

  Scenario Outline: --env is repeatable, one variable per flag, on every verb that has it
    Given a caller running <verb> with --env ROLE=worker and --env TIER=gpu, on a route that carries env
    When it runs
    Then the pane the verb opens carries both variables

    Examples:
      | verb          |
      | open          |
      | worktree add  |
      | worktree open |

    # Repeatability is per-REGISTRATION mechanics, not parsing: a verb that registers the flag without
    # its collector keeps only the last value and silently discards the rest. So it is pinned on every
    # verb rather than one — a flag wired repeatably where a scenario watches and non-repeatably where
    # none does is this project's recurring defect wearing its plainest disguise.

  Scenario Outline: --env is refused alongside --template, which owns its own panes' env
    Given a caller running <verb> with both --template and --env
    When it runs
    Then the command is rejected before any pane opens
    And the reason names the two flags as the conflict

    Examples:
      | verb         |
      | open         |
      | worktree add |

    # The exact shape of --launch's conflict with --template, for the exact reason: the template owns
    # what is IN the panes it declares. A caller wanting both edits the template.
    #
    # Both verbs that HAVE --template, not just one — `worktree open` carries no --template at all, so
    # the pair is unreachable there and pinning it would specify what no route can reach.

  Scenario Outline: --env without a KEY=VALUE pair is rejected before any side effect
    Given a caller running <verb> with --env <bad>
    When it runs
    Then the command is rejected before <side effect>
    And the reason names the expected KEY=VALUE form

    Examples:
      | verb          | bad     | side effect             |
      | open          | ROLE    | any pane opens          |
      | open          | =worker | any pane opens          |
      | worktree add  | ROLE    | the checkout is created |
      | worktree add  | =worker | the checkout is created |
      | worktree open | ROLE    | any workspace opens     |
      | worktree open | =worker | any workspace opens     |

    # Rejected BEFORE the side effect, like every other malformed input — and the side effect DIFFERS
    # by verb, which is why each is named rather than generalized to "opens". A worktree half-created
    # by a typo in an env flag is the outcome resolution-precedes-side-effects exists to prevent, and
    # only `worktree add` can produce it: pinning this on `open` alone would test the one verb that
    # carries no checkout to leave behind. The sibling pair at template.feature's resolution block
    # splits the same guarantee per verb for the same reason.
    #
    # A missing `=` and an empty KEY are both malformed; a missing `=` cannot be read as a key with
    # no value, because the shell hands over one word either way and only the `=` distinguishes them.

  Scenario Outline: --env with an empty value sets the variable empty, rather than rejecting
    Given a caller running <verb> with --env ROLE=, on a route that carries env
    When it runs
    Then the pane the verb opens carries ROLE set to an empty value

    Examples:
      | verb          |
      | open          |
      | worktree add  |
      | worktree open |

    # A real thing to want — it is how a caller empties a variable for a program that tests presence
    # rather than content. Only a MISSING `=` is malformed; a present one with nothing after it is an
    # answer.

  Scenario Outline: an env value containing = splits on the first = only
    Given a caller running <verb> with --env URL=k=v, on a route that carries env
    When it runs
    Then the pane the verb opens carries URL set to k=v

    Examples:
      | verb          |
      | open          |
      | worktree add  |
      | worktree open |

    # The value is arbitrary and routinely contains `=` (a URL query, a base64 pad). The key cannot,
    # so the first `=` is the only unambiguous boundary.
    #
    # Pinned per verb, like every other --env rule here. An earlier draft pinned these on `open` alone
    # and leaned on a scenario asserting the flag was "defined once and shared" to carry them to the
    # other verbs — but that asserted the SHAPE OF THE CODE, which no black-box subject can fail, so
    # it verified nothing and left these two rules unpinned on two verbs. Sharing the definition is
    # the obvious way to satisfy these rows and remains the right implementation; it is simply not
    # something a suite can assert. The suite pins behavior per verb; the code may share as it likes.
