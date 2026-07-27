@frozen
Feature: agent — the herdr agent-lifecycle capability
  How cyber-mux drives herdr's native per-pane agent-state wait (herdr agent wait) as its own
  optional AgentLifecycle capability, and refuses rather than emulates it on every backend that has
  no equivalent primitive. The CLI rendering of the refusal — exit code, code, help — is the surface
  in ../cli/agent/agent.feature; this suite owns the surface-independent capability and orchestrator.

  # ── Driving herdr's native agent wait ──
  # waitForState never sees the adapter; it only ever runs against herdr, which is why the
  # emulate-or-refuse decision below has to live one level up, in deriveAgentWait.

  @id:agent-wait-herdr-builds-command
  Scenario: herdr waitForState builds agent wait with a repeated --until flag and --timeout for the requested states
    Given a herdr pane, and a wait for it asking until idle or done with a 5000ms timeout, whose agent reaches done
    When waitForState runs
    Then it runs herdr agent wait for that pane with --until idle --until done --timeout 5000
    And it returns the AgentStatus done

  @id:agent-wait-herdr-until-omitted-uses-herdr-default
  Scenario: herdr waitForState with no until sends no --until flag, so herdr applies its own default
    Given a herdr pane, and a wait for it with no until list
    When waitForState runs
    Then the command it runs carries no --until flag
    # herdr's own default (idle|done|blocked) then applies — cyber-mux never restates it in the
    # command, so a future change to herdr's default is not silently pinned by this binding

  @id:agent-wait-herdr-timeout-omitted-indefinite
  Scenario: herdr waitForState with no timeoutMs sends no --timeout flag, so the wait is indefinite
    Given a herdr pane, and a wait for it with no timeoutMs
    When waitForState runs
    Then the command it runs carries no --timeout flag
    And the wait is indefinite, exactly as herdr's own no-timeout behavior

  @id:agent-wait-herdr-parses-reached-status
  Scenario: herdr waitForState parses herdr's JSON envelope into the reached AgentStatus
    Given a herdr agent wait whose JSON envelope reports it reached idle
    When waitForState runs
    Then it returns the AgentStatus idle
    # the caller learns WHICH requested state (or the timeout) ended the wait, not merely that it ended

  # ── agentLifecycle: present only on herdr ──
  # The same absent-rather-than-false convention worktree and regions already follow: a capability a
  # backend genuinely lacks is not present in a degraded form, it is not present at all.

  @id:agent-lifecycle-absent-non-herdr
  Scenario Outline: agentLifecycle is undefined on every backend except herdr
    Given a <backend> MuxAdapter
    When the adapter's agentLifecycle member is read
    Then it is undefined

    Examples:
      | backend |
      | tmux    |
      | wezterm |
      | zellij  |

  # ── deriveAgentWait: refuse, never emulate ──
  # Mirrors deriveRegionCapture in template-capture.ts exactly: the orchestrator is the one place
  # that sees the adapter, so it is the one place the emulate-or-refuse decision can be made. A
  # lookalike wait built from read() polling would silently disagree with herdr's own state
  # derivation on the same question, so the contract refuses rather than guesses.

  @id:agent-wait-unsupported-refused
  Scenario Outline: deriveAgentWait refuses before any exec when agentLifecycle is absent
    Given a <backend> adapter, whose agentLifecycle is absent
    When deriveAgentWait runs against a pane on that backend
    Then it throws AgentLifecycleUnsupportedError naming <backend>
    And no exec runs
    # exit-code-free and portable by design, same as CaptureUnsupportedError: the DECISION to refuse
    # is the library's; how it surfaces (exit code, help, the exact sentence) is the CLI's, in
    # ../cli/agent/agent.feature

    Examples:
      | backend |
      | tmux    |
      | wezterm |
      | zellij  |

  # ── The agentApi facade (cyber-mux/agent subpath) ──
  # The exec-bound facade paralleling worktreeApi/templateApi: agentApi(env, deps?) resolves the
  # backend adapter from env once and exposes supported/status/wait with the seams already bound.
  # It ADDS no logic of its own — supported reads the same capability presence deriveAgentWait
  # gates on, status reads the same LivePane.agentStatus the listing carries, and wait routes
  # through deriveAgentWait itself, so the refusal is specified once and enforced once.

  @id:agent-api-supported-reflects-backend
  Scenario Outline: agentApi's supported reflects whether the backend reports agent-lifecycle state
    Given an environment resolving to the <backend> backend
    When agentApi(env).supported() is called
    Then it returns <answer>

    Examples:
      | backend | answer |
      | herdr   | true   |
      | tmux    | false  |
      | wezterm | false  |
      | zellij  | false  |

  @id:agent-api-status-reads-snapshot
  Scenario: agentApi's status returns the pane's agentStatus snapshot on herdr
    Given an environment resolving to herdr, and a pane whose agent-state feed reports working
    When agentApi(env).status(pane) is called
    Then it returns working
    # the same snapshot the live listing carries (LivePane.agentStatus, ../mux/lookup) — the facade
    # reads it for one pane rather than redefining it

  @id:agent-api-status-undefined-no-feed
  Scenario Outline: agentApi's status returns undefined on a backend with no agent-state feed
    Given an environment resolving to the <backend> backend, and a live pane on it
    When agentApi(env).status(pane) is called
    Then it returns undefined
    # absent-not-false, exactly as LivePane.agentStatus omits the field there: a snapshot the backend
    # cannot take is undefined, never a guessed "unknown" — and never a refusal, matching agent
    # status's degrade on the CLI surface

    Examples:
      | backend |
      | tmux    |
      | wezterm |
      | zellij  |

  @id:agent-api-wait-drives-herdr
  Scenario: agentApi's wait drives the capability on herdr and returns the reached status
    Given an environment resolving to herdr, and a pane whose agent reaches idle
    When agentApi(env).wait(pane, opts) is called
    Then it returns the AgentStatus idle

  @id:agent-api-wait-routes-through-refusal
  Scenario Outline: agentApi's wait routes through deriveAgentWait's refusal on a backend without the capability
    Given an environment resolving to the <backend> backend
    When agentApi(env).wait(pane) is called
    Then it throws AgentLifecycleUnsupportedError naming <backend>
    And no exec runs
    # identical to calling deriveAgentWait directly — the facade adds no second refusal path that
    # could drift from the orchestrator's

    Examples:
      | backend |
      | tmux    |
      | wezterm |
      | zellij  |
