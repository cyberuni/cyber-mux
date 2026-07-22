@frozen
Feature: template capture — read a live region back into a template
  cyber-mux template save is the inverse of apply: it reads a live region, or a whole workspace,
  derives the split tree from the rectangles the seam reports, subtracts the target directory back
  out into dir, and writes the template that would rebuild it. The result is a draft — geometry,
  labels and dirs, never a command — and it says so in its own description.
  # This is the ENGINE: the surface-independent write contract — the geometry->tree derivation, the
  # target subtraction, the draft-note content, and the roundtrip. The save verb, its flags (--from,
  # --workspace, --description, --to, --force), where the file lands, and the exit code each refusal
  # takes are the CLI surface, in ../../cli/template/capture/capture.feature.

  # ── Capturing a live region: which region, and what tree ──
  # save is the inverse of apply. The seam reports one rectangle per pane; cyber-mux derives the tree.

  Scenario: save captures the region around the calling pane, not the one the user is looking at
    Given a caller in a pane whose region the caller is not focused on
    When cyber-mux template save pool-3 runs with no --from
    Then the captured region is the caller's own
    # the same reason every split names its pane: both backends' defaults track the user rather than
    # the caller, and they only coincide while a human is typing
    # (--from, which overrides this default subject, is a flag, on the CLI surface in cli/template/capture.)

  Scenario: the geometry seam reports one rectangle per pane, not a backend's own tree
    Given a region on any backend
    When the geometry seam reports it
    Then every pane in the region is reported with its rectangle
    And no backend's native split-tree encoding is parsed to obtain the tree
    # tmux encodes its tree in a bespoke string it does not promise to keep; herdr's splits[] is flat,
    # with parent links only inside an undocumented id convention. A rectangle is the one fact both
    # report exactly, and a region built by splitting is always guillotine-cuttable from rectangles.

  Scenario: a captured ratio is the one the split was made with, not the one the pane sizes imply
    Given a region split at ratio 0.7 on a backend that draws a divider between panes
    When the region is captured
    Then the captured split's ratio is 0.7
    # the divider cell belongs to the region and to neither pane, so the backend reports 34 and 15 of
    # a 50-row region. first/(first+second) reads 0.69; the complement, 1 - second/total, puts the
    # divider where the backend's own sizing flag puts it and reads the 0.7 the split was made with.

  Scenario: re-applying a captured template reproduces the region it was captured from
    Given a region of 4 panes built by splitting
    When it is captured and the captured template is applied to a fresh region of the same size
    Then every pane of the rebuilt region matches the size of its counterpart in the original
    # the property the whole derivation exists to hold — a capture that does not round-trip is a
    # confident lie about the user's screen

  Scenario: an n-ary row captures as the right-comb the flat sugar desugars to
    Given a region of 3 equal panes side by side
    When it is captured
    Then the captured tree is the one arrange even-horizontal desugars to for 3 panes
    # three panes side by side is ONE node with three children in a backend's own tree; the schema is
    # binary, so the capture must comb it — and must comb it the way the desugarer does, or a pool
    # would not survive the round trip. Capture and the flat sugar meet at the same canonical form.

  Scenario: an ambiguous grid captures columns-first, matching tiled rather than its transpose
    Given a region of 4 panes in a 2x2 grid
    When it is captured
    Then the captured tree is the one arrange tiled desugars to for 4 panes
    # a 2x2 is genuinely ambiguous: cutting vertically or horizontally first describes the same
    # screen and neither is more true. The tie is broken to match tiled, so a captured grid comes
    # back as the template that built it.

  # ── The capture is a draft ──
  # It recovers geometry, never commands — and the file has to say so itself.

  Scenario Outline: no pane in a captured template carries a command, on either backend
    Given a region on the <backend> adapter whose panes are running commands
    When it is captured
    Then no pane node in the written template carries a command

    Examples:
      | backend |
      | tmux    |
      | herdr   |

    # a command a backend can report is not a command worth capturing: what it reports is the
    # RESOLVED command line, not the one a human typed (`nr web dev` comes back as
    # `node /run/user/1000/fnm_multishells/.../bin/nr web dev`), which is machine-local and so not
    # portable into a template meant to be checked in and run elsewhere

  Scenario: a captured template records in its own description that it is geometry only
    Given a caller running cyber-mux template save pool-3 with no --description
    When the command runs
    Then the written template's description says the capture is geometry only
    And it says a command must be added to each pane
    # template list shows a capture beside finished templates, so a note that only reached the terminal
    # that ran save would be gone by the time anyone read the file
    # (--description, which replaces this note, is a flag, on the CLI surface in cli/template/capture.)

  # ── The capture subtracts the target back out ──
  # Apply's injection, run backwards: apply joins cwd + dir, so capture divides it out.

  Scenario: a pane under the captured root becomes a relative dir
    Given a region whose root pane runs in the target and another pane runs in the target's services/api
    When it is captured
    Then that pane node's dir is services/api
    And no pane node carries a cwd
    And no absolute path appears anywhere in the written template
    # the rule the whole capability exists to enforce, holding in the writing direction too

  Scenario: a pane outside the captured root loses its dir and says so
    Given a region one of whose panes runs outside the captured root
    When it is captured
    Then that pane node carries no dir
    And a warning naming that pane's directory is written to stderr
    And the template is still written
    # dir must stay under the apply-time target, so emitting ../elsewhere would fail the very
    # validator this capture has to satisfy — there is nowhere to put this pane's location

  Scenario: a captured template passes validate
    Given a template captured from a live region
    When cyber-mux template validate runs on it
    Then it exits 0
    # the round trip that matters: a capture that its own validator rejects is not a template

  Scenario: a label two panes share is captured onto both, because a human chose it
    Given a region where two panes are both labeled worker
    When it is captured
    Then both pane nodes carry the label worker
    And no warning about the label is written
    # this is what capture is FOR. A pane's label got there because someone renamed the pane by hand,
    # so dropping it discards the exact fact the capture exists to preserve — and reports "no label"
    # where there is one, against the absent-rather-than-false rule everything else here follows. The
    # live model has no uniqueness rule and neither does the schema: a pool of three panes all named
    # worker is a thing a person may legitimately mean.

  Scenario: a label the author set is captured, and a backend's default pane title is not
    Given a tmux region where one pane's title was set to reviewer and every other pane carries tmux's default title
    When it is captured
    Then the reviewer pane node carries the label reviewer
    And no other pane node carries a label
    # tmux has no unset title — it defaults every pane's to the hostname, so capturing the title
    # verbatim would hang the host's name on every pane of every capture. A title equal to the host
    # is the default; one that differs is a label someone chose. The trade is deliberate: a pane
    # labeled exactly its own hostname loses its label, which costs one hand-edit and is rare.

  # ── Capturing a whole workspace ──
  # A workspace capture derives one captured tab per live tab, each with its own tree — the exact
  # inverse of the tabs walk. The --workspace flag that asks for this, the bare-save reveal of what it
  # left out, and the declares-root-vs-tabs shape are the CLI surface, in cli/template/capture. What
  # stays here is the derivation across tabs and the label handling it does.

  Scenario: a captured tab keeps the label its tab carries
    Given a workspace whose tabs are labeled editor and logs
    When it is captured with --workspace
    Then the captured tabs are labeled editor and logs

  Scenario: a captured tab's label is the tab's own name, never the composed one
    Given a workspace labeled pool on tmux whose tab displays as "pool - editor"
    When it is captured with --workspace
    Then the captured tab is labeled editor
    And re-applying the capture displays "pool - editor" again rather than compounding the prefix
    # the tab's own name is read from where the walk stored it, not split back out of the display name
    # — the separator is ambiguous, so parsing would be unsound, and taking the display name verbatim
    # would re-prefix it on every round trip. Capture is the inverse of apply or it is a lie about the
    # user's screen.

  Scenario: re-applying a captured workspace reproduces the tabs it was captured from
    Given a workspace of 2 tabs, each of 2 panes built by splitting
    When it is captured with --workspace and the captured template is applied to a fresh workspace
    Then the rebuilt workspace has the same tabs
    And every pane matches the size of its counterpart in the original
    # the round-trip property the derivation exists to hold, now at the tab level as well as the pane
    # level — a capture that does not round-trip is a confident lie about the user's screen

  Scenario: a captured workspace is still a draft carrying no command
    Given a workspace of 2 tabs whose panes were launched with commands
    When it is captured with --workspace
    Then no pane in any tab carries a command
    And the template records in its own description that it is geometry only
    # unchanged and for the unchanged reason: a running pane's command line is machine-local rather
    # than portable, and adding a level does not change what is worth writing into a template

  Scenario: on a backend with no workspace tier, an untagged region captures as a single-tab workspace
    Given a caller in a tmux window carrying no grouping tag
    When cyber-mux template save pool --workspace runs
    Then the captured template carries exactly one tab
    # a window nobody grouped is a workspace of one — the honest answer, and the reason the tag is read
    # rather than the label parsed

  Scenario: a workspace whose tabs the backend cannot enumerate is refused, not guessed at
    Given a backend whose adapter cannot enumerate a workspace's tabs
    When a workspace capture is derived
    Then the capture is refused and nothing is produced
    # an absent optional seam member is a refusal, never a guess — the same shape as an absent
    # region-geometry primitive below. The save verb's observable of this refusal (exit 1 naming the
    # backend, no file written) is the CLI surface, in cli/template/capture.

  # ── save writes a file, and refuses rather than guessing ──
  # Where the file goes (--to, the repo default), the structured stdout payload, --force overwrite,
  # the malformed-name and no-pane usage refusals, and the exit code each refusal takes are all the
  # CLI surface, in cli/template/capture. What stays here is the adapter-capability contract behind
  # the geometry refusal: an optional seam member the backend lacks is a refusal, never a guess.

  Scenario: a region whose geometry the backend cannot report is refused, not guessed at
    Given a backend with no region-geometry primitive
    When a region capture is derived
    Then the capture is refused and nothing is produced
    # geometry reporting is an optional capability, exactly as the worktree binding already is —
    # a backend that cannot answer cannot be captured, and there is nothing to degrade to. The save
    # verb's observable of this refusal (exit 1 naming the backend, no file written) is the CLI
    # surface, in cli/template/capture.

  Scenario: a region no sequence of splits could have produced is refused
    Given a region whose panes no straight cut separates without crossing one
    When it is captured
    Then it exits 1
    And no template is written
    # both backends build regions only BY splitting, so this cannot come off a real screen. Reaching
    # it means the geometry is not what we think it is, and a tree that misplaces the user's panes is
    # worse than a refusal.
