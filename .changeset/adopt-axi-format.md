---
"cyber-mux": minor
---

Encode `--format json` and `--format agent` with `@clibuilder/axi`, the output package the clibuilder CLIs share. `--format agent` now writes [TOON](https://github.com/toon-format/toon) instead of the human table, on success and on structured errors; `--format json` is now compact JSON (same payload, no indentation). `text` stays the default.
