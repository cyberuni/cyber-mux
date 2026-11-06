---
"cyber-mux": minor
---

The `setup-tmux` skill now binds `prefix+B` to `cyber-mux focus --back`, so one keystroke returns to the pane you jumped from, with no model turn, even while the agent in the pane is mid-turn. The key runs in the tmux server through a new `~/.config/tmux/cyber-mux.sh` wrapper that finds cyber-mux without your interactive shell: `$CYBER_MUX_BIN`, then the server's PATH and the usual per-user bin directories (pnpm, mise shims, `~/.local/bin`, volta, bun, npm, and the newest nvm, mise, or fnm node), then `npx`. Users who keep their own tmux config can install the back key alone, and the skill asks before taking over an existing `prefix+B` binding.
