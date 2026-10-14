@frozen
Feature: worktree seam — the library git-worktree contract
  The surface-independent worktree helpers cyber-mux keeps: removeWorktreeSafely, the git worktree
  adapter, and the worktreeApi built on them. git owns every worktree fact; a backend contributes only
  the workspace binding, and removal is never delegated to it. Listing, the merged/dirty/landed
  signals, reuse (acquire), and prune are now specified by @cyberuni/agent-harness/worktrees, which
  cyber-mux/worktree re-exports. This suite is the LIBRARY seam only — the `cyber-mux worktree ...`
  CLI surface (verbs, flags, table rendering) lives in ../../cli/worktree/worktree.feature.

  # ── the worktree facts are git's, computed by the library on every backend ──
  # The session layer reads path/branch/linked/prunable/merged/dirty through the library's
  # listWorktrees (git) and joins only the backend's binding by normalized path; a backend that also
  # enumerates worktrees is merely re-reading git, and contributes only the binding.

  @id:worktree-facts-from-git-not-backend
  Scenario: the library reads every worktree fact from git, whatever the backend
    Given a backend that also enumerates worktrees and reports a branch of its own
    When the session layer lists the worktrees
    Then every path, branch, linked, and prunable value it returns is git's answer, not the backend's
    And two backends can never yield a different branch for the same worktree — the backend contributes only the binding

  # ── removal is the library's own gates + git; disposability is read, never acted on ──
  # removeWorktreeSafely runs cyber-mux's gates, then a releaseBinding callback the host supplies,
  # then git — gates BEFORE release, release BEFORE git — and the backend is never asked to remove.

  @id:worktree-remove-ignores-disposability-signal
  Scenario: the library's remove consults no disposability signal, and the listing never acts
    Given a worktree the library's listing would report as merged, clean, and unoccupied
    When removeWorktreeSafely is called on it
    Then it applies exactly its own gates, consulting no disposability signal — removability is reported, never a removal trigger
    And the listing is a pure read: nothing in it deletes or prunes a worktree of its own accord

  @id:worktree-remove-refuses-dirty-before-release
  Scenario: removeWorktreeSafely refuses uncommitted changes BEFORE releasing the binding
    Given a dirty worktree passed to removeWorktreeSafely with a releaseBinding callback and no force
    When removeWorktreeSafely runs
    Then it refuses, naming --force as the way to discard the changes
    And releaseBinding is never called — a refused removal has no side effect

  @id:worktree-remove-releases-before-git
  Scenario: removeWorktreeSafely releases the binding before git removes the checkout
    Given a clean worktree passed to removeWorktreeSafely with a releaseBinding callback
    When removeWorktreeSafely runs and every gate passes
    Then releaseBinding is called first, and only then does git remove the checkout
    And no binding is left pointing at a directory that no longer exists

  @id:worktree-remove-releases-orphan-binding
  Scenario: removeWorktreeSafely releases the binding of a checkout already gone from disk
    Given a path with nothing checked out there, passed to removeWorktreeSafely with a releaseBinding callback
    When removeWorktreeSafely runs
    Then releaseBinding is called, and no git removal command runs
    And the orphan this prevents — a binding pointing at a checkout that is gone — cannot persist

  @id:worktree-remove-not-delegated-to-backend
  Scenario: worktree removal is never delegated to the backend
    Given a backend with a worktree-removal primitive of its own, wired to removeWorktreeSafely as its releaseBinding
    When removeWorktreeSafely removes a worktree on it
    Then removal is cyber-mux's own gates plus git, and the backend's releaseBinding is the only thing it is asked for
    # The backend's own removal addresses a workspace, not a path, so it cannot even reach an unbound
    # worktree — delegating would make a destructive operation's safety depend on whether a workspace
    # happened to be open.
    And the gates behave identically whether or not a releaseBinding is supplied
