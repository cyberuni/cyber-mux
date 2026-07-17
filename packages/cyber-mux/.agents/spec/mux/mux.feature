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

  Scenario: neither tmux nor herdr detected errors before opening anything
    Given a caller with neither $TMUX nor $HERDR_ENV set
    When cyber-mux open runs
    Then it throws naming tmux/herdr as the required backend

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

  Scenario Outline: --at tab opens a new tab in the current window, never a split pane
    Given a caller running cyber-mux open --at tab with <env>
    When open runs
    Then the pane opens as a new tab through the <adapter> adapter
    And the caller's current pane is not split

    Examples:
      | env                         | adapter |
      | $TMUX set                   | tmux    |
      | $HERDR_ENV set and no $TMUX | herdr   |

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
  # report and the layout manifest (see layout/) — reads it from there rather than asking again.

  Scenario Outline: open returns the workspace the new pane landed in
    Given a caller running cyber-mux open --at <placement> with $HERDR_ENV set and no $TMUX
    When open runs
    Then the adapter's open returns the new pane carrying <workspace>

    Examples:
      | placement  | workspace                                                  |
      | workspace  | the workspace it created                                   |
      | tab        | the workspace the new tab was created in                   |
      | pane:right | the workspace the split landed in — the caller's own       |

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
    # reaching only a `--layout` caller through the manifest.

    Examples:
      | env                         | workspace                                          |
      | $HERDR_ENV set and no $TMUX | the workspace it landed in                         |
      | $TMUX set                   | a null workspace — no workspace tier to report from |

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

  Scenario Outline: send keys presses core-vocabulary keys and types nothing
    Given a caller running cyber-mux send keys against a pane with <env>
    When it passes several keys from the portable core vocabulary
    Then each key is pressed in the pane, in the order the caller wrote them
    And each reaches the backend as its own key, never joined into one literal string

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |

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
    Then help naming text and keys as its subcommands is written to stderr
    And it exits 1, leaving stdout empty
    And nothing is sent to any pane

  Scenario Outline: submit with text types the text and presses Enter, taking the pane's turn
    Given a caller running cyber-mux submit against a pane with <env>
    When it passes a message as the optional text argument
    Then the message is typed into the pane and Enter is pressed, taking its turn

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |

  Scenario Outline: submit types its text literally, never interpreting it as a key
    Given a caller running cyber-mux submit against a pane with <env>
    When it passes a message that is also the name of a key as the text argument
    Then the message is typed as literal characters and Enter is pressed
    And that key is never pressed, so the pane's own input history is not recalled and re-run

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |

  Scenario Outline: submit with no text presses a bare Enter and retypes nothing
    Given a pane with text already staged unsent in its input box, with <env>
    When cyber-mux submit runs against it with no text argument
    Then a bare Enter keystroke is sent, flushing the staged buffer through the <adapter> adapter
    And no text is retyped, so a repeated flush cannot duplicate the staged message

    Examples:
      | env                         | adapter |
      | $TMUX set                   | tmux    |
      | $HERDR_ENV set and no $TMUX | herdr   |

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

  # ── list enumerates every live pane, not just agent-bearing ones ──

  Scenario: list enumerates every live pane, including one running no agent/harness
    Given a backend with a mix of panes, some running an agent/harness and some running none
    When it runs cyber-mux list
    Then every live pane is reported, whether or not it is running an agent/harness

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
    Given a caller running cyber-mux worktree add --branch <branch> with neither --at nor --launch
    When add runs outside any multiplexer
    Then it creates the checkout with plain git and opens no pane, tab, or workspace
    And it reports no pane and no workspace
    And it resolves no backend — with nothing opened, a multiplexer has no part in the answer

  Scenario: worktree add --launch defaults the placement to workspace
    Given a caller running cyber-mux worktree add --branch <branch> --launch <command> with no --at
    When add runs
    Then the worktree opens in a workspace — a launch wants its own space, not a pane crowding the caller's
    And workspace is the only placement a backend can bind a worktree to

  Scenario Outline: worktree add --at workspace groups the worktree where the backend binds
    Given a caller running cyber-mux worktree add --branch <branch> --at workspace with <env>
    When add runs
    Then the worktree opens through the <adapter> adapter and is reported as <grouping>

    Examples:
      | branch     | env                         | adapter | grouping                                      |
      | my-feature | $HERDR_ENV set and no $TMUX | herdr   | bound to a workspace — one call creates both  |
      | my-feature | $TMUX set                   | tmux    | ungrouped — tmux binds nothing, plain git plus a plain open |

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
