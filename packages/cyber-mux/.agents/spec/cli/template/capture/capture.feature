@frozen
Feature: cyber-mux template save — the CLI capture surface
  How the cyber-mux command line reaches capture: which region --from names, --workspace and its
  bare-save reveal, the --description draft note, where the file goes (--to, --force) and what save
  refuses. The surface-independent engine save drives — deriving the split tree from the rectangles
  the seam reports, subtracting the target directory back out, the draft-note content, and the
  roundtrip — lives in ../../../template/capture/capture.feature; this suite owns invocation and
  presentation. The exit-code contract every refusal honors (1 operation failed, 2 usage error) is
  AXI's, pinned once for the whole CLI in ../../lookup/lookup.feature and applied here, not restated.

  # ── The subject: which region --from names ──
  # save's default subject is the caller's own region (the library engine's rule). --from overrides it.

  Scenario: --from captures the region around a named pane
    Given a caller running cyber-mux template save pool-3 --from a pane in another region
    When the command runs
    Then the captured region is that pane's

  # ── Capturing a whole workspace: --workspace ──
  # --workspace widens the subject to every tab of the workspace; a bare save stays the caller's
  # region and says, on stdout, what it left out.

  Scenario: save --workspace captures every tab of the caller's workspace
    Given a caller in a workspace of 3 tabs
    When cyber-mux template save pool --workspace runs
    Then the written template declares tabs
    And it carries one tab per tab of the workspace, each with that tab's own tree

  Scenario: save without --workspace captures only the caller's own region
    Given a caller in a workspace of 3 tabs
    When cyber-mux template save pool runs
    Then the written template declares root rather than tabs
    And it carries only the caller's own region
    # the default subject is unchanged — widening it silently would rewrite what save has always meant

  Scenario: a bare save in a multi-tab workspace says what it left out, in a help block on stdout
    Given a caller in a workspace of 3 tabs
    When cyber-mux template save pool runs with no --workspace
    Then the written path is reported on stdout as a structured payload
    And that payload carries a help entry naming the tabs left out and the command that captures them
    And the help entry's command is cyber-mux template save pool --workspace
    And stderr is empty
    # the capture is honest about its own scope rather than letting a caller believe a 3-tab workspace
    # round-trips from a 1-tab template. Per axi/'s #9 the reveal-a-truncated-list note belongs on
    # STDOUT inside the payload, not stderr the agent never reads — so save's stdout is a structured
    # payload (path + a help[N]: block), not a bare path. Programmatic composition reads the path from
    # --format json (below) rather than bare stdout.

  # ── The draft note: --description ──

  Scenario: --description replaces the draft note
    Given a caller running cyber-mux template save pool-3 --description "the review pool"
    When the command runs
    Then the written template's description is "the review pool"

  # ── save writes a file ──

  Scenario: save writes to the repo templates directory and reports the path on stdout
    Given a caller running cyber-mux template save pool-3
    When the command runs
    Then the template is written under the primary checkout's .cyber-mux/templates as pool-3.json
    And stdout carries the written path as a structured payload
    And no help entry rides along, because the caller's region is the whole workspace
    # save's stdout is a structured payload (a path field, plus a help[N]: block only when there is a
    # next move — a multi-tab workspace a bare save only partly captured). Nothing is on stderr.
    # Programmatic composition reads the path from --format json, not bare stdout:
    #   cyber-mux template save pool-3 --format json | jq -r .path

  Scenario: --format json reports the saved path and any help as one structured object
    Given a caller in a workspace of 3 tabs running cyber-mux template save pool --format json
    When the command runs
    Then stdout is a JSON object carrying the path and a help array
    And each help entry carries a message and the command that acts on it
    And the help entry's command is cyber-mux template save pool --workspace
    # the machine-readable half of the same payload — path plus the same #9 reveal, so a consumer that
    # branches on the help never has to parse a prose line off stderr

  Scenario: --to user writes to the user templates directory instead
    Given a caller running cyber-mux template save pool-3 --to user
    When the command runs
    Then the template is written under the user templates directory
    And nothing is written to the repo templates directory

  Scenario: save refuses to overwrite an existing template, and reads no region finding out
    Given a repo templates directory already containing pool-3.json
    When cyber-mux template save pool-3 runs
    Then it exits 1
    And the error names --force
    And the existing template is unchanged
    And no region is read
    # a capture is hand-edited afterwards — the commands are added by hand — so overwriting one
    # silently would throw that work away. Checked before the capture, so the refusal is free.

  Scenario: --force overwrites an existing template
    Given a repo templates directory already containing pool-3.json
    When cyber-mux template save pool-3 --force runs
    Then it exits 0
    And pool-3.json is replaced by the captured template

  # ── save's refusals ──
  # Every refusal writes nothing, under two exit codes by kind: a malformed name and no pane to
  # capture around are usage errors (2); a backend that cannot enumerate a workspace or report a
  # region's geometry is a genuine operation failure (1). The capability contract behind the two
  # backend refusals — that an absent optional seam member is a refusal, never a guess — is the
  # engine's, in ../../../template/capture; these rows own the verb's observable refusal.

  Scenario: save validates the name before touching the filesystem or the multiplexer
    Given a caller running cyber-mux template save "../escape"
    When the command runs
    Then it exits 2, a usage error — the same malformed-name family show refuses at 2
    And no file is written
    And no region is read
    # a name is a lookup key that must also be a filename, exactly as it is for show and validate

  Scenario: save with no pane to capture around refuses rather than guessing
    Given a caller in no pane at all
    And no --from
    When cyber-mux template save pool-3 runs
    Then it exits 2 naming --from, a usage error — a required parameter is missing, not an operation that failed
    And no template is written
    # falling back to the backend's own default would capture whichever region the user happens to be
    # looking at and name it after the caller's intent — a wrong answer is worse than no answer here

  Scenario: a backend that cannot enumerate a workspace's tabs refuses save --workspace cleanly
    Given a backend that cannot report its workspace's tabs
    When cyber-mux template save pool --workspace runs
    Then it exits 1 naming the backend
    And no file is written
    # the same refusal shape as a backend that cannot report a region's geometry — an absent optional
    # seam member is a refusal, never a guess

  Scenario: a backend that cannot report its region's geometry refuses save cleanly
    Given a backend with no region-geometry primitive
    When cyber-mux template save pool-3 runs
    Then it exits 1 naming that backend
    And no template is written
    # geometry reporting is an optional capability, exactly as the worktree binding already is —
    # a backend that cannot answer cannot be captured, and there is nothing to degrade to
