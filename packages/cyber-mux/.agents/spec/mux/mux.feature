@frozen
Feature: mux — the pane abstraction
  Which backend (tmux/herdr) is available, where a new pane opens, and how a caller detects the
  multiplexer it is really running inside, plus per-pane send/read/focus/close once opened.

  # ── The session backend is selected by environment ──
  # The backend is a parameter of one contract, not a second subject — one adapter per env.

  Scenario Outline: the session backend is selected by environment
    Given a caller with <env>
    When cyber-mux open runs
    Then the new pane is opened through the <adapter> adapter

    Examples:
      | env                         | adapter |
      | $TMUX set                   | tmux    |
      | $HERDR_ENV set and no $TMUX | herdr   |
      | $WEZTERM_PANE set           | wezterm |

  Scenario: no backend detected errors before opening anything
    Given a caller with none of $TMUX, $HERDR_ENV, or $WEZTERM_PANE set
    When cyber-mux open runs
    Then it throws naming tmux/herdr/wezterm as the required backend
    # A stale-mistake fix, not a narrowing: this scenario always meant "no multiplexer this process
    # can drive is detected", which a two-env Given happened to fully express before a third backend
    # existed. Widening the Given/Then to name all three keeps the SAME coverage — a caller with none
    # of the three still throws — rather than changing what is asserted.

  # ── Placement ──

  Scenario: --at chooses where the new pane opens
    Given a caller running cyber-mux open --at pane:down
    When open runs
    Then the pane opens at that placement

  Scenario: --at omitted falls back to tab
    Given a caller running cyber-mux open with no --at
    When open runs
    Then the adapter's own at ?? 'tab' fallback opens a new tab, same as --at tab

  # ── workspace — its own visible space, mapped to each backend's own-visible-space unit ──

  Scenario Outline: --at workspace opens the pane's own VISIBLE space on each backend
    Given a caller running cyber-mux open --at workspace with <env>
    When open runs
    Then the pane opens in its own space that is visible in the attached client through the <adapter> adapter

    Examples:
      | env                         | adapter |
      | $TMUX set                   | tmux    |
      | $HERDR_ENV set and no $TMUX | herdr   |
      | $WEZTERM_PANE set           | wezterm |

  Scenario: tmux --at workspace opens a visible window in the current session, never a detached session
    Given a caller running cyber-mux open --at workspace with $TMUX set
    When open runs
    Then the tmux adapter opens a new window in the caller's current session, visible in its status bar
    And it does not open a detached (new-session) session the attached client cannot see or beam to

  Scenario: herdr --at workspace creates its own workspace, unattached to any repo
    Given a caller running cyber-mux open --at workspace with $HERDR_ENV set and no $TMUX
    When open runs
    Then the herdr adapter creates a new workspace of its own
    # `open` is placement, not worktree work: the workspace it creates carries no worktree record,
    # so herdr does not know it belongs to a repo and never groups it. Grouping is the `worktree`
    # verbs' job — see the worktree/workspace binding section below.
    And the workspace is not bound to any repo, even when its cwd is a worktree checkout

  Scenario: wezterm --at workspace spawns a new window into a freshly named workspace
    Given a caller running cyber-mux open --at workspace with $WEZTERM_PANE set
    When open runs
    Then the wezterm adapter spawns a new window with --new-window and a fresh --workspace name
    # WezTerm's --workspace both selects AND creates: reusing "default" (the CLI's own default when
    # the flag is omitted) would join whatever the caller was already in rather than opening the
    # pane's OWN space, so a name is always minted here, using --label as the name when the caller
    # gave one.
    And the new window does not join the caller's current workspace

  Scenario Outline: --at tab opens a new tab in the current window, never a split pane
    Given a caller running cyber-mux open --at tab with <env>
    When open runs
    Then the pane opens as a new tab through the <adapter> adapter
    And the caller's current pane is not split

    Examples:
      | env                         | adapter |
      | $TMUX set                   | tmux    |
      | $HERDR_ENV set and no $TMUX | herdr   |
      | $WEZTERM_PANE set           | wezterm |

  Scenario: the tab placement opens in the background without stealing focus
    Given a caller running cyber-mux open --at tab
    When open runs
    Then the new tab is opened without moving input focus off the caller's session

  # ── open reports the workspace the new pane landed in ──
  # Not just a pane id: a caller holding several panes can group them by the space they occupy.
  # Absent — never a false "none" — on a backend with no workspace tier, the same convention the
  # focus probe's `unknown` follows.

  # Two levels, deliberately separate: what `open` RETURNS (the seam, below) and what the CLI PRINTS
  # (further down). The seam is the fact's source; every surface that reports it — the bare `open`
  # report and the template manifest (see template/) — reads it from there rather than asking again.

  Scenario Outline: open returns the workspace the new pane landed in
    Given a caller running cyber-mux open --at <placement> with $HERDR_ENV set and no $TMUX
    When open runs
    Then the adapter's open returns the new pane carrying <workspace>

    Examples:
      | placement  | workspace                                                  |
      | workspace  | the workspace it created                                   |
      | tab        | the workspace the new tab was created in                   |
      | pane:right | the workspace the split landed in — the caller's own       |

  Scenario Outline: wezterm reports the workspace on every placement, never absent
    Given a caller running cyber-mux open --at <placement> with $WEZTERM_PANE set
    When open runs
    Then the adapter's open returns the new pane carrying <workspace>
    # Every WezTerm pane belongs to SOME workspace, even the implicit "default" one — unlike tmux,
    # which has no tier at all to report, this is never absent on any placement.

    Examples:
      | placement  | workspace                                                  |
      | workspace  | the workspace it created                                   |
      | tab        | the workspace of the window the tab was created in        |
      | pane:right | the workspace the split landed in — the caller's own       |

  Scenario: wezterm's workspace and tab cost a follow-up call, unlike herdr's free report
    Given a caller running cyber-mux open with $WEZTERM_PANE set
    When open runs
    Then the tab, and on a tab or pane:* placement the workspace, are read from a separate wezterm cli list call
    # spawn/split-pane report ONLY the new pane's bare id — neither embeds the tab or workspace the
    # way tmux's -F format or herdr's JSON envelope does. The `workspace` placement is the one
    # exception: the workspace name is what open() itself picked, so reporting it costs nothing.

  Scenario: a backend with no workspace tier returns no workspace at all
    Given a caller running cyber-mux open with $TMUX set
    When open runs
    Then the adapter's open returns the new pane carrying no workspace
    # Absent, not a false "none". tmux has no workspace tier — `workspace` and `tab` both collapse to
    # a Window — so it has nothing to report, which is not the same as reporting nothing is there.

  Scenario: the workspace costs no extra backend call
    Given a caller running cyber-mux open with $HERDR_ENV set and no $TMUX
    When open runs
    Then the workspace is read from the same backend output the pane id is read from
    # Every herdr route already emits the pane's own workspace_id. Probing for it separately would
    # buy nothing and cost a round trip per open.

  Scenario Outline: open reports the workspace alongside the pane it opened
    Given a caller running cyber-mux open --format json with <env>
    When open runs
    Then stdout carries the pane and <workspace>
    # Nothing is looked up to answer this: the backend already said so when the pane was opened, and
    # the seam already carries it. Reporting it is what makes a caller able to group the panes it
    # holds by the space they occupy — the point of knowing it at all — rather than that fact
    # reaching only a `--template` caller through the manifest.

    Examples:
      | env                         | workspace                                          |
      | $HERDR_ENV set and no $TMUX | the workspace it landed in                         |
      | $TMUX set                   | a null workspace — no workspace tier to report from |
      | $WEZTERM_PANE set           | the workspace it landed in                         |

  Scenario: the workspace a pane landed in is not a worktree binding
    Given a caller running cyber-mux worktree add --branch my-feature --at pane:right on a backend that binds
    When add runs
    Then the pane it opened landed in the caller's workspace
    And the worktree is still reported as bound to no workspace
    # One workspace tier, two questions. Occupancy — which workspace a pane LIVES IN — is what open
    # answers. Binding — whether a worktree is GROUPED to a workspace — is the worktree report's, and
    # it stays null here because a split creates no binding. Neither answers for the other: a pane
    # sitting in a workspace is never evidence that its worktree was grouped there.

  Scenario: --at accepts only pane:right, pane:down, tab, and workspace
    Given a caller running cyber-mux open
    When it passes an --at value outside pane:right|pane:down|tab|workspace
    Then the command is rejected before any pane opens

  # ── Split options — what a split can be told: which pane, how big, what environment ──
  # The seam's own contract, stated at the seam: these scenarios address open() directly rather than
  # a `cyber-mux open` command line, because the seam is what they pin. `from` and `ratio` have no
  # CLI flag at all; `env` has one, specified as its own surface in the `--env` block below rather
  # than here — what the flag DOES is that block's business, what env MEANS is this one's. The template
  # capability is another such caller; what a template DOES with these is template's business.

  Scenario Outline: from names the pane a pane:* split targets
    Given a caller opening at pane:right through the <adapter> adapter, with from naming a pane
    When open runs
    Then the backend is told to split that named pane, via <how>

    Examples:
      | adapter | how                                        |
      | tmux    | -t and the pane id                         |
      | herdr   | the pane id passed positionally, no --from |
      | wezterm | --pane-id and the pane id                  |

  Scenario Outline: from omitted leaves each backend its own default, which tracks the USER's focus
    Given a caller opening at pane:right through the <adapter> adapter, with no from
    When open runs
    Then the backend is left to choose the pane itself, receiving <marker>

    Examples:
      | adapter | marker                                          |
      | tmux    | no pane-targeting flag at all                   |
      | herdr   | its own --current placeholder                   |
      | wezterm | no --pane-id, defaulting to $WEZTERM_PANE itself |

    # This is why `from` exists and why a caller should pass it. The two defaults disagree, and both
    # track the pane the USER is looking at: tmux always splits the session's ACTIVE pane and
    # ignores $TMUX_PANE entirely; herdr resolves --current from $HERDR_PANE_ID, silently falling
    # back to the UI-focused pane when that is unset. They agree while a human is typing and diverge
    # exactly when a program is driving. Naming the pane is the only way pane:right means the same
    # thing on both backends.

  Scenario Outline: from is ignored by tab and workspace, which split nothing
    Given a caller opening at <at> through the <adapter> adapter, with from naming a pane
    When open runs
    Then the pane id is not passed to the backend at all

    Examples:
      | at        | adapter |
      | tab       | tmux    |
      | workspace | tmux    |
      | tab       | herdr   |
      | workspace | herdr   |
      | tab       | wezterm |
      | workspace | wezterm |

  Scenario Outline: the ratio sign convention converts in opposite directions per backend
    Given a caller opening at pane:right through the <adapter> adapter, with ratio 0.333
    When open runs
    Then the backend receives <flag>

    Examples:
      | adapter | flag          |
      | herdr   | --ratio 0.333 |
      | tmux    | -l 67%        |
      | wezterm | --percent 67  |

    # ratio is the fraction kept by `first` — the ORIGINAL pane, not the new one. herdr's --ratio
    # sizes the original, so it passes through unconverted; tmux's -l sizes the NEW pane, so it takes
    # 1 - ratio. Applying the inversion to both backends, or to neither, is the single most likely
    # way to get a split backwards, and fails one of these rows.

  Scenario Outline: ratio omitted leaves each backend its own even default
    Given a caller opening at pane:right through the <adapter> adapter, with no ratio
    When open runs
    Then no sizing flag reaches the backend, which splits the region evenly

    Examples:
      | adapter |
      | tmux    |
      | herdr   |
      | wezterm |

  Scenario Outline: ratio is a split concept — a tab or workspace is never sized against a pane
    Given a caller opening at <at> through the tmux adapter, with a ratio
    When open runs
    Then no sizing flag reaches the backend, because a window is not sized against a pane

    Examples:
      | at        |
      | tab       |
      | workspace |

  Scenario Outline: ratio is a split concept on wezterm too — a tab or workspace is never sized against a pane
    Given a caller opening at <at> through the wezterm adapter, with a ratio
    When open runs
    Then no --percent flag reaches wezterm, because a window is not sized against a pane

    Examples:
      | at        |
      | tab       |
      | workspace |

  Scenario Outline: env is set natively at the birth of whatever tier is opened
    Given a caller opening at <at> through the <adapter> adapter, with env ROLE=worker
    When open runs
    Then the backend receives <flag> on the command that creates the space

    Examples:
      | at         | adapter | flag              |
      | pane:right | tmux    | -e ROLE=worker    |
      | tab        | tmux    | -e ROLE=worker    |
      | workspace  | tmux    | -e ROLE=worker    |
      | pane:right | herdr   | --env ROLE=worker |
      | tab        | herdr   | --env ROLE=worker |
      | workspace  | herdr   | --env ROLE=worker |

    # env reaches EVERY tier, not just a split, and that is load-bearing rather than incidental: a
    # pane pool's root pane is born by the region open and never by a split, so a seam that scoped
    # env to pane:* would drop it silently exactly where a caller needs it.

  Scenario Outline: env is native at NO tier on wezterm — every route takes the fallback, not just one
    Given a caller opening at <at> through the wezterm adapter, with env ROLE=worker
    When open runs
    Then no --env flag reaches wezterm on any tier
    And the env rides the same command-prefix-or-warn fallback herdr's worktree route alone uses

    Examples:
      | at         |
      | pane:right |
      | tab        |
      | workspace  |

    # Unlike herdr, which is native everywhere but ONE route, wezterm's CLI has no --env flag on
    # spawn or split-pane at all — every route is the exception here, not just the worktree one.

  Scenario Outline: each env variable gets its own flag, in the order given
    Given a caller opening through the <adapter> adapter, with env ROLE=worker and TIER=gpu
    When open runs
    Then the backend receives one repeated flag per variable, ROLE before TIER

    Examples:
      | adapter |
      | tmux    |
      | herdr   |

  Scenario Outline: env with no launch opens a blank shell carrying the env
    Given a caller opening through the <adapter> adapter, with env and no launch
    When open runs
    Then the pane is created with the env set
    And nothing is typed, sent, or run into it

    Examples:
      | adapter |
      | tmux    |
      | herdr   |

  Scenario: herdr's worktree verbs cannot set env at birth, and drop it rather than failing
    Given a caller creating or opening a worktree workspace through the herdr adapter, with env
    When it runs
    Then no env flag reaches herdr's worktree command
    # The one tier where env is NOT native: herdr's worktree create/open take no env parameter and
    # refuse the flag outright. Dropping it keeps the worktree route working; a caller that needs env
    # there carries it some other way.

  # The "some other way" above, made concrete. The scenario above stays exactly true — the prefix
  # rides in on the command the pane RUNS, never on herdr's worktree command — so what follows is the
  # compensation, not a reversal of the drop.
  #
  # These state the rule ONCE, and both callers inherit it rather than restating it: `--env` pins what
  # a user observes per verb (the `--env` block below) and `template/` pins what a TEMPLATE does with it
  # (root pane only, warned once — its "Ratio and env" block). Neither is a duplicate of this
  # and neither may contradict it. Unlike `ratio`, whose degrade policy is template's alone because
  # template is its only caller, env has two callers — so the rule lives here, where env's MEANING
  # already does, and a caller cannot quietly invent its own.

  Scenario Outline: whether a route carried env is reported by the route, because only it knows
    Given a caller opening a region with env via <route>
    When it runs
    Then the opened region reports env as <carried>

    Examples:
      | route                            | carried     |
      | herdr's worktree bind            | not carried |
      | the plain git worktree fallback  | carried     |
      | a direct open on herdr           | carried     |
      | a direct open on tmux            | carried     |
      | a direct open on wezterm, any tier | not carried |

    # The report is the SEAM's answer to its caller, not a message to a human — it is what makes the
    # compensation below possible, and a caller cannot see which route ran to work it out. Reported
    # rather than inferred, for the same reason the workspace grouping is. A route reporting "not
    # carried" unconditionally is as wrong as one reporting "carried" unconditionally, which is why
    # both directions are pinned here.

  Scenario: env a route could not carry rides in on the command instead
    Given a region opened with env the route could not carry, and a command to run in it
    When the command is run
    Then the command is prefixed with env KEY=VALUE
    And the variable is set for the command that runs
    # A last resort, and its cost is why: the values land in ps output and the pane's shell history.
    # It is still strictly better than the silent drop it replaces.

  Scenario: env a route could not carry, with no command to ride, warns rather than vanishing
    Given a region opened with env the route could not carry, and no command to run in it
    When it runs
    Then a warning names the variables that did not reach the region
    And the warning goes to stderr, leaving stdout machine-readable
    # The prefix only works by riding a command line. With no command there is nothing to ride, and
    # the honest outcome is to say so — a caller that asked for env and silently did not get it is
    # the quiet failure this whole block exists to prevent.

  Scenario Outline: a route that set env natively never prefixes it on top
    Given a region opened at <at> with env the <adapter> adapter carried natively, and a command
    When the command is run
    Then the command is run unprefixed

    Examples:
      | at         | adapter |
      | pane:right | tmux    |
      | tab        | tmux    |
      | workspace  | tmux    |
      | pane:right | herdr   |
      | tab        | herdr   |
      | workspace  | herdr   |

    # Every tier the positive rule above covers, covered again negatively — a subject that
    # double-prefixes at exactly one tier is otherwise caught by nothing.
    # Double-applying would be harmless in VALUE and wrong in truth: the values would land in ps
    # output and shell history on every route, which is exactly the cost the prefix is a last resort
    # to avoid paying. Only the route that lost env may compensate for it.

  Scenario: an env value carrying a space or a quote survives the prefix intact
    Given a region opened with env the route could not carry, whose value contains a space and a quote
    When the command is run
    Then the value reaches the command as one literal word
    # The prefix is a shell command line, so the value is quoted for one. Unquoted, a value with a
    # space splits into extra words and a value with a quote unbalances the line outright.

  # ── --env, the CLI surface for the seam's env option ──
  # env is the one split option with a CLI flag — `from` and `ratio` have none. It is on every verb
  # that OPENS a pane, because a variable a caller cannot set at birth is one they cannot set at all:
  # nothing else in the CLI reaches the pane before its shell starts. What the flag does to a pane
  # already open is not this block's business; there is no such verb.

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

  # ── The workspace group: carrying a grouping a backend has no tier for ──
  # A caller opening several tabs as one workspace needs them recognizable as a group afterwards. On a
  # backend with a real workspace tier that is free — the tier IS the group. On one without, the seam
  # carries an opaque group id the backend can store and be filtered by.

  Scenario: the open contract carries an opaque workspace group id
    Given a caller opening a tab with a workspace group id
    When open runs
    Then the id reaches the backend as an opaque value
    And it is never parsed, split, or derived from the label
    # the group id and the label are separate on purpose: a label is chosen by a human and may contain
    # anything, so recovering a grouping by parsing one is unsound

  Scenario: a backend with no workspace tier stores the group id natively
    Given a caller opening a tab through the tmux adapter, with a workspace group id
    When open runs
    Then the window carries the id as a window option the backend can filter on
    # tmux has no Workspace level, so the grouping has nowhere structural to live; a window option is
    # tmux's own mechanism for exactly this and survives a window rename

  Scenario: a backend with a real workspace tier ignores the group id
    Given a caller opening a tab through the herdr adapter, with a workspace group id
    When open runs
    Then no grouping flag reaches herdr
    # herdr's workspace IS the group and every pane and tab record already carries its workspace_id —
    # a second grouping would be a duplicate the backend never reads

  Scenario: wezterm also ignores the group id, for the same reason herdr does
    Given a caller opening a tab through the wezterm adapter, with a workspace group id
    When open runs
    Then no grouping call reaches wezterm
    # wezterm's workspace IS also a real tier — every window belongs to one — so there is nothing
    # left for a tag to add. Coarser than herdr's (per-WINDOW, since every tab in a window already
    # shares its workspace, and there is no move-tab-to-workspace primitive), but the same answer.

  Scenario: a group id is never invented for a caller that did not ask for one
    Given a caller opening a tab through the tmux adapter, with no workspace group id
    When open runs
    Then no window option is set
    # a window nobody grouped stays ungrouped, and reads back as a workspace of one

  Scenario: a space already open is grouped by the same verb open uses
    Given a caller grouping a tab that is already open through the tmux adapter
    When the grouping runs
    Then the backend stores the id on that space
    And it is the same command open itself issues to group a space it just created
    # open cannot be the only way in. A caller that did not open the space -- the worktree route opens
    # its region before the walk ever runs -- still has to group it, and it holds the space's own id
    # the moment the open returns. tmux has no birth flag for a window option anyway, so grouping is
    # ALREADY a second call after the window exists; routing open through this verb adds none.

  Scenario: a backend whose display name is composed stores the space's own name beside the group
    Given a caller grouping a tab through the tmux adapter, naming the tab editor
    When the grouping runs
    Then the backend stores editor as the space's own name
    And the space's own name is stored separately from its display name
    # tmux has ONE name field per space, so a caller that composes a display name out of the tab's name
    # DESTROYS the original -- and recovering it means splitting on a separator already proven
    # ambiguous. The same rule the group id follows, one tier down: the display name is a human's to
    # read, and an opaque option carries what a machine reads back.

  Scenario: a backend with a real workspace tier stores neither
    Given a caller grouping a tab through the herdr adapter
    When the grouping runs
    Then no grouping flag and no name flag reach herdr
    # its tier IS the group and its tab label IS the tab's own name, never composed -- so both are
    # facts the backend already holds

  Scenario: the group id is not a workspace, and open never reports it as one
    Given a caller opening a tab through the tmux adapter, with a workspace group id
    When open reports the pane
    Then the reported workspace is absent
    # absent rather than false, the same convention the focus probe's unknown follows: tmux has no
    # workspace tier, and a tag cyber-mux wrote is its own bookkeeping rather than a tier the backend
    # gained. Reporting it as a workspace would be a confident lie.

  # ── open reports the tab the pane landed in ──
  # The same move, and the same argument, as the workspace above: the backend already answered when
  # the pane was opened, so a surface that hid it would discard a fact it already held.

  Scenario Outline: open reports the tab the new pane landed in
    Given a caller opening at <at> through the <adapter> adapter
    When open runs
    Then the reported tab is the tab the pane landed in
    And it is read from the output the pane id already comes from

    Examples:
      | at         | adapter |
      | tab        | herdr   |
      | workspace  | herdr   |
      | pane:right | herdr   |
      | tab        | tmux    |
      | workspace  | tmux    |
      | pane:right | tmux    |

    # Every multiplexer has the Tab level — unlike the Workspace level, which only some have — so
    # every backend answers this and none reports it absent. herdr's create envelope carries the
    # pane's own tab id beside its pane id on every route: a new tab reports itself, a created
    # workspace reports its root tab, and a split reports the tab it landed in, which is the caller's.
    # tmux's Tab is its Window, so the answer is the window the pane landed in, read from the same
    # -F the pane id already rides out on. Either way the backend already answered when the pane was
    # opened, so it costs no extra call — the argument the workspace field is already reported on.

  Scenario: the reported tab is what names a new workspace's root tab
    Given a caller creating a workspace through the herdr adapter
    When the workspace's root tab is renamed using the tab open reported
    Then the rename addresses the tab rather than the pane
    # a rename addressed by a pane id is refused outright by herdr (tab_not_found) while tmux resolves
    # it and succeeds — so a caller reaching for the pane id would be green on one backend and
    # silently broken on the other. The reported tab is what makes the rename portable.

  # ── Naming a space after its birth ──
  # --label names a space AT birth wherever the backend's CLI allows. One tier cannot be: a new
  # workspace's root tab. So the seam also names a space that already exists.

  Scenario Outline: a space is named after birth on every backend
    Given a caller renaming an already-open <tier> through the <adapter> adapter
    When the rename runs
    Then the backend receives its own rename command for that tier

    Examples:
      | tier      | adapter |
      | tab       | tmux    |
      | tab       | herdr   |
      | pane      | tmux    |
      | pane      | herdr   |
      | tab       | wezterm |

    # Every backend can name every tier — the same breadth --label relies on at birth. tmux names a
    # window and a pane title; herdr renames a tab and a pane. This is the naming route for the one
    # case birth cannot serve, not a second way to do what --label already does. wezterm has no
    # `pane` row: unlike the other two, it cannot name a pane at all — see the dedicated scenario
    # below rather than a silent gap in this table.

  Scenario: wezterm cannot name a pane at any tier — rename throws rather than silently doing nothing
    Given a caller renaming an already-open pane through the wezterm adapter
    When the rename runs
    Then it throws, naming that wezterm has no way to title a pane
    # set-tab-title/set-window-title exist; there is no pane equivalent in the CLI at all. Throwing is
    # the honest answer — a silent no-op would report a rename that never happened as if it had.

  Scenario: every new tab on wezterm is named after birth, not just a new workspace's root tab
    Given a caller opening a tab through the wezterm adapter, with a label
    When open runs
    Then the tab is named by a set-tab-title call after the tab exists
    # spawn has no title flag at all (unlike tmux's -n or herdr's --label), so EVERY new tab takes
    # this route — not just the one root-tab case herdr has.

  Scenario: renaming is the only way to name a new workspace's root tab
    Given a caller creating a workspace through the herdr adapter
    When the workspace's root tab is given a name
    Then the name is set by a rename after the workspace exists
    # herdr labels a new workspace's root tab 1 and offers no flag to change it at birth. This is the
    # whole of the constraint the tab-naming non-goal generalized from — it binds the ROOT tab alone,
    # and every later tab takes --label at birth like any other space.

  Scenario: a rename moves no focus and opens nothing
    Given a caller renaming a tab the caller is not focused on
    When the rename runs
    Then the caller's focus is where it was
    And no space is created
    # a write as read-only in its side effects as isPaneFocused is: naming a space is not visiting it

  Scenario Outline: a backend declares whether it can size a split
    Given a caller asking the <adapter> adapter whether it can size a split
    When it reads the declaration
    Then the adapter answers yes

    Examples:
      | adapter |
      | tmux    |
      | herdr   |
      | wezterm |

    # The declaration is what lets a caller DEGRADE a ratio instead of failing when a backend cannot
    # honor one. Both real backends can size, so both say yes; an adapter that stays silent is taken
    # as cannot. What a caller does about a `no` is the caller's policy, not this seam's — see
    # template/, which warns once and takes the backend's own default.

  # ── --launch is optional — a blank pane is a valid open() outcome ──

  Scenario: open with no --launch creates a blank pane
    Given a caller running cyber-mux open with no --launch
    When open runs
    Then a new pane opens through the adapter
    And no launch command is sent or run into it

  Scenario: open --launch submits the command, so it actually runs
    Given a caller running cyber-mux open --launch with a command line
    When open runs
    Then the command is typed into the new pane and Enter is pressed
    And it does not sit staged unsent in the new pane's input box

  # ── Driving a pane's turn — text and keys are separate; only submit presses Enter FOR you ──
  # Typing text and pressing a named key are two different intents, so they are two different verbs
  # (`send text` / `send keys`) rather than one overloaded one. Neither adds an Enter the caller did
  # not write; `submit` always supplies one. `Enter` is itself a key, so `send keys <pane> Enter`
  # presses it and takes the turn — at the caller's explicit request, not the verb's initiative.

  Scenario Outline: send text types literal text and presses no Enter
    Given a caller running cyber-mux send text against a pane with <env>
    When it passes a word that is also the name of a key
    Then the word is typed into the pane as literal characters, not interpreted as that key
    And no Enter is appended, so the text is left staged in the pane's input box

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |
      | $WEZTERM_PANE set           |

  Scenario Outline: send keys presses core-vocabulary keys and types nothing
    Given a caller running cyber-mux send keys against a pane with <env>
    When it passes several keys from the portable core vocabulary
    Then each key is pressed in the pane, in the order the caller wrote them
    And each reaches the backend as its own key, never joined into one literal string

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |
      | $WEZTERM_PANE set           |

  Scenario: Backspace is the core's one renamed key, and tmux gets tmux's name for it
    Given a caller running cyber-mux send keys Backspace against a pane with $TMUX set
    When send keys runs
    Then tmux deletes the character before the cursor
    And the word Backspace is never delivered to the pane as literal characters

  Scenario: a non-core key that the backend does know is pressed
    Given a caller running cyber-mux send keys Home against a pane with $TMUX set
    When send keys runs
    Then the token reaches tmux unchanged, rather than being rejected by cyber-mux
    And tmux presses Home, a key the core vocabulary does not carry

  Scenario: a non-core token that the backend does not know is refused where the backend refuses
    Given a caller running cyber-mux send keys Home against a pane with $HERDR_ENV set and no $TMUX
    When send keys runs
    Then the token reaches herdr unchanged
    And herdr refuses it, reporting that key as unsupported

  Scenario: a token no backend knows is not rescued by cyber-mux on a backend that cannot refuse it
    Given a caller running cyber-mux send keys with a token that names no key at all, with $TMUX set
    When send keys runs
    Then the token reaches tmux unchanged
    And tmux types it as literal characters, because tmux has no way to refuse a key name

  Scenario: wezterm has no send-keys primitive at all — a key is its own raw terminal byte sequence
    Given a caller running cyber-mux send keys Up against a pane with $WEZTERM_PANE set
    When send keys runs
    Then the key is typed as its ANSI cursor-key escape sequence via send-text --no-paste
    # There is no key-name-taking verb in wezterm's CLI to forward a name TO — only send-text. The
    # core vocabulary is realized client-side as bytes rather than backend-side as a name.

  Scenario: a non-core key wezterm also knows (by the same extras a backend "knowing" Home means) is pressed
    Given a caller running cyber-mux send keys Home against a pane with $WEZTERM_PANE set
    When send keys runs
    Then Home is typed as its own escape sequence, not as the literal word "Home"

  Scenario: a token wezterm cannot encode is typed as its own literal characters, unable to refuse it
    Given a caller running cyber-mux send keys with a token that names no key at all, with $WEZTERM_PANE set
    When send keys runs
    Then the token is typed as literal characters via send-text
    # Nothing here ASKS wezterm anything — there is no backend to refuse a name, so an unencodable
    # token can only ever be typed, the same terminal case tmux's own key lookup falls back to.

  Scenario Outline: send keys Enter presses Enter and takes the turn, because the caller asked for it
    Given a pane with text already staged unsent in its input box, with <env>
    When cyber-mux send keys runs against it passing Enter
    Then Enter is pressed and the staged text is submitted, taking the pane's turn
    And it is not rejected, because Enter is a key like any other in the core vocabulary
    And no text is typed, because send keys types nothing

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |
      | $WEZTERM_PANE set           |

  Scenario: send keys with no key tokens is rejected
    Given a caller running cyber-mux send keys naming a pane but no key tokens
    When the command is parsed
    Then it is rejected before anything is sent to the pane

  Scenario: send text with no text argument is rejected
    Given a caller running cyber-mux send text naming a pane but no text
    When the command is parsed
    Then it is rejected before anything is sent to the pane

  Scenario: bare send is incomplete input, so it fails loud with help rather than acting
    Given a caller running cyber-mux send naming neither text nor keys
    When the command is parsed
    Then help naming text and keys as its subcommands is written to stdout
    And it exits 2, the status that separates bad input from a failed operation
    And nothing is sent to any pane

  Scenario Outline: submit with text types the text and presses Enter, taking the pane's turn
    Given a caller running cyber-mux submit against a pane with <env>
    When it passes a message as the optional text argument
    Then the message is typed into the pane and Enter is pressed, taking its turn

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |
      | $WEZTERM_PANE set           |

  Scenario Outline: submit types its text literally, never interpreting it as a key
    Given a caller running cyber-mux submit against a pane with <env>
    When it passes a message that is also the name of a key as the text argument
    Then the message is typed as literal characters and Enter is pressed
    And that key is never pressed, so the pane's own input history is not recalled and re-run

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |
      | $WEZTERM_PANE set           |

  Scenario Outline: submit with no text presses a bare Enter and retypes nothing
    Given a pane with text already staged unsent in its input box, with <env>
    When cyber-mux submit runs against it with no text argument
    Then a bare Enter keystroke is sent, flushing the staged buffer through the <adapter> adapter
    And no text is retyped, so a repeated flush cannot duplicate the staged message

    Examples:
      | env                         | adapter |
      | $TMUX set                   | tmux    |
      | $HERDR_ENV set and no $TMUX | herdr   |
      | $WEZTERM_PANE set           | wezterm |

  Scenario: submit with no pane is rejected
    Given a caller running cyber-mux submit naming no pane
    When the command is parsed
    Then it is rejected, naming pane as the missing argument
    And nothing is sent to any pane

  Scenario Outline: submit with empty text is the bare flush, not a second contract
    Given a pane with text already staged unsent in its input box, with <env>
    When cyber-mux submit runs against it with an empty text argument
    Then exactly one Enter is pressed and nothing is typed, the same as passing no text at all
    And the staged text is not duplicated

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |

  # ── Multiplexer detection is two-mode ──

  Scenario: $CYBER_MUX is trusted outright as a fast-path
    Given $CYBER_MUX=tmux and $CYBER_MUX_PANE=%3 are set
    When the mux probe runs
    Then it reports mux=tmux, pane=%3, via=env, without walking the process ancestry

  Scenario: $CYBER_MUX=none is an override even inside a real multiplexer
    Given $CYBER_MUX=none is set while $TMUX is also set
    When the mux probe runs
    Then it reports mux=none

  Scenario: absent the env fast-path, the probe walks the process ancestry from $$
    Given no $CYBER_MUX is set and a tmux server is an ancestor of the current process
    When the mux probe runs
    Then it reports mux=tmux via=ancestry, found by walking ppid/comm up from the current pid

  Scenario: $TMUX/$HERDR_ENV alone are not trusted — only a fast-positive hint the walk falls back to
    Given $TMUX is set but the ancestry walk itself is inconclusive
    When the mux probe runs
    Then it falls back to the $TMUX hint rather than declaring no multiplexer

  Scenario: doctor reports the detected mux and prints a pin hint
    Given a caller running behind a detected multiplexer
    When it runs cyber-mux doctor
    Then it reports mux, via, pane, and backend
    And it prints an export CYBER_MUX=<m> CYBER_MUX_PANE=<p> hint so the caller can pin the fast-path

  # ── mode reports the selected backend ──

  Scenario: mode reports the detected session backend
    Given a caller running inside a detected multiplexer
    When it runs cyber-mux mode
    Then it reports the selected session-backend name (tmux or herdr)

  Scenario: mode reports none when no backend is selectable
    Given a caller in no detectable multiplexer
    When it runs cyber-mux mode
    Then it reports "none" rather than erroring, and exits 0

  # ── Reporting whether a pane is currently focused (on screen for an attached client) ──

  Scenario: tmux reports a pane focused when an attached client is currently viewing it
    Given a tmux pane that is the active pane of the current window in a session with an attached client
    When the backend is asked whether that pane is focused
    Then it reports focused

  Scenario: tmux reports a pane not focused when no attached client is viewing it
    Given a tmux pane that is not the active pane, or whose window is not current, or whose session has no attached client
    When the backend is asked whether that pane is focused
    Then it reports not-focused

  Scenario: herdr reports a pane focused when its pane record is focused
    Given a herdr pane whose pane record reports it is currently being viewed by a client
    When the backend is asked whether that pane is focused
    Then it reports focused

  Scenario: herdr reports a pane not focused when its pane record is not focused
    Given a herdr pane whose pane record reports no client is currently viewing it
    When the backend is asked whether that pane is focused
    Then it reports not-focused

  Scenario: a focus query that cannot be answered is unknown, not a boolean
    Given a backend with no primitive to report focus, or a pane the backend can no longer resolve, or a focus query that errors
    When it is asked whether a pane is focused
    Then it answers unknown rather than a boolean, so callers fail open instead of treating the pane as absent

  Scenario: wezterm always reports unknown — it has no focus primitive at all, not just a per-query gap
    Given a wezterm pane, any pane
    When the backend is asked whether that pane is focused
    Then it reports unknown
    # `wezterm cli list --format json`'s documented fields carry no active/focused indicator for a
    # pane, tab, or window — unlike tmux/herdr, where unknown is a per-query FALLBACK, this is the
    # WHOLE backend's answer, every time, by the same honest convention.

  # ── list enumerates every live pane, not just agent-bearing ones ──

  Scenario: list enumerates every live pane, including one running no agent/harness
    Given a backend with a mix of panes, some running an agent/harness and some running none
    When it runs cyber-mux list
    Then every live pane is reported, whether or not it is running an agent/harness

  # ── Addressing a pane — a name or an id, and the candidates when a name is ambiguous ──
  # A label is a human name, not a key. Neither backend requires one unique, herdr labels every new
  # workspace's root tab 1, and a label reaches a live pane because a person set it by hand — so
  # duplicates arrive by default. Refusing them at authoring time was only ever a guess about what
  # the author meant; at LOOKUP time the ambiguity is a fact, the candidates are known, and the
  # caller is present to resolve it.

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

  Scenario: a name never resolves a wezterm pane — only an id can
    Given a live wezterm pane and a caller naming some word as if it were a label
    When a caller runs any pane verb naming that word
    Then it fails as a pane that could not be resolved, the same as any name matching no live pane
    # Not a gap in the resolution ladder — a direct consequence of wezterm never carrying a label at
    # all (see the live-pane-listing scenario below): with no pane ever reporting one, a name can
    # never match, so every pane verb on wezterm is reachable by id alone.

  Scenario Outline: an ambiguous name fails the same way on every pane verb
    Given three live panes all labeled worker
    When a caller runs <verb> naming worker
    Then the candidates are reported on stdout under the code ambiguous-pane
    And it exits 2, having acted on none of the three panes

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
  Scenario: an id addresses the pane whose id it is, even when another pane is labeled with that id
    Given a live pane whose id is a string, and a different live pane labeled with that same string
    When a caller names that string
    Then the pane whose id it is, is the one addressed
    And no ambiguity is reported, because the two matches are not peers

  # The counter-case a syntax rule cannot survive: %9 is id-SHAPED, but no pane carries it as an id
  # and one carries it as a label. A resolver that sniffs the shape calls this a missing pane and
  # exits 1; a resolver that asks the live list finds the label. Docker sniffs (`sg-` → an id) and it
  # is the cheaper rule — refused here because encoding a backend's id format in the CLI is the
  # backend leak this seam exists to prevent, and a new backend would owe a new syntax rule.
  Scenario: an id is recognized by matching a live pane, never by the shape of the string
    Given a live pane labeled %9, and no live pane whose id is %9
    When a caller names %9
    Then it resolves to the pane labeled %9
    And it is neither reported as a pane that does not exist, nor refused for looking like an id

  Scenario: a name matching exactly one live pane resolves to it and the command proceeds
    Given three live panes, exactly one of them labeled worker
    When a caller names worker
    Then it resolves to that pane, and the command proceeds against it
    And neither of the other two panes is acted on

  Scenario: a name matching no live pane is not found, rather than ambiguous
    Given no live pane labeled worker, and no live pane whose id is worker
    When a caller names worker
    Then it fails as a pane that could not be resolved
    And it exits 1

  Scenario: a name matching two or more live panes fails rather than guessing which was meant
    Given three live panes all labeled worker
    When a caller names worker
    Then the command fails, having acted on none of them
    And the matching entries are reported, so the caller can choose between them

  Scenario: the ambiguity report carries what tells the candidates apart, and what retries them
    Given three live panes all labeled worker, each in a different working directory
    When a caller names worker
    Then each candidate is reported with its id, its label, and its working directory
    And each candidate's id is directly usable as the retry that resolves the ambiguity

  # The report goes to stdout because that is the stream AXI reserves for what the agent consumes —
  # data, errors and suggestions alike — while stderr is defined as debug the agent does not read. A
  # report whose whole purpose is handing a caller the candidates to retry with is the last thing that
  # belongs on the ignored stream. This does not muddy the payload: a verb either succeeds and writes
  # its result or fails and writes its error, never both, so the exit code tells the two apart before
  # anything is parsed.
  Scenario: the ambiguity report is a structured error on stdout, where the agent reads
    Given two live panes labeled worker
    When a caller names worker
    Then the report is written to stdout under the stable code ambiguous-pane
    And stderr is left empty, carrying no part of the answer
    And it exits 2

  Scenario: --format json emits the ambiguity as a structured error carrying its candidates
    Given two live panes labeled worker
    When a caller names worker with --format json
    Then the error carries the code ambiguous-pane and the candidate entries as JSON
    And it is written to stdout, where a caller branching on exit 2 never mistakes it for a result

  # exists answers about a locator, and three panes named worker is not an answer to "is it live?" —
  # so the outcome rides the exit code rather than a word. The word-only alternative is what
  # systemctl is-active does, reporting `inactive` for both a stopped unit and a unit that does not
  # exist: only its exit code tells them apart.
  #
  # exists is a PREDICATE, and its `1` is a real divergence from axi #6 rather than an amendment to it.
  # AXI reserves `1` for an error; exists spends it on `gone`, which is not an error but the answer to
  # the question asked. That is the framing grep, POSIX test and systemctl is-active all take, it is
  # deliberate, and it is kept — but it is NOT the code set AXI states, and the axi node used to call it
  # "an amendment to the 0/1 set", which was wrong twice over: the set was always 0/1/2 (nothing was
  # amended), and what exists actually diverges on is the MEANING of 1, which no amendment covered.
  # Recorded here rather than mislabeled. Whether to keep it is its own question, not one the
  # error-surface pass that corrected the text around it settles.
  Scenario Outline: exists distinguishes its three outcomes by exit code, not by prose
    Given <world>
    When a caller runs cyber-mux exists naming that locator
    Then stdout carries <stdout>
    And it exits <code>

    Examples:
      | world                                     | stdout                        | code |
      | exactly one live pane matches the locator | live                          | 0    |
      | no live pane matches the locator          | gone                          | 1    |
      | two or more live panes match the locator  | the ambiguous-pane error      | 2    |

  Scenario: an ambiguous exists reports its candidates rather than answering the question
    Given two live panes labeled worker
    When a caller runs cyber-mux exists naming worker
    Then the candidates are reported on stdout under the code ambiguous-pane
    And it answers neither live nor gone, because there is no single pane the question is about
    # The report REPLACES the answer on stdout rather than joining it: exists either answers or errors,
    # so a caller reading stdout after a nonzero exit is reading the error, never a word plus an error.

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
  Scenario: a tmux pane nobody named carries no label, so the hostname addresses no pane
    Given a tmux pane whose title has never been set
    When the live panes are listed
    Then that pane reports no label
    And the hostname resolves to no pane, rather than colliding with every pane in the session

  # The contrast that shows the tmux rule is a workaround, not the shape of the thing: herdr has the
  # honest primitive, so an unnamed pane needs no rule to be read as unnamed.
  Scenario: a herdr pane nobody named carries no label, with no comparison needed to tell
    Given a herdr pane that has never been renamed
    When the live panes are listed
    Then that pane reports no label, because herdr omits the name outright until one is set

  Scenario: a wezterm pane never carries a label, because nothing can ever set one
    Given a wezterm pane, any pane
    When the live panes are listed
    Then that pane reports no label
    # Not a filtering rule like tmux's hostname guard — there is no primitive at all to title a pane
    # on this backend (see rename), so `title` is always the ambient running-program name, never
    # something a human or cyber-mux chose. Reporting it as a label would manufacture the exact
    # collision (every shell pane named the same thing) the hostname guard exists to prevent, with no
    # way for an author to ever override it here.

  Scenario: a label containing spaces resolves, and never corrupts what is listed beside it
    Given a tmux pane labeled my worker, whose working directory path also contains a space
    When the live panes are listed
    Then the label and the working directory are each read whole
    And a caller naming my worker resolves that pane

  # ── The error surface — structured, coded, and on the stream the agent actually reads ──
  #
  # These pin axi/'s #6 concretely, which is where that reference node's conformance is verified: it
  # carries no suite of its own. One helper reaches every verb here, so these scenarios are about the
  # surface rather than any one command — a verb-by-verb pin would freeze twenty copies of one rule.

  # This surface rule holds for EVERY verb, template included; the examples stay on the shared,
  # non-template surface so this node owns the shape, not any command's specifics. Each template verb's
  # own code, exit and message live in template/'s suite (the Boundary rule: domain behavior belongs to
  # its capability node), and they follow this same shape.
  Scenario Outline: a failure is a structured error on stdout, under the code for THAT failure
    Given <world>
    When a caller runs <verb>
    Then the report is written to stdout, never stderr
    And it carries the stable code <code>
    And it carries a help line naming the command that fixes it, never "see --help"
    And it exits <exit>

    Examples:
      | world                                    | verb                  | code           | exit |
      | no multiplexer this process is inside    | cyber-mux list        | no-mux         | 1    |
      | a locator matching no live pane          | cyber-mux focus %99   | pane-not-found | 1    |
      | two live panes labeled worker            | cyber-mux read worker | ambiguous-pane | 2    |

  # The codes must DISCRIMINATE, which is the whole of the third divergence and the half a reader is
  # most likely to skim past. A CLI that renamed fail()'s free text to `code: error` and moved it to
  # stdout would satisfy "carries a stable code" on every row while leaving a caller exactly as unable
  # to tell one failure from another as parsing prose left them — and that is the CHEAPEST edit at the
  # one helper this pass touches, so it is the wrong impl most likely to be built.
  Scenario: two different failures never share one code
    Given a caller who hits an ambiguous locator and a caller who hits no multiplexer
    When each failure is reported
    Then the code ambiguous-pane and the code no-mux differ
    And neither is a catch-all a third failure mode would also land under

  # A usage error is a missing or malformed ARGUMENT — the fix is a different invocation, not a retry.
  # A required argument the parser never received is exactly that. These ship at 1 today (commander's
  # default), which #36 did not separately count, and they are the same family as the unknown flag.
  Scenario Outline: a missing required argument is a usage error, not a failed operation
    Given a caller running <verb> without the pane argument it requires
    When the command is parsed
    Then it exits 2 rather than 1, having called no backend
    And the error names the argument that is missing

    Examples:
      | verb                |
      | cyber-mux read      |
      | cyber-mux focus     |
      | cyber-mux send text |

  Scenario: an unknown flag is a usage error, and says what the valid flags are
    Given a caller running cyber-mux list with a flag that command does not define
    When the command is parsed
    Then it exits 2, having called no backend and listed nothing
    And the error names the unrecognized flag
    And it lists that command's valid flags, so the agent self-corrects without a second call
    # AXI's own reasoning: the expensive cost is the follow-up round trip, and the agent's deterministic
    # next move after an unknown flag is `--help`. Folding that answer into the error collapses a
    # two-turn correction into one.

  Scenario: an unknown flag is rejected against the SUBCOMMAND's flags, not the group's
    Given a caller running cyber-mux template list with --force, a flag only cyber-mux template save defines
    When the command is parsed
    Then it exits 2 and names --force as unknown for template list
    And the valid flags it lists are template list's own, never template save's
    # A group's subcommands do not share a flag set, and only the subcommand layer knows which is in
    # play. Validating against the GROUP's union would accept --force here and then silently drop it —
    # the exact failure fail-loud exists to prevent. template is the pair that can carry this rule: save
    # takes --from/--workspace/--description/--force and list takes none of them. send cannot — its
    # text and keys subcommands define identical flag sets, so no flag exists that separates them.

  Scenario: --help is never an unknown flag
    Given a caller running any cyber-mux command with --help
    When the command is parsed
    Then help is written to stdout and it exits 0
    And no flag validation rejects it, on any command

  Scenario: a structured error honors --format json
    Given a caller whose command fails with --format json
    When the error is reported
    Then it is emitted as JSON on stdout carrying the same stable code the readable form uses
    And no free-text prose is written beside it

  # This is what makes an error on stdout safe, and it is the premise the whole stream decision rests
  # on — so it is contracted here rather than left as a property the current code happens to have.
  # The invariant is not "no verb ever exits nonzero with output" — apply exits nonzero and still
  # reports (below). It is narrower and exact: stdout carries exactly ONE payload. Either a RESULT —
  # which may report a negative or partial outcome inside itself and carry a nonzero exit, as exists's
  # `gone` and apply's partial manifest do — or a structured ERROR, when the operation produced no
  # result at all. Never a result and a separate error object concatenated. A caller branches on the
  # exit code, then parses one payload; it is never handed two.
  Scenario: a failed verb's stdout is its structured error alone, with no result before it
    Given a caller running cyber-mux read against a pane whose capture fails
    When the failure is reported
    Then the structured error is the whole of stdout
    And no partial pane output precedes it
    # read is the sharpest case, because its stdout is the pane's own raw byte stream rather than a
    # structured payload — the one place a mixture would be genuinely unparseable, not merely untidy.
    # It holds because a failed read captures nothing: there are no bytes for an error to land amid.

  Scenario: a partially-applied template is one result payload, not a result plus an error
    Given a tabs template whose second tab fails to open
    When cyber-mux applies it
    Then stdout carries the manifest of the panes already built, and that manifest alone
    And the tab that failed is named inside that manifest, never appended as a second structured error
    And it exits nonzero to signal the apply was incomplete
    # apply does not roll back (template/), so a partial build is a real outcome with a real result — the
    # one case that looks like "result AND error on stdout" and is not. The nonzero exit and the named
    # failing tab live INSIDE the one manifest payload, which is what keeps the invariant true here.

  Scenario: an error never leaks the multiplexer's own output
    Given a caller running a verb whose backend command fails with a tmux or herdr diagnostic
    When the failure is reported
    Then the error is translated into this CLI's own code and help
    And the backend's raw text is not passed through as the message
    # AXI: never leak dependency names — a suggestion references THIS CLI's commands, not the tool it
    # wraps. An agent handed a tmux error cannot act on it through cyber-mux.

  # The catch-all every worktree verb shares (`reportWorktreeFailure`) sits downstream of TWO error
  # sources with different safety, and it is the one place that has to tell them apart: this CLI's own
  # worktree refusals (a dirty-checkout guard, a primary-checkout guard) are safe to forward verbatim,
  # while a failure from opening or binding the worktree's pane comes from the multiplexer and carries
  # its raw diagnostic the same way the scenario above already forbids for every other verb.
  Scenario: the worktree catch-all never forwards the multiplexer's raw diagnostic either
    Given a caller running cyber-mux worktree add whose backend fails opening the worktree's pane
    When the failure is reported
    Then the error carries the worktree-failed code and this CLI's own message
    And neither the backend's name nor its raw diagnostic appears on stdout

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
