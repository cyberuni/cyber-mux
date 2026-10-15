#!/usr/bin/env bash
# herdr-style sidebar and helpers for tmux. Called from ~/.tmux.conf.
# Requires bash 4+ and tmux 3.4+.
#   render          draw the sidebar (runs inside the sidebar pane)
#   ensure WINDOW   add a sidebar to WINDOW when the sidebar is enabled
#   ensure-all      add a sidebar to every window
#   toggle          turn the sidebar on or off everywhere (prefix+b)
#   gc              close windows where only the sidebar is left
#   borders [WIN]   show pane labels only when a window is split
#   fixwidth        keep sidebars at their fixed width
set -u
W=26
SELF="$(readlink -f "$0")"
AGENTS='^(claude|codex|gemini|opencode|amp|cursor-agent|copilot|droid|kimi|kiro|qwen|grok|aider|pi|cline|hermes|kilo|letta)$'

# Hooks fire concurrently; serialize sidebar creation so a window never gets two.
lock() {
  local f="${TMPDIR:-/tmp}/tmux-herdr-$(id -u).lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$f" && flock 9
  else
    until mkdir "$f.d" 2>/dev/null; do sleep 0.05; done
    trap 'rmdir "$f.d"' EXIT
  fi
}

enabled() { [ "$(tmux show -gqv @herdr_sidebar_enabled)" != 0 ]; }

sidebar_of() { tmux list-panes -t "$1" -F '#{pane_id} #{@herdr_sidebar}' 2>/dev/null | awk '$2==1{print $1; exit}'; }

ensure() {
  local win=$1 id
  enabled || return 0
  [ -n "$(sidebar_of "$win")" ] && return 0
  [ "$(tmux display -p -t "$win" '#{window_zoomed_flag}')" = 1 ] && return 0
  id=$(tmux split-window -hbf -d -l "$W" -t "$win" -P -F '#{pane_id}' "exec '$SELF' render") || return 0
  tmux set -p -t "$id" @herdr_sidebar 1
  borders "$win"
}

ensure_all() { for w in $(tmux list-windows -a -F '#{window_id}' 2>/dev/null); do ensure "$w"; done; }

toggle() {
  if enabled; then
    tmux set -g @herdr_sidebar_enabled 0
    for p in $(tmux list-panes -a -F '#{pane_id} #{@herdr_sidebar}' | awk '$2==1{print $1}'); do
      tmux kill-pane -t "$p"
    done
    borders
  else
    tmux set -g @herdr_sidebar_enabled 1
    ensure_all
  fi
}

gc() {
  tmux list-panes -a -F '#{window_id} #{@herdr_sidebar}' |
    awk '{t[$1]++; if ($2==1) s[$1]++} END {for (w in t) if (t[w]==s[w]) print w}' |
    while read -r w; do tmux kill-window -t "$w"; done
  borders
}

borders() {
  local wins=${1:-$(tmux list-windows -a -F '#{window_id}')} w real want
  for w in $wins; do
    real=$(tmux list-panes -t "$w" -F '#{@herdr_sidebar}' 2>/dev/null | grep -vc '^1$')
    if [ "$real" -gt 1 ]; then want=top; else want=off; fi
    [ "$(tmux show -wqv -t "$w" pane-border-status)" = "$want" ] || tmux set -w -t "$w" pane-border-status "$want"
  done
}

fixwidth() {
  tmux list-panes -a -F '#{pane_id} #{@herdr_sidebar} #{pane_width} #{window_zoomed_flag}' |
    awk -v w="$W" '$2==1 && $3!=w && $4!=1 {print $1}' |
    while read -r p; do tmux resize-pane -t "$p" -x "$W"; done
}

# ── Sidebar rendering ─────────────────────────────────────────────────────────
fg() { printf '\e[38;2;%d;%d;%dm' "0x${1:0:2}" "0x${1:2:2}" "0x${1:4:2}"; }
bg() { printf '\e[48;2;%d;%d;%dm' "0x${1:0:2}" "0x${1:2:2}" "0x${1:4:2}"; }
# Catppuccin Mocha, herdr's default theme
TEXT=$(fg cdd6f4) SUB=$(fg a6adc8) OV0=$(fg 6c7086) SKY=$(fg 89dceb)
GREEN=$(fg a6e3a1) YELLOW=$(fg f9e2af) RED=$(fg f38ba8)
ROWBG=$(bg 313244) BOLD=$'\e[1m' RESET=$'\e[0m'

declare -A GCACHE GTIME
FRAME="" ROW=0 COLS=$W LINES_MAX=50
declare -a ACT

# row ACTION HIGHLIGHT color text [color text ...]
row() {
  local act=$1 hl=$2; shift 2
  ROW=$((ROW + 1))
  [ "$ROW" -gt "$LINES_MAX" ] && return
  ACT[$ROW]=$act
  local out="" used=0 room=$((COLS - 1)) color text
  [ "$hl" = 1 ] && out+=$ROWBG
  out+=" "
  while [ $# -ge 2 ]; do
    color=$1 text=$2; shift 2
    [ $((used + ${#text})) -gt "$room" ] && text=${text:0:$((room - used))}
    out+="$color$text"
    used=$((used + ${#text}))
    [ $hl = 1 ] && out+=$ROWBG
  done
  [ "$hl" = 1 ] && out+="$(printf '%*s' $((room - used)) '')"
  FRAME+=$'\e['"$ROW"';1H'"$out$RESET"$'\e[K'
}

git_info() { # sets GI for path $1, cached for 5 seconds
  local p=$1 b ab=""
  if [ -n "${GTIME[$p]:-}" ] && [ $((SECONDS - GTIME[$p])) -lt 5 ]; then GI=${GCACHE[$p]}; return; fi
  b=$(git -C "$p" branch --show-current 2>/dev/null)
  if [ -n "$b" ]; then
    read -r ahead behind < <(git -C "$p" rev-list --left-right --count HEAD...@{u} 2>/dev/null)
    [ "${ahead:-0}" -gt 0 ] && ab+=" ↑$ahead"
    [ "${behind:-0}" -gt 0 ] && ab+=" ↓$behind"
    GI="$b$ab"
  else
    GI=""
  fi
  GCACHE[$p]=$GI GTIME[$p]=$SECONDS
}

icon() { # state -> colored glyph, in herdr's "symbols" style
  case $1 in
    blocked) printf '%s' "$RED⚠" ;;
    working) printf '%s' "$YELLOW◐" ;;
    done) printf '%s' "$GREEN✓" ;;
    idle) printf '%s' "$OV0○" ;;
    *) printf '%s' "$OV0·" ;;
  esac
}
rank() { case $1 in blocked) echo 4 ;; working) echo 3 ;; done) echo 2 ;; idle) echo 1 ;; *) echo 0 ;; esac; }

