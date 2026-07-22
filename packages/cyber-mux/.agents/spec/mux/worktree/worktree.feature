@frozen
Feature: worktree seam — the library git-worktree contract
  The surface-independent worktree helpers a host links against: provisionWorktree / WorktreeApi,
  listWorktreesFromGit, isWorktreeRemovable, and removeWorktreeSafely. git owns every worktree fact;
  a backend contributes only the workspace binding, and removal is never delegated to it. This suite
  is the LIBRARY seam only — the `cyber-mux worktree ...` CLI surface (verbs, flags, table rendering)
  lives in ../../cli/worktree/worktree.feature.

  # ── provision — reuse a free worktree instead of always creating one, the twin of prune ──
  # prune REMOVES every disposable worktree; provision RECYCLES one, through the SAME default gate
  # (isWorktreeRemovable), so the two can never disagree about which worktrees are free. Availability
  # is an INJECTED predicate: the clean/landed/on-disk/unoccupied part is generic git and is the
  # default here, but "no live agent session is attached" is a host concept this seam never knows —
  # so it enters as a (entry) => boolean parameter, and injecting one is a LIBRARY-ONLY power.
  # SURFACE: provision is the library seam provisionWorktree / WorktreeApi.provision (src/worktree.ts).
  # The CLI surface — the `cyber-mux worktree provision` verb — lives in ../../cli/worktree and wires
  # this seam with the DEFAULT gate only; it cannot inject a predicate. Each Given below names the
  # seam; "When provision runs" stays surface-neutral (the operation, however it is reached).

  Scenario: provision reuses a free worktree, resetting it to a pristine tree on a fresh branch
    Given a caller invoking the provisionWorktree seam with a pool holding a merged, clean, unoccupied worktree
    When provision runs
    Then it reuses that worktree rather than creating a new checkout
    And it resets it to a fresh branch at base, then reset --hard, then clean -fdx — a pristine tree
    And it reports the action as reused, with the recycled worktree's prior branch and workspace

  Scenario: provision branches a reused worktree from an explicit base
    Given a caller invoking provisionWorktree with an explicit base <base> and a free worktree to reuse
    When provision runs
    Then the reused worktree's fresh branch starts at <base> rather than the resolved default branch

  Scenario: provision creates a fresh worktree when none is available
    Given a caller invoking the provisionWorktree seam with a pool holding no available worktree
    When provision runs
    Then it creates a fresh checkout with plain git and recycles nothing
    And it reports the action as created, with no recycled worktree

  Scenario: provision never reuses an unmerged worktree under the default gate
    Given a caller invoking the provisionWorktree seam with a pool whose only free-looking worktrees are unmerged
    When provision runs with the default availability gate
    Then it treats none of them as reusable and creates a fresh checkout instead

  Scenario: provision never hands back a worktree the availability predicate excludes
    Given a host availability predicate — a LIBRARY-ONLY injected gate — that excludes the first candidate because a live session is bound to it
    When provision runs
    Then it skips that worktree and reuses the next free one, never the excluded one

  Scenario: provision never reuses the primary checkout
    Given an availability predicate that would clear every worktree, including the primary checkout
    When provision runs
    Then the primary checkout is filtered out before the gate and is never handed back

  # ── the worktree facts are git's, computed by the library on every backend ──
  # listWorktreesFromGit reads path/branch/linked/prunable/merged/dirty from git; a backend that also
  # enumerates worktrees is merely re-reading git, and contributes only the binding.

  Scenario: the library reads every worktree fact from git, whatever the backend
    Given a backend that also enumerates worktrees and reports a branch of its own
    When listWorktreesFromGit / WorktreeApi.list reads the worktrees
    Then every path, branch, linked, and prunable value it returns is git's answer, not the backend's
    And two backends can never yield a different branch for the same worktree — the backend contributes only the binding

  Scenario: the default branch merged is measured against is resolved, never assumed
    Given a repo whose default branch is not named main
    When listWorktreesFromGit computes each worktree's merged signal
    Then merged is measured against the branch the repo actually treats as its default
    # The remote-tracking ref first, because "merged" means landed upstream in the workflow this
    # serves; the primary checkout's own branch when there is no remote to ask, which is the trunk
    # for a local-only repo and costs no extra read.
    And a repo with no resolvable default branch yields no merged verdict rather than a guessed one

  Scenario: a disposability signal git cannot determine is absent, never false
    Given worktrees including one on a detached HEAD and one whose checkout is gone from disk
    When listWorktreesFromGit reads each worktree and isWorktreeRemovable is asked of it
    Then every worktree is still returned, the missing signal costing a field rather than the entry
    And the undeterminable signal is absent from the entry rather than reported as a negative
    And isWorktreeRemovable never clears such a worktree, because undeterminable must never count as safe to delete

  # ── removal is the library's own gates + git; disposability is read, never acted on ──
  # removeWorktreeSafely runs cyber-mux's gates, then a releaseBinding callback the host supplies,
  # then git — gates BEFORE release, release BEFORE git — and the backend is never asked to remove.

  Scenario: the library's remove consults no disposability signal, and the listing never acts
    Given a worktree isWorktreeRemovable would clear
    When removeWorktreeSafely is called on it
    Then it applies exactly the gates it always did, consulting no disposability signal — removability is reported, never a removal trigger
    And listWorktreesFromGit is a pure read: nothing in the listing deletes or prunes a worktree of its own accord

  Scenario: removeWorktreeSafely refuses uncommitted changes BEFORE releasing the binding
    Given a dirty worktree passed to removeWorktreeSafely with a releaseBinding callback and no force
    When removeWorktreeSafely runs
    Then it refuses, naming --force as the way to discard the changes
    And releaseBinding is never called — a refused removal has no side effect

  Scenario: removeWorktreeSafely releases the binding before git removes the checkout
    Given a clean worktree passed to removeWorktreeSafely with a releaseBinding callback
    When removeWorktreeSafely runs and every gate passes
    Then releaseBinding is called first, and only then does git remove the checkout
    And no binding is left pointing at a directory that no longer exists

  Scenario: removeWorktreeSafely releases the binding of a checkout already gone from disk
    Given a path with nothing checked out there, passed to removeWorktreeSafely with a releaseBinding callback
    When removeWorktreeSafely runs
    Then releaseBinding is called, and no git removal command runs
    And the orphan this prevents — a binding pointing at a checkout that is gone — cannot persist

  Scenario: worktree removal is never delegated to the backend
    Given a backend with a worktree-removal primitive of its own, wired to removeWorktreeSafely as its releaseBinding
    When removeWorktreeSafely removes a worktree on it
    Then removal is cyber-mux's own gates plus git, and the backend's releaseBinding is the only thing it is asked for
    # The backend's own removal addresses a workspace, not a path, so it cannot even reach an unbound
    # worktree — delegating would make a destructive operation's safety depend on whether a workspace
    # happened to be open.
    And the gates behave identically whether or not a releaseBinding is supplied
