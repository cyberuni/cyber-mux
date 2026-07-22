@frozen
Feature: mux driving — taking a pane's turn
  Typing text, pressing named keys, and submitting: only submit presses Enter for you.

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

  # The CLI usage errors of these verbs — send keys with no tokens, send text with no text, and a
  # bare send with no subcommand — are a surface concern and live in ../../cli/driving/driving.feature.

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
      | $ZELLIJ set                 | zellij  |

  # submit's CLI usage error — a missing pane argument — lives in ../../cli/driving/driving.feature.

  Scenario Outline: submit with empty text is the bare flush, not a second contract
    Given a pane with text already staged unsent in its input box, with <env>
    When cyber-mux submit runs against it with an empty text argument
    Then exactly one Enter is pressed and nothing is typed, the same as passing no text at all
    And the staged text is not duplicated

    Examples:
      | env                         |
      | $TMUX set                   |
      | $HERDR_ENV set and no $TMUX |

