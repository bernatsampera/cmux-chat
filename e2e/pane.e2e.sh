#!/usr/bin/env bash
# E2E of pane/claude: Claude in a taller hidden tmux screen, the pane shows its bottom. The pane is an outer tmux, Claude is a fake.
# Ways it can fail, written first:
# P1 the pane shows the top, not the bottom. P2 the arguments change (spaces, quotes, $, empty, ;). P3 it starts itself again, or not the claude that PATH gives (the cmux shim has the hooks).
# P4 CMUX_SURFACE_ID, the folder, or PATH is lost: no chat, no sidebar state. Two chats share one tmux server: wrong CMUX_SURFACE_ID.
# P5 a click goes to the wrong row. P6 the width or height does not follow the pane. P7 Claude stays alive when the pane closes. P8 the pane stays open when Claude ends.
# P9 a tmux key (Ctrl+B) or the tmux status line takes over. P10 no tmux, or no terminal: Claude does not start. P11 $TMUX is seen by Claude and cmux. P12 the user's ~/.tmux.conf is loaded.
# P15 the hidden part is not exactly half: conversation text shows, or the input is cut.
# P13 Shift+Enter is the same as Enter. P14 a start in a tmux already.
HERE="$(cd "$(dirname "$0")/.." && pwd)"; OUT="${1:-${TMPDIR:-/tmp}}/pane-$(date +%s)"; mkdir -p "$OUT/bin" "$OUT/w x" "$OUT/home"; O="pane-e2e-$$"
cat > "$OUT/bin/claude" <<'F'
#!/usr/bin/env bash
{ printf '<%s>' "$@"; echo; echo "pid=$$ surf=$CMUX_SURFACE_ID pwd=$PWD tmux=${TMUX:-none} path1=${PATH%%:*}"; } > "$LOGF"
[ -t 1 ] || { echo notty; exit 7; }
draw() { IFS=' ' read -r r c < <(stty size); echo "$r $c" > "$LOGF.size"; printf '\033[2J'; for ((n=1;n<=r;n++)); do printf '\033[%d;1HROW%d/%d' "$n" "$n" "$r"; done; printf '\033[%d;3H' "$((r-3))"; }
printf '\033[?1049h\033[?1000h\033[?1006h\033[>4;2m'; trap draw WINCH; stty raw -echo; draw; : > "$LOGF.keys"
while :; do if IFS= read -rsn1 -t 1 k; then printf '%s' "$k" >> "$LOGF.keys"; [ "$k" = q ] && exit 0; fi; done
F
chmod +x "$OUT/bin/claude"; pass=0; fail=0; res=""
ok() { if [[ "$3" == $4 ]]; then pass=$((pass+1)); s=PASS; else fail=$((fail+1)); s=FAIL; printf '   want %s\n   got  %s\n' "$4" "$3"; fi; echo "$s $1 $2"; res="$res{\"id\":\"$1\",\"name\":\"$2\",\"result\":\"$s\"},"; }
o() { tmux -L "$O" "$@"; }; cap() { o capture-pane -p -t "$1"; }; pids() { sed -n 's/^pid=\([0-9]*\).*/\1/p' "$1" 2>/dev/null; }
start() { o -f /dev/null new-session -d -s "$1" -x 100 -y 8 -c "$OUT/w x" "env HOME='$OUT/home' LOGF='$OUT/$1' CMUX_SURFACE_ID=S-$1 PATH='$HERE/pane:$OUT/bin:$PATH' ${2:-} claude --settings 'a b' \"it's\" '\$HOME' '' 'x;y'"; o set -g status off; o set -g mouse on; sleep 3; }
echo 'set -g status on' > "$OUT/home/.tmux.conf"
start a; start b
ok P1 "the pane shows the bottom 8 rows" "$(cap a | tr '\n' ' ')" "ROW9/16* ROW16/16*"
ok P9 "no tmux status line, no user config (P12)" "$(cap a | tail -1)" "ROW16/16*"
ok P2 "arguments" "$(head -1 "$OUT/a")" "<--settings><a b><it's><\$HOME><><x;y>"
ok P4 "surface, folder, first PATH entry, no TMUX (P3 P11)" "$(sed -n 2p "$OUT/a")" "pid=* surf=S-a pwd=$OUT/w x tmux=none path1=$OUT/bin"
ok P4 "the second chat has its own surface" "$(sed -n 2p "$OUT/b")" "* surf=S-b *"
printf '\033[<0;9;5M' | xxd -p | fold -w2 | xargs tmux -L "$O" send-keys -t a -H; sleep 1
ok P5 "a click in pane row 5 is row 13 of 16" "$(cat "$OUT/a.keys" | tr -d '\033')" "*[[]<0;9;13M*"
o send-keys -t a C-b; o send-keys -t a -l "c"; sleep 1; ok P9 "Ctrl+B goes to Claude (as CSI 27;5;98~)" "$(xxd -p "$OUT/a.keys" | tr -d '\n')" "*1b5b32373b353b39387e63*"
o send-keys -t a -H 1b 5b 31 33 3b 32 75; sleep 1; ok P13 "Shift+Enter is not Enter" "$(xxd -p "$OUT/a.keys" | tr -d '\n')" "*1b5b*3b32*"
o resize-window -t a -x 120 -y 12; sleep 2; ok P6 "the width and the height follow" "$(cat "$OUT/a.size")" "24 120"; ok P6 "and the bottom shows" "$(cap a | tail -1)" "ROW24/24*"
o resize-window -t a -x 90 -y 6; sleep 2; ok P6 "smaller" "$(stty size < "/dev/$(ps -o tty= -p "$(pids "$OUT/a")" | tr -d ' ')")" "12 90"
p=$(pids "$OUT/b"); o kill-session -t b; sleep 2; ok P7 "the pane closes: Claude ends" "$(kill -0 "$p" 2>/dev/null && echo alive || echo gone)" gone
ok P7 "the other chat stays" "$(kill -0 "$(pids "$OUT/a")" 2>/dev/null && echo alive)" alive
o send-keys -t a -l q; sleep 2; ok P8 "Claude ends: the pane closes" "$(o ls 2>&1 | grep -c '^a:')" 0
ok P7 "no tmux server stays" "$(pgrep -fl 'tmux -L cmux-claude' | grep -c "$OUT" )" 0
mkdir -p "$OUT/small"; for t in bash env cat stty sed dirname grep tr; do ln -sf "$(command -v $t)" "$OUT/small/$t"; done
start c "PATH='$HERE/pane:$OUT/bin:$OUT/small'"; ok P10 "no tmux: Claude starts" "$(cat "$OUT/c.size" 2>/dev/null)" "8 100"
r=$(LOGF="$OUT/d" PATH="$HERE/pane:$OUT/bin:$PATH" "$HERE/pane/claude" x </dev/null 2>&1); ok P10 "no terminal: Claude starts" "$r $?" "notty *"
o kill-server 2>/dev/null
echo "{\"passed\":$pass,\"failed\":$fail,\"results\":[${res%,}]}" > "$OUT/result.json"; echo "$pass passed, $fail failed"; echo "$OUT/result.json"; [ $fail = 0 ]
