@frozen
Feature: mux detection — which multiplexer, and which backend adapter
  How a caller detects the multiplexer it is really running inside, which session backend that
  selects, and how doctor and mode report the answer.

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

