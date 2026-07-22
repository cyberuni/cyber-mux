@frozen
Feature: cyber-mux detection read-out — doctor and mode
  The two CLI commands that report what detection found: doctor prints the full probe read-out plus a
  pin hint, and mode prints the selected backend name, or none. The surface-independent probe and
  selection contract they read — probeMultiplexer / selectSessionAdapter, the env fast-path, the
  ancestry walk, the screen rejection — lives in ../../mux/detection/detection.feature; this suite
  owns only how doctor and mode present its result.

  # ── doctor reports the detected mux and prints a pin hint ──

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
