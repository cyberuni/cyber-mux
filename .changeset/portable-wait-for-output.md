---
"cyber-mux": minor
---

Add a portable `waitForOutput` to the seam, and a `wait` verb to the CLI: block until a pane's output
matches a literal (`--match`) or a regex (`--regex`), or until a timeout elapses. Real support on
every backend rather than a one-backend capability — herdr drives its native `pane wait-output`
(0.7.5), while tmux, WezTerm and Zellij poll their existing read through one shared loop, so every
backend searches exactly the snapshot its `read` returns and existing output counts as a match. The
CLI puts the verdict in the exit code (0 matched, 1 timed out) and prints the pane's own output on a
timeout, so a caller that guessed the wrong pattern keeps the evidence; a pane that is GONE fails with
`pane-not-found` instead of quietly waiting out the deadline, and so does a wait that never ran (a
herdr older than 0.7.5, which has no `pane wait-output`, fails loudly rather than reporting an instant
false timeout). Resolves #97.
