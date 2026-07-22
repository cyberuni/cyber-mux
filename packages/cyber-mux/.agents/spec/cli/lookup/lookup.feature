@frozen
Feature: cyber-mux lookup — the pane-addressing verbs and the shared error contract
  The cyber-mux verbs that address a pane — read, focus, close, list, exists — what each writes to
  stdout and exits, and the one structured-error/usage contract every cyber-mux verb fails through.
  The resolution ladder, the read-only focus probe, and what the live pane listing carries are the
  library contract in ../../mux/lookup/lookup.feature; this suite owns invocation and presentation.

  # ── read, focus, close — the pane-taking verbs ──
  # Each resolves its <pane> argument to a single pane through the shared id/label ladder in
  # ../../mux/lookup before acting; an ambiguous locator fails through the shared error contract below.

  Scenario: read writes the addressed pane's captured output straight to stdout, as raw bytes
    Given a live pane labeled worker with captured output
    When a caller runs cyber-mux read worker
    Then the pane's captured bytes are written to stdout, followed by a trailing newline
    And the bytes are the pane's own raw output, not wrapped in a structured payload — read addresses a byte stream, not a JSON envelope
    And it exits 0
    # read is the one verb whose stdout is raw bytes rather than the --format json envelope: it always
    # writes the capture directly, because the capture IS what the caller asked for.

  Scenario: read --lines caps the capture to the trailing n lines
    Given a live pane labeled worker whose scrollback holds more than five lines
    When a caller runs cyber-mux read worker --lines 5
    Then stdout carries only the trailing five lines of the pane's output
    And it exits 0

  Scenario: focus beams the attached client's view to the addressed pane
    Given a live pane labeled worker on a backend with an attached client
    When a caller runs cyber-mux focus worker
    Then the backend drives the attached client's view to the pane labeled worker
    And stdout is empty, because focus reports nothing on success — its effect is the moved view
    And it exits 0
    # The focus VERB, not the read-only focus PROBE in ../../mux/lookup: the probe reports
    # focused/not-focused/unknown and opens nothing, while this verb drives the client's view to a pane.

  Scenario: close terminates the addressed pane
    Given a live pane labeled worker
    When a caller runs cyber-mux close worker
    Then the backend closes the pane labeled worker
    And stdout is empty, because close reports nothing on success
    And it exits 0

  # ── exists — probe whether a single pane is live ──
  # The `list` verb's enumeration (every live pane, agent-bearing or not) and which labels a listing
  # carries are adapter listing behavior — the library contract in ../../mux/lookup. This verb surface
  # adds no rendering rule of its own beyond the shared table and the shared error contract below.

  # exists answers about a locator, and three panes named worker is not an answer to "is it live?" —
  # so the outcome rides the exit code rather than a word. The word-only alternative is what
  # systemctl is-active does, reporting `inactive` for both a stopped unit and a unit that does not
  # exist: only its exit code tells them apart.
  Scenario Outline: exists distinguishes its three outcomes by exit code, not by prose
    Given <world>
    When a caller runs cyber-mux exists naming that locator
    Then stdout carries <stdout>
    And it exits <code>

    Examples:
      | world                                     | stdout                        | code |
      | exactly one live pane matches the locator | live                          | 0    |
      | no live pane matches the locator          | gone                          | 1    |
      | two or more live panes match the locator  | the ambiguous-pane error      | 2    |

  Scenario: an ambiguous exists reports its candidates rather than answering the question
    Given two live panes labeled worker
    When a caller runs cyber-mux exists naming worker
    Then the candidates are reported on stdout under the code ambiguous-pane
    And it answers neither live nor gone, because there is no single pane the question is about
    # The report REPLACES the answer on stdout rather than joining it: exists either answers or errors,
    # so a caller reading stdout after a nonzero exit is reading the error, never a word plus an error.

  # ── The shared AXI error and usage contract — structured, coded, on the stream the agent reads ──
  #
  # These pin axi/'s #6 concretely, which is where that reference node's conformance is verified: it
  # carries no suite of its own. One helper (fail()/reportError, with paneVerb and reportWorktreeFailure
  # translating backend throws) reaches EVERY cyber-mux verb here, so these scenarios are about the
  # surface rather than any one command — a verb-by-verb pin would freeze twenty copies of one rule.

  # An ambiguous locator fails identically across every pane verb, and the PAYLOAD is the "same way":
  # reported on stdout under ambiguous-pane at exit 2. The resolution decision behind it — that an
  # ambiguous name acts on none of the panes, uniformly across verbs — is the contract in ../../mux/lookup.
  Scenario Outline: an ambiguous locator is reported under ambiguous-pane on every pane verb
    Given three live panes all labeled worker
    When a caller runs <verb> naming worker
    Then the candidates are reported on stdout under the code ambiguous-pane
    And it exits 2

    Examples:
      | verb                         |
      | cyber-mux read               |
      | cyber-mux submit             |
      | cyber-mux exists             |
      | cyber-mux focus              |
      | cyber-mux close              |
      | cyber-mux send text          |
      | cyber-mux send keys          |
      | cyber-mux template save --from |

  Scenario: the ambiguity report carries what tells the candidates apart, and what retries them
    Given three live panes all labeled worker, each in a different working directory
    When a caller names worker
    Then each candidate is reported with its id, its label, and its working directory
    And each candidate's id is directly usable as the retry that resolves the ambiguity

  # The report goes to stdout because that is the stream AXI reserves for what the agent consumes —
  # data, errors and suggestions alike — while stderr is defined as debug the agent does not read. A
  # report whose whole purpose is handing a caller the candidates to retry with is the last thing that
  # belongs on the ignored stream. A verb either succeeds and writes its result or fails and writes its
  # error, never both, so the exit code tells the two apart before anything is parsed.
  Scenario: the ambiguity report is a structured error on stdout, where the agent reads
    Given two live panes labeled worker
    When a caller names worker
    Then the report is written to stdout under the stable code ambiguous-pane
    And stderr is left empty, carrying no part of the answer
    And it exits 2

  Scenario: --format json emits the ambiguity as a structured error carrying its candidates
    Given two live panes labeled worker
    When a caller names worker with --format json
    Then the error carries the code ambiguous-pane and the candidate entries as JSON
    And it is written to stdout, where a caller branching on exit 2 never mistakes it for a result

  # This surface rule holds for EVERY verb, template included; the examples stay on the shared,
  # non-template surface so this node owns the shape, not any command's specifics. Each template verb's
  # own code, exit and message live in template/'s suite, and they follow this same shape.
  Scenario Outline: a failure is a structured error on stdout, under the code for THAT failure
    Given <world>
    When a caller runs <verb>
    Then the report is written to stdout, never stderr
    And it carries the stable code <code>
    And it carries a help line naming the command that fixes it, never "see --help"
    And it exits <exit>

    Examples:
      | world                                    | verb                  | code           | exit |
      | no multiplexer this process is inside    | cyber-mux list        | no-mux         | 1    |
      | a locator matching no live pane          | cyber-mux focus %99   | pane-not-found | 1    |
      | two live panes labeled worker            | cyber-mux read worker | ambiguous-pane | 2    |

  # The codes must DISCRIMINATE. A CLI that renamed fail()'s free text to `code: error` and moved it to
  # stdout would satisfy "carries a stable code" on every row while leaving a caller exactly as unable
  # to tell one failure from another as parsing prose left them — and that is the CHEAPEST edit at the
  # one helper this surface owns, so it is the wrong impl most likely to be built.
  Scenario: two different failures never share one code
    Given a caller who hits an ambiguous locator and a caller who hits no multiplexer
    When each failure is reported
    Then the code ambiguous-pane and the code no-mux differ
    And neither is a catch-all a third failure mode would also land under

  # A usage error is a missing or malformed ARGUMENT — the fix is a different invocation, not a retry.
  # A required argument the parser never received is exactly that, and it is the same family as the
  # unknown flag: both exit 2, having called no backend.
  Scenario Outline: a missing required argument is a usage error, not a failed operation
    Given a caller running <verb> without the pane argument it requires
    When the command is parsed
    Then it exits 2 rather than 1, having called no backend
    And the error names the argument that is missing

    Examples:
      | verb                |
      | cyber-mux read      |
      | cyber-mux focus     |
      | cyber-mux send text |

  Scenario: an unknown flag is a usage error, and says what the valid flags are
    Given a caller running cyber-mux list with a flag that command does not define
    When the command is parsed
    Then it exits 2, having called no backend and listed nothing
    And the error names the unrecognized flag
    And it lists that command's valid flags, so the agent self-corrects without a second call
    # AXI's own reasoning: the expensive cost is the follow-up round trip, and the agent's deterministic
    # next move after an unknown flag is `--help`. Folding that answer into the error collapses a
    # two-turn correction into one.

  Scenario: an unknown flag is rejected against the SUBCOMMAND's flags, not the group's
    Given a caller running cyber-mux template list with --force, a flag only cyber-mux template save defines
    When the command is parsed
    Then it exits 2 and names --force as unknown for template list
    And the valid flags it lists are template list's own, never template save's
    # A group's subcommands do not share a flag set, and only the subcommand layer knows which is in
    # play. Validating against the GROUP's union would accept --force here and then silently drop it —
    # the exact failure fail-loud exists to prevent. template is the pair that can carry this rule: save
    # takes --from/--workspace/--description/--force and list takes none of them. send cannot — its
    # text and keys subcommands define identical flag sets, so no flag exists that separates them.

  Scenario: --help is never an unknown flag
    Given a caller running any cyber-mux command with --help
    When the command is parsed
    Then help is written to stdout and it exits 0
    And no flag validation rejects it, on any command

  Scenario: a structured error honors --format json
    Given a caller whose command fails with --format json
    When the error is reported
    Then it is emitted as JSON on stdout carrying the same stable code the readable form uses
    And no free-text prose is written beside it

  # This is what makes an error on stdout safe, and it is the premise the whole stream decision rests
  # on. The invariant is not "no verb ever exits nonzero with output" — apply exits nonzero and still
  # reports (below). It is narrower and exact: stdout carries exactly ONE payload. Either a RESULT —
  # which may report a negative or partial outcome inside itself and carry a nonzero exit, as exists's
  # `gone` and apply's partial manifest do — or a structured ERROR, when the operation produced no
  # result at all. Never a result and a separate error object concatenated.
  Scenario: a failed verb's stdout is its structured error alone, with no result before it
    Given a caller running cyber-mux read against a pane whose capture fails
    When the failure is reported
    Then the structured error is the whole of stdout
    And no partial pane output precedes it
    # read is the sharpest case, because its stdout is the pane's own raw byte stream rather than a
    # structured payload — the one place a mixture would be genuinely unparseable. It holds because a
    # failed read captures nothing: there are no bytes for an error to land amid.

  Scenario: a partially-applied template is one result payload, not a result plus an error
    Given a tabs template whose second tab fails to open
    When cyber-mux applies it
    Then stdout carries the manifest of the panes already built, and that manifest alone
    And the tab that failed is named inside that manifest, never appended as a second structured error
    And it exits nonzero to signal the apply was incomplete
    # apply does not roll back (template/), so a partial build is a real outcome with a real result — the
    # one case that looks like "result AND error on stdout" and is not. The nonzero exit and the named
    # failing tab live INSIDE the one manifest payload, which is what keeps the invariant true here.

  Scenario: an error never leaks the multiplexer's own output
    Given a caller running a verb whose backend command fails with a tmux or herdr diagnostic
    When the failure is reported
    Then the error is translated into this CLI's own code and help
    And the backend's raw text is not passed through as the message
    # AXI: never leak dependency names — a suggestion references THIS CLI's commands, not the tool it
    # wraps. An agent handed a tmux error cannot act on it through cyber-mux.

  # The catch-all every worktree verb shares (reportWorktreeFailure) sits downstream of TWO error
  # sources with different safety, and it is the one place that has to tell them apart: this CLI's own
  # worktree refusals (a dirty-checkout guard, a primary-checkout guard) are safe to forward verbatim,
  # while a failure from opening or binding the worktree's pane comes from the multiplexer and carries
  # its raw diagnostic the same way the scenario above already forbids for every other verb.
  Scenario: the worktree catch-all never forwards the multiplexer's raw diagnostic either
    Given a caller running cyber-mux worktree add whose backend fails opening the worktree's pane
    When the failure is reported
    Then the error carries the worktree-failed code and this CLI's own message
    And neither the backend's name nor its raw diagnostic appears on stdout

  # ── The list rendering keeps each field whole ──

  Scenario: a listed label or working directory containing a space is rendered whole, never split across columns
    Given a tmux pane labeled my worker, whose working directory path also contains a space
    When a caller runs cyber-mux list and reads the human table
    Then the label my worker and the working directory are each rendered whole in their own column
    And neither value corrupts what is listed beside it
    # The resolution half — that a caller naming `my worker` resolves that pane — is the contract in
    # ../../mux/lookup: the whole spaced label is taken as one locator.
