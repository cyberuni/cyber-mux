---
'cyber-mux': patch
---

Fix the tmux adapter returning plausible-looking wrong answers when the calling process has no
locale. Every tmux invocation now leads with `-u`.

Without a `LANG`/`LC_ALL`/`LC_CTYPE` containing "UTF-8", tmux does not consider its command client
UTF-8 and sanitizes what it prints: every byte outside printable ASCII becomes a literal `_`. The
adapter separates the fields of its `-F` formats with a TAB, so the split found no separator and a
listing of N panes collapsed into ONE record whose id was the whole line — `%0_zsh_/home/u_host_0`
rather than a pane id. It did not throw and did not return empty, so anything culling or reconciling
on that listing acted on a pane that does not exist.

Reached by a caller that has neither a locale nor `$TMUX`: a systemd unit, a cron job, a container
entrypoint, or a non-interactive ssh session driving tmux through `CYBER_MUX=tmux`. A caller running
inside a pane was never affected — `$TMUX` gives the command client the containing client's UTF-8
state.

- **`-u` on every invocation, not only the ones that parse a tab.** The mangling is a whole byte
  class, measured on tmux 3.7c: every control byte, `0x7f`, and every non-ASCII byte comes back as
  `_`. So `#{pane_title}`, `#{pane_current_path}` and `#{session_name}` lost their non-ASCII content
  in the space-separated formats too, which re-picking the separator would not have fixed.
- **rmux is unaffected and unchanged.** Measured on a live rmux 0.10.0 under `env -i`: it emits a
  real tab. The earlier note that it shared the defect was an inference from the shared `#{…}`
  vocabulary, not a measurement.
- **The regression test drives the real tmux with the environment stripped** — `PATH` and `HOME` and
  nothing else, on its own socket — because the integration suite inherits a locale, which is why
  this survived every release.

No API change.
