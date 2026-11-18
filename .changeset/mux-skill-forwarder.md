---
"cyber-mux": patch
---

The `mux` skill now runs the CLI through a forwarding script in its own folder,
`node <skill>/scripts/cyber-mux.mjs`, instead of probing `PATH`, the repository's package manager,
and `npx` in turn. The forwarder runs the enclosing cyber-mux checkout or package when there is one,
and `npx -y cyber-mux@<plugin version>` otherwise, so it works on every install route.
