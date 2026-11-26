#!/usr/bin/env bash
# E2E of cmux/make-groups with a fake cmux CLI. Ways it can fail, written first:
# G1 a second run makes duplicate groups (no stable key). G2 a missing folder gets a group.
# G3 a comment or an empty line becomes a group. G4 one failed create stops the others or looks like success.
# G5 it closes, deletes, or ungroups something. G6 a run outside cmux does something or fails without a message.
# G9 a name that is part of another name (acme-brain, acme-brain-state) is seen as the same.
# G10 a new name for the same folder makes a second group, and does not rename the first.
# G7 a group is not pinned or not collapsed, or the wrong group is. G8 a second run collapses a group that the user opened.
OUT="${1:-${TMPDIR:-/tmp}}/groups-$(date +%s)"; mkdir -p "$OUT/bin" "$OUT/a" "$OUT/b"; HERE="$(cd "$(dirname "$0")" && pwd)"
cat > "$OUT/bin/cmux" <<'F'
#!/usr/bin/env bash
echo "$*" >> "$LOG"
case "$1 $2" in
  "workspace-group list") sed -E 's/^[^ ]+ (.*)$/{"groups":[{"name":"\1"}]}/' "$DB" ;;
  "workspace-group create") [ "$4" = bad ] && { echo no >&2; exit 1; }; k="$LOG.key.$(tr -c 'a-zA-Z0-9\n' _ <<<"$8")"; [ -f "$k" ] && { echo "OK $(cat "$k")"; exit 0; }; n=$(($(wc -l < "$DB") + 1)); echo "workspace_group:$n $4" >> "$DB"; echo "workspace_group:$n" > "$k"; echo "OK workspace_group:$n" ;;
  "workspace-group rename") sed -i.old "s|^$3 .*|$3 $5|" "$DB" ;;
esac
F
chmod +x "$OUT/bin/cmux"; export LOG="$OUT/calls" DB="$OUT/db" PATH="$OUT/bin:$PATH"; : > "$LOG"; : > "$DB"
printf '# c | %s\n\none | %s\nbad | %s\ngone | %s/none\ntwo | %s\n' "$OUT/a" "$OUT/a" "$OUT/a" "$OUT" "$OUT/b" > "$OUT/p.txt"
fail=0; check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi | tee -a "$OUT/result.txt"; }
env -u CMUX_WORKSPACE_ID "$HERE/../cmux/make-groups" "$OUT/p.txt" > "$OUT/o0" 2>&1; c0=$?
check G6 '[ $c0 -ne 0 ] && grep -q "inside cmux" "$OUT/o0" && [ ! -s "$LOG" ]'
CMUX_WORKSPACE_ID=x "$HERE/../cmux/make-groups" "$OUT/p.txt" > "$OUT/o1" 2>&1; c1=$?
check G2-G3 '! grep -qE "name (gone|#|c) " "$LOG" && grep -q "gone: no folder" "$OUT/o1"'
check G4 '[ $c1 -ne 0 ] && grep -q "bad: FAILED" "$OUT/o1" && grep -q "two$" "$DB"'
check G7 'grep -qx "workspace-group pin workspace_group:1" "$LOG" && grep -qx "workspace-group collapse workspace_group:2" "$LOG"'
n=$(wc -l < "$LOG"); CMUX_WORKSPACE_ID=x "$HERE/../cmux/make-groups" "$OUT/p.txt" > "$OUT/o2" 2>&1
check G1-G8 '[ $(wc -l < "$DB") -eq 2 ] && ! tail -n +$((n+1)) "$LOG" | grep -qE "collapse|pin|name one|name two"'
check G1-key 'grep -q -- "--idempotency-key project:$OUT/a" "$LOG"'
printf 'on | %s\n' "$OUT/a" > "$OUT/q.txt"; echo 'workspace_group:9 on-state' >> "$DB"; CMUX_WORKSPACE_ID=x "$HERE/../cmux/make-groups" "$OUT/q.txt" > "$OUT/o3" 2>&1
check G9 'grep -q "^on: made$" "$OUT/o3"'
printf 'ACME/two | %s\n' "$OUT/b" > "$OUT/r.txt"; before=$(wc -l < "$DB"); CMUX_WORKSPACE_ID=x "$HERE/../cmux/make-groups" "$OUT/r.txt" > "$OUT/o4" 2>&1
check G10 '[ $(wc -l < "$DB") -eq $before ] && grep -qx "workspace_group:2 ACME/two" "$DB"'
check G5 '! grep -qE "delete|close|ungroup|remove" "$LOG"'
echo "$OUT/result.txt"; ! grep -q FAIL "$OUT/result.txt"
