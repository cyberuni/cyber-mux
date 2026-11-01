---
"cyber-mux": patch
---

The `cyber-mux` binary now bundles its dependencies, so it runs from an installed agent plugin directory that has no `node_modules`. `clibuilder` moves from `dependencies` to an optional peer dependency. Only `cyber-mux/plugin` needs it, and it uses the host CLI's copy.
