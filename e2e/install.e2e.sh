#!/usr/bin/env bash
# A fresh install must render both configs, install React, preserve edits on a
# second run, and back up the exact live file before replacing it on request.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd -P)"
testdir="$(mktemp -d)"
export HOME="$testdir/home" TMPDIR="$testdir/tmp"
mkdir -p "$HOME" "$TMPDIR" "$testdir/bin"
unset ORCA_CHAT_DATA_DIR BUN_INSTALL BUN_INSTALL_CACHE_DIR XDG_CONFIG_HOME XDG_CACHE_HOME GIT_CONFIG_GLOBAL
export PATH="$testdir/bin:$PATH"
for shim in cmux claude; do
  printf '#!/bin/sh\nexit 99\n' > "$testdir/bin/$shim"
  chmod +x "$testdir/bin/$shim"
done
cd "$root"
config="$HOME/.config/cmux-chat"
live="$HOME/.config/cmux/cmux.json"
data="$HOME/.local/share/orca-chat"
run_install() {
  if ! ./install "$@" > "$testdir/install.out" 2>&1; then
    cat "$testdir/install.out" >&2
    return 1
  fi
}
run_install
cmp "$config/projects.txt" cmux/projects.example.txt
for name in cmux.json claude-settings.json; do
  grep -Fq "$root" "$config/$name"
  jq -e . "$config/$name" >/dev/null
  if grep -Eq '__ROOT__|__HOME__' "$config/$name"; then exit 1; fi
done
jq -e --arg home "$HOME" '.workspaceGroups.byCwd[$home]' "$config/cmux.json" >/dev/null
cmp "$config/cmux.json" "$live"
test -d "$data/cmux-src/agent-chat/node_modules/react"
echo 'PASS fresh install, example projects, both rendered configs, home menu and React'
echo '# Local edit' >> "$config/projects.txt"
echo '{"local":true}' > "$live"
run_install
grep -Fxq '# Local edit' "$config/projects.txt"
grep -Fxq '{"local":true}' "$live"
grep -Fq "Merge $config/cmux.json" "$testdir/install.out"
echo 'PASS second install preserved projects and the existing cmux config'
run_install --write-cmux-config
backups=("$live".*.bak)
test "${#backups[@]}" -eq 1
grep -Fxq '{"local":true}' "${backups[0]}"
cmp "$live" "$config/cmux.json"
test ! -e "$HOME/.claude"
test ! -e "$HOME/.zshrc"
echo "PASS replacement saved $(basename "${backups[0]}") with the original contents"
