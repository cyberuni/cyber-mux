@frozen
Feature: mux lookup — addressing a pane, and the error surface
  How a pane locator resolves to one pane, what a listing reports, whether a pane is focused, and the
  structured error every verb fails with.

  # ── Reporting whether a pane is currently focused (on screen for an attached client) ──

  Scenario: tmux reports a pane focused when an attached client is currently viewing it
    Given a tmux pane that is the active pane of the current window in a session with an attached client
    When the backend is asked whether that pane is focused
    Then it reports focused

  Scenario Outline: tmux reports a pane not focused when <condition>
    Given a tmux pane where <condition>
    When the backend is asked whether that pane is focused
    Then it reports not-focused

    Examples:
      | condition                               |
      | it is not the active pane of its window |
      | its window is not the current window    |
      | its session has no attached client      |

  Scenario: herdr reports a pane focused when its pane record is focused
    Given a herdr pane whose pane record reports it is currently being viewed by a client
    When the backend is asked whether that pane is focused
    Then it reports focused

  Scenario: herdr reports a pane not focused when its pane record is not focused
    Given a herdr pane whose pane record reports no client is currently viewing it
    When the backend is asked whether that pane is focused
    Then it reports not-focused

  Scenario Outline: a focus query that cannot be answered is unknown, not a boolean
    Given <condition>
    When it is asked whether a pane is focused
    Then it answers unknown rather than a boolean, so callers fail open instead of treating the pane as absent

    Examples:
      | condition                                    |
      | a backend with no primitive to report focus  |
      | a pane the backend can no longer resolve     |
      | a focus query that errors                    |

  Scenario: wezterm always reports unknown — it has no focus primitive at all, not just a per-query gap
    Given a wezterm pane, any pane
    When the backend is asked whether that pane is focused
    Then it reports unknown
    # `wezterm cli list --format json`'s documented fields carry no active/focused indicator for a
    # pane, tab, or window — unlike tmux/herdr, where unknown is a per-query FALLBACK, this is the
    # WHOLE backend's answer, every time, by the same honest convention.

  # ── list enumerates every live pane, not just agent-bearing ones ──

  Scenario: list enumerates every live pane, including one running no agent/harness
    Given a backend with a mix of panes, some running an agent/harness and some running none
    When it runs cyber-mux list
    Then every live pane is reported, whether or not it is running an agent/harness

  # ── Addressing a pane — a name or an id, and the candidates when a name is ambiguous ──
  # A label is a human name, not a key. Neither backend requires one unique, herdr labels every new
  # workspace's root tab 1, and a label reaches a live pane because a person set it by hand — so
  # duplicates arrive by default. Refusing them at authoring time was only ever a guess about what
  # the author meant; at LOOKUP time the ambiguity is a fact, the candidates are known, and the
  # caller is present to resolve it.

  Scenario Outline: every pane verb addresses a pane by name as readily as by id
    Given three live panes, labeled worker, sidebar and logs
    When a caller runs <verb> naming worker rather than the pane's id
    Then the verb acts on the pane labeled worker, exactly as if that pane's id had been passed
    And neither of the other two panes is acted on

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

  Scenario: a name never resolves a wezterm pane — only an id can
    Given a live wezterm pane and a caller naming some word as if it were a label
    When a caller runs any pane verb naming that word
    Then it fails as a pane that could not be resolved, the same as any name matching no live pane
    # Not a gap in the resolution ladder — a direct consequence of wezterm never carrying a label at
    # all (see the live-pane-listing scenario below): with no pane ever reporting one, a name can
    # never match, so every pane verb on wezterm is reachable by id alone.

  Scenario Outline: an ambiguous name fails the same way on every pane verb
    Given three live panes all labeled worker
    When a caller runs <verb> naming worker
    Then the candidates are reported on stdout under the code ambiguous-pane
    And it exits 2, having acted on none of the three panes

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

  # An id outranks a name, so every caller that works today keeps working: an id can never be made
  # to mean something else by a person renaming an unrelated pane. Ambiguity is a fuzzy-tier
  # condition only — the same ladder git, Docker and tmux resolve their own targets by.
  Scenario: an id addresses the pane whose id it is, even when another pane is labeled with that id
    Given a live pane whose id is a string, and a different live pane labeled with that same string
    When a caller names that string
    Then the pane whose id it is, is the one addressed
    And no ambiguity is reported, because the two matches are not peers

  # The counter-case a syntax rule cannot survive: %9 is id-SHAPED, but no pane carries it as an id
  # and one carries it as a label. A resolver that sniffs the shape calls this a missing pane and
  # exits 1; a resolver that asks the live list finds the label. Docker sniffs (`sg-` → an id) and it
  # is the cheaper rule — refused here because encoding a backend's id format in the CLI is the
  # backend leak this seam exists to prevent, and a new backend would owe a new syntax rule.
  Scenario: an id is recognized by matching a live pane, never by the shape of the string
    Given a live pane labeled %9, and no live pane whose id is %9
    When a caller names %9
    Then it resolves to the pane labeled %9
    And it is neither reported as a pane that does not exist, nor refused for looking like an id

  Scenario: a name matching exactly one live pane resolves to it and the command proceeds
    Given three live panes, exactly one of them labeled worker
    When a caller names worker
    Then it resolves to that pane, and the command proceeds against it
    And neither of the other two panes is acted on

  Scenario: a name matching no live pane is not found, rather than ambiguous
    Given no live pane labeled worker, and no live pane whose id is worker
    When a caller names worker
    Then it fails as a pane that could not be resolved
    And it exits 1

  Scenario: a name matching two or more live panes fails rather than guessing which was meant
    Given three live panes all labeled worker
    When a caller names worker
    Then the command fails, having acted on none of them
    And the matching entries are reported, so the caller can choose between them

  Scenario: the ambiguity report carries what tells the candidates apart, and what retries them
    Given three live panes all labeled worker, each in a different working directory
    When a caller names worker
    Then each candidate is reported with its id, its label, and its working directory
    And each candidate's id is directly usable as the retry that resolves the ambiguity

  # The report goes to stdout because that is the stream AXI reserves for what the agent consumes —
  # data, errors and suggestions alike — while stderr is defined as debug the agent does not read. A
  # report whose whole purpose is handing a caller the candidates to retry with is the last thing that
  # belongs on the ignored stream. This does not muddy the payload: a verb either succeeds and writes
  # its result or fails and writes its error, never both, so the exit code tells the two apart before
  # anything is parsed.
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

  # exists answers about a locator, and three panes named worker is not an answer to "is it live?" —
  # so the outcome rides the exit code rather than a word. The word-only alternative is what
  # systemctl is-active does, reporting `inactive` for both a stopped unit and a unit that does not
  # exist: only its exit code tells them apart.
  #
  # exists is a PREDICATE, and its `1` is a real divergence from axi #6 rather than an amendment to it.
  # AXI reserves `1` for an error; exists spends it on `gone`, which is not an error but the answer to
  # the question asked. That is the framing grep, POSIX test and systemctl is-active all take, it is
  # deliberate, and it is kept — but it is NOT the code set AXI states, and the axi node used to call it
  # "an amendment to the 0/1 set", which was wrong twice over: the set was always 0/1/2 (nothing was
  # amended), and what exists actually diverges on is the MEANING of 1, which no amendment covered.
  # Recorded here rather than mislabeled. Whether to keep it is its own question, not one the
  # error-surface pass that corrected the text around it settles.
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

  Scenario Outline: the live pane listing carries each pane's label, so a name resolves from it
    Given a <backend> pane a person has labeled
    When the live panes are listed
    Then the listing carries that pane's label beside its id

    Examples:
      | backend |
      | tmux    |
      | herdr   |

  # tmux has no unset title — it defaults pane_title to the hostname, so an untouched pane reports a
  # name nobody chose. Exporting that would label EVERY pane in the session identically, and the
  # hostname would then resolve to every one of them: ambiguity manufactured out of nothing.
  Scenario: a tmux pane nobody named carries no label, so the hostname addresses no pane
    Given a tmux pane whose title has never been set
    When the live panes are listed
    Then that pane reports no label
    And the hostname resolves to no pane, rather than colliding with every pane in the session

  # The contrast that shows the tmux rule is a workaround, not the shape of the thing: herdr has the
  # honest primitive, so an unnamed pane needs no rule to be read as unnamed.
  Scenario: a herdr pane nobody named carries no label, with no comparison needed to tell
    Given a herdr pane that has never been renamed
    When the live panes are listed
    Then that pane reports no label, because herdr omits the name outright until one is set

  Scenario: a wezterm pane never carries a label, because nothing can ever set one
    Given a wezterm pane, any pane
    When the live panes are listed
    Then that pane reports no label
    # Not a filtering rule like tmux's hostname guard — there is no primitive at all to title a pane
    # on this backend (see rename), so `title` is always the ambient running-program name, never
    # something a human or cyber-mux chose. Reporting it as a label would manufacture the exact
    # collision (every shell pane named the same thing) the hostname guard exists to prevent, with no
    # way for an author to ever override it here.

  Scenario: a label containing spaces resolves, and never corrupts what is listed beside it
    Given a tmux pane labeled my worker, whose working directory path also contains a space
    When the live panes are listed
    Then the label and the working directory are each read whole
    And a caller naming my worker resolves that pane

  # ── The error surface — structured, coded, and on the stream the agent actually reads ──
  #
  # These pin axi/'s #6 concretely, which is where that reference node's conformance is verified: it
  # carries no suite of its own. One helper reaches every verb here, so these scenarios are about the
  # surface rather than any one command — a verb-by-verb pin would freeze twenty copies of one rule.

  # This surface rule holds for EVERY verb, template included; the examples stay on the shared,
  # non-template surface so this node owns the shape, not any command's specifics. Each template verb's
  # own code, exit and message live in template/'s suite (the Boundary rule: domain behavior belongs to
  # its capability node), and they follow this same shape.
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

  # The codes must DISCRIMINATE, which is the whole of the third divergence and the half a reader is
  # most likely to skim past. A CLI that renamed fail()'s free text to `code: error` and moved it to
  # stdout would satisfy "carries a stable code" on every row while leaving a caller exactly as unable
  # to tell one failure from another as parsing prose left them — and that is the CHEAPEST edit at the
  # one helper this pass touches, so it is the wrong impl most likely to be built.
  Scenario: two different failures never share one code
    Given a caller who hits an ambiguous locator and a caller who hits no multiplexer
    When each failure is reported
    Then the code ambiguous-pane and the code no-mux differ
    And neither is a catch-all a third failure mode would also land under

  # A usage error is a missing or malformed ARGUMENT — the fix is a different invocation, not a retry.
  # A required argument the parser never received is exactly that. These ship at 1 today (commander's
  # default), which #36 did not separately count, and they are the same family as the unknown flag.
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
  # on — so it is contracted here rather than left as a property the current code happens to have.
  # The invariant is not "no verb ever exits nonzero with output" — apply exits nonzero and still
  # reports (below). It is narrower and exact: stdout carries exactly ONE payload. Either a RESULT —
  # which may report a negative or partial outcome inside itself and carry a nonzero exit, as exists's
  # `gone` and apply's partial manifest do — or a structured ERROR, when the operation produced no
  # result at all. Never a result and a separate error object concatenated. A caller branches on the
  # exit code, then parses one payload; it is never handed two.
  Scenario: a failed verb's stdout is its structured error alone, with no result before it
    Given a caller running cyber-mux read against a pane whose capture fails
    When the failure is reported
    Then the structured error is the whole of stdout
    And no partial pane output precedes it
    # read is the sharpest case, because its stdout is the pane's own raw byte stream rather than a
    # structured payload — the one place a mixture would be genuinely unparseable, not merely untidy.
    # It holds because a failed read captures nothing: there are no bytes for an error to land amid.

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

  # The catch-all every worktree verb shares (`reportWorktreeFailure`) sits downstream of TWO error
  # sources with different safety, and it is the one place that has to tell them apart: this CLI's own
  # worktree refusals (a dirty-checkout guard, a primary-checkout guard) are safe to forward verbatim,
  # while a failure from opening or binding the worktree's pane comes from the multiplexer and carries
  # its raw diagnostic the same way the scenario above already forbids for every other verb.
  Scenario: the worktree catch-all never forwards the multiplexer's raw diagnostic either
    Given a caller running cyber-mux worktree add whose backend fails opening the worktree's pane
    When the failure is reported
    Then the error carries the worktree-failed code and this CLI's own message
    And neither the backend's name nor its raw diagnostic appears on stdout