draw() {
  local me size s path attached first cp
  me=$(tmux display -p -t "$TMUX_PANE" '#S') || exit 0
  size=$(tmux display -p -t "$TMUX_PANE" '#{pane_width} #{pane_height}')
  COLS=${size% *} LINES_MAX=${size#* }
  FRAME="" ROW=0 ACT=()

  declare -A sstate spath
  local -a agents=()
  local sname widx wname pid cmd title bell side ppath wact pact state
  while IFS=$'\t' read -r sname widx wname pid cmd title bell side ppath wact pact; do
    [ "$side" = 1 ] && continue
    [ "$wact" = 1 ] && [ "$pact" = 1 ] && spath[$sname]=$ppath
    [[ $cmd =~ $AGENTS ]] || continue
    first=${title:0:1}
    cp=$(printf '%d' "'$first" 2>/dev/null || echo 0)
    if [ "$cp" -ge 10240 ] && [ "$cp" -le 10495 ]; then state=working   # braille spinner in the title
    elif [ "$bell" = 1 ]; then state=done                               # rang the bell, not yet seen
    else state=idle; fi
    agents+=("$state"$'\t'"$sname"$'\t'"$wname"$'\t'"$pid"$'\t'"$cmd")
    if [ "$(rank "$state")" -gt "$(rank "${sstate[$sname]:-}")" ]; then sstate[$sname]=$state; fi
  done < <(tmux list-panes -a -F '#{session_name}	#{window_index}	#{window_name}	#{pane_id}	#{pane_current_command}	#{pane_title}	#{window_bell_flag}	#{@herdr_sidebar}	#{pane_current_path}	#{window_active}	#{pane_active}')

  row "" 0 "$OV0$BOLD" "Spaces"
  while IFS=$'\t' read -r s attached; do
    local hl=0 namec=$SUB
    [ "$s" = "$me" ] && hl=1 namec=$TEXT$BOLD
    row "s:$s" "$hl" "$(icon "${sstate[$s]:-none}")" "" "$namec" " $s"
    path=${spath[$s]:-}
    GI=""; [ -n "$path" ] && git_info "$path"
    [ -n "$GI" ] && row "s:$s" "$hl" "$OV0" "  $GI"
  done < <(tmux list-sessions -F '#{session_name}	#{session_attached}')

  row "" 0 "" ""
  row "" 0 "$OV0$BOLD" "Agents"
  if [ ${#agents[@]} -eq 0 ]; then
    row "" 0 "$OV0" "  no agents"
  else
    local a
    for a in "${agents[@]}"; do
      IFS=$'\t' read -r state sname wname pid cmd <<<"$a"
      row "p:$pid" 0 "$(icon "$state")" "" "$TEXT" " $sname" "$OV0" " · " "$SUB" "$wname"
      row "p:$pid" 0 "$OV0" "  $cmd"
    done
  fi
  printf '%s\e[%d;1H\e[J' "$FRAME" $((ROW + 1))
}

click() {
  local act=${ACT[$1]:-} client
  [ -z "$act" ] && return
  client=$(tmux list-clients -t "$(tmux display -p -t "$TMUX_PANE" '#S')" -F '#{client_name}' | head -1)
  case $act in
    s:*)
      if [ "${act#s:}" = "$(tmux display -p -t "$TMUX_PANE" '#S')" ]; then
        tmux select-pane -t "$TMUX_PANE" -R
      else
        tmux switch-client ${client:+-c "$client"} -t "=${act#s:}"
      fi ;;
    p:*)
      tmux switch-client ${client:+-c "$client"} -t "${act#p:}"
      tmux select-window -t "${act#p:}"
      tmux select-pane -t "${act#p:}" ;;
  esac
}

render() {
  printf '\e[?25l\e[?1000h\e[?1006h\e[2J'
  trap 'printf "\e[?1000l\e[?1006l\e[?25h"' EXIT
  stty -echo 2>/dev/null
  local c rest
  while :; do
    draw
    if IFS= read -rsn1 -t 1 c && [ "$c" = $'\e' ]; then
      rest=""
      IFS= read -rsn32 -t 0.05 rest
      if [[ $rest =~ ^\[\<0\;([0-9]+)\;([0-9]+)M ]]; then click "${BASH_REMATCH[2]}"; fi
    fi
  done
}

case ${1:-} in
  render) render ;;
  ensure) lock; ensure "$2" ;;
  ensure-all) lock; ensure_all ;;
  toggle) toggle ;;
  gc) gc ;;
  borders) borders "${2:-}" ;;
  fixwidth) fixwidth ;;
  *) echo "usage: $0 render|ensure WIN|ensure-all|toggle|gc|borders [WIN]|fixwidth" >&2; exit 2 ;;
esac
