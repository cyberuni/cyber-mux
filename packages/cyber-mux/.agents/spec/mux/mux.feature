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

  Scenario: herdr --at workspace creates its own workspace nested under the source
    Given a caller running cyber-mux open --at workspace with $HERDR_ENV set and no $TMUX
    When open runs
    Then the herdr adapter creates a new workspace of its own, nested under the source workspace

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

  Scenario: --at accepts only pane:right, pane:down, tab, and workspace
    Given a caller running cyber-mux open
    When it passes an --at value outside pane:right|pane:down|tab|workspace
    Then the command is rejected before any pane opens

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
