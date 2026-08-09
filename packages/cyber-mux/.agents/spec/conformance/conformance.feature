@frozen
Feature: conformance — verifying one adapter against its real multiplexer
  The maintainer-run runner (scripts/test-adapter.mjs, the test:adapter package script) that CI
  cannot replace, because CI cannot install every multiplexer. It answers, per adapter: is this
  multiplexer here, is there a real-boundary suite for it, and did that suite actually exercise
  anything. It exists because `pnpm test:integration` can neither select one adapter nor tell a
  skip apart from a pass.

  # ── Discovery (shared sub-graph) ──
  # Neither the adapter set nor the suite set is written down in the runner. A hand-maintained table
  # would go stale silently — the same class of lie as a skip rendering as a pass.

  @id:conformance-adapters-derived-from-source
  Scenario: the adapter set is derived from the mux source files
    Given a source tree whose adapter files are mux.tmux.ts, mux.herdr.ts, mux.wezterm.ts and mux.zellij.ts
    When the runner discovers its adapters
    Then the adapter set is exactly tmux, herdr, wezterm and zellij

  @id:conformance-unit-test-is-not-an-adapter
  Scenario: a unit test sitting beside an adapter does not become an adapter
    Given a source tree containing the adapter file mux.tmux.ts
    And the unit test mux.tmux.test.ts beside it
    When the runner discovers its adapters
    Then the adapter set contains tmux
    And the adapter set contains no entry named tmux.test

  @id:conformance-new-adapter-needs-no-edit
  Scenario: an adapter added to the source tree is discovered without editing the runner
    Given a source tree containing the adapter file mux.cmux.ts, which the runner names nowhere
    When the runner discovers its adapters
    Then the adapter set contains cmux
    And the presence check it runs for cmux looks up a binary named cmux
    # this is what "stays current as adapters are added" is bought with — derivation, not a registry

  @id:conformance-adapter-with-several-suites
  Scenario: an adapter with several integration suites resolves to all of them
    Given the integration suites mux.herdr.integration.test.ts and cli.herdr.integration.test.ts
    When the runner resolves herdr's suites
    Then both of those files are among herdr's suites

  @id:conformance-adapter-with-no-suite
  Scenario: an adapter with no integration suite resolves to none
    Given a source tree containing the adapter file mux.wezterm.ts
    And no file matching src/*.wezterm.integration.test.ts
    When the runner resolves wezterm's suites
    Then wezterm's suite count is zero

  @id:conformance-empty-discovery-is-an-error
  Scenario: discovering no adapters at all exits 1 rather than reporting an empty pass
    Given a source tree containing no file matching src/mux.<name>.ts
    When the runner discovers its adapters
    Then it reports that it found no adapters
    And it exits 1
    # the doctrine scripts/check-features.mjs already applies to its own scan: a check that finds
    # nothing must never render the same as one that passed

  # ── test-adapter — the listing form ──
  # Flags alone drive this tool: the bare form reports, and there is no interactive mode.

  @id:conformance-listing-reports-installation
  Scenario: the listing reports each adapter's installation state and suite count
    Given tmux is on PATH with one integration suite
    And herdr, wezterm and zellij are absent from PATH
    When the runner is invoked with no adapter and no flags
    Then tmux is listed as installed
    And tmux's line carries the suite count 1
    And herdr, wezterm and zellij are each listed as not installed

  @id:conformance-listing-projects-skip
  Scenario: the listing projects skip for an adapter whose multiplexer is not installed
    Given herdr is absent from PATH
    And herdr has two integration suites
    When the runner is invoked with no adapter and no flags
    Then herdr's projected outcome is skip

  @id:conformance-listing-projects-gap
  Scenario: the listing projects gap for an installed adapter with no suite
    Given wezterm is on PATH
    And wezterm has no integration suite
    When the runner is invoked with no adapter and no flags
    Then wezterm's projected outcome is gap

  @id:conformance-listing-projects-runnable
  Scenario: the listing projects runnable rather than claiming a run outcome it cannot know
    Given tmux is on PATH
    And tmux has one integration suite
    When the runner is invoked with no adapter and no flags
    Then tmux's projected outcome is runnable
    And no vitest invocation is made
    # pass, fail and no-coverage are findings OF a run. Claiming one here would mean executing every
    # installed adapter's suite — as expensive as the verification this form exists to preview.

  @id:conformance-listing-exits-zero-despite-a-gap
  Scenario: the listing exits 0 even when it projects a gap
    Given wezterm is on PATH
    And wezterm has no integration suite
    When the runner is invoked with no adapter and no flags
    Then wezterm's projected outcome is gap
    And it exits 0
    # the listing's exit is unconditional: it reports a state of affairs rather than judging it, so a
    # subject that reused --all's "any bad outcome exits 1" aggregation here would be caught

  @id:conformance-listing-shows-gap-when-uninstalled
  Scenario: the listing reports a missing suite for an adapter this machine cannot exercise
    Given wezterm is absent from PATH
    And wezterm has no integration suite
    When the runner is invoked with no adapter and no flags
    Then wezterm's line reports a suite count of zero
    # suite presence is reported for every adapter regardless of installation, so a gap stays visible
    # from a machine that cannot run it; only the EXIT STATUS is scoped to what this machine verified

  # ── Refusing to run from inside a multiplexer ──
  # The real-boundary suites drive live multiplexers, and several verbs resolve against the caller's
  # own current pane — from inside herdr, `pane split --current` splits THIS pane. The rule is
  # deliberately blunt rather than per-adapter: a manual verification tool is run from a plain shell,
  # and "which cross-adapter combinations happen to be safe" is not a judgment worth encoding.

  @id:conformance-refuses-inside-a-multiplexer
  Scenario Outline: verifying an adapter from inside any multiplexer is refused
    Given this shell is inside <mux>
    When the runner verifies tmux
    Then it reports that it refuses to run because the shell is inside <mux>
    And no vitest invocation is made
    And it exits 1

    Examples:
      | mux     |
      | tmux    |
      | herdr   |
      | wezterm |
      | zellij  |
      | cmux    |
      | otty    |

  @id:conformance-refuses-inside-a-multiplexer-for-all
  Scenario: --all from inside a multiplexer is refused too
    Given this shell is inside herdr
    When the runner is invoked with --all
    Then it reports that it refuses to run because the shell is inside herdr
    And no vitest invocation is made
    And it exits 1

  @id:conformance-listing-is-exempt-from-the-refusal
  Scenario: the listing form still works from inside a multiplexer
    Given this shell is inside herdr
    When the runner is invoked with no adapter and no flags
    Then every discovered adapter is listed with its projected outcome
    And it exits 0
    # the listing runs no suite, so it carries none of the risk the refusal exists to prevent — and
    # it is how a caller discovers what this machine could verify from a plain shell

  # ── test-adapter <adapter> — verify one adapter ──

  @id:conformance-selects-only-that-adapters-suites
  Scenario: verifying one adapter runs only that adapter's suite files
    Given tmux is on PATH
    And both the tmux and the herdr integration suites exist
    When the runner verifies tmux
    Then the vitest invocation names vitest.integration.config.ts as its config
    And the files it names are exactly tmux's suite files

  @id:conformance-uninstalled-skips
  Scenario: an uninstalled multiplexer is skipped without invoking vitest, and exits 0
    Given herdr is absent from PATH
    And herdr has two integration suites
    When the runner verifies herdr
    Then the outcome reported for herdr is skip
    And no vitest invocation is made
    And it exits 0
    # an adapter you cannot test on this machine is not a defect of this machine's run, and running
    # a suite whose every test would excuse itself reports nothing

  @id:conformance-installed-without-suite-is-a-gap
  Scenario: an installed multiplexer with no real-boundary suite is reported as a gap and exits 1
    Given wezterm is on PATH
    And wezterm has no integration suite
    When the runner verifies wezterm
    Then the outcome reported for wezterm is gap
    And it exits 1
    # wezterm and zellij ship adapters with mocked unit tests only; reporting them green would
    # assert coverage that does not exist

  @id:conformance-all-skipped-is-no-coverage
  Scenario: a suite that executed no tests is reported as no coverage and exits 1
    Given tmux is on PATH
    And its suite run reports 6 tests collected, 0 passed, 0 failed and 6 skipped
    When the runner verifies tmux
    Then the outcome reported for tmux is no-coverage
    And the report carries the skipped count 6
    And it exits 1
    # the subtle case, and a measured one: with the tmux binary made unavailable the suite reports
    # exactly this and vitest still exits 0 reporting success

  @id:conformance-passing-suite-passes
  Scenario: an installed multiplexer whose suite passes is reported as a pass and exits 0
    Given tmux is on PATH
    And its suite run reports 6 tests collected, 6 passed, 0 failed and 0 skipped
    When the runner verifies tmux
    Then the outcome reported for tmux is pass
    And the report carries the executed count 6
    And it exits 0

  @id:conformance-failing-suite-fails
  Scenario: an installed multiplexer whose suite fails is reported as a failure and exits 1
    Given tmux is on PATH
    And its suite run reports 6 tests collected, 5 passed and 1 failed
    When the runner verifies tmux
    Then the outcome reported for tmux is fail
    And it exits 1

  @id:conformance-unknown-adapter-is-usage-error
  Scenario: an unknown adapter name exits 2 and names the adapters that are known
    Given the adapter set tmux, herdr, wezterm and zellij
    When the runner is invoked with the adapter name screen
    Then it reports that screen is not a known adapter
    And it lists tmux, herdr, wezterm and zellij as the known adapters
    And it exits 2
    # screen is recognized by cyber-mux as a mux and deliberately not drivable, so it is the name a
    # caller is most likely to try

  # ── test-adapter --all — verify every installed adapter ──

  @id:conformance-all-reports-each-and-summarizes
  Scenario: --all reports every adapter on its own line and summarizes the counts
    Given tmux is on PATH and its suite passes
    And herdr is absent from PATH
    And wezterm is on PATH with no integration suite
    When the runner is invoked with --all
    Then tmux is reported as pass on its own line
    And herdr is reported as skip on its own line
    And wezterm is reported as gap on its own line
    And a summary of the outcome counts follows those lines

  @id:conformance-all-exits-nonzero-on-any-bad-outcome
  Scenario Outline: --all exits 1 when any single adapter is a gap, no coverage, or a failure
    Given one adapter whose outcome is pass
    And a second adapter whose outcome is <outcome>
    When the runner is invoked with --all
    Then it exits 1

    Examples:
      | outcome     |
      | gap         |
      | no-coverage |
      | fail        |
    # one bad outcome cannot be averaged away by its passing neighbors

  @id:conformance-all-exits-zero-when-nothing-bad
  Scenario: --all exits 0 when every adapter either passed or was skipped
    Given one adapter whose outcome is pass
    And a second adapter whose outcome is skip
    When the runner is invoked with --all
    Then it exits 0
    # the positive companion to the guard above: skip must not be able to fail the run, or a
    # tmux-only machine could never report success

  @id:conformance-unknown-flag-is-usage-error
  Scenario: an unrecognized flag exits 2, naming the flag and listing the valid ones
    Given the runner's one valid flag is --all
    When the runner is invoked with the flag --everything
    Then it names --everything as unrecognized
    And it lists --all as the valid flag
    And it exits 2
    # the caller self-corrects in one turn rather than spending a round trip on --help
