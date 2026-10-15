---
name: setup-tmux
description: "Configure tmux to look and behave like herdr: herdr's default keys, its Catppuccin theme, a top tab row with a mode bar, and a left sidebar of workspaces and agent states. Use when asked to set up tmux, make tmux work like herdr, or style tmux like herdr."
compatibility: Requires tmux 3.4+ and bash 4+.
---

# setup-tmux

Install a tmux config that matches herdr's defaults, plus the sidebar script it calls.

## When to use

- The user asks to set up or configure tmux, or to make tmux look or behave like herdr.
- The user invokes `/setup-tmux` (`/cyber-mux:setup-tmux` (pnpm install: `pnpm-cyber-mux-setup-tmux`)).

Out of scope: driving panes (use the `mux` skill), and configuring herdr itself.

## What gets installed

| Asset | Installed to | Role |
| --- | --- | --- |
| `assets/tmux.conf` | `~/.tmux.conf` | Keys, theme, tab row, mode bar, hooks |
| `assets/herdr.sh` | `~/.config/tmux/herdr.sh` | Draws the sidebar; keeps it sized and cleaned up |

The config maps a herdr workspace to a tmux session, a tab to a window, and a pane to a pane. The
prefix is `ctrl+b`, as in herdr. The key table is in [README.md](README.md).

## Workflow

1. **Check the prerequisites.** Run `tmux -V` and `bash --version`. Stop and report if tmux is
   older than 3.4 or bash older than 4. On macOS, the system bash is 3.2; the user needs a newer
   bash on `PATH`.
2. **Look at the existing config.** Read `~/.tmux.conf` and `~/.config/tmux/tmux.conf` if they
   exist. If either has content, summarize what it sets and ask the user whether to replace it.
   Do not continue without a yes.
3. **Ask about the sidebar.** It is on by default. It adds one pane to every window, so scripts
   that address panes by index see an extra pane, and `cyber-mux list` shows it. Pane IDs are
   unaffected. If the user wants it off, change `set -g @herdr_sidebar_enabled 1` to `0` in the
   installed config; `prefix+b` still turns it on later.
4. **Back up and install.** Resolve this skill's directory, then:

   ```bash
   stamp=$(date +%Y%m%d-%H%M%S)
   [ -f ~/.tmux.conf ] && cp ~/.tmux.conf ~/.tmux.conf.bak-"$stamp"
   [ -f ~/.config/tmux/herdr.sh ] && cp ~/.config/tmux/herdr.sh ~/.config/tmux/herdr.sh.bak-"$stamp"
   mkdir -p ~/.config/tmux
   cp "$SKILL_DIR/assets/tmux.conf" ~/.tmux.conf
   cp "$SKILL_DIR/assets/herdr.sh" ~/.config/tmux/herdr.sh
   chmod +x ~/.config/tmux/herdr.sh
   ```

   If `~/.config/tmux/tmux.conf` exists, tmux reads `~/.tmux.conf` first and ignores the other;
   tell the user that file is now unused.
5. **Validate on a throwaway server.** This never touches the user's sessions:

   ```bash
   tmux -L setup-tmux-check -f ~/.tmux.conf new-session -d -x 120 -y 30 && sleep 2
   tmux -L setup-tmux-check list-panes -a -F '#{pane_id} sidebar=#{@herdr_sidebar} w=#{pane_width}'
   tmux -L setup-tmux-check show-messages | grep -iE 'error|unknown|invalid'
   tmux -L setup-tmux-check kill-server
   ```

   With the sidebar on, expect exactly one pane with `sidebar=1 w=26`. Any error line is a
   failure; report it verbatim.
6. **Apply.** If a tmux server is running (`tmux ls` succeeds), ask before reloading it with
   `tmux source-file ~/.tmux.conf`. Otherwise the config applies the next time tmux starts.
7. **Report.** Name the backup files, say whether the running server was reloaded, and list the
   five keys herdr says to learn first: `c` new tab, `v`/`-` split, `h/j/k/l` move,
   `w` workspaces, `q` detach.

## Anti-patterns

- Overwriting an existing config without a backup or without the user's yes.
- Reloading the user's running tmux server without asking.
- Validating on the default socket instead of `-L setup-tmux-check`.
- Editing the keys in the installed copy to "fix" a conflict without telling the user.

## Validate

- A backup exists for every file that was replaced.
- The throwaway server started, showed one sidebar pane per window (when enabled), logged no
  errors, and was killed.
- The user's running server was reloaded only after they agreed.

## References

- herdr keyboard docs: <https://herdr.dev/docs/keyboard/>
- herdr configuration docs: <https://herdr.dev/docs/configuration/>
