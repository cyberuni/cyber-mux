@frozen
Feature: cyber-mux send/submit invocation — rejecting incomplete input
  How the `cyber-mux send` and `cyber-mux submit` verbs reject an incomplete invocation before a
  keystroke reaches a pane: send keys with no tokens, send text with no text, a bare send group, and
  submit with no pane. What each verb sends once the input is complete is the drive contract in
  ../../mux/driving/driving.feature. The structured error/exit-code/help envelope these rejections
  ride is the shared fail() contract owned by ../lookup/lookup.feature; this suite names the usage
  errors, not that envelope.

  # ── send text / send keys reject incomplete input before touching a pane ──

  Scenario: send keys with no key tokens is rejected
    Given a caller running cyber-mux send keys naming a pane but no key tokens
    When the command is parsed
    Then it is rejected before anything is sent to the pane

  Scenario: send text with no text argument is rejected
    Given a caller running cyber-mux send text naming a pane but no text
    When the command is parsed
    Then it is rejected before anything is sent to the pane

  # ── the bare send group — invoked without a subcommand (axi/ #6: a missing required parameter) ──

  Scenario: bare send is incomplete input, so it fails loud with help rather than acting
    Given a caller running cyber-mux send naming neither text nor keys
    When the command is parsed
    Then help naming text and keys as its subcommands is written to stdout
    And it exits 2, the status that separates bad input from a failed operation
    And nothing is sent to any pane

  # ── submit rejects a missing pane ──

  Scenario: submit with no pane is rejected
    Given a caller running cyber-mux submit naming no pane
    When the command is parsed
    Then it is rejected, naming pane as the missing argument
    And nothing is sent to any pane
