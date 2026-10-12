---
'cyber-mux': minor
---

Moves to clibuilder 12 and drops `@clibuilder/axi`; the commands, positionals, flags and documented output are unchanged. User-visible changes:

- `--format` is now clibuilder's one global option, so a command's own `--help` no longer lists it; the root `cyber-mux --help` does. `text` stays the default, and `agent` (TOON) and the hidden `--json` alias still work: they are rewritten to `toon` and `--format json` before parsing.
- A bad `--format` value now reports `expected one of 'toon', 'json', 'text'`, and an unknown-flag error still lists `--format` among the valid flags. Both stay coded errors on stdout with exit 2.
- `--format=json` and `--format=agent` (the `=` spelling) now select the machine format, where the value was parsed but ignored before.
- Option values are checked by `args-minus` instead of zod: a boolean flag takes no separate value (`--full false` leaves `false` as a positional; write `--full=false`), and an array flag takes one value per occurrence.
