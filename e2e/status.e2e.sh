#!/usr/bin/env bash
# E2E of bin/status-line and cmux/claude-settings.json. Ways it can fail, written first:
# T1 more than one line, or an empty line. T2 the status command of the user fails, hangs, or is missing: an error text in the status.
# T3 the stdin of Claude does not reach the command. T4 it starts itself again (a loop). T5 the colors leak into the next line.
# T6 the settings file does not set fullscreen mode, or names a program that is not there. T7 one line of input only.
HERE="$(cd "$(dirname "$0")/.." && pwd)"; OUT="${1:-${TMPDIR:-/tmp}}/status-$(date +%s)"; mkdir -p "$OUT/c"
pass=0; fail=0; res=""; ok() { if [ "$3" = "$4" ]; then pass=$((pass+1)); s=PASS; else fail=$((fail+1)); s=FAIL; printf '   want %q\n   got  %q\n' "$4" "$3"; fi; echo "$s $1 $2"; res="$res{\"id\":\"$1\",\"name\":\"$2\",\"result\":\"$s\"},"; }
run() { jq -n --arg c "$1" '{statusLine:{command:$c}}' > "$OUT/c/settings.json"; echo '{"model":"M"}' | CLAUDE_CONFIG_DIR="$OUT/c" "$HERE/bin/status-line" 2>&1; }
R=$'\e[0m'
ok T1 "three lines become one, the third is dropped" "$(run 'printf "a\nb\nc\n"')" "a │ b$R"
ok T1 "empty lines are dropped" "$(run 'printf "\na\n\nb\n"')" "a │ b$R"
ok T7 "one line" "$(run 'echo a')" "a$R"
ok T2 "a command that fails: nothing" "$(run 'echo oops >&2; exit 3')" ""
ok T2 "no command: nothing" "$(run '')" ""
ok T3 "stdin" "$(run 'jq -r .model')" "M$R"
ok T4 "its own path: nothing" "$(run "$HERE/bin/status-line")" ""
a=$(date +%s); r="$(run 'sleep 60')"; ok T2 "a command that hangs: nothing" "$r" ""; ok T2 "and it ends in 10 s" "$(( $(date +%s) - a < 10 ))" 1
ok T5 "color ends" "$(run $'printf "\\033[31ma\\n"')" $'\e[31ma'"$R"
ok T6 "settings" "$(jq -r '[.tui,.statusLine.type]|join(" ")' "$HERE/cmux/claude-settings.json")" "fullscreen command"
ok T6 "the program is there" "$([ -x "$(jq -r --arg root "$HERE" '.statusLine.command | sub("__ROOT__"; $root)' "$HERE/cmux/claude-settings.json")" ] && echo yes)" yes
echo "{\"passed\":$pass,\"failed\":$fail,\"results\":[${res%,}]}" > "$OUT/result.json"; echo "$pass passed, $fail failed"; echo "$OUT/result.json"; [ $fail = 0 ]
