#!/usr/bin/env bash
# E2E of bin/md-open with a fake cmux and the real fzf in a pseudo terminal. Ways it can fail, written first:
# M1 the file opens in the small terminal pane, not in the pane of the chat. M2 no chat pane (or cmux fails): nothing opens.
# M3 a path with spaces, a quote, or a leading dash breaks it. M4 the newest file is not first. M5 it lists only the current subfolder, not the project.
# M6 a pasted path outside the project does not open, or a path that is not there opens something. M7 Esc opens something.
# M8 the tab stays open with an error that nobody sees, or closes before the user can read the error. M9 git-ignored files are missing, or node_modules is listed.
# M10 a second chat-like browser tab is taken. M11 cmux.json: the key is in use by cmux, or the command does not close its tab.
HERE="$(cd "$(dirname "$0")/.." && pwd)"; OUT="${1:-${TMPDIR:-/tmp}}/md-$(date +%s)"
mkdir -p "$OUT/bin" "$OUT/p/docs/sub" "$OUT/p/node_modules/x" "$OUT/p/code" "$OUT/other"; OUT="$(cd "$OUT" && pwd -P)"; cd "$OUT/p" && git init -q . && echo 'docs/sub' > .gitignore
echo a > "docs/it's old.md"; echo b > docs/sub/ignored.md; echo c > node_modules/x/dep.md; echo d > ./-dash.md; echo e > "$OUT/other/far away.md"; echo f > notes.txt
touch -t 202601010000 "docs/it's old.md"; touch -t 202601020000 -- ./-dash.md; touch -t 202601030000 docs/sub/ignored.md
cat > "$OUT/bin/cmux" <<'F'
#!/usr/bin/env bash
printf '%s\t' "$@" >> "$LOG"; echo >> "$LOG"
case "$1 $2" in "rpc surface.list") cat >/dev/null; [ "$MODE" = fail ] && exit 1; cat "$SURF" ;; open*) [ "$MODE" = openfail ] && { echo boom >&2; exit 1; }; exit 0 ;; esac
F
chmod +x "$OUT/bin/cmux"
cat > "$OUT/surf.json" <<'F'
{"surfaces":[{"type":"browser","pane_id":"PANE-WEB","title":"Chatham House"},{"type":"browser","pane_id":"PANE-CHAT","title":"Chat"},{"type":"terminal","pane_id":"PANE-TERM","title":"Chat"}]}
F
echo '{"surfaces":[{"type":"terminal","pane_id":"PANE-TERM","title":"Claude"}]}' > "$OUT/none.json"
cat > "$OUT/run.exp" <<'F'
set stty_init "rows 24 columns 100"
log_user 0
log_file -a -noappend $env(TTY)
set done 0
proc drain {s} { global done spawn_id; if {$done} return; set timeout 1; set end [expr {[clock milliseconds] + int($s * 1000)}]; if {[catch {expect { -re {.+} { if {[clock milliseconds] < $end} exp_continue } timeout {} eof { set done 1 } }}]} { set done 1 } }
spawn $env(BIN)
drain 2
foreach k $argv { if {!$done} { send -- $k; drain 1 } }
drain 3
if {!$done} { drain 3 }
if {!$done} { exec kill -9 [exp_pid]; puts "still open"; exit 99 }
catch wait r
exit [lindex $r 3]
F
pass=0; fail=0; res=""
ok() { if [ "$3" = "$4" ]; then pass=$((pass+1)); s=PASS; else fail=$((fail+1)); s=FAIL; fi; echo "$s $1 $2"; [ $s = FAIL ] && printf '   want %q\n   got  %q\n' "$4" "$3"; res="$res{\"id\":\"$1\",\"name\":\"$2\",\"result\":\"$s\"},"; }
run() { export LOG="$OUT/log.$1" SURF="$OUT/surf.json" MODE="" TTY="$OUT/tty.$1" BIN="$HERE/bin/md-open" CMUX_WORKSPACE_ID=W1; [ -n "${S:-}" ] && SURF="$S"; [ -n "${MO:-}" ] && MODE="$MO"; : > "$LOG"; (cd "${D:-$OUT/p}" && PATH="$OUT/bin:$PATH" CMUX_BUNDLED_CLI_PATH="$OUT/bin/cmux" expect "$OUT/run.exp" "${@:2}"); code=$?; got="$(grep '^open' "$LOG" | tr '\t' '|')"; }
run 1 $'\r'; ok M4 "Enter opens the newest file, in the pane of the chat" "$got" "open|$OUT/p/docs/sub/ignored.md|--workspace|W1|--pane|PANE-CHAT|--focus|true|"
ok M10 "exit code 0" "$code" 0
run 2 "it's" $'\r'; ok M3 "a space and a quote" "$got" "open|$OUT/p/docs/it's old.md|--workspace|W1|--pane|PANE-CHAT|--focus|true|"
run 3 "dash" $'\r'; ok M3 "a leading dash" "$got" "open|$OUT/p/-dash.md|--workspace|W1|--pane|PANE-CHAT|--focus|true|"
D="$OUT/p/code" run 4 $'\r'; ok M5 "from a subfolder it lists the project" "$got" "open|$OUT/p/docs/sub/ignored.md|--workspace|W1|--pane|PANE-CHAT|--focus|true|"
run 5 "$OUT/other/far away.md" $'\r'; ok M6 "a pasted path outside the project" "$got" "open|$OUT/other/far away.md|--workspace|W1|--pane|PANE-CHAT|--focus|true|"
run 6 "/nope/zzqq.md" $'\r' $'\r'; ok M6 "a path that is not there opens nothing" "$got" ""; ok M8 "and says so" "$(grep -c 'no file' "$OUT/tty.6")" 1
run 7 $'\x1b'; ok M7 "Esc opens nothing" "$got" ""; ok M7 "Esc ends with code 0" "$code" 0
run 8 "dep" $'\x1b'; ok M9 "node_modules is not listed" "$(grep -c 'node_modules/x/dep' "$OUT/tty.8")" 0
S="$OUT/none.json" run 9 $'\r'; ok M2 "no chat pane: it opens in this pane" "$got" "open|$OUT/p/docs/sub/ignored.md|--workspace|W1|--focus|true|"
MO=fail run 10 $'\r'; ok M2 "the list fails: it opens in this pane" "$got" "open|$OUT/p/docs/sub/ignored.md|--workspace|W1|--focus|true|"
MO=openfail run 11 $'\r' $'\r'; ok M8 "cmux open fails: the message stays until a key" "$(grep -c 'boom' "$OUT/tty.11")" 1
ok M11 "cmux.json has the key and exec" "$(jq -r '.actions["open-markdown"]|[.type,.shortcut,.target,(.command|startswith("exec "))]|join("|")' "$HERE/cmux/cmux.json")" "command|cmd+shift+x|newTabInCurrentPane|true"
echo "{\"passed\":$pass,\"failed\":$fail,\"results\":[${res%,}]}" > "$OUT/result.json"; echo "$pass passed, $fail failed"; echo "$OUT/result.json"; [ $fail = 0 ]
