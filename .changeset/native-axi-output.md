---
"cyber-mux": minor
---

Move the CLI to clibuilder's native `output: 'axi'`. Commands now return their answers and clibuilder prints them and reports every error, in place of cyber-mux's own printing code. The `--format text|json|agent` flags, the `text` default, and the hidden `--json` alias are unchanged. The `text` tables and fields look as they did. What changes on stdout:

- **Errors are one flat object.** `--format json` prints `{"error":"<message>","code":"<code>",...,"help":["..."]}` in place of `{"error":{"code","message","help",...}}`. `text` prints `error: <message>`, then `code: <code>`, then a `help:` list, in place of `error: <code>: <message>` and `help: <line>`.
- **Pane candidates are three lists.** `ambiguous-pane` and `missing-pane` carry `candidates` (the ids), `labels` and `cwds`, matched by position, in place of a `candidates` list of `{ id, label, cwd }`. `ambiguous-pane` also carries the `locator`.
- **Template validation errors are a list.** `invalid-template` carries `errors` (and `path`), one entry per problem, and its message counts them, in place of a message that joined them with newlines.
- **Usage errors use clibuilder's codes.** An unknown flag is `unknown-option` (was `unknown-flag`). Conflicting flags are `conflicting-options` and too many arguments are `extra-arguments` (both were `usage-error`). A bare group such as `cyber-mux send` is a `missing-command` error that lists its commands, in place of printing its help. The `help` lines are a usage line and the command's options. cyber-mux's own checks no longer use `usage-error`: a bad `--regex` or `--timeout` is `invalid-value`, `wait` without a pattern is `missing-argument`, and `focus --back` with a pane is `conflicting-options`.
- **Next steps are strings.** A `help` entry reads `<what to do> — run \`<command>\``. In `json` it was a `{ message, command }` object, and in `text` it was `help[N]: <message>` with `-> <command>` under it.
- **The home view lists the commands through clibuilder.** A bare `cyber-mux` no longer has a `verbs` field. Its last `help` line lists the root's commands instead.
- **The `mux` plugin follows its host.** `cyber-mux/plugin` no longer installs its own usage-error handler, so its answers, errors and usage errors come out in the host's output mode and default format. A default clibuilder 12 host prints TOON unless the caller passes `--format text` or `--format json`.
