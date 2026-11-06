#!/bin/sh
# Run cyber-mux from a tmux key binding: cyber-mux.sh <pane-id> <cyber-mux args...>
# Installed by the cyber-mux setup-tmux skill to ~/.config/tmux/cyber-mux.sh.
#
# A binding runs in the tmux server, not in the pane, so it needs no turn from the program in the
# pane. It also gets no $TMUX_PANE, no interactive shell, and only the PATH the server started
# with. So the binding passes the pane in, and this script looks for cyber-mux in order:
#   1. $CYBER_MUX_BIN, a command split on spaces (set it in tmux.conf with
#      set-environment -g CYBER_MUX_BIN '/path/to/cyber-mux')
#   2. cyber-mux on the server's PATH, then in the usual per-user bin directories
#      (pnpm, mise shims, ~/.local/bin, volta, bun, npm, and the newest nvm, mise, or fnm node)
#   3. npx --yes cyber-mux@<version>, with node found the same way
# Success is silent. A failure shows its first line as a tmux message, never as text in the pane.

pane=$1
shift

notify() {
	# `#` starts a tmux format; double it so the message prints as written.
	tmux display-message -t "$pane" "cyber-mux: $(printf '%s' "$1" | sed 's/#/##/g')"
}

newest() {
	for entry in "$@"; do
		[ -e "$entry" ] && printf '%s\n' "$entry"
	done | sort -V | tail -n 1
}

data=${XDG_DATA_HOME:-$HOME/.local/share}
mise=${MISE_DATA_DIR:-$data/mise}
extra=
for dir in \
	"${PNPM_HOME:-}" "$data/pnpm" "$data/pnpm/bin" "$mise/shims" "$HOME/.local/bin" "$HOME/bin" \
	"$HOME/.volta/bin" "$HOME/.bun/bin" "$HOME/.npm-global/bin" \
	"$(newest "$HOME"/.nvm/versions/node/v[0-9]*/bin)" \
	"$(newest "$mise"/installs/node/[0-9]*/bin)" \
	"$(newest "$data"/fnm/node-versions/v[0-9]*/installation/bin)"; do
	[ -n "$dir" ] && [ -d "$dir" ] && extra="$extra:$dir"
done
PATH="$PATH$extra"
export PATH

if [ -n "${CYBER_MUX_BIN:-}" ]; then
	# shellcheck disable=SC2086 # split on purpose: the value may be "node /path/to/cli.mjs"
	set -- $CYBER_MUX_BIN "$@"
elif command -v cyber-mux >/dev/null 2>&1; then
	set -- cyber-mux "$@"
elif command -v npx >/dev/null 2>&1; then
	set -- npx --yes cyber-mux@0.11.0 "$@"
else
	notify "not found; install it, or set CYBER_MUX_BIN with: tmux set-environment -g CYBER_MUX_BIN /path/to/cyber-mux"
	exit 0
fi

if ! out=$(CYBER_MUX=tmux CYBER_MUX_PANE=$pane "$@" 2>&1); then
	notify "$(printf '%s\n' "$out" | head -n 1)"
fi
exit 0
