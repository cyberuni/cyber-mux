# setup-tmux

Configure tmux to look and behave like [herdr](https://herdr.dev): the same keys, the same theme,
and a sidebar of workspaces and agents.

## When to use

Run `/cyber-mux:setup-tmux`, or ask the agent to set up tmux like herdr. It asks before replacing
an existing config and backs up whatever it replaces.

## What you get

- **Keys:** herdr's defaults, with `ctrl+b` as the prefix.
- **Theme:** Catppuccin Mocha with herdr's sky accent; rounded popups and menus.
- **Tab row:** at the top. ✓ marks a tab whose program rang the bell; `Z` marks a zoomed tab. The
  right end becomes a mode bar with hints in prefix, copy, and resize mode.
- **Sidebar:** a 26-column pane on the left of every window. It lists each workspace with its git
  branch and ahead/behind counts, then each agent with its state: ◐ working, ✓ done and not yet
  seen, ○ idle. Click a row to jump to it. `prefix+b` turns it on or off everywhere.
- **Pane labels:** shown only on split windows; set one with `prefix+P`.

| Action | Key (after `ctrl+b`) |
| --- | --- |
| New tab / rename / close | `c` / `T` / `X` |
| Next / previous / jump to tab | `n` / `p` / `1`–`9` |
| Split right / down | `v` / `-` |
| Move between panes | `h` `j` `k` `l`, `Tab` / `Shift+Tab` |
| Swap panes / zoom / close pane | `H` `J` `K` `L` / `z` / `x` |
| Resize mode / copy mode | `r` / `[` |
| Edit scrollback in `$EDITOR` | `e` |
| New / rename / close workspace | `N` / `W` / `D` |
| Workspace navigation / goto picker | `w` / `g` |
| Detach / jump to the tab that rang | `q` / `o` |
| Toggle sidebar / help / settings / reload | `b` / `?` / `s` / `R` |

herdr's prefix-free chords also work: `ctrl+alt` with `h` `j` `k` `l`, `[`, `]`, `c`, `d`, `D`,
and `z`.

## Limits

- **Agent state is inferred.** A braille spinner in a pane title means working; a bell means done.
  tmux cannot see herdr's "blocked" state.
- **Agents are recognized by name:** claude, codex, gemini, opencode, amp, and a few others.
- **No pane gaps or outer frame.** tmux draws shared borders only.
- **Layout cycling is unbound** (`prefix+Space`, `prefix+Alt+1`–`5`) because it would squash the
  sidebar.

## Install

Ships in the `cyber-mux` plugin. Add this repository as a marketplace, then install `cyber-mux`:

```text
/plugin marketplace add cyberuni/cyber-mux
/plugin install cyber-mux@cyberuni-cyber-mux-local
```
