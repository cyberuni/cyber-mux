@frozen
Feature: mux placement — where a new pane opens, and what open reports back
  Where cyber-mux open puts a new pane on each backend, how a split is told which pane, how big and
  what environment, how spaces are grouped and named, and what open reports back about the pane. The
  CLI flag surface — how --at, --launch, and --env are parsed, defaulted, validated, and refused —
  lives in ../../cli/placement/placement.feature; this suite owns the library open contract those
  flags drive.

  # ── workspace — its own visible space, mapped to each backend's own-visible-space unit ──

  @id:placement-at-workspace-visible-space
  Scenario Outline: --at workspace opens the pane's own VISIBLE space on each backend
    Given a caller running cyber-mux open --at workspace with <env>
    When open runs
    Then the pane opens in its own space that is visible in the attached client through the <adapter> adapter

    Examples:
      | env                         | adapter |
      | $TMUX set                   | tmux    |
      | $HERDR_ENV set and no $TMUX | herdr   |
      | $WEZTERM_PANE set           | wezterm |
      | $ZELLIJ set                 | zellij  |

  @id:placement-tmux-workspace-visible-window
  Scenario: tmux --at workspace opens a visible window in the current session, never a detached session
    Given a caller running cyber-mux open --at workspace with $TMUX set
    When open runs
    Then the tmux adapter opens a new window in the caller's current session, visible in its status bar
    And it does not open a detached (new-session) session the attached client cannot see or beam to

  @id:placement-herdr-workspace-unattached
  Scenario: herdr --at workspace creates its own workspace, unattached to any repo
    Given a caller running cyber-mux open --at workspace with $HERDR_ENV set and no $TMUX
    When open runs
    Then the herdr adapter creates a new workspace of its own
    # `open` is placement, not worktree work: the workspace it creates carries no worktree record,
    # so herdr does not know it belongs to a repo and never groups it. Grouping is the `worktree`
    # verbs' job — see the worktree/workspace binding section below.
    And the workspace is not bound to any repo, even when its cwd is a worktree checkout

  @id:placement-wezterm-workspace-fresh-name
  Scenario: wezterm --at workspace spawns a new window into a freshly named workspace
    Given a caller running cyber-mux open --at workspace with $WEZTERM_PANE set
    When open runs
    Then the wezterm adapter spawns a new window with --new-window and a fresh --workspace name
    # WezTerm's --workspace both selects AND creates: reusing "default" (the CLI's own default when
    # the flag is omitted) would join whatever the caller was already in rather than opening the
    # pane's OWN space, so a name is always minted here, using --label as the name when the caller
    # gave one.
    And the new window does not join the caller's current workspace

  @id:placement-at-tab-new-tab
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
      | $ZELLIJ set                 | zellij  |

  @id:placement-tab-no-focus-steal
  Scenario: the tab placement opens in the background without stealing focus
    Given a caller running cyber-mux open --at tab
    When open runs
    Then the new tab is opened without moving input focus off the caller's session

  @id:placement-omitted-defaults-to-tab
  Scenario: an omitted placement falls back to tab — the adapter's own default, not the CLI's
    Given the open contract is invoked with no placement — at is undefined
    When the backend adapter opens the pane
    Then the adapter's own at ?? 'tab' default opens a new tab, identical to an explicit tab placement
    # The default lives in each adapter (mux.tmux/herdr/wezterm/zellij), never in the CLI: the `open`
    # verb passes `at` through unmodified and only declines to reject an omitted one. So the fallback
    # is a library contract, observable by calling open() with at undefined — not a CLI-surface fact.

  # ── open reports the workspace the new pane landed in ──
  # Not just a pane id: a caller holding several panes can group them by the space they occupy.
  # Absent — never a false "none" — on a backend with no workspace tier, the same convention the
  # focus probe's `unknown` follows.

  # Two levels, deliberately separate: what `open` RETURNS (the seam, below) and what the CLI PRINTS
  # (further down). The seam is the fact's source; every surface that reports it — the bare `open`
  # report and the template manifest (see template/) — reads it from there rather than asking again.

  @id:placement-open-returns-workspace
  Scenario Outline: open returns the workspace the new pane landed in
    Given a caller running cyber-mux open --at <placement> with $HERDR_ENV set and no $TMUX
    When open runs
    Then the adapter's open returns the new pane carrying <workspace>

    Examples:
      | placement  | workspace                                                  |
      | workspace  | the workspace it created                                   |
      | tab        | the workspace the new tab was created in                   |
      | pane:right | the workspace the split landed in — the caller's own       |

  @id:placement-wezterm-workspace-never-absent
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

  @id:placement-wezterm-workspace-followup-call
  Scenario: wezterm's workspace and tab cost a follow-up call, unlike herdr's free report
    Given a caller running cyber-mux open with $WEZTERM_PANE set
    When open runs
    Then the tab, and on a tab or pane:* placement the workspace, are read from a separate wezterm cli list call
    # spawn/split-pane report ONLY the new pane's bare id — neither embeds the tab or workspace the
    # way tmux's -F format or herdr's JSON envelope does. The `workspace` placement is the one
    # exception: the workspace name is what open() itself picked, so reporting it costs nothing.

  @id:placement-tmux-no-workspace-tier
  Scenario: a backend with no workspace tier returns no workspace at all
    Given a caller running cyber-mux open with $TMUX set
    When open runs
    Then the adapter's open returns the new pane carrying no workspace
    # Absent, not a false "none". tmux has no workspace tier — `workspace` and `tab` both collapse to
    # a Window — so it has nothing to report, which is not the same as reporting nothing is there.

  @id:placement-herdr-workspace-free
  Scenario: the workspace costs no extra backend call
    Given a caller running cyber-mux open with $HERDR_ENV set and no $TMUX
    When open runs
    Then the workspace is read from the same backend output the pane id is read from
    # Every herdr route already emits the pane's own workspace_id. Probing for it separately would
    # buy nothing and cost a round trip per open.

  @id:placement-open-reports-workspace-with-pane
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

  @id:placement-workspace-not-worktree-binding
  Scenario: the workspace a pane landed in is not a worktree binding
    Given a caller running cyber-mux worktree add --branch my-feature --at pane:right on a backend that binds
    When add runs
    Then the pane it opened landed in the caller's workspace
    And the worktree is still reported as bound to no workspace
    # One workspace tier, two questions. Occupancy — which workspace a pane LIVES IN — is what open
    # answers. Binding — whether a worktree is GROUPED to a workspace — is the worktree report's, and
    # it stays null here because a split creates no binding. Neither answers for the other: a pane
    # sitting in a workspace is never evidence that its worktree was grouped there.

  # ── Split options — what a split can be told: which pane, how big, what environment ──
  # The seam's own contract, stated at the seam: these scenarios address open() directly rather than
  # a `cyber-mux open` command line, because the seam is what they pin. `from` and `ratio` have no
  # CLI flag at all; `env` has one, specified as its own surface in the `--env` block below rather
  # than here — what the flag DOES is that block's business, what env MEANS is this one's. The template
  # capability is another such caller; what a template DOES with these is template's business.

  @id:placement-from-names-split-target
  Scenario Outline: from names the pane a pane:* split targets
    Given a caller opening at pane:right through the <adapter> adapter, with from naming a pane
    When open runs
    Then the backend is told to split that named pane, via <how>

    Examples:
      | adapter | how                                        |
      | tmux    | -t and the pane id                         |
      | herdr   | the pane id passed positionally, no --from |
      | wezterm | --pane-id and the pane id                  |

  @id:placement-from-omitted-tracks-focus
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

  @id:placement-from-ignored-by-tab-workspace
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

  @id:placement-ratio-sign-convention
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

  @id:placement-ratio-omitted-even-default
  Scenario Outline: ratio omitted leaves each backend its own even default
    Given a caller opening at pane:right through the <adapter> adapter, with no ratio
    When open runs
    Then no sizing flag reaches the backend, which splits the region evenly

    Examples:
      | adapter |
      | tmux    |
      | herdr   |
      | wezterm |

  @id:placement-ratio-not-for-tab-workspace
  Scenario Outline: ratio is a split concept — a tab or workspace is never sized against a pane
    Given a caller opening at <at> through the tmux adapter, with a ratio
    When open runs
    Then no sizing flag reaches the backend, because a window is not sized against a pane

    Examples:
      | at        |
      | tab       |
      | workspace |

  @id:placement-wezterm-ratio-not-for-tab-workspace
  Scenario Outline: ratio is a split concept on wezterm too — a tab or workspace is never sized against a pane
    Given a caller opening at <at> through the wezterm adapter, with a ratio
    When open runs
    Then no --percent flag reaches wezterm, because a window is not sized against a pane

    Examples:
      | at        |
      | tab       |
      | workspace |

  @id:placement-ratio-out-of-range-rejected
  Scenario Outline: a ratio outside 0 < ratio < 1 is rejected at the seam, never rendered into a broken split
    Given a caller opening at pane:right through the <adapter> adapter, with ratio <ratio>
    When open runs
    Then open throws, naming that ratio must be strictly between 0 and 1
    And no split command reaches the backend

    Examples:
      | adapter | ratio |
      | tmux    | 1.5   |
      | tmux    | 0     |
      | herdr   | 1.5   |
      | herdr   | 0     |
      | wezterm | 1.5   |
      | wezterm | 0     |

    # The range is a PRECONDITION the seam enforces, not a hint the caller is trusted to honor. Above 1
    # the sizing render goes negative (tmux -l -50%, wezterm --percent -50); 0 or 1 hands one side the
    # whole region and the other nothing. Rendered rather than refused, each is a SILENTLY broken split,
    # which is the exact silent-wrong output this seam's loud-over-quiet preference refuses. The guard
    # lives with the size render, so it throws before the split command is issued. Range VALIDITY is a
    # universal property of what a ratio is — true on every backend — and so belongs here; the DEGRADE
    # policy for a backend that cannot size a split at all stays the caller's, unchanged. A backend that
    # renders no ratio (zellij, which drops it) reaches no guard — a dropped value is never checked.
    # `template`'s schema still refuses a degenerate ratio earlier, per node, with a path-qualified
    # message: two layers, different jobs, the seam the backstop for a direct caller with no schema.

  @id:placement-env-native-at-birth
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

  @id:placement-wezterm-env-never-native
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

  @id:placement-env-each-var-own-flag
  Scenario Outline: each env variable gets its own flag, in the order given
    Given a caller opening through the <adapter> adapter, with env ROLE=worker and TIER=gpu
    When open runs
    Then the backend receives one repeated flag per variable, ROLE before TIER

    Examples:
      | adapter |
      | tmux    |
      | herdr   |

  @id:placement-env-no-launch-blank-shell
  Scenario Outline: env with no launch opens a blank shell carrying the env
    Given a caller opening through the <adapter> adapter, with env and no launch
    When open runs
    Then the pane is created with the env set
    And nothing is typed, sent, or run into it

    Examples:
      | adapter |
      | tmux    |
      | herdr   |

  @id:placement-herdr-worktree-env-dropped
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

  @id:placement-route-reports-env-carried
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

  @id:placement-env-rides-command-prefix
  Scenario: env a route could not carry rides in on the command instead
    Given a region opened with env the route could not carry, and a command to run in it
    When the command is run
    Then the command is prefixed with env KEY=VALUE
    And the variable is set for the command that runs
    # A last resort, and its cost is why: the values land in ps output and the pane's shell history.
    # It is still strictly better than the silent drop it replaces.

  @id:placement-env-no-command-warns
  Scenario: env a route could not carry, with no command to ride, warns rather than vanishing
    Given a region opened with env the route could not carry, and no command to run in it
    When it runs
    Then a warning names the variables that did not reach the region
    And the warning goes to stderr, leaving stdout machine-readable
    # The prefix only works by riding a command line. With no command there is nothing to ride, and
    # the honest outcome is to say so — a caller that asked for env and silently did not get it is
    # the quiet failure this whole block exists to prevent.

  @id:placement-native-env-no-double-prefix
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

  @id:placement-env-value-quoted-in-prefix
  Scenario: an env value carrying a space or a quote survives the prefix intact
    Given a region opened with env the route could not carry, whose value contains a space and a quote
    When the command is run
    Then the value reaches the command as one literal word
    # The prefix is a shell command line, so the value is quoted for one. Unquoted, a value with a
    # space splits into extra words and a value with a quote unbalances the line outright.

  # ── The workspace group: carrying a grouping a backend has no tier for ──
  # A caller opening several tabs as one workspace needs them recognizable as a group afterwards. On a
  # backend with a real workspace tier that is free — the tier IS the group. On one without, the seam
  # carries an opaque group id the backend can store and be filtered by.

  @id:placement-group-id-opaque
  Scenario: the open contract carries an opaque workspace group id
    Given a caller opening a tab with a workspace group id
    When open runs
    Then the id reaches the backend as an opaque value
    And it is never parsed, split, or derived from the label
    # the group id and the label are separate on purpose: a label is chosen by a human and may contain
    # anything, so recovering a grouping by parsing one is unsound

  @id:placement-tmux-group-id-window-option
  Scenario: a backend with no workspace tier stores the group id natively
    Given a caller opening a tab through the tmux adapter, with a workspace group id
    When open runs
    Then the window carries the id as a window option the backend can filter on
    # tmux has no Workspace level, so the grouping has nowhere structural to live; a window option is
    # tmux's own mechanism for exactly this and survives a window rename

  @id:placement-herdr-group-id-ignored
  Scenario: a backend with a real workspace tier ignores the group id
    Given a caller opening a tab through the herdr adapter, with a workspace group id
    When open runs
    Then no grouping flag reaches herdr
    # herdr's workspace IS the group and every pane and tab record already carries its workspace_id —
    # a second grouping would be a duplicate the backend never reads

  @id:placement-wezterm-group-id-ignored
  Scenario: wezterm also ignores the group id, for the same reason herdr does
    Given a caller opening a tab through the wezterm adapter, with a workspace group id
    When open runs
    Then no grouping call reaches wezterm
    # wezterm's workspace IS also a real tier — every window belongs to one — so there is nothing
    # left for a tag to add. Coarser than herdr's (per-WINDOW, since every tab in a window already
    # shares its workspace, and there is no move-tab-to-workspace primitive), but the same answer.

  @id:placement-group-id-not-invented
  Scenario: a group id is never invented for a caller that did not ask for one
    Given a caller opening a tab through the tmux adapter, with no workspace group id
    When open runs
    Then no window option is set
    # a window nobody grouped stays ungrouped, and reads back as a workspace of one

  @id:placement-group-existing-space
  Scenario: a space already open is grouped by the same verb open uses
    Given a caller grouping a tab that is already open through the tmux adapter
    When the grouping runs
    Then the backend stores the id on that space
    And it is the same command open itself issues to group a space it just created
    # open cannot be the only way in. A caller that did not open the space -- the worktree route opens
    # its region before the walk ever runs -- still has to group it, and it holds the space's own id
    # the moment the open returns. tmux has no birth flag for a window option anyway, so grouping is
    # ALREADY a second call after the window exists; routing open through this verb adds none.

  @id:placement-tmux-name-stored-separately-from-group
  Scenario: a backend whose display name is composed stores the space's own name beside the group
    Given a caller grouping a tab through the tmux adapter, naming the tab editor
    When the grouping runs
    Then the backend stores editor as the space's own name
    And the space's own name is stored separately from its display name
    # tmux has ONE name field per space, so a caller that composes a display name out of the tab's name
    # DESTROYS the original -- and recovering it means splitting on a separator already proven
    # ambiguous. The same rule the group id follows, one tier down: the display name is a human's to
    # read, and an opaque option carries what a machine reads back.

  @id:placement-herdr-stores-neither-group-nor-name
  Scenario: a backend with a real workspace tier stores neither
    Given a caller grouping a tab through the herdr adapter
    When the grouping runs
    Then no grouping flag and no name flag reach herdr
    # its tier IS the group and its tab label IS the tab's own name, never composed -- so both are
    # facts the backend already holds

  @id:placement-group-id-not-reported-as-workspace
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

  @id:placement-open-reports-tab
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

  @id:placement-reported-tab-names-root
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

  @id:placement-rename-after-birth
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

  @id:placement-wezterm-rename-pane-throws
  Scenario: wezterm cannot name a pane at any tier — rename throws rather than silently doing nothing
    Given a caller renaming an already-open pane through the wezterm adapter
    When the rename runs
    Then it throws, naming that wezterm has no way to title a pane
    # set-tab-title/set-window-title exist; there is no pane equivalent in the CLI at all. Throwing is
    # the honest answer — a silent no-op would report a rename that never happened as if it had.

  @id:placement-wezterm-every-tab-named-after-birth
  Scenario: every new tab on wezterm is named after birth, not just a new workspace's root tab
    Given a caller opening a tab through the wezterm adapter, with a label
    When open runs
    Then the tab is named by a set-tab-title call after the tab exists
    # spawn has no title flag at all (unlike tmux's -n or herdr's --label), so EVERY new tab takes
    # this route — not just the one root-tab case herdr has.

  @id:placement-herdr-root-tab-rename-only
  Scenario: renaming is the only way to name a new workspace's root tab
    Given a caller creating a workspace through the herdr adapter
    When the workspace's root tab is given a name
    Then the name is set by a rename after the workspace exists
    # herdr labels a new workspace's root tab 1 and offers no flag to change it at birth. This is the
    # whole of the constraint the tab-naming non-goal generalized from — it binds the ROOT tab alone,
    # and every later tab takes --label at birth like any other space.

  @id:placement-rename-no-focus-no-create
  Scenario: a rename moves no focus and opens nothing
    Given a caller renaming a tab the caller is not focused on
    When the rename runs
    Then the caller's focus is where it was
    And no space is created
    # a write as read-only in its side effects as isPaneFocused is: naming a space is not visiting it

  @id:placement-backend-declares-can-size
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

  # ── launch is optional — a blank pane is a valid open() outcome ──
  # The library half of the open contract's launch behavior. Whether the CLI --launch flag was given
  # or omitted is ../../cli/placement/placement.feature's; what open() DOES with a launch command, or
  # its absence, is this band's.

  @id:placement-open-no-launch-blank-pane
  Scenario: open with no launch command creates a blank pane
    Given open called with no launch command
    When open runs
    Then a new pane opens through the adapter
    And no launch command is sent or run into it

  @id:placement-launch-command-submitted
  Scenario: a launch command is submitted, so it actually runs
    Given open called with a launch command
    When open runs
    Then the command is typed into the new pane and Enter is pressed
    And it does not sit staged unsent in the new pane's input box

