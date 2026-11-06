---
name: setup-tmux
description: "Configure tmux to look and behave like herdr: herdr's default keys, its Catppuccin theme, a top tab row with a mode bar, a left sidebar of workspaces and agent states, and a prefix+B key that jumps back to the pane you came from (cyber-mux focus --back). Use when asked to set up tmux, make tmux work like herdr, style tmux like herdr, or bind a tmux key to go back after a jump."
compatibility: Requires tmux 3.4+ and bash 4+.
---

# setup-tmux

Install a tmux config that matches herdr's defaults, the sidebar script it calls, and a back key
that runs `cyber-mux focus --back` for the pane it is pressed in.

## When to use

- The user asks to set up or configure tmux, or to make tmux look or behave like herdr.
- The user wants one key that returns to the pane they jumped from, with or without the rest of
  the config.
- The user invokes `/setup-tmux` (`/cyber-mux:setup-tmux` (pnpm install: `pnpm-cyber-mux-setup-tmux`)).

Out of scope: driving panes (use the `mux` skill), and configuring herdr itself.

## What gets installed

| Asset | Installed to | Role |
| --- | --- | --- |
| `assets/tmux.conf` | `~/.tmux.conf` | Keys, theme, tab row, mode bar, hooks |
| `assets/herdr.sh` | `~/.config/tmux/herdr.sh` | Draws the sidebar; keeps it sized and cleaned up |
| `assets/cyber-mux.conf` | `~/.config/tmux/cyber-mux.conf` | The back key: `prefix+B` runs `cyber-mux focus --back` |
| `assets/cyber-mux.sh` | `~/.config/tmux/cyber-mux.sh` | Finds and runs cyber-mux for a key binding |

The config maps a herdr workspace to a tmux session, a tab to a window, and a pane to a pane. The
prefix is `ctrl+b`, as in herdr. The key table is in [README.md](README.md). `tmux.conf` loads
`cyber-mux.conf`; a user who keeps their own config can load it alone (step 3).

### How the back key runs

`prefix+B` runs `run-shell -b '~/.config/tmux/cyber-mux.sh "#{pane_id}" focus --back'`. The
command runs in the tmux server, in the background, and never types into the pane, so it works in
a plain shell pane and in a pane whose agent is mid-turn, and it costs no model turn. A binding
gets no `$TMUX_PANE`, so tmux expands `#{pane_id}` and the wrapper runs cyber-mux with
`CYBER_MUX=tmux CYBER_MUX_PANE=<pane>`.

A binding also gets no interactive shell: no `.zshrc`, no `mise activate`, and only the PATH the
server started with. A path found in this session can also go stale: a mise or nvm node moves on
every upgrade. So the binding names no path, and the wrapper looks when the key is pressed.
It looks in this order:

1. `$CYBER_MUX_BIN`, a command split on spaces, set in tmux with
   `set-environment -g CYBER_MUX_BIN '/path/to/cyber-mux'`.
2. `cyber-mux` on the server's PATH, then in the per-user bin directories: pnpm, mise shims,
   `~/.local/bin`, `~/bin`, volta, bun, `~/.npm-global/bin`, and the newest nvm, mise, or fnm node.
3. `npx --yes cyber-mux@0.11.0`, the version this skill ships with, with `npx` found the same
   way.

On success it prints nothing. On failure it shows the first line of the error as a tmux message.

## Workflow

1. **Check the prerequisites.** Run `tmux -V` and `bash --version`. Stop and report if tmux is
   older than 3.4 or bash older than 4. On macOS, the system bash is 3.2; the user needs a newer
   bash on `PATH`.
2. **Look at the existing config.** Read `~/.tmux.conf` and `~/.config/tmux/tmux.conf` if they
   exist. If either has content, summarize what it sets, say whether it binds `prefix+B` (the back
   key replaces that binding), and ask the user whether to replace it. Do not continue without a
   yes. If they want to keep their config, offer the back key alone (step 3) instead.
3. **Back key only.** Skip this step when the user agreed to replace their config. Otherwise:
   1. Find what their config binds to `prefix+B`. Load it on a throwaway server, so includes and
      plugins count, and ask the running server too if there is one:

      ```bash
      conf=~/.tmux.conf; [ -f "$conf" ] || conf=~/.config/tmux/tmux.conf
      tmux -L setup-tmux-check -f "$conf" new-session -d && sleep 1
      tmux -L setup-tmux-check list-keys -T prefix | grep -E '^bind-key +(-r +)?-T prefix +B '
      tmux -L setup-tmux-check kill-server
      tmux list-keys -T prefix 2>/dev/null | grep -E '^bind-key +(-r +)?-T prefix +B '
      ```

      (`list-keys -T prefix B` prints nothing even for a bound key, so filter the whole table.)
   2. If either prints a line, show it and ask: replace it, move the back key to another key, or
      skip the back key. Do not bind over it without a yes. To move it, pick a key the same
      listing does not show, and change `bind B` in the installed `cyber-mux.conf`.
   3. Install it and load it from their config, with a backup:

      ```bash
      stamp=$(date +%Y%m%d-%H%M%S)
      [ -f "$conf" ] && cp "$conf" "$conf.bak-$stamp"
      mkdir -p ~/.config/tmux
      cp "$SKILL_DIR/assets/cyber-mux.conf" "$SKILL_DIR/assets/cyber-mux.sh" ~/.config/tmux/
      chmod +x ~/.config/tmux/cyber-mux.sh
      grep -qF 'source-file -q ~/.config/tmux/cyber-mux.conf' "$conf" 2>/dev/null ||
        printf '\n# cyber-mux keys (setup-tmux skill)\nsource-file -q ~/.config/tmux/cyber-mux.conf\n' >> "$conf"
      ```

   Then skip to step 6 to validate, with `"$conf"` in place of `~/.tmux.conf` and no sidebar
   expectation.
