---
"cyber-mux": patch
---

The `setup-tmux` skill's `cyber-mux.sh` and `herdr.sh` now ship without the executable bit, so the release can commit them through the GitHub API. The skill still runs `chmod +x` on both when it installs them to `~/.config/tmux/`, so the sidebar and the `prefix+B` back key work as before.
