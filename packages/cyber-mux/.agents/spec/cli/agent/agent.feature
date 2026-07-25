@frozen
Feature: cyber-mux agent — the CLI agent-lifecycle surface
  How the cyber-mux command line reaches the agent-lifecycle capability: agent status <pane> (a
  snapshot that degrades truthfully, never refuses) and agent wait <pane> (a blocking drive of
  herdr's native wait, refused with backend-unsupported on every backend without it). The
  surface-independent capability and the deriveAgentWait refusal decision live in
  ../../agent/agent.feature; this suite owns invocation and presentation. The exit-code contract
  every refusal honors (0 ok, 1 operation failed) is AXI's, pinned once for the whole CLI in
  ../lookup/lookup.feature and applied here, not restated.

  # ── agent status: a snapshot that degrades, never refuses ──
  # agent status resolves a pane through the shared ladder and prints its agentStatus — a fact
  # independent of whether the backend can wait on it, so a no-feed backend still answers, truthfully.

  @id:cli-agent-status-prints-herdr
  Scenario: agent status prints the resolved pane's agentStatus on herdr
    Given a herdr pane whose agent-state feed reports working
    When cyber-mux agent status runs against that pane
    Then it prints working
    And it exits 0

  @id:cli-agent-status-json-payload
  Scenario: agent status --format json emits pane and agentStatus as a structured payload
    Given a herdr pane whose agent-state feed reports working
    When cyber-mux agent status --format json runs against that pane
    Then it emits a JSON object carrying the pane and agentStatus working
    And it exits 0

  @id:cli-agent-status-no-feed-degrades
  Scenario: agent status on a backend with no agent-state feed prints the pane with no status, and exits 0
    Given a tmux pane
    When cyber-mux agent status runs against that pane
    Then it prints the pane with no agentStatus
    And it exits 0, because a missing feed is degraded truthfully, not refused
    # tmux, wezterm, and zellij carry no agent-state feed at all — the same absent-not-false rule
    # LivePane.agentStatus follows in ../../mux/lookup/lookup.feature. Refusing here would turn a
    # caller away from a fact the backend CAN answer (which pane this is) because of a fact it can't
    # (what its agent is doing) — the two are independent, and only the second is herdr-only.

  # ── agent wait: drives herdr's capability, or refuses naming the backend ──
  # agent wait is a refusal surface, unlike agent status: waiting has no truthful degrade, so a
  # backend without the capability is refused rather than answered with a guess.

  @id:cli-agent-wait-drives-herdr
  Scenario: agent wait drives the capability on herdr and reports the reached state
    Given a herdr pane whose agent reaches idle
    When cyber-mux agent wait runs against that pane with --until idle --timeout 5000
    Then it prints idle
    And it exits 0

  @id:cli-agent-wait-unsupported-refused
  Scenario Outline: agent wait refuses with backend-unsupported on a backend with no agent-lifecycle capability
    Given a <backend> pane
    When cyber-mux agent wait runs against that pane
    Then it exits 1 under the code backend-unsupported
    And the help line names the herdr-only constraint
    # the CLI's rendering of the library's AgentLifecycleUnsupportedError, the exact mirror of how
    # template save surfaces CaptureUnsupportedError as its own backend-unsupported (exit 1, naming
    # the backend, a fix hint rather than the raw error)

    Examples:
      | backend |
      | tmux    |
      | wezterm |
      | zellij  |