4. **Ask about the sidebar.** It is on by default. It adds one pane to every window, so scripts
   that address panes by index see an extra pane, and `cyber-mux list` shows it. Pane IDs are
   unaffected. If the user wants it off, change `set -g @herdr_sidebar_enabled 1` to `0` in the
   installed config; `prefix+b` still turns it on later.
5. **Back up and install.** Resolve this skill's directory, then:

   ```bash
   stamp=$(date +%Y%m%d-%H%M%S)
   [ -f ~/.tmux.conf ] && cp ~/.tmux.conf ~/.tmux.conf.bak-"$stamp"
   for f in herdr.sh cyber-mux.conf cyber-mux.sh; do
     [ -f ~/.config/tmux/"$f" ] && cp ~/.config/tmux/"$f" ~/.config/tmux/"$f".bak-"$stamp"
   done
   mkdir -p ~/.config/tmux
   cp "$SKILL_DIR/assets/tmux.conf" ~/.tmux.conf
   cp "$SKILL_DIR/assets/herdr.sh" "$SKILL_DIR/assets/cyber-mux.conf" "$SKILL_DIR/assets/cyber-mux.sh" ~/.config/tmux/
   chmod +x ~/.config/tmux/herdr.sh ~/.config/tmux/cyber-mux.sh
   ```

   The `chmod +x` is required: the scripts ship without the executable bit, because the release
   commits through the GitHub API, which cannot carry it.

   If `~/.config/tmux/tmux.conf` exists, tmux reads `~/.tmux.conf` first and ignores the other;
   tell the user that file is now unused.
6. **Validate on a throwaway server.** This never touches the user's sessions. The server starts
   with only tmux's directory and the system directories on PATH, the least a real server may
   have, so the check proves the back key finds cyber-mux without this session's PATH:

   ```bash
   check() { env PATH="$(dirname "$(command -v tmux)"):/usr/bin:/bin" tmux -L setup-tmux-check "$@"; }
   check -f ~/.tmux.conf new-session -d -x 120 -y 30 && sleep 2
   check list-panes -a -F '#{pane_id} sidebar=#{@herdr_sidebar} w=#{pane_width}'
   check list-keys -T prefix | grep -E '^bind-key +(-r +)?-T prefix +B '
   check run-shell '~/.config/tmux/cyber-mux.sh "#{pane_id}" --version'
   check show-messages | grep -iE 'error|unknown|invalid|cyber-mux:'
   check kill-server
   ```

   With the sidebar on, expect exactly one pane with `sidebar=1 w=26`. Expect one `prefix B` line
   that runs `cyber-mux.sh`. Any message line is a failure; report it verbatim. A
   `cyber-mux: not found` line means no lookup step found cyber-mux: give the user the
   `set-environment -g CYBER_MUX_BIN` line from that message, with the path from `command -v
   cyber-mux` in a shell where it works, to add to their config. The npx step downloads cyber-mux
   on its first run, so this check can take a few seconds.
7. **Apply.** If a tmux server is running (`tmux ls` succeeds), ask before reloading it with
   `tmux source-file ~/.tmux.conf`. For the back key alone, reload only that file:
   `tmux source-file ~/.config/tmux/cyber-mux.conf`. Otherwise the config applies the next time
   tmux starts.
8. **Report.** Name the backup files, say whether the running server was reloaded, and list the
   five keys herdr says to learn first: `c` new tab, `v`/`-` split, `h/j/k/l` move,
   `w` workspaces, `q` detach. Name the back key (`B`, or the key the user chose) and which lookup
   step found cyber-mux. For the back key alone, report only the backup, the key, and the lookup.

## Anti-patterns

- Overwriting an existing config without a backup or without the user's yes.
- Reloading the user's running tmux server without asking.
- Validating on the default socket instead of `-L setup-tmux-check`.
- Editing the keys in the installed copy to "fix" a conflict without telling the user.
- Binding the back key over an existing `prefix+B` without the user's yes.
- Writing a path found in this session (the plugin cache, a mise or nvm node) into the binding:
  it breaks on the next update. The wrapper looks when the key is pressed.
- Typing `cyber-mux focus --back` into the pane with `send-keys`: it would land in a busy agent's
  input. The binding runs it with `run-shell`.

## Validate

- A backup exists for every file that was replaced.
- The throwaway server started, showed one sidebar pane per window (when enabled), bound
  `prefix+B` to `cyber-mux.sh`, ran it with no `cyber-mux:` message, logged no errors, and was
  killed.
- An existing `prefix+B` binding was replaced only after the user agreed.
- The user's running server was reloaded only after they agreed.

## References

- herdr keyboard docs: <https://herdr.dev/docs/keyboard/>
- herdr configuration docs: <https://herdr.dev/docs/configuration/>
